use serde::{Deserialize, Serialize};
use serde_json::{Map as JsonMap, Value as JsonValue};
use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::sync::{mpsc, Arc, Condvar, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{Emitter, Manager, State};
use tauri_plugin_opener::OpenerExt;
use uuid::Uuid;

use crate::db::TelemetryDb;

#[cfg(not(debug_assertions))]
const KEYCHAIN_SERVICE: &str = "com.agentree.agentree.login-profiles";
const READINESS_CHECK_TIMEOUT: Duration = Duration::from_secs(12);
const OPENCODE_READINESS_CHECK_TIMEOUT: Duration = Duration::from_secs(120);
const CODEX_DEVICE_LOGIN_URL: &str = "https://auth.openai.com/codex/device";
const CODEX_LOGIN_START_TIMEOUT: Duration = Duration::from_secs(20);
const CODEX_GLOBAL_INSTRUCTION_FILES: [&str; 2] = ["AGENTS.override.md", "AGENTS.md"];
const CODEX_AUTH_CONFIG_LINE: &str = "cli_auth_credentials_store = \"file\"";
const CLAUDE_LOGIN_START_TIMEOUT: Duration = Duration::from_secs(20);
const CLAUDE_LOGIN_PENDING_TIMEOUT: Duration = Duration::from_secs(15 * 60);
const CLAUDE_LOGIN_CODE_TIMEOUT: Duration = Duration::from_secs(120);
const OPENCODE_PROVIDER_CAPABILITIES_CONFIG_KEY: &str = "opencode_provider_capabilities";
const OPENCODE_MODEL_CATALOG_CONFIG_KEY: &str = "opencode_model_catalog";
const OPENCODE_MODEL_CATALOG_CHECKED_AT_CONFIG_KEY: &str = "opencode_model_catalog_checked_at";

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct LoginProfile {
    pub id: String,
    pub provider: String,
    pub display_name: String,
    pub auth_type: String,
    pub redacted_hint: Option<String>,
    #[specta(type = specta_typescript::Unknown)]
    pub config: JsonValue,
    pub status: String,
    pub status_message: Option<String>,
    pub plan_type: Option<String>,
    pub is_default: bool,
    pub created_at: i64,
    pub updated_at: i64,
    pub last_checked_at: Option<i64>,
}

#[derive(Debug, Clone, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct UpsertLoginProfileRequest {
    pub id: Option<String>,
    pub provider: String,
    pub display_name: String,
    pub auth_type: String,
    pub secret: Option<String>,
    #[specta(type = specta_typescript::Unknown)]
    pub config: Option<JsonValue>,
    pub make_default: Option<bool>,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct LoginImportCandidate {
    pub id: String,
    pub provider: String,
    pub display_name: String,
    pub auth_type: String,
    pub source_kind: String,
    pub source_label: String,
    pub redacted_hint: Option<String>,
    pub importable: bool,
}

#[derive(Debug, Clone, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ImportLoginCandidateRequest {
    pub candidate_id: String,
    pub display_name: Option<String>,
    pub make_default: Option<bool>,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ActiveLoginProfileRun {
    pub login_profile_id: String,
    pub run_id: String,
    pub assistant_node_id: String,
    pub workspace_id: Option<String>,
    pub agent_type: Option<String>,
    pub status: String,
    pub phase: String,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
#[tauri_specta(event_name = "login-profiles:changed")]
pub struct LoginProfilesChangedEvent {
    pub profile_id: String,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CodexLoginStart {
    pub profile_id: String,
    pub device_url: String,
    pub device_code: String,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeOAuthLoginStart {
    pub profile_id: String,
    pub login_url: String,
}

#[derive(Debug, Clone)]
#[allow(dead_code)]
pub struct MaterializedRuntimeCredentials {
    pub profile_id: String,
    pub provider: String,
    pub auth_type: String,
    pub env: HashMap<String, String>,
    pub codex_home: Option<PathBuf>,
    pub opencode_auth_path: Option<PathBuf>,
}

struct PendingClaudeOAuthLogin {
    child: std::process::Child,
    stdin: std::process::ChildStdin,
    output: Arc<Mutex<String>>,
    started_at: SystemTime,
}

static PENDING_CLAUDE_OAUTH_LOGINS: OnceLock<Mutex<HashMap<String, PendingClaudeOAuthLogin>>> =
    OnceLock::new();
static CODEX_PROFILE_SYNC_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

struct ReadinessFlight {
    result: Mutex<Option<Result<LoginProfile, String>>>,
    completed: Condvar,
}

#[derive(Default)]
struct ReadinessCoordinatorState {
    generations: HashMap<String, u64>,
    flights: HashMap<String, Arc<ReadinessFlight>>,
}

enum ReadinessFlightRole {
    Owner {
        flight: Arc<ReadinessFlight>,
        generation: u64,
    },
    Waiter,
}

static READINESS_COORDINATOR: OnceLock<Mutex<ReadinessCoordinatorState>> = OnceLock::new();

fn readiness_coordinator() -> &'static Mutex<ReadinessCoordinatorState> {
    READINESS_COORDINATOR.get_or_init(|| Mutex::new(ReadinessCoordinatorState::default()))
}

fn begin_readiness_flight(profile_id: &str) -> Result<ReadinessFlightRole, String> {
    let mut coordinator = readiness_coordinator()
        .lock()
        .map_err(|error| error.to_string())?;
    if coordinator.flights.contains_key(profile_id) {
        return Ok(ReadinessFlightRole::Waiter);
    }
    let generation = coordinator
        .generations
        .entry(profile_id.to_string())
        .and_modify(|generation| *generation += 1)
        .or_insert(1)
        .to_owned();
    let flight = Arc::new(ReadinessFlight {
        result: Mutex::new(None),
        completed: Condvar::new(),
    });
    coordinator
        .flights
        .insert(profile_id.to_string(), Arc::clone(&flight));
    Ok(ReadinessFlightRole::Owner { flight, generation })
}

#[cfg(test)]
fn wait_for_readiness_flight(flight: &ReadinessFlight) -> Result<LoginProfile, String> {
    let mut result = flight.result.lock().map_err(|error| error.to_string())?;
    while result.is_none() {
        result = flight
            .completed
            .wait(result)
            .map_err(|error| error.to_string())?;
    }
    result
        .as_ref()
        .expect("readiness flight result is present")
        .clone()
}

#[cfg(test)]
fn active_readiness_flight(profile_id: &str) -> Result<Arc<ReadinessFlight>, String> {
    readiness_coordinator()
        .lock()
        .map_err(|error| error.to_string())?
        .flights
        .get(profile_id)
        .cloned()
        .ok_or_else(|| format!("No readiness flight exists for {}", profile_id))
}

fn complete_readiness_flight(
    profile_id: &str,
    flight: &Arc<ReadinessFlight>,
    result: Result<LoginProfile, String>,
) {
    if let Ok(mut coordinator) = readiness_coordinator().lock() {
        if coordinator
            .flights
            .get(profile_id)
            .is_some_and(|current| Arc::ptr_eq(current, flight))
        {
            coordinator.flights.remove(profile_id);
        }
    }
    if let Ok(mut shared_result) = flight.result.lock() {
        *shared_result = Some(result);
        flight.completed.notify_all();
    }
}

fn invalidate_readiness_generation(profile_id: &str) {
    if let Ok(mut coordinator) = readiness_coordinator().lock() {
        let generation = coordinator
            .generations
            .entry(profile_id.to_string())
            .or_insert(0);
        *generation += 1;
    }
}

fn with_current_readiness_generation<T>(
    profile_id: &str,
    generation: u64,
    action: impl FnOnce() -> T,
) -> Result<Option<T>, String> {
    let coordinator = readiness_coordinator()
        .lock()
        .map_err(|error| error.to_string())?;
    if coordinator.generations.get(profile_id).copied() != Some(generation) {
        return Ok(None);
    }
    Ok(Some(action()))
}

fn current_readiness_generation(profile_id: &str) -> Result<u64, String> {
    readiness_coordinator()
        .lock()
        .map_err(|error| error.to_string())?
        .generations
        .get(profile_id)
        .copied()
        .ok_or_else(|| format!("No readiness generation exists for profile {profile_id}"))
}

pub trait CredentialVault {
    fn set_secret(&self, account: &str, secret: &str) -> Result<(), String>;
    fn get_secret(&self, account: &str) -> Result<String, String>;
    fn delete_secret(&self, account: &str) -> Result<(), String>;
}

pub struct KeyringCredentialVault;

fn safe_secret_account(account: &str) -> String {
    account
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
                ch
            } else {
                '_'
            }
        })
        .collect()
}

#[cfg(any(not(debug_assertions), test))]
fn file_secret_path(account: &str) -> Result<PathBuf, String> {
    let data_dir = dirs::data_dir()
        .or_else(dirs::data_local_dir)
        .ok_or_else(|| "could not resolve app data directory".to_string())?;
    Ok(data_dir
        .join("com.agentree.agentree")
        .join("login-profile-secrets")
        .join(safe_secret_account(account)))
}

#[cfg(debug_assertions)]
fn debug_file_secret_path(account: &str) -> Result<PathBuf, String> {
    let data_dir = dirs::data_dir()
        .or_else(dirs::data_local_dir)
        .ok_or_else(|| "could not resolve app data directory".to_string())?;
    Ok(data_dir
        .join("com.agentree.agentree.dev")
        .join("login-profile-secrets")
        .join(safe_secret_account(account)))
}

#[cfg(any(debug_assertions, test))]
fn read_optional_file_secret(path: &Path) -> Result<Option<String>, String> {
    match fs::read_to_string(path) {
        Ok(secret) => Ok(Some(secret)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!(
            "Could not access login profile credentials: {}",
            error
        )),
    }
}

#[cfg(any(debug_assertions, test))]
fn write_private_secret_file(path: &Path, secret: &str) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "could not resolve login profile secret directory".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("failed to create login profile secret directory: {}", error))?;
    let mut temporary =
        tempfile::NamedTempFile::new_in(parent).map_err(|error| error.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        temporary
            .as_file()
            .set_permissions(fs::Permissions::from_mode(0o600))
            .map_err(|error| format!("failed to protect login profile credentials: {}", error))?;
    }
    temporary
        .write_all(secret.as_bytes())
        .map_err(|error| format!("failed to write login profile credentials: {}", error))?;
    temporary
        .as_file()
        .sync_all()
        .map_err(|error| format!("failed to sync login profile credentials: {}", error))?;
    temporary.persist(path).map_err(|error| {
        format!(
            "failed to persist login profile credentials: {}",
            error.error
        )
    })?;
    Ok(())
}

#[cfg(any(not(debug_assertions), test))]
fn read_file_secret(account: &str) -> Result<String, String> {
    let path = file_secret_path(account)?;
    fs::read_to_string(&path).map_err(|error| match error.kind() {
        std::io::ErrorKind::NotFound => {
            "Login profile credentials are missing. Reconnect this profile in Logins and try again."
                .to_string()
        }
        _ => format!("Could not access login profile credentials: {}", error),
    })
}

#[cfg(not(debug_assertions))]
fn delete_file_secret(account: &str) -> Result<(), String> {
    let path = file_secret_path(account)?;
    match fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!(
            "failed to delete login profile secret fallback {}: {}",
            path.display(),
            error
        )),
    }
}

impl CredentialVault for KeyringCredentialVault {
    fn set_secret(&self, account: &str, secret: &str) -> Result<(), String> {
        #[cfg(debug_assertions)]
        {
            write_private_secret_file(&debug_file_secret_path(account)?, secret)
        }
        #[cfg(not(debug_assertions))]
        {
            let entry = crate::secure_store::open_entry(KEYCHAIN_SERVICE, account)?;
            crate::secure_store::set_password(&entry, secret)?;
            delete_file_secret(account)
        }
    }

    fn get_secret(&self, account: &str) -> Result<String, String> {
        #[cfg(debug_assertions)]
        {
            read_optional_file_secret(&debug_file_secret_path(account)?)?.ok_or_else(|| {
                "Login profile credentials are missing. Reconnect this profile in Logins and try again."
                    .to_string()
            })
        }
        #[cfg(not(debug_assertions))]
        {
            let entry = crate::secure_store::open_entry(KEYCHAIN_SERVICE, account)?;
            match entry.get_password() {
                Ok(secret) => {
                    delete_file_secret(account)?;
                    Ok(secret)
                }
                Err(keyring::Error::NoEntry) => {
                    let secret = read_file_secret(account)?;
                    crate::secure_store::set_password(&entry, &secret)?;
                    delete_file_secret(account)?;
                    Ok(secret)
                }
                Err(error) => Err(error.to_string()),
            }
        }
    }

    fn delete_secret(&self, account: &str) -> Result<(), String> {
        #[cfg(debug_assertions)]
        {
            let path = debug_file_secret_path(account)?;
            match fs::remove_file(path) {
                Ok(()) => Ok(()),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
                Err(error) => Err(format!(
                    "failed to delete development login profile credentials: {}",
                    error
                )),
            }
        }
        #[cfg(not(debug_assertions))]
        {
            let entry = crate::secure_store::open_entry(KEYCHAIN_SERVICE, account)?;
            let keyring_result = match entry.delete_credential() {
                Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
                Err(error) => Err(error.to_string()),
            };
            let file_result = delete_file_secret(account);
            match (keyring_result, file_result) {
                (Ok(()), Ok(())) => Ok(()),
                (Err(error), Ok(())) | (Ok(()), Err(error)) => Err(error),
                (Err(keyring_error), Err(file_error)) => Err(format!(
                    "{}; also failed to delete legacy credential file: {}",
                    keyring_error, file_error
                )),
            }
        }
    }
}

pub fn secret_account_id(profile_id: &str, kind: &str) -> String {
    format!("login-profile:{}:{}", profile_id, kind)
}

pub fn redacted_secret_hint(secret: &str) -> String {
    let trimmed = secret.trim();
    if trimmed.len() < 12 {
        return "•••••".to_string();
    }
    let prefix = &trimmed[..trimmed.len().min(7)];
    let suffix = &trimmed[trimmed.len() - 4..];
    format!("{}...{}", prefix, suffix)
}

fn unix_timestamp() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or(0)
}

fn is_supported_provider(provider: &str) -> bool {
    matches!(provider, "codex" | "claude" | "opencode")
}

pub(crate) fn provider_requires_managed_profile(provider: &str) -> bool {
    is_supported_provider(provider)
}

pub(crate) fn require_managed_login_profile(
    provider: &str,
    profile_id: Option<&str>,
) -> Result<(), String> {
    if !provider_requires_managed_profile(provider) || profile_id.is_some() {
        return Ok(());
    }
    let label = match provider {
        "codex" => "Codex",
        "claude" => "Claude",
        "opencode" => "OpenCode",
        _ => provider,
    };
    Err(format!(
        "{label} agent runs require an Agentree login profile; refusing to fall back to global CLI credentials."
    ))
}

pub(crate) fn select_login_profile_for_provider<'a>(
    profiles: &'a [LoginProfile],
    provider: &str,
    explicit_profile_id: Option<&str>,
) -> Option<&'a LoginProfile> {
    explicit_profile_id
        .and_then(|profile_id| {
            profiles
                .iter()
                .find(|profile| profile.id == profile_id && profile.provider == provider)
        })
        .or_else(|| {
            profiles.iter().find(|profile| {
                profile.provider == provider && profile.status == "ready" && profile.is_default
            })
        })
        .or_else(|| {
            profiles
                .iter()
                .find(|profile| profile.provider == provider && profile.status == "ready")
        })
        .or_else(|| {
            profiles
                .iter()
                .find(|profile| profile.provider == provider && profile.is_default)
        })
        .or_else(|| profiles.iter().find(|profile| profile.provider == provider))
}

fn validate_auth_type(provider: &str, auth_type: &str) -> Result<(), String> {
    let valid = match provider {
        "codex" => matches!(auth_type, "codex_chatgpt_session" | "codex_api_key"),
        "claude" => matches!(
            auth_type,
            "claude_oauth"
                | "claude_api_key"
                | "claude_bedrock"
                | "claude_vertex"
                | "claude_azure_foundry"
        ),
        "opencode" => auth_type == "opencode_auth",
        _ => false,
    };
    if valid {
        Ok(())
    } else {
        Err(format!(
            "auth type {} is not supported for provider {}",
            auth_type, provider
        ))
    }
}

fn is_secretish_key(key: &str) -> bool {
    let normalized = key.to_ascii_lowercase();
    normalized.contains("secret")
        || normalized.contains("token")
        || normalized.contains("password")
        || normalized.contains("credential")
        || normalized.contains("auth_json")
        || normalized == "api_key"
        || normalized.ends_with("_api_key")
}

fn sanitize_config(value: JsonValue) -> JsonValue {
    match value {
        JsonValue::Object(object) => JsonValue::Object(
            object
                .into_iter()
                .filter_map(|(key, value)| {
                    if is_secretish_key(&key) {
                        None
                    } else {
                        Some((key, sanitize_config(value)))
                    }
                })
                .collect(),
        ),
        JsonValue::Array(values) => {
            JsonValue::Array(values.into_iter().map(sanitize_config).collect())
        }
        other => other,
    }
}

fn ensure_no_duplicate_managed_secret(
    db: &TelemetryDb,
    vault: &dyn CredentialVault,
    profile_id: &str,
    provider: &str,
    auth_type: &str,
    secret: &str,
) -> Result<(), String> {
    let profiles = db.list_login_profiles()?;
    for profile in profiles {
        if profile.id == profile_id
            || profile.provider != provider
            || profile.auth_type != auth_type
            || profile.auth_type == "external_cli"
        {
            continue;
        }
        let account = secret_account_id(&profile.id, "primary");
        let Ok(existing_secret) = vault.get_secret(&account) else {
            continue;
        };
        if existing_secret.trim() == secret.trim() {
            return Err(format!(
                "a matching {} login profile already exists: {}",
                provider, profile.display_name
            ));
        }
    }
    Ok(())
}

pub fn upsert_login_profile_with_vault(
    db: &TelemetryDb,
    vault: &dyn CredentialVault,
    request: UpsertLoginProfileRequest,
) -> Result<LoginProfile, String> {
    let provider = request.provider.trim().to_ascii_lowercase();
    let auth_type = request.auth_type.trim().to_ascii_lowercase();
    if !is_supported_provider(&provider) {
        return Err(format!("unsupported login provider: {}", request.provider));
    }
    validate_auth_type(&provider, &auth_type)?;

    let profile_id = request
        .id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    let display_name = request.display_name.trim();
    if display_name.is_empty() {
        return Err("display name is required".to_string());
    }
    let existing = db.get_login_profile(&profile_id).ok();

    let now = unix_timestamp();
    let mut secret_ref = None;
    let mut redacted_hint = None;
    let mut secret_was_updated = false;
    let secret = request
        .secret
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let allows_deferred_secret = (provider == "codex" && auth_type == "codex_chatgpt_session")
        || (provider == "claude" && auth_type == "claude_oauth");
    if existing.is_none() && !allows_deferred_secret && secret.is_none() {
        return Err("a secret is required for managed login profiles".to_string());
    }
    if let Some(secret) = secret {
        if provider == "opencode" {
            let auth: JsonValue = serde_json::from_str(secret).map_err(|error| {
                format!("OpenCode auth must be valid auth.json content: {}", error)
            })?;
            if !auth.is_object() {
                return Err("OpenCode auth.json must contain a JSON object.".to_string());
            }
        }
        ensure_no_duplicate_managed_secret(db, vault, &profile_id, &provider, &auth_type, secret)?;
        let account = secret_account_id(&profile_id, "primary");
        vault.set_secret(&account, secret)?;
        secret_ref = Some(account);
        redacted_hint = Some(if provider == "opencode" {
            "Managed OpenCode credentials".to_string()
        } else {
            redacted_secret_hint(secret)
        });
        secret_was_updated = true;
    }

    let mut config = sanitize_config(request.config.unwrap_or_else(|| serde_json::json!({})));
    if secret_was_updated && provider == "opencode" {
        if let Some(object) = config.as_object_mut() {
            object.remove(OPENCODE_PROVIDER_CAPABILITIES_CONFIG_KEY);
        }
    }

    let profile = LoginProfile {
        id: profile_id,
        provider,
        display_name: display_name.to_string(),
        auth_type,
        redacted_hint: redacted_hint.or_else(|| {
            existing
                .as_ref()
                .and_then(|profile| profile.redacted_hint.clone())
        }),
        config,
        status: if secret_was_updated {
            "unchecked".to_string()
        } else {
            existing
                .as_ref()
                .map(|profile| profile.status.clone())
                .unwrap_or_else(|| "unchecked".to_string())
        },
        status_message: if secret_was_updated {
            None
        } else {
            existing
                .as_ref()
                .and_then(|profile| profile.status_message.clone())
        },
        plan_type: existing
            .as_ref()
            .and_then(|profile| profile.plan_type.clone()),
        is_default: request.make_default.unwrap_or_else(|| {
            existing
                .as_ref()
                .map(|profile| profile.is_default)
                .unwrap_or(true)
        }),
        created_at: existing
            .as_ref()
            .map(|profile| profile.created_at)
            .unwrap_or(now),
        updated_at: now,
        last_checked_at: if secret_was_updated {
            None
        } else {
            existing
                .as_ref()
                .and_then(|profile| profile.last_checked_at)
        },
    };

    db.upsert_login_profile_metadata(&profile, secret_ref.as_deref())
}

pub fn delete_login_profile_with_vault(
    db: &TelemetryDb,
    vault: &dyn CredentialVault,
    profile_id: &str,
) -> Result<(), String> {
    if let Ok(mut pending_logins) = pending_claude_oauth_logins().lock() {
        if let Some(mut pending) = pending_logins.remove(profile_id) {
            let _ = pending.child.kill();
            let _ = pending.child.wait();
        }
    }
    let deleted_metadata = db.delete_login_profile_metadata(profile_id)?;
    if let Err(delete_error) = vault.delete_secret(&secret_account_id(profile_id, "primary")) {
        if let Some(metadata) = deleted_metadata.as_ref() {
            db.restore_login_profile_metadata(metadata)
                .map_err(|restore_error| {
                    format!(
                        "{}; also failed to restore login profile after credential deletion failed: {}",
                        delete_error, restore_error
                    )
                })?;
        }
        return Err(delete_error);
    }
    Ok(())
}

pub fn resolve_runtime_credentials(
    db: &TelemetryDb,
    vault: &dyn CredentialVault,
    profile_id: &str,
    app_cache_dir: PathBuf,
) -> Result<MaterializedRuntimeCredentials, String> {
    let profile = db.get_login_profile(profile_id)?;
    let secret = vault.get_secret(&secret_account_id(profile_id, "primary"))?;
    materialize_runtime_credentials(profile, &secret, app_cache_dir)
}

pub(crate) fn resolve_runtime_credentials_for_launch(
    app: &tauri::AppHandle,
    db: &TelemetryDb,
    profile_id: &str,
    app_cache_dir: PathBuf,
) -> Result<MaterializedRuntimeCredentials, String> {
    resolve_runtime_credentials(db, &KeyringCredentialVault, profile_id, app_cache_dir).map_err(
        |error| {
            if status_from_live_check_error(&error) == "auth_missing" {
                let _ = mark_login_profile_auth_missing(app, db, profile_id, &error);
            }
            error
        },
    )
}

pub fn materialize_runtime_credentials(
    profile: LoginProfile,
    secret: &str,
    app_cache_dir: PathBuf,
) -> Result<MaterializedRuntimeCredentials, String> {
    let mut env = HashMap::new();
    match profile.auth_type.as_str() {
        "codex_api_key" => {
            env.insert("OPENAI_API_KEY".to_string(), secret.to_string());
            copy_optional_string(&profile.config, "openai_org_id", &mut env, "OPENAI_ORG_ID");
            copy_optional_string(
                &profile.config,
                "openai_project_id",
                &mut env,
                "OPENAI_PROJECT_ID",
            );
            materialized(profile, env, None)
        }
        "codex_chatgpt_session" => materialize_codex_home(profile, secret, app_cache_dir, env),
        "claude_oauth" => materialize_claude_oauth(profile, secret, env),
        "claude_api_key" => {
            env.insert("ANTHROPIC_API_KEY".to_string(), secret.to_string());
            copy_optional_string(
                &profile.config,
                "anthropic_base_url",
                &mut env,
                "ANTHROPIC_BASE_URL",
            );
            materialized(profile, env, None)
        }
        "claude_bedrock" => materialize_claude_bedrock(profile, secret, env),
        "claude_vertex" => materialize_claude_vertex(profile, secret, env),
        "claude_azure_foundry" => materialize_claude_azure_foundry(profile, secret, env),
        "opencode_auth" => materialize_opencode_auth(profile, secret, app_cache_dir, env),
        "external_cli" => Err("external CLI login profiles cannot be materialized".to_string()),
        other => Err(format!("unsupported login profile auth type: {}", other)),
    }
}

fn materialized(
    profile: LoginProfile,
    env: HashMap<String, String>,
    codex_home: Option<PathBuf>,
) -> Result<MaterializedRuntimeCredentials, String> {
    Ok(MaterializedRuntimeCredentials {
        profile_id: profile.id,
        provider: profile.provider,
        auth_type: profile.auth_type,
        env,
        codex_home,
        opencode_auth_path: None,
    })
}

fn materialize_opencode_auth(
    profile: LoginProfile,
    secret: &str,
    app_cache_dir: PathBuf,
    mut env: HashMap<String, String>,
) -> Result<MaterializedRuntimeCredentials, String> {
    let auth: JsonValue = serde_json::from_str(secret)
        .map_err(|error| format!("OpenCode auth must be valid auth.json content: {}", error))?;
    if !auth.is_object() {
        return Err("OpenCode auth.json must contain a JSON object.".to_string());
    }

    let root = app_cache_dir
        .join("login-profiles")
        .join(&profile.id)
        .join("opencode");
    let data_home = root.join("data");
    let config_home = root.join("config");
    let state_home = root.join("state");
    let cache_home = root.join("cache");
    let auth_path = data_home.join("opencode").join("auth.json");
    for directory in [&data_home, &config_home, &state_home, &cache_home] {
        fs::create_dir_all(directory).map_err(|error| {
            format!(
                "failed to create OpenCode profile directory {}: {}",
                directory.display(),
                error
            )
        })?;
    }
    sync_global_opencode_config(&config_home)?;
    fs::create_dir_all(auth_path.parent().expect("auth path has parent"))
        .map_err(|error| format!("failed to create OpenCode auth directory: {}", error))?;
    if !auth_path.exists() {
        write_restricted_file(&auth_path, secret)?;
    }
    env.insert(
        "XDG_DATA_HOME".to_string(),
        data_home.to_string_lossy().into_owned(),
    );
    env.insert(
        "XDG_CONFIG_HOME".to_string(),
        config_home.to_string_lossy().into_owned(),
    );
    env.insert(
        "XDG_STATE_HOME".to_string(),
        state_home.to_string_lossy().into_owned(),
    );
    env.insert(
        "XDG_CACHE_HOME".to_string(),
        cache_home.to_string_lossy().into_owned(),
    );
    env.insert(
        "OPENCODE_DISABLE_AUTOUPDATE".to_string(),
        "true".to_string(),
    );
    let mut result = materialized(profile, env, None)?;
    result.opencode_auth_path = Some(auth_path);
    Ok(result)
}

fn global_opencode_config_dir() -> Option<PathBuf> {
    std::env::var_os("XDG_CONFIG_HOME")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|home| home.join(".config")))
        .map(|root| root.join("opencode"))
}

fn sync_global_opencode_config(managed_config_home: &Path) -> Result<(), String> {
    let source = global_opencode_config_dir();
    sync_opencode_config_dir(source.as_deref(), managed_config_home)
}

fn sync_opencode_config_dir(
    source: Option<&Path>,
    managed_config_home: &Path,
) -> Result<(), String> {
    let destination = managed_config_home.join("opencode");
    let Some(source) = source else {
        return remove_path_if_exists(&destination);
    };
    if same_path(&source, &destination) {
        return Ok(());
    }
    if source.is_dir() {
        replace_path(&source, &destination)
    } else {
        remove_path_if_exists(&destination)
    }
}

fn replace_cached_opencode_auth(
    app_cache_dir: &Path,
    profile_id: &str,
    secret: &str,
) -> Result<(), String> {
    let auth: JsonValue = serde_json::from_str(secret)
        .map_err(|error| format!("OpenCode auth must be valid auth.json content: {}", error))?;
    if !auth.is_object() {
        return Err("OpenCode auth.json must contain a JSON object.".to_string());
    }
    let auth_path = app_cache_dir
        .join("login-profiles")
        .join(profile_id)
        .join("opencode")
        .join("data")
        .join("opencode")
        .join("auth.json");
    fs::create_dir_all(auth_path.parent().expect("auth path has parent"))
        .map_err(|error| format!("failed to create OpenCode auth directory: {}", error))?;
    write_restricted_file(&auth_path, secret)
}

fn refresh_opencode_auth_cache(
    app: &tauri::AppHandle,
    vault: &dyn CredentialVault,
    profile: &LoginProfile,
) -> Result<(), String> {
    if profile.provider != "opencode" || profile.auth_type != "opencode_auth" {
        return Ok(());
    }
    let cache_dir = app
        .path()
        .app_cache_dir()
        .map_err(|error| format!("Could not resolve app cache dir: {}", error))?;
    let secret = vault.get_secret(&secret_account_id(&profile.id, "primary"))?;
    replace_cached_opencode_auth(&cache_dir, &profile.id, &secret)
}

pub fn persist_opencode_auth_state(
    db: &TelemetryDb,
    vault: &dyn CredentialVault,
    profile_id: &str,
    auth_path: &Path,
) -> Result<(), String> {
    let mut profile = db.get_login_profile(profile_id)?;
    if profile.provider != "opencode" || profile.auth_type != "opencode_auth" {
        return Ok(());
    }
    let auth_json = fs::read_to_string(auth_path).map_err(|error| {
        format!(
            "failed to read OpenCode auth state {}: {}",
            auth_path.display(),
            error
        )
    })?;
    let parsed: JsonValue = serde_json::from_str(&auth_json)
        .map_err(|error| format!("OpenCode auth state is invalid JSON: {}", error))?;
    if !parsed.is_object() {
        return Err("OpenCode auth state must contain a JSON object.".to_string());
    }
    let account = secret_account_id(profile_id, "primary");
    vault.set_secret(&account, auth_json.trim())?;
    profile.redacted_hint = Some("Managed OpenCode credentials".to_string());
    profile.updated_at = unix_timestamp();
    db.upsert_login_profile_metadata(&profile, Some(&account))?;
    Ok(())
}

fn merge_opencode_provider_capabilities(config: &mut JsonValue, capabilities: &JsonValue) {
    let Some(incoming) = capabilities.as_array() else {
        return;
    };
    if !config.is_object() {
        *config = serde_json::json!({});
    }
    let stored = config
        .as_object_mut()
        .expect("OpenCode profile config is an object")
        .entry(OPENCODE_PROVIDER_CAPABILITIES_CONFIG_KEY)
        .or_insert_with(|| serde_json::json!({}));
    if !stored.is_object() {
        *stored = serde_json::json!({});
    }
    let stored = stored
        .as_object_mut()
        .expect("OpenCode provider capabilities are an object");
    for capability in incoming {
        let Some(provider_id) = capability
            .get("providerId")
            .and_then(JsonValue::as_str)
            .map(str::trim)
            .filter(|provider_id| !provider_id.is_empty())
        else {
            continue;
        };
        let entry = stored
            .entry(provider_id.to_string())
            .or_insert_with(|| serde_json::json!({}));
        if !entry.is_object() {
            *entry = serde_json::json!({});
        }
        let entry = entry
            .as_object_mut()
            .expect("OpenCode provider capability is an object");
        if !entry.contains_key("authStatus") {
            if let Some(legacy) = entry.get("credentials").cloned() {
                entry.insert("authStatus".to_string(), legacy);
            }
        }
        for (incoming_field, stored_field) in [
            ("credentials", "authStatus"),
            ("pricedModelAccess", "pricedModelAccess"),
        ] {
            let Some(value) = capability.get(incoming_field).and_then(JsonValue::as_str) else {
                continue;
            };
            if value != "unknown" {
                entry.insert(
                    stored_field.to_string(),
                    JsonValue::String(value.to_string()),
                );
            }
        }
        entry.remove("credentials");
        for field in [
            "providerName",
            "checkedAt",
            "method",
            "probeModel",
            "modelCount",
            "freeModelCount",
        ] {
            if let Some(value) = capability.get(field) {
                entry.insert(field.to_string(), value.clone());
            }
        }
    }
}

fn persist_opencode_provider_capabilities(
    db: &TelemetryDb,
    profile_id: &str,
    capabilities: &JsonValue,
) -> Result<LoginProfile, String> {
    let mut profile = db.get_login_profile(profile_id)?;
    if profile.provider != "opencode" {
        return Ok(profile);
    }
    merge_opencode_provider_capabilities(&mut profile.config, capabilities);
    profile.updated_at = unix_timestamp();
    db.upsert_login_profile_metadata(&profile, None)
}

fn merge_opencode_model_catalog(config: &mut JsonValue, catalog: &JsonValue, checked_at: i64) {
    if !catalog.is_array() {
        return;
    }
    if !config.is_object() {
        *config = serde_json::json!({});
    }
    let config = config
        .as_object_mut()
        .expect("OpenCode profile config is an object");
    config.insert(
        OPENCODE_MODEL_CATALOG_CONFIG_KEY.to_string(),
        catalog.clone(),
    );
    config.insert(
        OPENCODE_MODEL_CATALOG_CHECKED_AT_CONFIG_KEY.to_string(),
        JsonValue::from(checked_at),
    );
}

pub(crate) fn persist_opencode_model_catalog(
    db: &TelemetryDb,
    profile_id: &str,
    catalog: &JsonValue,
) -> Result<LoginProfile, String> {
    if !catalog.is_array() {
        return Err("OpenCode model catalog must contain an array.".to_string());
    }
    let mut profile = db.get_login_profile(profile_id)?;
    if profile.provider != "opencode" {
        return Err(format!(
            "Login profile {} is for {}, not opencode",
            profile_id, profile.provider
        ));
    }
    let now = unix_timestamp();
    merge_opencode_model_catalog(&mut profile.config, catalog, now);
    profile.updated_at = now;
    let updated = db.upsert_login_profile_metadata(&profile, None)?;
    if catalog.is_array() {
        let _ = crate::runtime_model_catalog::cache_opencode_accessible_catalog(
            db, profile_id, catalog,
        );
    }
    Ok(updated)
}

const CLAUDE_TOKEN_PREFIX: &str = "sk-ant-";
const CLAUDE_SETUP_TOKEN_PREFIXES: [&str; 2] = ["sk-ant-oat", "sk-ant-at"];

fn is_claude_token_char(ch: char) -> bool {
    ch.is_ascii_alphanumeric() || ch == '-' || ch == '_'
}

fn is_recognized_claude_setup_token(token: &str) -> bool {
    let has_versioned_setup_prefix = CLAUDE_SETUP_TOKEN_PREFIXES.iter().any(|prefix| {
        token.strip_prefix(prefix).is_some_and(|suffix| {
            let bytes = suffix.as_bytes();
            bytes.len() >= 3
                && bytes[0].is_ascii_digit()
                && bytes[1].is_ascii_digit()
                && bytes[2] == b'-'
        })
    });
    token.len() >= 40 && has_versioned_setup_prefix && token.chars().all(is_claude_token_char)
}

fn redact_claude_tokens(raw: &str) -> String {
    let mut redacted = String::with_capacity(raw.len());
    let mut remaining = raw;
    while let Some(found) = remaining.find(CLAUDE_TOKEN_PREFIX) {
        redacted.push_str(&remaining[..found]);
        let candidate_start = &remaining[found..];
        let candidate: String = candidate_start
            .chars()
            .take_while(|ch| is_claude_token_char(*ch))
            .collect();
        redacted.push_str("[REDACTED_CLAUDE_TOKEN]");
        remaining = &candidate_start[candidate.len()..];
    }
    redacted.push_str(remaining);
    redacted
}

fn scrub_claude_auth_env(command: &mut Command) {
    command.env("PATH", crate::cli_path::build_tool_path());
    for key in [
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_AUTH_TOKEN",
        "ANTHROPIC_BASE_URL",
        "ANTHROPIC_MODEL",
        "ANTHROPIC_DEFAULT_HAIKU_MODEL",
        "ANTHROPIC_DEFAULT_OPUS_MODEL",
        "ANTHROPIC_DEFAULT_SONNET_MODEL",
        "CLAUDE_CODE_OAUTH_TOKEN",
        "CLAUDE_CONFIG_DIR",
    ] {
        command.env_remove(key);
    }
}

// The user decides where to open the sign-in URL, so the CLI's built-in
// browser auto-open is suppressed with no-op `xdg-open`/`open` shims placed
// first on PATH.
fn browser_suppression_tool_path(app_cache_dir: &Path) -> Result<String, String> {
    let shim_dir = app_cache_dir.join("login-shims");
    fs::create_dir_all(&shim_dir)
        .map_err(|error| format!("failed to create login shim directory: {}", error))?;
    for name in ["xdg-open", "open"] {
        let shim_path = shim_dir.join(name);
        fs::write(&shim_path, "#!/bin/sh\nexit 0\n")
            .map_err(|error| format!("failed to write {} shim: {}", name, error))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&shim_path, fs::Permissions::from_mode(0o755))
                .map_err(|error| format!("failed to mark {} shim executable: {}", name, error))?;
        }
    }
    Ok(format!(
        "{}:{}",
        shim_dir.display(),
        crate::cli_path::build_tool_path()
    ))
}

// `claude setup-token` only renders through a TTY, so wrap it in `script` to
// allocate a pseudo terminal. The wide `stty` size keeps the login URL and the
// minted token on single unwrapped lines so they can be parsed from the output.
fn claude_setup_token_command(
    claude_binary: &str,
    app_cache_dir: &Path,
) -> Result<Command, String> {
    let script_binary = crate::cli_path::find_on_tool_path("script").ok_or_else(|| {
        "the `script` command is missing; Claude login needs it to allocate a terminal. \
         Install it (Fedora: `sudo dnf install util-linux-script`, Debian/Ubuntu: part of \
         `bsdutils`/`util-linux`) and retry."
            .to_string()
    })?;
    let shell_command =
        "stty cols 400 rows 60 2>/dev/null; exec \"$AGENTREE_CLAUDE_BIN\" setup-token";
    let mut command = if cfg!(target_os = "macos") {
        let mut command = Command::new(&script_binary);
        command
            .arg("-q")
            .arg("/dev/null")
            .arg("sh")
            .arg("-c")
            .arg(shell_command);
        command
    } else {
        let mut command = Command::new(&script_binary);
        command.arg("-qefc").arg(shell_command).arg("/dev/null");
        command
    };
    command.env("AGENTREE_CLAUDE_BIN", claude_binary);
    scrub_claude_auth_env(&mut command);
    command.env("PATH", browser_suppression_tool_path(app_cache_dir)?);
    Ok(command)
}

fn find_claude_login_failure_line(cleaned_output: &str) -> Option<String> {
    cleaned_output.lines().map(str::trim).find_map(|line| {
        let lower = line.to_ascii_lowercase();
        let is_failure = lower.contains("oauth error")
            || lower.contains("invalid")
            || lower.contains("expired")
            || lower.contains("mismatch")
            || lower.contains("failed");
        if is_failure {
            Some(redact_claude_tokens(line))
        } else {
            None
        }
    })
}

fn collect_command_output<R>(stream: R, buffer: Arc<Mutex<String>>)
where
    R: std::io::Read + Send + 'static,
{
    thread::spawn(move || {
        let mut stream = stream;
        let mut chunk = [0u8; 4096];
        loop {
            match stream.read(&mut chunk) {
                Ok(0) | Err(_) => break,
                Ok(read) => {
                    if let Ok(mut buffer) = buffer.lock() {
                        buffer.push_str(&String::from_utf8_lossy(&chunk[..read]));
                    }
                }
            }
        }
    });
}

fn extract_claude_login_url(raw_output: &str) -> Option<String> {
    let mut best: Option<String> = None;
    let mut search_from = 0;
    while let Some(found) = raw_output[search_from..].find("https://") {
        let start = search_from + found;
        search_from = start + "https://".len();
        let mut candidate: String = raw_output[start..]
            .chars()
            .take_while(|ch| !ch.is_whitespace() && !ch.is_control() && *ch != '"' && *ch != '\'')
            .collect();
        // OSC 8 hyperlinks repeat the link target as display text with no
        // separator; keep only the first copy.
        if let Some(duplicate) = candidate["https://".len()..].find("https://") {
            candidate.truncate("https://".len() + duplicate);
        }
        let is_claude_host = candidate.starts_with("https://claude.com/")
            || candidate.starts_with("https://www.claude.com/")
            || candidate.starts_with("https://claude.ai/");
        if is_claude_host && candidate.contains("oauth") {
            // Hard-wrapped display copies are truncated at the line break, so
            // the longest candidate is the complete unwrapped URL.
            if best
                .as_ref()
                .map(|url| candidate.len() > url.len())
                .unwrap_or(true)
            {
                best = Some(candidate);
            }
        }
    }
    best
}

fn extract_claude_setup_token(raw_output: &str) -> Option<String> {
    let cleaned = strip_ansi(raw_output);
    let mut search_from = 0;
    while let Some(found) = cleaned[search_from..].find(CLAUDE_TOKEN_PREFIX) {
        let start = search_from + found;
        let token: String = cleaned[start..]
            .chars()
            .take_while(|ch| is_claude_token_char(*ch))
            .collect();
        if is_recognized_claude_setup_token(&token) {
            return Some(token);
        }
        search_from = start + CLAUDE_TOKEN_PREFIX.len();
    }
    None
}

fn materialize_claude_oauth(
    profile: LoginProfile,
    secret: &str,
    mut env: HashMap<String, String>,
) -> Result<MaterializedRuntimeCredentials, String> {
    let token = secret.trim();
    if token.is_empty() {
        return Err(
            "Claude login profile has no stored token. Reconnect this profile.".to_string(),
        );
    }
    if !is_recognized_claude_setup_token(token) {
        return Err(
            "This Claude profile was connected with an older login flow. Reconnect it to mint a long-lived token."
                .to_string(),
        );
    }
    env.insert("CLAUDE_CODE_OAUTH_TOKEN".to_string(), token.to_string());
    materialized(profile, env, None)
}

pub fn persist_claude_oauth_token(
    db: &TelemetryDb,
    vault: &dyn CredentialVault,
    profile_id: &str,
    token: &str,
) -> Result<(), String> {
    let mut profile = db.get_login_profile(profile_id)?;
    if profile.provider != "claude" || profile.auth_type != "claude_oauth" {
        return Ok(());
    }
    let trimmed = token.trim();
    if trimmed.is_empty() {
        return Err("Claude setup token is empty.".to_string());
    }
    if !is_recognized_claude_setup_token(trimmed) {
        return Err("The supplied credential is not a recognized Claude setup token.".to_string());
    }
    let account = secret_account_id(profile_id, "primary");
    vault.set_secret(&account, trimmed)?;
    profile.redacted_hint = Some(redacted_secret_hint(trimmed));
    profile.updated_at = unix_timestamp();
    db.upsert_login_profile_metadata(&profile, Some(&account))?;
    Ok(())
}

fn materialize_codex_home(
    profile: LoginProfile,
    secret: &str,
    app_cache_dir: PathBuf,
    mut env: HashMap<String, String>,
) -> Result<MaterializedRuntimeCredentials, String> {
    let codex_home = prepare_codex_profile_home(&app_cache_dir, &profile.id)?;
    let auth_json = codex_home.join("auth.json");
    if !auth_json.exists() {
        write_restricted_file(&auth_json, secret)?;
    }
    env.insert(
        "CODEX_HOME".to_string(),
        codex_home.to_string_lossy().into_owned(),
    );
    materialized(profile, env, Some(codex_home))
}

fn prepare_codex_profile_home(app_cache_dir: &Path, profile_id: &str) -> Result<PathBuf, String> {
    let codex_home = codex_profile_home(app_cache_dir, profile_id);
    let user_codex_home = user_codex_home(&codex_home);
    prepare_codex_profile_home_with_instructions(
        app_cache_dir,
        profile_id,
        user_codex_home.as_deref(),
    )
}

fn prepare_codex_profile_home_with_instructions(
    app_cache_dir: &Path,
    profile_id: &str,
    user_codex_home: Option<&Path>,
) -> Result<PathBuf, String> {
    let _sync_guard = CODEX_PROFILE_SYNC_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|error| format!("failed to lock Codex profile sync: {}", error))?;
    let codex_home = codex_profile_home(app_cache_dir, profile_id);
    fs::create_dir_all(&codex_home)
        .map_err(|error| format!("failed to create profile CODEX_HOME: {}", error))?;
    sync_global_codex_config(user_codex_home, &codex_home)?;
    if let Some(user_codex_home) = user_codex_home {
        sync_global_codex_instructions(user_codex_home, &codex_home)?;
        sync_global_codex_skills(user_codex_home, &codex_home)?;
    }
    Ok(codex_home)
}

fn user_codex_home(managed_codex_home: &Path) -> Option<PathBuf> {
    let env_codex_home = std::env::var("CODEX_HOME")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .map(PathBuf::from);
    if let Some(env_codex_home) = env_codex_home {
        if !same_path(&env_codex_home, managed_codex_home) {
            return Some(env_codex_home);
        }
    }
    dirs::home_dir()
        .map(|home| home.join(".codex"))
        .filter(|path| !same_path(path, managed_codex_home))
}

fn sync_global_codex_instructions(
    user_codex_home: &Path,
    managed_codex_home: &Path,
) -> Result<(), String> {
    if user_codex_home == managed_codex_home
        || matches!(
            (
                fs::canonicalize(user_codex_home),
                fs::canonicalize(managed_codex_home)
            ),
            (Ok(user_home), Ok(managed_home)) if user_home == managed_home
        )
    {
        return Ok(());
    }

    for filename in CODEX_GLOBAL_INSTRUCTION_FILES {
        let source = user_codex_home.join(filename);
        let destination = managed_codex_home.join(filename);
        match fs::read_to_string(&source) {
            Ok(contents) => write_restricted_file(&destination, &contents)?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                match fs::remove_file(&destination) {
                    Ok(()) => {}
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                    Err(error) => {
                        return Err(format!(
                            "failed to remove stale {}: {}",
                            destination.display(),
                            error
                        ));
                    }
                }
            }
            Err(error) => {
                return Err(format!(
                    "failed to read global Codex instructions {}: {}",
                    source.display(),
                    error
                ));
            }
        }
    }
    Ok(())
}

fn sync_global_codex_config(
    user_codex_home: Option<&Path>,
    managed_codex_home: &Path,
) -> Result<(), String> {
    let config = match user_codex_home
        .filter(|path| !same_path(path, managed_codex_home))
        .map(|path| path.join("config.toml"))
    {
        Some(source) => match fs::read_to_string(&source) {
            Ok(contents) => codex_config_with_file_auth(&contents),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                format!("{}\n", CODEX_AUTH_CONFIG_LINE)
            }
            Err(error) => {
                return Err(format!(
                    "failed to read global Codex config {}: {}",
                    source.display(),
                    error
                ));
            }
        },
        None => format!("{}\n", CODEX_AUTH_CONFIG_LINE),
    };

    write_restricted_file(&managed_codex_home.join("config.toml"), &config)
}

fn codex_config_with_file_auth(contents: &str) -> String {
    let mut retained_lines = Vec::new();
    let mut in_top_level = true;

    for line in contents.lines() {
        let trimmed_start = line.trim_start();
        if trimmed_start.starts_with('[') {
            in_top_level = false;
        }
        let is_auth_store_line = in_top_level
            && trimmed_start
                .strip_prefix("cli_auth_credentials_store")
                .is_some_and(|rest| rest.trim_start().starts_with('='));
        if !is_auth_store_line {
            retained_lines.push(line);
        }
    }

    let mut merged = format!("{}\n", CODEX_AUTH_CONFIG_LINE);
    if !retained_lines.is_empty() {
        merged.push('\n');
        merged.push_str(&retained_lines.join("\n"));
        merged.push('\n');
    }
    merged
}

fn sync_global_codex_skills(
    user_codex_home: &Path,
    managed_codex_home: &Path,
) -> Result<(), String> {
    if same_path(user_codex_home, managed_codex_home) {
        return Ok(());
    }

    let source_skills = user_codex_home.join("skills");
    if !source_skills.is_dir() {
        return Ok(());
    }

    let managed_skills = managed_codex_home.join("skills");
    fs::create_dir_all(&managed_skills).map_err(|error| {
        format!(
            "failed to create managed Codex skills folder {}: {}",
            managed_skills.display(),
            error
        )
    })?;

    let source_entries: Vec<_> = fs::read_dir(&source_skills)
        .map_err(|error| {
            format!(
                "failed to read global Codex skills folder {}: {}",
                source_skills.display(),
                error
            )
        })?
        .map(|entry| {
            entry
                .map(|entry| (entry.file_name(), entry.path()))
                .map_err(|error| {
                    format!(
                        "failed to read global Codex skills folder entry {}: {}",
                        source_skills.display(),
                        error
                    )
                })
        })
        .collect::<Result<_, _>>()?;

    for entry in fs::read_dir(&managed_skills).map_err(|error| {
        format!(
            "failed to read managed Codex skills folder {}: {}",
            managed_skills.display(),
            error
        )
    })? {
        let entry = entry.map_err(|error| {
            format!(
                "failed to read managed Codex skills folder entry {}: {}",
                managed_skills.display(),
                error
            )
        })?;
        let name = entry.file_name();
        if name.to_string_lossy() == ".system" {
            continue;
        }
        if !source_entries
            .iter()
            .any(|(source_name, _)| source_name == &name)
        {
            remove_path_if_exists(&entry.path())?;
        }
    }

    for (name, source) in source_entries {
        if name.to_string_lossy() == ".system" {
            continue;
        }
        let destination = managed_skills.join(&name);
        replace_path(&source, &destination)?;
    }

    Ok(())
}

fn replace_path(source: &Path, destination: &Path) -> Result<(), String> {
    remove_path_if_exists(destination)?;
    copy_path(source, destination)
}

fn remove_path_if_exists(path: &Path) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {
            fs::remove_dir_all(path)
        }
        Ok(_) => fs::remove_file(path),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => Err(error),
    }
    .map_err(|error| format!("failed to remove stale {}: {}", path.display(), error))
}

fn copy_path(source: &Path, destination: &Path) -> Result<(), String> {
    let metadata = fs::symlink_metadata(source)
        .map_err(|error| format!("failed to inspect {}: {}", source.display(), error))?;
    if metadata.file_type().is_symlink() {
        return copy_symlink(source, destination);
    }
    if metadata.is_dir() {
        fs::create_dir_all(destination)
            .map_err(|error| format!("failed to create {}: {}", destination.display(), error))?;
        for entry in fs::read_dir(source)
            .map_err(|error| format!("failed to read {}: {}", source.display(), error))?
        {
            let entry = entry.map_err(|error| {
                format!(
                    "failed to read folder entry under {}: {}",
                    source.display(),
                    error
                )
            })?;
            copy_path(&entry.path(), &destination.join(entry.file_name()))?;
        }
        return Ok(());
    }
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("failed to create {}: {}", parent.display(), error))?;
    }
    fs::copy(source, destination).map_err(|error| {
        format!(
            "failed to copy {} to {}: {}",
            source.display(),
            destination.display(),
            error
        )
    })?;
    Ok(())
}

#[cfg(unix)]
fn copy_symlink(source: &Path, destination: &Path) -> Result<(), String> {
    use std::os::unix::fs::symlink;

    let target = fs::read_link(source)
        .map_err(|error| format!("failed to read symlink {}: {}", source.display(), error))?;
    symlink(&target, destination).map_err(|error| {
        format!(
            "failed to copy symlink {} to {}: {}",
            source.display(),
            destination.display(),
            error
        )
    })
}

#[cfg(windows)]
fn copy_symlink(source: &Path, destination: &Path) -> Result<(), String> {
    let target = fs::read_link(source)
        .map_err(|error| format!("failed to read symlink {}: {}", source.display(), error))?;
    if target.is_dir() {
        std::os::windows::fs::symlink_dir(&target, destination)
    } else {
        std::os::windows::fs::symlink_file(&target, destination)
    }
    .map_err(|error| {
        format!(
            "failed to copy symlink {} to {}: {}",
            source.display(),
            destination.display(),
            error
        )
    })
}

fn same_path(left: &Path, right: &Path) -> bool {
    left == right
        || matches!(
            (fs::canonicalize(left), fs::canonicalize(right)),
            (Ok(left), Ok(right)) if left == right
        )
}

fn codex_profile_home(app_cache_dir: &Path, profile_id: &str) -> PathBuf {
    app_cache_dir
        .join("login-profiles")
        .join(profile_id)
        .join("codex-home")
}

pub fn persist_codex_auth_state(
    db: &TelemetryDb,
    vault: &dyn CredentialVault,
    profile_id: &str,
    codex_home: &Path,
) -> Result<(), String> {
    let mut profile = db.get_login_profile(profile_id)?;
    if profile.provider != "codex" || profile.auth_type != "codex_chatgpt_session" {
        return Ok(());
    }
    let auth_path = codex_home.join("auth.json");
    let auth_json = fs::read_to_string(&auth_path).map_err(|error| {
        format!(
            "failed to read Codex auth state {}: {}",
            auth_path.display(),
            error
        )
    })?;
    let trimmed = auth_json.trim();
    if trimmed.is_empty() {
        return Err(format!(
            "Codex auth state is empty: {}",
            auth_path.display()
        ));
    }
    let account = secret_account_id(profile_id, "primary");
    vault.set_secret(&account, trimmed)?;
    profile.redacted_hint = Some(redacted_secret_hint(trimmed));
    profile.updated_at = unix_timestamp();
    db.upsert_login_profile_metadata(&profile, Some(&account))?;
    Ok(())
}

fn mark_login_profile_status(
    db: &TelemetryDb,
    profile_id: &str,
    status: &str,
    status_message: Option<String>,
) -> Result<LoginProfile, String> {
    let mut profile = db.get_login_profile(profile_id)?;
    profile.status = status.to_string();
    profile.status_message = status_message;
    profile.last_checked_at = Some(unix_timestamp());
    profile.updated_at = unix_timestamp();
    db.upsert_login_profile_metadata(&profile, None)
}

fn strip_ansi(input: &str) -> String {
    let mut output = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '\u{1b}' {
            match chars.peek() {
                Some('[') => {
                    let _ = chars.next();
                    for next in chars.by_ref() {
                        if next.is_ascii_alphabetic() {
                            break;
                        }
                    }
                }
                // OSC sequences (terminal hyperlinks, window titles) end with
                // BEL or ESC-backslash.
                Some(']') => {
                    let _ = chars.next();
                    while let Some(next) = chars.next() {
                        if next == '\u{7}' {
                            break;
                        }
                        if next == '\u{1b}' {
                            let _ = chars.next();
                            break;
                        }
                    }
                }
                _ => {}
            }
            continue;
        }
        output.push(ch);
    }
    output
}

fn parse_codex_device_code_line(line: &str, expecting_code: &mut bool) -> Option<String> {
    let cleaned = strip_ansi(line);
    let trimmed = cleaned.trim();
    if trimmed.is_empty() {
        return None;
    }
    if *expecting_code {
        *expecting_code = false;
        return Some(trimmed.to_string());
    }
    if trimmed.contains("one-time code") {
        *expecting_code = true;
    }
    None
}

fn pending_claude_oauth_logins() -> &'static Mutex<HashMap<String, PendingClaudeOAuthLogin>> {
    PENDING_CLAUDE_OAUTH_LOGINS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn finish_codex_login_process(
    app: tauri::AppHandle,
    db_path: String,
    profile_id: String,
    codex_home: PathBuf,
    mut child: std::process::Child,
    stdout: std::process::ChildStdout,
    sender: mpsc::Sender<Result<String, String>>,
) {
    let mut expecting_code = false;
    let mut code_sent = false;
    let reader = BufReader::new(stdout);
    for line in reader.lines().map_while(Result::ok) {
        if !code_sent {
            if let Some(code) = parse_codex_device_code_line(&line, &mut expecting_code) {
                code_sent = true;
                crate::app_log!(
                    "[LOGIN_PROFILE] event=codex_login_device_code profile_id={}",
                    profile_id
                );
                let _ = sender.send(Ok(code));
            }
        }
    }
    if !code_sent {
        let _ = sender.send(Err("Codex did not print a device login code.".to_string()));
    }

    let status = child.wait();
    let db_result = Path::new(&db_path)
        .parent()
        .ok_or_else(|| "could not resolve telemetry db directory".to_string())
        .and_then(TelemetryDb::open);
    let Ok(db) = db_result else {
        let message = db_result
            .err()
            .unwrap_or_else(|| "failed to open telemetry db".to_string());
        let _ = app.emit(
            "login-profiles:changed",
            LoginProfilesChangedEvent {
                profile_id,
                status: "error".to_string(),
            },
        );
        crate::app_log!(
            "[LOGIN_PROFILE] event=codex_login_db_open_failed error={}",
            message
        );
        return;
    };

    let vault = KeyringCredentialVault;
    match status {
        Ok(exit_status) if exit_status.success() => {
            crate::app_log!(
                "[LOGIN_PROFILE] event=codex_login_process_completed profile_id={}",
                profile_id
            );
            let result =
                persist_codex_auth_state(&db, &vault, &profile_id, &codex_home).and_then(|_| {
                    mark_login_profile_status(
                        &db,
                        &profile_id,
                        "ready",
                        Some("Codex account connected.".to_string()),
                    )
                    .map(|_| ())
                });
            match result {
                Ok(()) => {
                    crate::app_log!(
                        "[LOGIN_PROFILE] event=codex_login_profile_ready profile_id={}",
                        profile_id
                    );
                    let _ = app.emit(
                        "login-profiles:changed",
                        LoginProfilesChangedEvent {
                            profile_id,
                            status: "ready".to_string(),
                        },
                    );
                }
                Err(error) => {
                    let _ =
                        mark_login_profile_status(&db, &profile_id, "error", Some(error.clone()));
                    let _ = app.emit(
                        "login-profiles:changed",
                        LoginProfilesChangedEvent {
                            profile_id,
                            status: "error".to_string(),
                        },
                    );
                    crate::app_log!(
                        "[LOGIN_PROFILE] event=codex_login_persist_failed error={}",
                        error
                    );
                }
            }
        }
        Ok(exit_status) => {
            crate::app_log!(
                "[LOGIN_PROFILE] event=codex_login_process_failed profile_id={} status={}",
                profile_id,
                exit_status
            );
            let message = format!("Codex login exited with status {}.", exit_status);
            let _ = mark_login_profile_status(&db, &profile_id, "error", Some(message));
            let _ = app.emit(
                "login-profiles:changed",
                LoginProfilesChangedEvent {
                    profile_id,
                    status: "error".to_string(),
                },
            );
        }
        Err(error) => {
            let message = format!("failed to wait for Codex login: {}", error);
            let _ = mark_login_profile_status(&db, &profile_id, "error", Some(message));
            let _ = app.emit(
                "login-profiles:changed",
                LoginProfilesChangedEvent {
                    profile_id,
                    status: "error".to_string(),
                },
            );
        }
    }
}

fn materialize_claude_bedrock(
    profile: LoginProfile,
    secret: &str,
    mut env: HashMap<String, String>,
) -> Result<MaterializedRuntimeCredentials, String> {
    let secret_json = parse_secret_json(secret);
    env.insert("CLAUDE_CODE_USE_BEDROCK".to_string(), "1".to_string());
    env.insert(
        "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST".to_string(),
        "agentree".to_string(),
    );
    copy_optional_string(&profile.config, "aws_region", &mut env, "AWS_REGION");
    copy_optional_string(&profile.config, "aws_profile", &mut env, "AWS_PROFILE");
    copy_optional_string(
        &profile.config,
        "anthropic_bedrock_base_url",
        &mut env,
        "ANTHROPIC_BEDROCK_BASE_URL",
    );
    copy_optional_string(
        &secret_json,
        "aws_access_key_id",
        &mut env,
        "AWS_ACCESS_KEY_ID",
    );
    copy_optional_string(
        &secret_json,
        "aws_secret_access_key",
        &mut env,
        "AWS_SECRET_ACCESS_KEY",
    );
    copy_optional_string(
        &secret_json,
        "aws_session_token",
        &mut env,
        "AWS_SESSION_TOKEN",
    );
    copy_optional_string(
        &secret_json,
        "anthropic_bedrock_base_url",
        &mut env,
        "ANTHROPIC_BEDROCK_BASE_URL",
    );
    copy_optional_bool_as_one(
        &profile.config,
        "skip_bedrock_auth",
        &mut env,
        "CLAUDE_CODE_SKIP_BEDROCK_AUTH",
    );
    materialized(profile, env, None)
}

fn materialize_claude_vertex(
    profile: LoginProfile,
    secret: &str,
    mut env: HashMap<String, String>,
) -> Result<MaterializedRuntimeCredentials, String> {
    let secret_json = parse_secret_json(secret);
    env.insert("CLAUDE_CODE_USE_VERTEX".to_string(), "1".to_string());
    env.insert(
        "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST".to_string(),
        "agentree".to_string(),
    );
    copy_optional_string(
        &profile.config,
        "google_cloud_project",
        &mut env,
        "GOOGLE_CLOUD_PROJECT",
    );
    copy_optional_string(
        &profile.config,
        "google_cloud_location",
        &mut env,
        "GOOGLE_CLOUD_LOCATION",
    );
    copy_optional_string(
        &profile.config,
        "cloud_ml_region",
        &mut env,
        "CLOUD_ML_REGION",
    );
    copy_optional_string(
        &profile.config,
        "anthropic_vertex_base_url",
        &mut env,
        "ANTHROPIC_VERTEX_BASE_URL",
    );
    copy_optional_string(
        &secret_json,
        "google_application_credentials",
        &mut env,
        "GOOGLE_APPLICATION_CREDENTIALS",
    );
    copy_optional_string(
        &secret_json,
        "google_cloud_project",
        &mut env,
        "GOOGLE_CLOUD_PROJECT",
    );
    copy_optional_string(
        &secret_json,
        "google_cloud_location",
        &mut env,
        "GOOGLE_CLOUD_LOCATION",
    );
    copy_optional_string(
        &secret_json,
        "anthropic_vertex_base_url",
        &mut env,
        "ANTHROPIC_VERTEX_BASE_URL",
    );
    copy_optional_bool_as_one(
        &profile.config,
        "skip_vertex_auth",
        &mut env,
        "CLAUDE_CODE_SKIP_VERTEX_AUTH",
    );
    materialized(profile, env, None)
}

fn materialize_claude_azure_foundry(
    profile: LoginProfile,
    secret: &str,
    mut env: HashMap<String, String>,
) -> Result<MaterializedRuntimeCredentials, String> {
    let secret_json = parse_secret_json(secret);
    env.insert("CLAUDE_CODE_USE_FOUNDRY".to_string(), "1".to_string());
    env.insert(
        "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST".to_string(),
        "agentree".to_string(),
    );
    copy_optional_string(
        &profile.config,
        "azure_openai_endpoint",
        &mut env,
        "AZURE_OPENAI_ENDPOINT",
    );
    copy_optional_string(
        &profile.config,
        "azure_ai_foundry_endpoint",
        &mut env,
        "AZURE_AI_FOUNDRY_ENDPOINT",
    );
    copy_optional_string(
        &profile.config,
        "azure_deployment",
        &mut env,
        "AZURE_OPENAI_DEPLOYMENT",
    );
    copy_optional_string(
        &profile.config,
        "anthropic_foundry_base_url",
        &mut env,
        "ANTHROPIC_FOUNDRY_BASE_URL",
    );
    copy_optional_string(
        &secret_json,
        "azure_openai_api_key",
        &mut env,
        "AZURE_OPENAI_API_KEY",
    );
    copy_optional_string(&secret_json, "azure_api_key", &mut env, "AZURE_API_KEY");
    copy_optional_string(&secret_json, "azure_client_id", &mut env, "AZURE_CLIENT_ID");
    copy_optional_string(
        &secret_json,
        "azure_client_secret",
        &mut env,
        "AZURE_CLIENT_SECRET",
    );
    copy_optional_string(&secret_json, "azure_tenant_id", &mut env, "AZURE_TENANT_ID");
    copy_optional_string(
        &secret_json,
        "anthropic_foundry_base_url",
        &mut env,
        "ANTHROPIC_FOUNDRY_BASE_URL",
    );
    copy_optional_bool_as_one(
        &profile.config,
        "skip_foundry_auth",
        &mut env,
        "CLAUDE_CODE_SKIP_FOUNDRY_AUTH",
    );
    materialized(profile, env, None)
}

fn parse_secret_json(secret: &str) -> JsonValue {
    serde_json::from_str(secret).unwrap_or_else(|_| serde_json::json!({}))
}

fn copy_optional_string(
    source: &JsonValue,
    source_key: &str,
    env: &mut HashMap<String, String>,
    env_key: &str,
) {
    let Some(value) = source
        .get(source_key)
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return;
    };
    env.insert(env_key.to_string(), value.to_string());
}

fn copy_optional_bool_as_one(
    source: &JsonValue,
    source_key: &str,
    env: &mut HashMap<String, String>,
    env_key: &str,
) {
    if source.get(source_key).and_then(|value| value.as_bool()) == Some(true) {
        env.insert(env_key.to_string(), "1".to_string());
    }
}

fn write_restricted_file(path: &Path, contents: &str) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::fs::OpenOptions;
        use std::os::unix::fs::OpenOptionsExt;
        use std::os::unix::fs::PermissionsExt;

        if path.exists() {
            fs::set_permissions(path, fs::Permissions::from_mode(0o600))
                .map_err(|error| format!("failed to restrict {}: {}", path.display(), error))?;
        }
        let mut file = OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(path)
            .map_err(|error| format!("failed to open {}: {}", path.display(), error))?;
        file.write_all(contents.as_bytes())
            .map_err(|error| format!("failed to write {}: {}", path.display(), error))?;
        file.sync_all()
            .map_err(|error| format!("failed to sync {}: {}", path.display(), error))?;
    }
    #[cfg(not(unix))]
    {
        fs::write(path, contents)
            .map_err(|error| format!("failed to write {}: {}", path.display(), error))?;
    }
    Ok(())
}

fn command_output_with_timeout(command: &mut Command, timeout: Duration) -> Result<Output, String> {
    crate::process_runner::command_output_with_timeout(command, timeout, "Account check").map_err(
        |error| match error {
            crate::process_runner::CommandOutputError::TimedOut { .. } => {
                "Account check timed out before receiving a provider response.".to_string()
            }
            other => other.to_string(),
        },
    )
}

#[derive(Debug, Clone)]
pub struct LiveCheckFailure {
    pub code: Option<String>,
    pub message: String,
}

impl LiveCheckFailure {
    fn uncoded(message: impl Into<String>) -> Self {
        Self {
            code: None,
            message: message.into(),
        }
    }
}

impl From<String> for LiveCheckFailure {
    fn from(message: String) -> Self {
        Self::uncoded(message)
    }
}

impl std::fmt::Display for LiveCheckFailure {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

fn truncate_live_check_message(mut message: String) -> String {
    if message.len() > 500 {
        let mut cut = 500;
        while !message.is_char_boundary(cut) {
            cut -= 1;
        }
        message.truncate(cut);
        message.push('…');
    }
    message
}

/// Stack frames, crash banners, and code-frame markers that Node prints around
/// the actual error; surfacing these instead of the error line is what made
/// packaged-build failures look like "Node.js v18.19.1".
fn is_diagnostic_noise_line(line: &str) -> bool {
    let trimmed = line.trim();
    trimmed.starts_with("at ")
        || trimmed.starts_with("node:internal")
        || trimmed.starts_with("Node.js v")
        || trimmed.starts_with("ErrorCaptureStackTrace")
        || trimmed
            .chars()
            .all(|character| matches!(character, '^' | '~' | '|' | ' '))
        || trimmed.starts_with("code:")
        || trimmed == "}"
        || trimmed == "{"
}

fn structured_error_from_stdout(stdout: &str) -> Option<LiveCheckFailure> {
    for line in stdout.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(value) = serde_json::from_str::<JsonValue>(trimmed) else {
            continue;
        };
        if value.get("type").and_then(JsonValue::as_str) != Some("error") {
            continue;
        }
        let content = value
            .get("content")
            .and_then(JsonValue::as_str)
            .map(str::trim)
            .filter(|content| !content.is_empty())?;
        return Some(LiveCheckFailure {
            code: value
                .get("provider_error_code")
                .and_then(JsonValue::as_str)
                .map(ToOwned::to_owned),
            message: content.to_string(),
        });
    }
    None
}

fn failed_provider_stop_content(stdout: &str) -> Option<String> {
    for line in stdout.lines() {
        let Ok(value) = serde_json::from_str::<JsonValue>(line.trim()) else {
            continue;
        };
        if value.get("type").and_then(JsonValue::as_str) != Some("provider_stop") {
            continue;
        }
        if let Some(content) = value
            .get("final_content")
            .and_then(JsonValue::as_str)
            .map(str::trim)
            .filter(|content| !content.is_empty())
        {
            return Some(content.to_string());
        }
    }
    None
}

fn stderr_failure(stderr: &str) -> Option<LiveCheckFailure> {
    let meaningful = stderr
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty() && !is_diagnostic_noise_line(line));
    let line = match meaningful {
        Some(line) => line,
        None => stderr
            .lines()
            .map(str::trim)
            .find(|line| !line.is_empty())?,
    };
    if line.contains("ERR_MODULE_NOT_FOUND") || line.contains("Cannot find package") {
        let (code, runtime) = if stderr.contains("@opencode-ai/sdk")
            || stderr.contains("opencode-agent-sdk-adapter")
        {
            ("opencode_runtime_missing", "OpenCode")
        } else {
            ("claude_runtime_missing", "Claude")
        };
        return Some(LiveCheckFailure {
            code: Some(code.to_string()),
            message: format!(
                "{} runtime dependency is missing or broken: {}. Reinstall or repair the {} runtime.",
                runtime, line, runtime
            ),
        });
    }
    Some(LiveCheckFailure::uncoded(line))
}

fn extract_live_check_failure(stdout: &str, stderr: &str) -> LiveCheckFailure {
    let failure = structured_error_from_stdout(stdout)
        .or_else(|| failed_provider_stop_content(stdout).map(LiveCheckFailure::uncoded))
        .or_else(|| stderr_failure(stderr))
        .or_else(|| {
            stdout
                .lines()
                .map(str::trim)
                .find(|line| !line.is_empty() && !is_diagnostic_noise_line(line))
                .map(LiveCheckFailure::uncoded)
        })
        .unwrap_or_else(|| {
            LiveCheckFailure::uncoded("Account check failed without provider output.")
        });
    LiveCheckFailure {
        code: failure.code,
        message: truncate_live_check_message(failure.message),
    }
}

fn status_for_live_check_failure(failure: &LiveCheckFailure) -> &'static str {
    match failure.code.as_deref() {
        Some("auth_error")
        | Some("auth_missing")
        | Some("codex_auth_missing")
        | Some("claude_auth_missing") => return "auth_missing",
        Some("usage_limited") | Some("rate_limited") => return "usage_limited",
        Some("claude_runtime_missing")
        | Some("opencode_runtime_missing")
        | Some("codex_cli_missing")
        | Some("codex_cli_outdated")
        | Some("node_runtime_missing") => return "runtime_error",
        Some("codex_transport_closed") => return "unknown_error",
        _ => {}
    }
    let lower = failure.message.to_ascii_lowercase();
    if lower.contains("managed runtime")
        || lower.contains("managed opencode runtime")
        || lower.contains("managed codex runtime")
        || lower.contains("managed claude runtime")
        || lower.contains("runtime archive")
        || lower.contains("content fingerprint mismatch")
    {
        return "runtime_error";
    }
    status_from_live_check_error(&failure.message)
}

fn status_from_live_check_error(message: &str) -> &'static str {
    let lower = message.to_ascii_lowercase();
    if lower.contains("auth")
        || lower.contains("unauthorized")
        || lower.contains("401")
        || lower.contains("login")
        || lower.contains("session has ended")
        || lower.contains("session ended")
        || lower.contains("refresh token")
        || lower.contains("failed to refresh token")
        || lower.contains("api key")
    {
        "auth_missing"
    } else if lower.contains("rate limit")
        || lower.contains("usage limit")
        || lower.contains("usage_limit")
        || lower.contains("quota")
        || lower.contains("insufficient_quota")
    {
        "usage_limited"
    } else if lower.contains("invalid")
        || lower.contains("not found")
        || lower.contains("model")
        || lower.contains("forbidden")
        || lower.contains("403")
    {
        "invalid"
    } else {
        "unknown_error"
    }
}

pub(crate) fn provider_login_required_message(provider: &str) -> String {
    match provider {
        "codex" => "Log in to Codex in Managed Accounts.".to_string(),
        "claude" => "Log in to Claude in Managed Accounts.".to_string(),
        "opencode" => "Log in to OpenCode in Managed Accounts.".to_string(),
        _ => "Open Managed Accounts and log in to this coding agent.".to_string(),
    }
}

fn readiness_status_message(provider: &str, status: &str) -> String {
    match status {
        "auth_missing" => provider_login_required_message(provider),
        "usage_limited" => "This account has reached its usage limit.".to_string(),
        "invalid" => "This account configuration is no longer valid. Reconnect it.".to_string(),
        _ => "Agentree could not verify this account. Try again.".to_string(),
    }
}

fn readiness_failure_status_message(
    provider: &str,
    status: &str,
    failure: &LiveCheckFailure,
) -> String {
    if status == "runtime_error" {
        return truncate_live_check_message(failure.message.clone());
    }
    readiness_status_message(provider, status)
}

fn capture_live_check_output(
    app: &tauri::AppHandle,
    label: &str,
    stdout: &str,
    stderr: &str,
) -> Option<PathBuf> {
    crate::logging::append_live_check_capture(app, label, stdout, stderr).ok()
}

fn live_check_failure_with_log(
    app: &tauri::AppHandle,
    label: &str,
    stdout: &str,
    stderr: &str,
) -> LiveCheckFailure {
    let mut failure = extract_live_check_failure(stdout, stderr);
    if let Some(log_path) = capture_live_check_output(app, label, stdout, stderr) {
        failure.message = format!("{} (full output: {})", failure.message, log_path.display());
    }
    failure
}

#[derive(Debug, Clone)]
struct ProviderReadiness {
    message: String,
    plan_type: Option<String>,
}

fn parse_provider_readiness(output: &str) -> Result<ProviderReadiness, LiveCheckFailure> {
    let value = output
        .lines()
        .rev()
        .filter_map(|line| serde_json::from_str::<JsonValue>(line.trim()).ok())
        .find(|value| value.get("status").and_then(JsonValue::as_str).is_some())
        .ok_or_else(|| {
            LiveCheckFailure::uncoded("Account check returned no readiness status.".to_string())
        })?;
    let status = value
        .get("status")
        .and_then(JsonValue::as_str)
        .unwrap_or("unknown_error");
    let message = value
        .get("message")
        .and_then(JsonValue::as_str)
        .map(str::trim)
        .filter(|message| !message.is_empty())
        .unwrap_or("Account readiness could not be determined.")
        .to_string();
    if status != "ready" {
        return Err(LiveCheckFailure {
            code: Some(status.to_string()),
            message,
        });
    }
    Ok(ProviderReadiness {
        message,
        plan_type: value
            .get("planType")
            .and_then(JsonValue::as_str)
            .map(ToOwned::to_owned),
    })
}

fn run_codex_readiness_check(
    app: &tauri::AppHandle,
    profile: &LoginProfile,
    materialized: &MaterializedRuntimeCredentials,
) -> Result<ProviderReadiness, LiveCheckFailure> {
    let command_plan = crate::runtime_scripts::codex_adapter_command(app)?;
    let mut command = Command::new(&command_plan.program);
    command
        .args(command_plan.args_prefix)
        .arg("--readiness-check")
        .env("PATH", crate::cli_path::build_tool_path());
    for (key, value) in &materialized.env {
        command.env(key, value);
    }
    let output = command_output_with_timeout(&mut command, READINESS_CHECK_TIMEOUT)?;
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    if output.status.success() {
        return parse_provider_readiness(&stdout);
    }
    if stdout.trim().is_empty() && stderr.trim().is_empty() {
        return Err(LiveCheckFailure::uncoded(format!(
            "Account check process exited with {}.",
            output.status
        )));
    }
    Err(live_check_failure_with_log(
        app,
        &format!("codex account check (profile {})", profile.id),
        &stdout,
        &stderr,
    ))
}

fn run_claude_readiness_check(
    app: &tauri::AppHandle,
    profile: &LoginProfile,
    materialized: Option<&MaterializedRuntimeCredentials>,
) -> Result<ProviderReadiness, LiveCheckFailure> {
    let invocation = crate::managed_runtime::claude_adapter_invocation(app)?;
    let mut command = Command::new(&invocation.node_program);
    command
        .arg(&invocation.adapter_script)
        .arg("--readiness-check")
        .current_dir(std::env::temp_dir())
        .env("PATH", crate::cli_path::build_tool_path());
    if let Some(materialized) = materialized {
        scrub_claude_auth_env(&mut command);
        for (key, value) in &materialized.env {
            command.env(key, value);
        }
    }
    let output = command_output_with_timeout(&mut command, READINESS_CHECK_TIMEOUT)?;
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    if output.status.success() {
        return parse_provider_readiness(&stdout);
    }
    if stdout.trim().is_empty() && stderr.trim().is_empty() {
        return Err(LiveCheckFailure::uncoded(format!(
            "Account check process exited with {}.",
            output.status
        )));
    }
    Err(live_check_failure_with_log(
        app,
        &format!("claude account check (profile {})", profile.id),
        &stdout,
        &stderr,
    ))
}

fn run_opencode_readiness_check(
    app: &tauri::AppHandle,
    db: &TelemetryDb,
    profile: &LoginProfile,
    materialized: &MaterializedRuntimeCredentials,
) -> Result<ProviderReadiness, LiveCheckFailure> {
    let invocation = crate::managed_runtime::opencode_adapter_invocation(app)?;
    let mut command = Command::new(&invocation.node_program);
    command
        .arg(&invocation.adapter_script)
        .arg("--opencode-bin")
        .arg(&invocation.opencode_program)
        .arg("--readiness-check")
        .current_dir(std::env::temp_dir())
        .env("PATH", crate::cli_path::build_tool_path());
    for (key, value) in &materialized.env {
        command.env(key, value);
    }
    let output = command_output_with_timeout(&mut command, OPENCODE_READINESS_CHECK_TIMEOUT)?;
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    if output.status.success() {
        for line in stdout.lines() {
            let Ok(value) = serde_json::from_str::<JsonValue>(line) else {
                continue;
            };
            if value.get("type").and_then(JsonValue::as_str) == Some("model_catalog") {
                if let Some(catalog) = value.get("models") {
                    persist_opencode_model_catalog(db, &profile.id, catalog)?;
                }
                continue;
            }
            if value.get("type").and_then(JsonValue::as_str) == Some("provider_capabilities") {
                if let Some(capabilities) = value.get("capabilities") {
                    persist_opencode_provider_capabilities(db, &profile.id, capabilities)?;
                }
                continue;
            }
            if value.get("type").and_then(JsonValue::as_str) != Some("readiness") {
                continue;
            }
            let connected = value
                .get("connected_providers")
                .and_then(JsonValue::as_array)
                .map(Vec::len)
                .unwrap_or(0);
            if connected == 0 {
                return Err(LiveCheckFailure::uncoded(
                    "OpenCode is running, but this profile has no connected model providers.",
                ));
            }
            let model_count = value
                .get("model_count")
                .and_then(JsonValue::as_u64)
                .unwrap_or(0);
            let usable_models = value
                .get("usable_model_count")
                .and_then(JsonValue::as_u64)
                .unwrap_or(model_count);
            let invalid_providers = value
                .get("invalid_provider_count")
                .and_then(JsonValue::as_u64)
                .unwrap_or(0) as usize;
            if usable_models == 0 {
                let all_credentials_invalid = invalid_providers == connected;
                return Err(LiveCheckFailure {
                    code: Some(
                        if all_credentials_invalid {
                            "auth_missing"
                        } else {
                            "usage_limited"
                        }
                        .to_string(),
                    ),
                    message: if all_credentials_invalid {
                        "All connected OpenCode provider credentials were rejected. Reconnect this profile."
                            .to_string()
                    } else {
                        "OpenCode provider credentials are valid, but no currently visible model has usable balance."
                            .to_string()
                    },
                });
            }
            return Ok(ProviderReadiness {
                message: format!(
                    "OpenCode account connected with {usable_models} usable models across {connected} providers."
                ),
                plan_type: None,
            });
        }
    }
    if stdout.trim().is_empty() && stderr.trim().is_empty() {
        return Err(LiveCheckFailure::uncoded(format!(
            "OpenCode account check exited with {}.",
            output.status
        )));
    }
    Err(live_check_failure_with_log(
        app,
        &format!("opencode account check (profile {})", profile.id),
        &stdout,
        &stderr,
    ))
}

/// Validates a freshly connected OAuth token through the same SDK adapter
/// the account check uses — previously this went through the `claude` CLI from
/// PATH, so connect could "succeed" via one toolchain and the account check
/// then fail via another.
fn run_claude_oauth_connect_smoke_check(app: &tauri::AppHandle, token: &str) -> Result<(), String> {
    let invocation = crate::managed_runtime::claude_adapter_invocation(app)
        .map_err(|error| format!("Claude login validation failed: {}", error))?;
    let mut command = Command::new(&invocation.node_program);
    command
        .arg(&invocation.adapter_script)
        .arg("--readiness-check")
        .current_dir(std::env::temp_dir())
        .env("PATH", crate::cli_path::build_tool_path());
    scrub_claude_auth_env(&mut command);
    command.env("CLAUDE_CODE_OAUTH_TOKEN", token.trim());
    let output = command_output_with_timeout(&mut command, READINESS_CHECK_TIMEOUT)?;
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    if output.status.success() && parse_provider_readiness(&stdout).is_ok() {
        return Ok(());
    }
    if stdout.trim().is_empty() && stderr.trim().is_empty() {
        return Err(format!(
            "Claude login validation exited with {}.",
            output.status
        ));
    }
    Err(format!(
        "Claude login validation failed: {}",
        live_check_failure_with_log(app, "claude oauth connect smoke check", &stdout, &stderr)
    ))
}

fn finish_claude_oauth_login_success(
    app: &tauri::AppHandle,
    db: &TelemetryDb,
    profile_id: &str,
    token: &str,
) -> Result<LoginProfile, String> {
    persist_claude_oauth_token(db, &KeyringCredentialVault, profile_id, token)?;
    run_claude_oauth_connect_smoke_check(app, token)?;
    let profile = mark_login_profile_status(
        db,
        profile_id,
        "ready",
        Some("Claude account connected.".to_string()),
    )?;
    emit_login_profiles_changed(app, &profile);
    Ok(profile)
}

fn run_login_profile_readiness_check(
    app: &tauri::AppHandle,
    db: &TelemetryDb,
    vault: &dyn CredentialVault,
    profile: &LoginProfile,
    cache_dir: PathBuf,
) -> Result<ProviderReadiness, LiveCheckFailure> {
    match (profile.provider.as_str(), profile.auth_type.as_str()) {
        ("claude", "external_cli") => run_claude_readiness_check(app, profile, None),
        ("codex", _) | ("claude", _) | ("opencode", _) => {
            let materialized = resolve_runtime_credentials(db, vault, &profile.id, cache_dir)?;
            if materialized.provider != profile.provider {
                return Err(LiveCheckFailure::uncoded(format!(
                    "Login profile is for {}, not {}.",
                    materialized.provider, profile.provider
                )));
            }
            match profile.provider.as_str() {
                "codex" => {
                    let result = run_codex_readiness_check(app, profile, &materialized);
                    if result.is_ok() {
                        if let Some(codex_home) = materialized.codex_home.as_deref() {
                            persist_codex_auth_state(db, vault, &profile.id, codex_home)?;
                        }
                    }
                    result
                }
                "claude" => run_claude_readiness_check(app, profile, Some(&materialized)),
                "opencode" => {
                    let result = run_opencode_readiness_check(app, db, profile, &materialized);
                    if result.is_ok() {
                        if let Some(auth_path) = materialized.opencode_auth_path.as_deref() {
                            persist_opencode_auth_state(db, vault, &profile.id, auth_path)?;
                        }
                    }
                    result
                }
                _ => Err(LiveCheckFailure::uncoded(format!(
                    "Unsupported login provider: {}",
                    profile.provider
                ))),
            }
        }
        _ => Err(LiveCheckFailure::uncoded(format!(
            "Unsupported login profile auth type: {}",
            profile.auth_type
        ))),
    }
}

pub(crate) fn emit_login_profiles_changed(app: &tauri::AppHandle, profile: &LoginProfile) {
    let _ = app.emit(
        "login-profiles:changed",
        LoginProfilesChangedEvent {
            profile_id: profile.id.clone(),
            status: profile.status.clone(),
        },
    );
}

pub fn mark_login_profile_provider_failure(
    app: &tauri::AppHandle,
    profile_id: &str,
    model_provider: Option<&str>,
    status_code: u64,
) -> Result<(), String> {
    let provider_label = match model_provider {
        Some("openrouter") => "OpenRouter",
        Some("opencode") => "OpenCode Zen",
        Some("kimi-for-coding") => "Kimi For Coding",
        Some("deepseek") => "DeepSeek",
        Some("openai") => "OpenAI",
        Some("groq") => "Groq",
        _ => "Model provider",
    };
    let db = app.state::<TelemetryDb>();
    let mut profile = db.get_login_profile(profile_id)?;
    let (credentials, priced_model_access, message) = if status_code == 401 {
        (
            "invalid",
            "unknown",
            format!(
                "{} authentication failed. Reconnect this provider and run Check providers.",
                provider_label
            ),
        )
    } else {
        (
            "valid",
            "unavailable",
            format!(
                "{} has insufficient balance. Only its zero-priced models remain visible.",
                provider_label
            ),
        )
    };
    if let Some(provider_id) = model_provider {
        merge_opencode_provider_capabilities(
            &mut profile.config,
            &serde_json::json!([{
                "providerId": provider_id,
                "credentials": credentials,
                "pricedModelAccess": priced_model_access,
                "checkedAt": unix_timestamp() * 1000,
                "method": "runtime_error",
            }]),
        );
        profile.status_message = Some(message);
        profile.last_checked_at = Some(unix_timestamp());
        profile.updated_at = unix_timestamp();
        profile = db.upsert_login_profile_metadata(&profile, None)?;
    } else {
        profile = mark_login_profile_status(
            &db,
            profile_id,
            if status_code == 401 {
                "auth_missing"
            } else {
                "usage_limited"
            },
            Some(message),
        )?;
    }
    emit_login_profiles_changed(app, &profile);
    Ok(())
}

fn mark_login_profile_auth_missing(
    app: &tauri::AppHandle,
    db: &TelemetryDb,
    profile_id: &str,
    reason: &str,
) -> Result<LoginProfile, String> {
    let existing_profile = db.get_login_profile(profile_id)?;
    crate::app_log!(
        "[LOGIN_PROFILE] event=credentials_unavailable profile_id={} reason={}",
        profile_id,
        reason
    );
    let profile = db.mark_login_profile_status(
        profile_id,
        "auth_missing",
        Some(&provider_login_required_message(&existing_profile.provider)),
        None,
        unix_timestamp(),
    )?;
    emit_login_profiles_changed(app, &profile);
    Ok(profile)
}

enum ReadinessCheckAttempt {
    Completed(Result<LoginProfile, String>),
    Superseded(u64),
}

fn attempt_login_profile_readiness_check(
    app: &tauri::AppHandle,
    db: &TelemetryDb,
    vault: &dyn CredentialVault,
    profile_id: &str,
    generation: u64,
) -> Result<ReadinessCheckAttempt, String> {
    let outcome = (|| {
        let profile = db.get_login_profile(profile_id)?;
        let cache_dir = app
            .path()
            .app_cache_dir()
            .map_err(|error| format!("Could not resolve app cache dir: {}", error))?;
        let readiness_result =
            run_login_profile_readiness_check(app, db, vault, &profile, cache_dir);
        let (status, message, plan_type) = match readiness_result {
            Ok(readiness) => ("ready", readiness.message, readiness.plan_type),
            Err(failure) => {
                let status = status_for_live_check_failure(&failure);
                crate::app_log!(
                    "[LOGIN_PROFILE] event=readiness_failed profile_id={} status={} reason={}",
                    profile_id,
                    status,
                    failure.message
                );
                let message = readiness_failure_status_message(&profile.provider, status, &failure);
                (status, message, None)
            }
        };
        Ok::<_, String>((status, message, plan_type))
    })();
    let completed = with_current_readiness_generation(profile_id, generation, || match outcome {
        Ok((status, message, plan_type)) => db.mark_login_profile_status(
            profile_id,
            status,
            Some(&message),
            plan_type.as_deref(),
            unix_timestamp(),
        ),
        Err(error) => {
            crate::app_log!(
                "[LOGIN_PROFILE] event=readiness_check_error profile_id={} reason={}",
                profile_id,
                error
            );
            db.mark_login_profile_status(
                profile_id,
                "unknown_error",
                Some("Agentree could not verify this account. Try again."),
                None,
                unix_timestamp(),
            )
        }
    })?;
    match completed {
        Some(result) => Ok(ReadinessCheckAttempt::Completed(result)),
        None => Ok(ReadinessCheckAttempt::Superseded(
            current_readiness_generation(profile_id)?,
        )),
    }
}

fn run_readiness_flight(
    app: &tauri::AppHandle,
    db: &TelemetryDb,
    vault: &dyn CredentialVault,
    profile_id: &str,
    mut generation: u64,
) -> Result<LoginProfile, String> {
    loop {
        match attempt_login_profile_readiness_check(app, db, vault, profile_id, generation)? {
            ReadinessCheckAttempt::Completed(result) => return result,
            ReadinessCheckAttempt::Superseded(current_generation) => {
                crate::app_log!(
                    "[LOGIN_PROFILE] event=readiness_superseded profile_id={} old_generation={} new_generation={}",
                    profile_id,
                    generation,
                    current_generation
                );
                generation = current_generation;
            }
        }
    }
}

#[derive(Debug)]
enum LaunchProfileValidationError {
    ProfileUnavailable(String),
    NotReady { provider: String },
    CredentialsMissing { provider: String, reason: String },
}

impl LaunchProfileValidationError {
    fn user_message(&self) -> String {
        match self {
            Self::ProfileUnavailable(error) => error.clone(),
            Self::NotReady { provider } | Self::CredentialsMissing { provider, .. } => {
                provider_login_required_message(provider)
            }
        }
    }
}

/// Checks only persisted metadata and locally stored credential material.
///
/// This function deliberately has no `AppHandle`, runtime invocation, or readiness-check
/// dependency so an agent launch cannot reach provider discovery or a network probe.
fn validate_login_profile_for_launch(
    db: &TelemetryDb,
    vault: &dyn CredentialVault,
    profile_id: &str,
) -> Result<LoginProfile, LaunchProfileValidationError> {
    let profile = db
        .get_login_profile(profile_id)
        .map_err(LaunchProfileValidationError::ProfileUnavailable)?;
    if profile.status != "ready"
        || !is_supported_provider(&profile.provider)
        || validate_auth_type(&profile.provider, &profile.auth_type).is_err()
    {
        return Err(LaunchProfileValidationError::NotReady {
            provider: profile.provider,
        });
    }

    match vault.get_secret(&secret_account_id(profile_id, "primary")) {
        Ok(secret) if !secret.trim().is_empty() => Ok(profile),
        Ok(_) => Err(LaunchProfileValidationError::CredentialsMissing {
            provider: profile.provider,
            reason: "stored credential is empty".to_string(),
        }),
        Err(reason) => Err(LaunchProfileValidationError::CredentialsMissing {
            provider: profile.provider,
            reason,
        }),
    }
}

pub(crate) fn ensure_login_profile_ready_with_vault(
    app: &tauri::AppHandle,
    db: &TelemetryDb,
    vault: &dyn CredentialVault,
    profile_id: &str,
) -> Result<LoginProfile, String> {
    match validate_login_profile_for_launch(db, vault, profile_id) {
        Ok(profile) => Ok(profile),
        Err(error @ LaunchProfileValidationError::CredentialsMissing { .. }) => {
            if let LaunchProfileValidationError::CredentialsMissing { reason, .. } = &error {
                let _ = mark_login_profile_auth_missing(app, db, profile_id, reason);
            }
            Err(error.user_message())
        }
        Err(error) => Err(error.user_message()),
    }
}

pub(crate) fn sync_login_profile_auth_failure_from_event(
    app: &tauri::AppHandle,
    profile_id: &str,
    event: &JsonValue,
) {
    let Some(message) = provider_auth_failure_message(event) else {
        return;
    };
    let db = app.state::<TelemetryDb>();
    let _ = mark_login_profile_auth_missing(app, &db, profile_id, message);
}

fn provider_auth_failure_message(event: &JsonValue) -> Option<&str> {
    let event_type = event.get("type").and_then(JsonValue::as_str)?;
    let meta = event.get("meta");
    let (code, message) = match event_type {
        "error" => (
            event
                .get("provider_error_code")
                .and_then(JsonValue::as_str)
                .or_else(|| {
                    meta.and_then(|value| value.get("provider_error_code"))
                        .and_then(JsonValue::as_str)
                }),
            event
                .get("provider_error_message")
                .and_then(JsonValue::as_str)
                .or_else(|| event.get("content").and_then(JsonValue::as_str))
                .or_else(|| event.get("data").and_then(JsonValue::as_str))
                .or_else(|| {
                    meta.and_then(|value| value.get("provider_error_message"))
                        .and_then(JsonValue::as_str)
                }),
        ),
        "provider_meta" => (
            meta.and_then(|value| value.get("provider_error_code"))
                .and_then(JsonValue::as_str),
            meta.and_then(|value| value.get("provider_error_message"))
                .and_then(JsonValue::as_str),
        ),
        "provider_stop"
            if event.get("provider_status").and_then(JsonValue::as_str) == Some("failed") =>
        {
            (
                event
                    .get("provider_error_code")
                    .and_then(JsonValue::as_str)
                    .or_else(|| {
                        event
                            .get("provider_stop_reason")
                            .and_then(JsonValue::as_str)
                    }),
                event
                    .get("provider_error_message")
                    .and_then(JsonValue::as_str)
                    .or_else(|| event.get("final_content").and_then(JsonValue::as_str)),
            )
        }
        _ => return None,
    };
    if !matches!(
        code,
        Some("auth_error" | "auth_missing" | "codex_auth_missing" | "claude_auth_missing")
    ) {
        return None;
    }
    Some(message.unwrap_or_default())
}

fn spawn_login_profile_readiness_check(
    app: tauri::AppHandle,
    profile_id: String,
    flight: Arc<ReadinessFlight>,
    generation: u64,
) {
    thread::spawn(move || {
        let db = app.state::<TelemetryDb>();
        let result =
            run_readiness_flight(&app, &db, &KeyringCredentialVault, &profile_id, generation);
        if let Ok(profile) = &result {
            emit_login_profiles_changed(&app, profile);
        } else if let Err(error) = &result {
            crate::app_log!(
                "[LOGIN_PROFILE] event=readiness_check_error profile_id={} reason={}",
                profile_id,
                error
            );
        }
        complete_readiness_flight(&profile_id, &flight, result);
    });
}

fn enqueue_login_profile_readiness_check(
    app: tauri::AppHandle,
    db: &TelemetryDb,
    profile_id: &str,
) -> Result<LoginProfile, String> {
    match begin_readiness_flight(profile_id)? {
        ReadinessFlightRole::Owner { flight, generation } => {
            let profile_result = with_current_readiness_generation(profile_id, generation, || {
                db.mark_login_profile_status(
                    profile_id,
                    "checking",
                    Some("Checking account credentials without starting an agent run."),
                    None,
                    unix_timestamp(),
                )
            });
            let profile = match profile_result {
                Ok(Some(Ok(profile))) => profile,
                Ok(Some(Err(error))) | Err(error) => {
                    complete_readiness_flight(profile_id, &flight, Err(error.clone()));
                    return Err(error);
                }
                Ok(None) => {
                    let error = "Account check was superseded before it started.".to_string();
                    complete_readiness_flight(profile_id, &flight, Err(error.clone()));
                    return Err(error);
                }
            };
            emit_login_profiles_changed(&app, &profile);
            spawn_login_profile_readiness_check(app, profile_id.to_string(), flight, generation);
            Ok(profile)
        }
        ReadinessFlightRole::Waiter => db.get_login_profile(profile_id),
    }
}

pub fn reconcile_login_profiles_on_startup(db: &TelemetryDb) -> Result<usize, String> {
    let profiles = db.list_login_profiles()?;
    let mut reconciled = 0usize;
    for profile in profiles {
        if profile.status == "checking" {
            db.mark_login_profile_status(
                &profile.id,
                "unchecked",
                Some("Previous sign in or account check was interrupted. Re-check or reconnect this account."),
                None,
                unix_timestamp(),
            )?;
            reconciled += 1;
        }
    }
    Ok(reconciled)
}

#[tauri::command]
#[specta::specta]
pub fn list_login_profiles(db: State<TelemetryDb>) -> Result<Vec<LoginProfile>, String> {
    db.list_login_profiles()
}

fn read_opencode_login_profile_auth_with_vault(
    db: &TelemetryDb,
    vault: &dyn CredentialVault,
    profile_id: &str,
) -> Result<String, String> {
    let profile = db.get_login_profile(profile_id)?;
    if profile.provider != "opencode" || profile.auth_type != "opencode_auth" {
        return Err("auth.json can only be read for OpenCode login profiles.".to_string());
    }
    vault.get_secret(&secret_account_id(profile_id, "primary"))
}

#[tauri::command]
#[specta::specta]
pub fn read_opencode_login_profile_auth(
    db: State<TelemetryDb>,
    profile_id: String,
) -> Result<String, String> {
    read_opencode_login_profile_auth_with_vault(&db, &KeyringCredentialVault, &profile_id)
}

#[tauri::command]
#[specta::specta]
pub fn upsert_login_profile(
    app: tauri::AppHandle,
    db: State<TelemetryDb>,
    request: UpsertLoginProfileRequest,
) -> Result<LoginProfile, String> {
    if let Some(profile_id) = request.id.as_deref() {
        invalidate_readiness_generation(profile_id);
    }
    let refresh_cache = request.provider.eq_ignore_ascii_case("opencode")
        && request.auth_type.eq_ignore_ascii_case("opencode_auth")
        && request
            .secret
            .as_deref()
            .is_some_and(|secret| !secret.trim().is_empty());
    let profile = upsert_login_profile_with_vault(&db, &KeyringCredentialVault, request)?;
    if refresh_cache {
        refresh_opencode_auth_cache(&app, &KeyringCredentialVault, &profile)?;
        return enqueue_login_profile_readiness_check(app, &db, &profile.id);
    }
    Ok(profile)
}

#[tauri::command]
#[specta::specta]
pub fn delete_login_profile(db: State<TelemetryDb>, profile_id: String) -> Result<(), String> {
    invalidate_readiness_generation(&profile_id);
    delete_login_profile_with_vault(&db, &KeyringCredentialVault, &profile_id)
}

#[tauri::command]
#[specta::specta]
pub fn set_default_login_profile(
    db: State<TelemetryDb>,
    provider: String,
    profile_id: Option<String>,
) -> Result<Vec<LoginProfile>, String> {
    db.set_default_login_profile(&provider, profile_id.as_deref())?;
    db.list_login_profiles()
}

#[tauri::command]
#[specta::specta]
pub fn list_active_login_profile_runs(
    db: State<TelemetryDb>,
) -> Result<Vec<ActiveLoginProfileRun>, String> {
    db.list_active_login_profile_runs()
}

#[tauri::command]
#[specta::specta]
pub fn check_login_profile_readiness(
    app: tauri::AppHandle,
    db: State<TelemetryDb>,
    profile_id: String,
) -> Result<LoginProfile, String> {
    enqueue_login_profile_readiness_check(app, &db, &profile_id)
}

#[tauri::command]
#[specta::specta]
pub async fn ensure_login_profile_ready(
    app: tauri::AppHandle,
    profile_id: String,
) -> Result<LoginProfile, String> {
    let worker_app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let db = worker_app.state::<TelemetryDb>();
        ensure_login_profile_ready_with_vault(
            &worker_app,
            &db,
            &KeyringCredentialVault,
            &profile_id,
        )
    })
    .await
    .map_err(|error| format!("Account check task failed: {}", error))?
}

#[tauri::command]
#[specta::specta]
pub async fn connect_codex_login_profile(
    app: tauri::AppHandle,
    profile_id: String,
) -> Result<CodexLoginStart, String> {
    let worker_app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let db = worker_app.state::<TelemetryDb>();
        connect_codex_login_profile_blocking(&worker_app, &db, profile_id)
    })
    .await
    .map_err(|error| format!("Codex login task failed: {}", error))?
}

fn connect_codex_login_profile_blocking(
    app: &tauri::AppHandle,
    db: &TelemetryDb,
    profile_id: String,
) -> Result<CodexLoginStart, String> {
    let profile = db.get_login_profile(&profile_id)?;
    if profile.provider != "codex" || profile.auth_type != "codex_chatgpt_session" {
        return Err(
            "Connect is only supported for managed Codex ChatGPT session profiles.".to_string(),
        );
    }
    let cache_dir = app
        .path()
        .app_cache_dir()
        .map_err(|error| format!("failed to resolve app cache dir: {}", error))?;
    let codex_home = prepare_codex_profile_home(&cache_dir, &profile.id)?;
    let codex_install = crate::managed_runtime::ensure_component(
        app,
        crate::managed_runtime::COMPONENT_CODEX,
    )
    .map_err(|error| {
        format!(
            "Agentree's managed Codex runtime could not be installed or repaired: {} Open Runtime Health and retry.",
            error
        )
    })?;
    let codex = crate::managed_runtime::codex_binary_path(&codex_install);
    let mut command = Command::new(codex);
    command
        .arg("-c")
        .arg("cli_auth_credentials_store=\"file\"")
        .arg("login")
        .arg("--device-auth")
        .env("CODEX_HOME", &codex_home)
        .env("PATH", crate::cli_path::build_tool_path())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let mut child = command
        .spawn()
        .map_err(|error| format!("failed to start Codex login: {}", error))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "failed to capture Codex login output".to_string())?;
    let _ = mark_login_profile_status(
        db,
        &profile.id,
        "checking",
        Some("Waiting for Codex browser sign in.".to_string()),
    );
    emit_login_profiles_changed(
        app,
        &LoginProfile {
            status: "checking".to_string(),
            ..profile.clone()
        },
    );

    let (sender, receiver) = mpsc::channel();
    let app_for_thread = app.clone();
    let db_path = db.path();
    let profile_id_for_thread = profile.id.clone();
    let codex_home_for_thread = codex_home.clone();
    thread::spawn(move || {
        finish_codex_login_process(
            app_for_thread,
            db_path,
            profile_id_for_thread,
            codex_home_for_thread,
            child,
            stdout,
            sender,
        );
    });

    let device_code = receiver
        .recv_timeout(CODEX_LOGIN_START_TIMEOUT)
        .map_err(|_| "Timed out waiting for Codex device login code.".to_string())??;
    if let Err(error) = app.opener().open_url(CODEX_DEVICE_LOGIN_URL, None::<&str>) {
        crate::app_log!(
            "[LOGIN_PROFILE] event=codex_login_open_browser_failed error={}",
            error
        );
    }
    Ok(CodexLoginStart {
        profile_id: profile.id,
        device_url: CODEX_DEVICE_LOGIN_URL.to_string(),
        device_code,
    })
}

fn connect_claude_oauth_login_profile_blocking(
    app: &tauri::AppHandle,
    db: &TelemetryDb,
    profile_id: String,
) -> Result<ClaudeOAuthLoginStart, String> {
    let profile = db.get_login_profile(&profile_id)?;
    if profile.provider != "claude" || profile.auth_type != "claude_oauth" {
        return Err("Connect is only supported for Claude subscription profiles.".to_string());
    }
    if let Ok(mut pending_logins) = pending_claude_oauth_logins().lock() {
        if let Some(mut previous) = pending_logins.remove(&profile.id) {
            let _ = previous.child.kill();
            let _ = previous.child.wait();
        }
    }
    let result: Result<ClaudeOAuthLoginStart, String> = (|| {
        let cache_dir = app
            .path()
            .app_cache_dir()
            .map_err(|error| format!("failed to resolve app cache dir: {}", error))?;
        let claude_install = crate::managed_runtime::ensure_component(
            app,
            crate::managed_runtime::COMPONENT_CLAUDE_SDK,
        )
        .map_err(|error| {
            format!(
                "Agentree's managed Claude runtime could not be installed or repaired: {} Open Runtime Health and retry.",
                error
            )
        })?;
        let claude = crate::managed_runtime::claude_binary_path(&claude_install)?;
        let mut command = claude_setup_token_command(&claude.to_string_lossy(), &cache_dir)?;
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        let process_started_at = SystemTime::now();
        let mut child = command
            .spawn()
            .map_err(|error| format!("failed to start Claude login: {}", error))?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "failed to capture Claude login input".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "failed to capture Claude login output".to_string())?;
        let output = Arc::new(Mutex::new(String::new()));
        collect_command_output(stdout, output.clone());
        let _ = mark_login_profile_status(
            &db,
            &profile.id,
            "checking",
            Some("Waiting for Claude browser sign in.".to_string()),
        );
        emit_login_profiles_changed(
            &app,
            &LoginProfile {
                status: "checking".to_string(),
                ..profile.clone()
            },
        );

        let wait_started = Instant::now();
        let mut login_url = String::new();
        while wait_started.elapsed() < CLAUDE_LOGIN_START_TIMEOUT {
            if let Ok(buffer) = output.lock() {
                if let Some(url) = extract_claude_login_url(&buffer) {
                    login_url = url;
                    break;
                }
            }
            thread::sleep(Duration::from_millis(150));
        }
        pending_claude_oauth_logins()
            .lock()
            .map_err(|_| "Claude login state lock is poisoned.".to_string())?
            .insert(
                profile.id.clone(),
                PendingClaudeOAuthLogin {
                    child,
                    stdin,
                    output,
                    started_at: process_started_at,
                },
            );
        if login_url.is_empty() {
            crate::app_log!(
                "[LOGIN_PROFILE] event=claude_login_url_not_captured profile_id={}",
                profile.id
            );
        }
        Ok(ClaudeOAuthLoginStart {
            profile_id: profile.id,
            login_url,
        })
    })();
    if let Err(error) = &result {
        if let Ok(profile) =
            mark_login_profile_status(db, &profile_id, "error", Some(error.clone()))
        {
            emit_login_profiles_changed(app, &profile);
        }
    }
    result
}

#[tauri::command]
#[specta::specta]
pub async fn connect_claude_oauth_login_profile(
    app: tauri::AppHandle,
    profile_id: String,
) -> Result<ClaudeOAuthLoginStart, String> {
    let worker_app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let db = worker_app.state::<TelemetryDb>();
        connect_claude_oauth_login_profile_blocking(&worker_app, &db, profile_id)
    })
    .await
    .map_err(|error| format!("Claude login task failed: {}", error))?
}

fn pending_output_snapshot(pending: &PendingClaudeOAuthLogin) -> String {
    pending
        .output
        .lock()
        .map(|buffer| buffer.clone())
        .unwrap_or_default()
}

fn poll_claude_oauth_login(
    app: &tauri::AppHandle,
    db: &TelemetryDb,
    profile_id: &str,
) -> Result<LoginProfile, String> {
    let mut pending = {
        let mut pending_logins = pending_claude_oauth_logins()
            .lock()
            .map_err(|_| "Claude login state lock is poisoned.".to_string())?;
        match pending_logins.remove(profile_id) {
            Some(pending) => pending,
            None => return db.get_login_profile(profile_id),
        }
    };

    if let Some(token) = extract_claude_setup_token(&pending_output_snapshot(&pending)) {
        let _ = pending.child.kill();
        let _ = pending.child.wait();
        return finish_claude_oauth_login_success(app, db, profile_id, &token);
    }

    match pending.child.try_wait() {
        Ok(None) => {
            let timed_out = pending
                .started_at
                .elapsed()
                .map(|elapsed| elapsed > CLAUDE_LOGIN_PENDING_TIMEOUT)
                .unwrap_or(false);
            if timed_out {
                let _ = pending.child.kill();
                let _ = pending.child.wait();
                let message = "Claude sign in timed out. Reconnect to try again.".to_string();
                let profile =
                    mark_login_profile_status(db, profile_id, "error", Some(message.clone()))?;
                emit_login_profiles_changed(app, &profile);
                return Err(message);
            }
            pending_claude_oauth_logins()
                .lock()
                .map_err(|_| "Claude login state lock is poisoned.".to_string())?
                .insert(profile_id.to_string(), pending);
            db.get_login_profile(profile_id)
        }
        Ok(Some(status)) => {
            if let Some(token) = extract_claude_setup_token(&pending_output_snapshot(&pending)) {
                return finish_claude_oauth_login_success(app, db, profile_id, &token);
            }
            let message = format!(
                "Claude sign in exited with {} before producing a token.",
                status
            );
            let profile =
                mark_login_profile_status(db, profile_id, "error", Some(message.clone()))?;
            emit_login_profiles_changed(app, &profile);
            Err(message)
        }
        Err(error) => {
            let message = format!("failed to check Claude login status: {}", error);
            let profile =
                mark_login_profile_status(db, profile_id, "error", Some(message.clone()))?;
            emit_login_profiles_changed(app, &profile);
            Err(message)
        }
    }
}

#[tauri::command]
#[specta::specta]
pub async fn poll_claude_oauth_login_profile(
    app: tauri::AppHandle,
    profile_id: String,
) -> Result<LoginProfile, String> {
    let worker_app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let db = worker_app.state::<TelemetryDb>();
        poll_claude_oauth_login(&worker_app, &db, &profile_id)
    })
    .await
    .map_err(|error| format!("Claude login poll task failed: {}", error))?
}

fn submit_claude_oauth_login_code_blocking(
    app: &tauri::AppHandle,
    db: &TelemetryDb,
    profile_id: String,
    code: String,
) -> Result<LoginProfile, String> {
    if code.trim().is_empty() {
        return poll_claude_oauth_login(&app, &db, &profile_id);
    }
    let mut pending = pending_claude_oauth_logins()
        .lock()
        .map_err(|_| "Claude login state lock is poisoned.".to_string())?
        .remove(&profile_id)
        .ok_or_else(|| "No pending Claude login is waiting for this profile.".to_string())?;
    let result = (|| {
        let trimmed_code = code.trim();
        let submitted_at_output_len = pending_output_snapshot(&pending).len();
        // Send the code and Enter as separate writes with a settle delay.
        // Delivered as a single chunk, the CLI's input handling processes the
        // trailing Enter against an empty field and exits without a token.
        pending
            .stdin
            .write_all(trimmed_code.as_bytes())
            .map_err(|error| format!("failed to submit Claude login code: {}", error))?;
        pending
            .stdin
            .flush()
            .map_err(|error| format!("failed to submit Claude login code: {}", error))?;
        thread::sleep(Duration::from_millis(700));
        pending
            .stdin
            .write_all(b"\r")
            .map_err(|error| format!("failed to submit Claude login code: {}", error))?;
        pending
            .stdin
            .flush()
            .map_err(|error| format!("failed to submit Claude login code: {}", error))?;

        let deadline = Instant::now() + CLAUDE_LOGIN_CODE_TIMEOUT;
        let mut logged_output_len = submitted_at_output_len;
        let token = loop {
            let snapshot = pending_output_snapshot(&pending);
            if let Some(token) = extract_claude_setup_token(&snapshot) {
                break token;
            }
            // Record progress without writing TUI content: setup-token output
            // contains the credential itself, and chunks can split inside it.
            if snapshot.len() > logged_output_len {
                crate::app_log!(
                    "[LOGIN_PROFILE] event=claude_setup_token_progress profile_id={} bytes_received={}",
                    profile_id,
                    snapshot.len() - logged_output_len
                );
                logged_output_len = snapshot.len();
            }
            let new_output = strip_ansi(&snapshot[submitted_at_output_len.min(snapshot.len())..]);
            if let Some(failure_line) = find_claude_login_failure_line(&new_output) {
                return Err(format!(
                    "Claude sign in rejected the code: {}",
                    failure_line
                ));
            }
            match pending.child.try_wait() {
                Ok(Some(status)) => {
                    let final_snapshot = pending_output_snapshot(&pending);
                    if let Some(token) = extract_claude_setup_token(&final_snapshot) {
                        break token;
                    }
                    return Err(format!(
                        "Claude sign in exited with {} before producing a token.",
                        status
                    ));
                }
                Ok(None) => {
                    if Instant::now() >= deadline {
                        let last_line = new_output
                            .lines()
                            .rev()
                            .map(str::trim)
                            .find(|line| !line.is_empty())
                            .unwrap_or("");
                        let last_line = redact_claude_tokens(last_line);
                        return Err(if last_line.is_empty() {
                            "Timed out waiting for Claude to accept the sign in code. Reconnect to try again.".to_string()
                        } else {
                            format!(
                                "Timed out waiting for Claude to accept the sign in code. Last output: {}",
                                last_line
                            )
                        });
                    }
                    thread::sleep(Duration::from_millis(200));
                }
                Err(error) => {
                    return Err(format!("failed to wait for Claude login: {}", error));
                }
            }
        };
        persist_claude_oauth_token(&db, &KeyringCredentialVault, &profile_id, &token).and_then(
            |_| {
                run_claude_oauth_connect_smoke_check(&app, &token)?;
                mark_login_profile_status(
                    &db,
                    &profile_id,
                    "ready",
                    Some("Claude account connected.".to_string()),
                )
            },
        )
    })();
    let _ = pending.child.kill();
    let _ = pending.child.wait();
    match result {
        Ok(profile) => {
            emit_login_profiles_changed(&app, &profile);
            Ok(profile)
        }
        Err(error) => {
            let profile = mark_login_profile_status(&db, &profile_id, "error", Some(error.clone()))
                .unwrap_or_else(|_| LoginProfile {
                    id: profile_id.clone(),
                    provider: "claude".to_string(),
                    display_name: "Claude login".to_string(),
                    auth_type: "claude_oauth".to_string(),
                    redacted_hint: None,
                    config: serde_json::json!({}),
                    status: "error".to_string(),
                    status_message: Some(error.clone()),
                    plan_type: None,
                    is_default: false,
                    created_at: unix_timestamp(),
                    updated_at: unix_timestamp(),
                    last_checked_at: Some(unix_timestamp()),
                });
            emit_login_profiles_changed(&app, &profile);
            Err(error)
        }
    }
}

#[tauri::command]
#[specta::specta]
pub async fn submit_claude_oauth_login_code(
    app: tauri::AppHandle,
    profile_id: String,
    code: String,
) -> Result<LoginProfile, String> {
    let worker_app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let db = worker_app.state::<TelemetryDb>();
        submit_claude_oauth_login_code_blocking(&worker_app, &db, profile_id, code)
    })
    .await
    .map_err(|error| format!("Claude login submit task failed: {}", error))?
}

#[tauri::command]
#[specta::specta]
pub fn check_all_login_profile_readiness(
    app: tauri::AppHandle,
    db: State<TelemetryDb>,
) -> Result<Vec<LoginProfile>, String> {
    let profiles = db.list_login_profiles()?;
    for profile in profiles {
        let _ = enqueue_login_profile_readiness_check(app.clone(), &db, &profile.id);
    }
    db.list_login_profiles()
}

fn env_import_candidate(
    env: &HashMap<String, String>,
    key: &str,
    provider: &str,
    auth_type: &str,
    display_name: &str,
) -> Option<LoginImportCandidate> {
    let secret = env.get(key).map(String::as_str).map(str::trim)?;
    if secret.is_empty() {
        return None;
    }
    Some(LoginImportCandidate {
        id: format!("env:{}", key),
        provider: provider.to_string(),
        display_name: display_name.to_string(),
        auth_type: auth_type.to_string(),
        source_kind: "env".to_string(),
        source_label: key.to_string(),
        redacted_hint: Some(redacted_secret_hint(secret)),
        importable: true,
    })
}

pub fn discover_login_import_candidates_from_sources(
    env: &HashMap<String, String>,
) -> Vec<LoginImportCandidate> {
    let mut candidates = Vec::new();
    if let Some(candidate) = env_import_candidate(
        env,
        "OPENAI_API_KEY",
        "codex",
        "codex_api_key",
        "OpenAI API key",
    ) {
        candidates.push(candidate);
    }
    if let Some(candidate) = env_import_candidate(
        env,
        "ANTHROPIC_API_KEY",
        "claude",
        "claude_api_key",
        "Anthropic API key",
    ) {
        candidates.push(candidate);
    }
    candidates
}

fn opencode_import_candidate(auth_path: &Path) -> Option<LoginImportCandidate> {
    auth_path.is_file().then(|| LoginImportCandidate {
        id: "file:opencode:default".to_string(),
        provider: "opencode".to_string(),
        display_name: "Existing OpenCode setup".to_string(),
        auth_type: "opencode_auth".to_string(),
        source_kind: "file".to_string(),
        source_label: auth_path.display().to_string(),
        redacted_hint: Some("Connected OpenCode providers".to_string()),
        importable: true,
    })
}

fn default_opencode_auth_path() -> Option<PathBuf> {
    if let Ok(data_home) = std::env::var("XDG_DATA_HOME") {
        let trimmed = data_home.trim();
        if !trimmed.is_empty() {
            return Some(PathBuf::from(trimmed).join("opencode").join("auth.json"));
        }
    }
    dirs::home_dir().map(|home| {
        home.join(".local")
            .join("share")
            .join("opencode")
            .join("auth.json")
    })
}

#[tauri::command]
#[specta::specta]
pub fn discover_login_import_candidates() -> Result<Vec<LoginImportCandidate>, String> {
    let env = std::env::vars().collect::<HashMap<_, _>>();
    let mut candidates = discover_login_import_candidates_from_sources(&env);
    if let Some(candidate) = default_opencode_auth_path()
        .as_deref()
        .and_then(opencode_import_candidate)
    {
        candidates.push(candidate);
    }
    Ok(candidates)
}

fn display_name_or_default(requested: Option<String>, default_name: &str) -> String {
    requested
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(default_name)
        .to_string()
}

fn imported_profiles(
    db: &TelemetryDb,
    provider: &str,
    auth_type: &str,
    imported_from: &str,
) -> Vec<LoginProfile> {
    let Ok(mut profiles) = db.list_login_profiles() else {
        return Vec::new();
    };
    profiles.retain(|profile| {
        profile.provider == provider
            && profile.auth_type == auth_type
            && profile
                .config
                .get("imported_from")
                .and_then(|value| value.as_str())
                == Some(imported_from)
    });
    profiles
}

fn existing_imported_profile(
    db: &TelemetryDb,
    provider: &str,
    auth_type: &str,
    imported_from: &str,
) -> Option<LoginProfile> {
    let profiles = imported_profiles(db, provider, auth_type, imported_from);
    profiles
        .iter()
        .find(|profile| profile.is_default)
        .cloned()
        .or_else(|| profiles.into_iter().next())
}

fn cleanup_duplicate_imported_profiles(
    db: &TelemetryDb,
    vault: &dyn CredentialVault,
    keep_profile_id: &str,
    provider: &str,
    auth_type: &str,
    imported_from: &str,
) -> Result<(), String> {
    for profile in imported_profiles(db, provider, auth_type, imported_from) {
        if profile.id == keep_profile_id {
            continue;
        }
        match delete_login_profile_with_vault(db, vault, &profile.id) {
            Ok(()) => {}
            Err(error) if error.contains("active run") => {}
            Err(error) if error.contains("login profile not found") => {}
            Err(error) => return Err(error),
        }
    }
    Ok(())
}

fn upsert_imported_managed_profile(
    db: &TelemetryDb,
    vault: &dyn CredentialVault,
    provider: &str,
    auth_type: &str,
    imported_from: &str,
    display_name: String,
    secret: String,
    make_default: Option<bool>,
) -> Result<LoginProfile, String> {
    let existing_id =
        existing_imported_profile(db, provider, auth_type, imported_from).map(|profile| profile.id);
    if let Some(existing_id) = existing_id.as_deref() {
        cleanup_duplicate_imported_profiles(
            db,
            vault,
            existing_id,
            provider,
            auth_type,
            imported_from,
        )?;
    }
    let profile = upsert_login_profile_with_vault(
        db,
        vault,
        UpsertLoginProfileRequest {
            id: existing_id,
            provider: provider.to_string(),
            display_name,
            auth_type: auth_type.to_string(),
            secret: Some(secret),
            config: Some(serde_json::json!({ "imported_from": imported_from })),
            make_default: make_default.or(Some(true)),
        },
    )?;
    cleanup_duplicate_imported_profiles(
        db,
        vault,
        &profile.id,
        provider,
        auth_type,
        imported_from,
    )?;
    Ok(profile)
}

pub fn import_discovered_login_profile_with_vault(
    db: &TelemetryDb,
    vault: &dyn CredentialVault,
    env: &HashMap<String, String>,
    request: ImportLoginCandidateRequest,
) -> Result<LoginProfile, String> {
    let opencode_auth_path = default_opencode_auth_path();
    import_discovered_login_profile_with_vault_and_sources(
        db,
        vault,
        env,
        opencode_auth_path.as_deref(),
        request,
    )
}

pub fn import_discovered_login_profile_with_vault_and_sources(
    db: &TelemetryDb,
    vault: &dyn CredentialVault,
    env: &HashMap<String, String>,
    opencode_auth_path: Option<&Path>,
    request: ImportLoginCandidateRequest,
) -> Result<LoginProfile, String> {
    match request.candidate_id.as_str() {
        "env:OPENAI_API_KEY" => {
            let secret = env
                .get("OPENAI_API_KEY")
                .map(String::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| "OPENAI_API_KEY is not available".to_string())?;
            upsert_imported_managed_profile(
                db,
                vault,
                "codex",
                "codex_api_key",
                "OPENAI_API_KEY",
                display_name_or_default(request.display_name, "OpenAI API key"),
                secret.to_string(),
                request.make_default,
            )
        }
        "env:ANTHROPIC_API_KEY" => {
            let secret = env
                .get("ANTHROPIC_API_KEY")
                .map(String::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| "ANTHROPIC_API_KEY is not available".to_string())?;
            upsert_imported_managed_profile(
                db,
                vault,
                "claude",
                "claude_api_key",
                "ANTHROPIC_API_KEY",
                display_name_or_default(request.display_name, "Anthropic API key"),
                secret.to_string(),
                request.make_default,
            )
        }
        "file:opencode:default" => {
            let auth_path = opencode_auth_path
                .filter(|path| path.is_file())
                .ok_or_else(|| "The detected OpenCode auth.json is no longer available.".to_string())?;
            let secret = fs::read_to_string(auth_path)
                .map_err(|error| format!("Could not read {}: {}", auth_path.display(), error))?;
            upsert_imported_managed_profile(
                db,
                vault,
                "opencode",
                "opencode_auth",
                "opencode_auth_json",
                display_name_or_default(request.display_name, "Existing OpenCode setup"),
                secret,
                request.make_default,
            )
        }
        "env:ANTHROPIC_AUTH_TOKEN" => {
            Err("ANTHROPIC_AUTH_TOKEN import is not supported. Add a Claude subscription or Anthropic API key profile instead.".to_string())
        }
        "cli:claude" => {
            Err("Claude CLI login import is not supported. Add a managed Claude profile instead.".to_string())
        }
        candidate_id if candidate_id.starts_with("file:codex:") => {
            Err("Codex auth file import is not supported. Add or reconnect a managed Codex profile instead.".to_string())
        }
        other => Err(format!("unknown login import candidate: {}", other)),
    }
}

#[tauri::command]
#[specta::specta]
pub fn import_discovered_login_profile(
    app: tauri::AppHandle,
    db: State<TelemetryDb>,
    request: ImportLoginCandidateRequest,
) -> Result<LoginProfile, String> {
    let env = std::env::vars().collect::<HashMap<_, _>>();
    let profile =
        import_discovered_login_profile_with_vault(&db, &KeyringCredentialVault, &env, request)?;
    if profile.provider == "opencode" {
        refresh_opencode_auth_cache(&app, &KeyringCredentialVault, &profile)?;
        return enqueue_login_profile_readiness_check(app, &db, &profile.id);
    }
    Ok(profile)
}

#[tauri::command]
#[specta::specta]
pub fn import_existing_runtime_login(
    db: State<TelemetryDb>,
    provider: String,
    display_name: String,
) -> Result<LoginProfile, String> {
    import_existing_runtime_login_with_vault(&db, &KeyringCredentialVault, &provider, &display_name)
}

pub fn import_existing_runtime_login_with_vault(
    _db: &TelemetryDb,
    _vault: &dyn CredentialVault,
    provider: &str,
    _display_name: &str,
) -> Result<LoginProfile, String> {
    match provider.trim().to_ascii_lowercase().as_str() {
        "codex" => {
            Err("Importing the current Codex runtime login is not supported. Add or reconnect a managed Codex profile instead.".to_string())
        }
        "claude" => {
            Err("Importing the current Claude CLI login is not supported. Add a managed Claude profile instead.".to_string())
        }
        "opencode" => {
            Err("Import OpenCode through Find existing so Agentree can copy auth.json into an isolated managed profile.".to_string())
        }
        other => Err(format!("unsupported provider import: {}", other)),
    }
}

pub fn metadata_with_login_profile(
    mut execution_data: JsonValue,
    profile: &LoginProfile,
) -> JsonValue {
    let Some(object) = execution_data.as_object_mut() else {
        return execution_data;
    };
    let meta = object
        .entry("meta".to_string())
        .or_insert_with(|| JsonValue::Object(JsonMap::new()));
    if let Some(meta_object) = meta.as_object_mut() {
        meta_object.insert(
            "login_profile_id".to_string(),
            JsonValue::String(profile.id.clone()),
        );
        meta_object.insert(
            "login_profile_name".to_string(),
            JsonValue::String(profile.display_name.clone()),
        );
        meta_object.insert(
            "login_profile_provider".to_string(),
            JsonValue::String(profile.provider.clone()),
        );
        meta_object.insert(
            "login_profile_auth_type".to_string(),
            JsonValue::String(profile.auth_type.clone()),
        );
        meta_object.insert(
            "login_profile_redacted_hint".to_string(),
            profile
                .redacted_hint
                .as_ref()
                .map(|value| JsonValue::String(value.clone()))
                .unwrap_or(JsonValue::Null),
        );
    }
    execution_data
}

#[cfg(test)]
pub fn materialize_runtime_credentials_for_test(
    profile_id: &str,
    provider: &str,
    auth_type: &str,
    secret: &str,
    config: JsonValue,
) -> Result<MaterializedRuntimeCredentials, String> {
    let now = unix_timestamp();
    materialize_runtime_credentials(
        LoginProfile {
            id: profile_id.to_string(),
            provider: provider.to_string(),
            display_name: "Test".to_string(),
            auth_type: auth_type.to_string(),
            redacted_hint: None,
            config,
            status: "unchecked".to_string(),
            status_message: None,
            plan_type: None,
            is_default: false,
            created_at: now,
            updated_at: now,
            last_checked_at: None,
        },
        secret,
        tempfile::tempdir()
            .map_err(|error| error.to_string())?
            .keep(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    #[cfg(unix)]
    #[test]
    fn timed_out_account_check_terminates_descendant_processes() {
        let directory = tempfile::tempdir().expect("account-check tempdir");
        let child_pid_path = directory.path().join("child.pid");
        let mut command = Command::new("/bin/sh");
        command
            .arg("-c")
            .arg("sleep 30 & echo $! > \"$1\"; wait")
            .arg("agentree-account-check-test")
            .arg(&child_pid_path);

        let error = command_output_with_timeout(&mut command, Duration::from_millis(150))
            .expect_err("account check should time out");
        assert_eq!(
            error,
            "Account check timed out before receiving a provider response."
        );

        let child_pid = fs::read_to_string(&child_pid_path)
            .expect("child pid should be recorded")
            .trim()
            .parse::<i32>()
            .expect("child pid should be numeric");
        let descendant_stopped = (0..40).any(|_| {
            let exists = unsafe { libc::kill(child_pid, 0) } == 0;
            if exists {
                thread::sleep(Duration::from_millis(25));
            }
            !exists
        });
        assert!(descendant_stopped, "timed-out descendant process survived");
    }

    struct MemoryVault {
        secrets: Mutex<HashMap<String, String>>,
        delete_failures_remaining: Mutex<usize>,
    }

    impl MemoryVault {
        fn new() -> Self {
            Self {
                secrets: Mutex::new(HashMap::new()),
                delete_failures_remaining: Mutex::new(0),
            }
        }

        fn fail_next_delete(&self) {
            *self
                .delete_failures_remaining
                .lock()
                .expect("delete failure lock") = 1;
        }
    }

    impl CredentialVault for MemoryVault {
        fn set_secret(&self, account: &str, secret: &str) -> Result<(), String> {
            self.secrets
                .lock()
                .map_err(|error| error.to_string())?
                .insert(account.to_string(), secret.to_string());
            Ok(())
        }

        fn get_secret(&self, account: &str) -> Result<String, String> {
            self.secrets
                .lock()
                .map_err(|error| error.to_string())?
                .get(account)
                .cloned()
                .ok_or_else(|| format!("secret not found: {}", account))
        }

        fn delete_secret(&self, account: &str) -> Result<(), String> {
            let mut failures_remaining = self
                .delete_failures_remaining
                .lock()
                .map_err(|error| error.to_string())?;
            if *failures_remaining > 0 {
                *failures_remaining -= 1;
                return Err("simulated credential deletion failure".to_string());
            }
            drop(failures_remaining);
            self.secrets
                .lock()
                .map_err(|error| error.to_string())?
                .remove(account);
            Ok(())
        }
    }

    fn open_test_db() -> (tempfile::TempDir, TelemetryDb) {
        let dir = tempfile::tempdir().expect("db tempdir");
        let db = TelemetryDb::open(dir.path()).expect("open telemetry db");
        (dir, db)
    }

    fn test_profile(
        profile_id: &str,
        provider: &str,
        auth_type: &str,
        config: JsonValue,
    ) -> LoginProfile {
        let now = unix_timestamp();
        LoginProfile {
            id: profile_id.to_string(),
            provider: provider.to_string(),
            display_name: "Test".to_string(),
            auth_type: auth_type.to_string(),
            redacted_hint: None,
            config,
            status: "unchecked".to_string(),
            status_message: None,
            plan_type: None,
            is_default: false,
            created_at: now,
            updated_at: now,
            last_checked_at: None,
        }
    }

    #[test]
    fn redacts_openai_key_without_returning_secret() {
        let hint = redacted_secret_hint("sk-proj-1234567890abcdef");
        assert_eq!(hint, "sk-proj...cdef");
    }

    #[test]
    fn redacts_short_secret_without_exposing_value() {
        let hint = redacted_secret_hint("short");
        assert_eq!(hint, "•••••");
    }

    #[test]
    fn missing_file_backed_secret_returns_reconnect_guidance_without_a_path() {
        let account = format!("missing-login-profile-secret-{}", Uuid::new_v4());
        let error = read_file_secret(&account).expect_err("secret must not exist");

        assert_eq!(
            error,
            "Login profile credentials are missing. Reconnect this profile in Logins and try again."
        );
        assert!(!error.contains(&account));
    }

    #[cfg(debug_assertions)]
    #[test]
    fn debug_secret_file_is_private_and_readable_after_write() {
        let directory = tempfile::tempdir().expect("secret tempdir");
        let path = directory.path().join("profile-secret");
        write_private_secret_file(&path, "saved-secret").expect("write secret");

        let secret = read_optional_file_secret(&path)
            .expect("read secret")
            .expect("saved secret");

        assert_eq!(secret, "saved-secret");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(path)
                    .expect("secret metadata")
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
    }

    #[cfg(debug_assertions)]
    #[test]
    fn missing_debug_secret_does_not_fall_back_to_another_store() {
        let directory = tempfile::tempdir().expect("secret tempdir");
        let path = directory.path().join("profile-secret");

        assert_eq!(
            read_optional_file_secret(&path).expect("read missing secret"),
            None
        );
    }

    #[test]
    fn launch_validation_uses_stale_persisted_readiness_without_a_live_check() {
        let (_dir, db) = open_test_db();
        let vault = MemoryVault::new();
        for (profile_id, provider, auth_type) in [
            ("codex", "codex", "codex_chatgpt_session"),
            ("claude", "claude", "claude_oauth"),
            ("opencode", "opencode", "opencode_auth"),
        ] {
            let mut profile = test_profile(profile_id, provider, auth_type, serde_json::json!({}));
            profile.status = "ready".to_string();
            profile.last_checked_at = Some(1);
            db.upsert_login_profile_metadata(&profile, None)
                .expect("store ready profile");
            vault
                .set_secret(
                    &secret_account_id(profile_id, "primary"),
                    "local-credential",
                )
                .expect("store local credential");

            let validated = validate_login_profile_for_launch(&db, &vault, profile_id)
                .expect("stale persisted readiness remains launchable");

            assert_eq!(validated.id, profile_id);
            assert_eq!(validated.last_checked_at, Some(1));
        }
    }

    #[test]
    fn launch_validation_rejects_non_ready_profiles_without_rechecking_them() {
        let (_dir, db) = open_test_db();
        let vault = MemoryVault::new();
        let profile = test_profile(
            "opencode-unchecked",
            "opencode",
            "opencode_auth",
            serde_json::json!({}),
        );
        db.upsert_login_profile_metadata(&profile, None)
            .expect("store unchecked profile");
        vault
            .set_secret(
                &secret_account_id(&profile.id, "primary"),
                "local-credential",
            )
            .expect("store local credential");

        let error = validate_login_profile_for_launch(&db, &vault, &profile.id)
            .expect_err("unchecked profile must fail immediately");

        assert!(matches!(
            &error,
            LaunchProfileValidationError::NotReady { provider }
                if provider == "opencode"
        ));
        assert_eq!(
            error.user_message(),
            "Log in to OpenCode in Managed Accounts."
        );
    }

    #[test]
    fn launch_validation_requires_local_credentials_but_no_provider_runtime() {
        let (_dir, db) = open_test_db();
        let vault = MemoryVault::new();
        let mut profile = test_profile(
            "opencode-missing-secret",
            "opencode",
            "opencode_auth",
            serde_json::json!({}),
        );
        profile.status = "ready".to_string();
        db.upsert_login_profile_metadata(&profile, None)
            .expect("store ready profile");

        let error = validate_login_profile_for_launch(&db, &vault, &profile.id)
            .expect_err("missing local credential must fail immediately");

        assert!(matches!(
            &error,
            LaunchProfileValidationError::CredentialsMissing { provider, .. }
                if provider == "opencode"
        ));
        assert_eq!(
            error.user_message(),
            "Log in to OpenCode in Managed Accounts."
        );
    }

    #[test]
    fn all_coding_providers_require_managed_profiles() {
        for provider in ["codex", "claude", "opencode"] {
            assert!(provider_requires_managed_profile(provider));
            assert!(require_managed_login_profile(provider, None).is_err());
            assert!(require_managed_login_profile(provider, Some("profile-1")).is_ok());
        }
        assert!(!provider_requires_managed_profile("bash"));
        assert!(require_managed_login_profile("bash", None).is_ok());
    }

    #[test]
    fn concurrent_readiness_requests_share_one_flight() {
        let profile_id = format!("singleflight-{}", Uuid::new_v4());
        let (owner_flight, generation) =
            match begin_readiness_flight(&profile_id).expect("begin owner readiness flight") {
                ReadinessFlightRole::Owner { flight, generation } => (flight, generation),
                ReadinessFlightRole::Waiter => panic!("first caller should own the flight"),
            };
        match begin_readiness_flight(&profile_id).expect("join readiness flight") {
            ReadinessFlightRole::Waiter => {}
            ReadinessFlightRole::Owner { .. } => panic!("second caller should share the flight"),
        }
        let waiter_flight = active_readiness_flight(&profile_id).expect("read shared flight");

        assert!(Arc::ptr_eq(&owner_flight, &waiter_flight));
        assert_eq!(
            current_readiness_generation(&profile_id).expect("read generation"),
            generation
        );
        let profile = test_profile(&profile_id, "codex", "codex_api_key", serde_json::json!({}));
        complete_readiness_flight(&profile_id, &owner_flight, Ok(profile.clone()));
        assert_eq!(
            wait_for_readiness_flight(&waiter_flight)
                .expect("waiter result")
                .id,
            profile.id
        );
    }

    #[test]
    fn superseded_readiness_generation_cannot_commit() {
        let profile_id = format!("generation-{}", Uuid::new_v4());
        let (flight, generation) =
            match begin_readiness_flight(&profile_id).expect("begin readiness flight") {
                ReadinessFlightRole::Owner { flight, generation } => (flight, generation),
                ReadinessFlightRole::Waiter => panic!("first caller should own the flight"),
            };
        invalidate_readiness_generation(&profile_id);
        let committed = std::sync::atomic::AtomicBool::new(false);

        let result = with_current_readiness_generation(&profile_id, generation, || {
            committed.store(true, std::sync::atomic::Ordering::SeqCst);
        })
        .expect("generation check");

        assert!(result.is_none());
        assert!(!committed.load(std::sync::atomic::Ordering::SeqCst));
        complete_readiness_flight(
            &profile_id,
            &flight,
            Err("superseded test flight".to_string()),
        );
    }

    #[test]
    fn profile_selection_uses_shared_priority_order() {
        let first = test_profile("first", "codex", "codex_api_key", serde_json::json!({}));
        let mut default = test_profile("default", "codex", "codex_api_key", serde_json::json!({}));
        default.is_default = true;
        let mut ready = test_profile("ready", "codex", "codex_api_key", serde_json::json!({}));
        ready.status = "ready".to_string();
        let mut ready_default = test_profile(
            "ready-default",
            "codex",
            "codex_api_key",
            serde_json::json!({}),
        );
        ready_default.status = "ready".to_string();
        ready_default.is_default = true;
        let profiles = vec![
            first.clone(),
            default.clone(),
            ready.clone(),
            ready_default.clone(),
        ];

        assert_eq!(
            select_login_profile_for_provider(&profiles, "codex", None).map(|profile| &profile.id),
            Some(&ready_default.id)
        );
        assert_eq!(
            select_login_profile_for_provider(&profiles, "codex", Some("first"))
                .map(|profile| &profile.id),
            Some(&first.id)
        );

        ready_default.is_default = false;
        let profiles = vec![first.clone(), default.clone(), ready.clone(), ready_default];
        assert_eq!(
            select_login_profile_for_provider(&profiles, "codex", None).map(|profile| &profile.id),
            Some(&ready.id)
        );

        ready.status = "unchecked".to_string();
        let profiles = vec![first.clone(), default.clone(), ready];
        assert_eq!(
            select_login_profile_for_provider(&profiles, "codex", None).map(|profile| &profile.id),
            Some(&default.id)
        );

        default.is_default = false;
        let profiles = vec![first.clone(), default];
        assert_eq!(
            select_login_profile_for_provider(&profiles, "codex", None).map(|profile| &profile.id),
            Some(&first.id)
        );
    }

    #[test]
    fn opencode_model_catalog_is_persisted_without_replacing_other_profile_config() {
        let mut config = serde_json::json!({
            "opencode_provider_capabilities": {
                "openai": { "authStatus": "valid" }
            },
            "custom": true
        });
        let catalog = serde_json::json!([{
            "id": "openai/gpt-5.6-sol",
            "providerId": "openai",
            "name": "GPT-5.6 Sol"
        }]);

        merge_opencode_model_catalog(&mut config, &catalog, 123);

        assert_eq!(config[OPENCODE_MODEL_CATALOG_CONFIG_KEY], catalog);
        assert_eq!(
            config[OPENCODE_MODEL_CATALOG_CHECKED_AT_CONFIG_KEY],
            serde_json::json!(123)
        );
        assert_eq!(config["custom"], serde_json::json!(true));
        assert_eq!(
            config["opencode_provider_capabilities"]["openai"]["authStatus"],
            serde_json::json!("valid")
        );
    }

    #[test]
    fn opencode_managed_config_sync_preserves_global_mcp_and_skills() {
        let source_root = tempfile::tempdir().expect("source config");
        let managed_root = tempfile::tempdir().expect("managed config");
        let source = source_root.path().join("opencode");
        fs::create_dir_all(source.join("skills/review")).expect("skill directory");
        fs::write(
            source.join("opencode.json"),
            r#"{"mcp":{"custom":{"type":"remote","url":"https://mcp.example"}}}"#,
        )
        .expect("global OpenCode config");
        fs::write(source.join("skills/review/SKILL.md"), "# Review").expect("global skill");

        sync_opencode_config_dir(Some(&source), managed_root.path()).expect("sync config");

        let destination = managed_root.path().join("opencode");
        assert!(destination.join("opencode.json").is_file());
        assert!(destination.join("skills/review/SKILL.md").is_file());
    }

    #[test]
    fn readiness_parser_accepts_ready_without_model_output() {
        let output = concat!(
            r#"{"type":"trace","name":"adapter_started"}"#,
            "\n",
            r#"{"status":"ready","message":"Codex is ready for Agentree.","planType":"pro"}"#,
        );
        let readiness = parse_provider_readiness(output).expect("ready response");

        assert_eq!(readiness.message, "Codex is ready for Agentree.");
        assert_eq!(readiness.plan_type.as_deref(), Some("pro"));
    }

    #[test]
    fn readiness_parser_preserves_provider_auth_status() {
        let output = r#"{"status":"auth_missing","message":"The saved login has expired."}"#;
        let failure = parse_provider_readiness(output).expect_err("auth must fail");

        assert_eq!(failure.code.as_deref(), Some("auth_missing"));
        assert_eq!(failure.message, "The saved login has expired.");
    }

    #[test]
    fn provider_message_text_cannot_mark_login_profile_auth_missing() {
        let event = serde_json::json!({
            "type": "message_completed",
            "content": "I will inspect the login and authentication implementation."
        });

        assert_eq!(provider_auth_failure_message(&event), None);
    }

    #[test]
    fn unstructured_error_text_cannot_mark_login_profile_auth_missing() {
        let event = serde_json::json!({
            "type": "error",
            "content": "Unauthorized: refresh token revoked."
        });

        assert_eq!(provider_auth_failure_message(&event), None);
    }

    #[test]
    fn non_auth_provider_code_wins_over_auth_like_error_text() {
        let event = serde_json::json!({
            "type": "error",
            "provider_error_code": "provider_error",
            "content": "The response mentioned login documentation."
        });

        assert_eq!(provider_auth_failure_message(&event), None);
    }

    #[test]
    fn structured_provider_auth_error_can_mark_login_profile_auth_missing() {
        let event = serde_json::json!({
            "type": "provider_meta",
            "meta": {
                "provider_error_code": "auth_error",
                "provider_error_message": "The refresh token was revoked."
            }
        });

        assert_eq!(
            provider_auth_failure_message(&event),
            Some("The refresh token was revoked.")
        );
    }

    #[test]
    fn structured_provider_stop_can_mark_claude_login_profile_auth_missing() {
        let event = serde_json::json!({
            "type": "provider_stop",
            "provider_stop_reason": "auth_missing",
            "provider_status": "failed",
            "final_content": "Claude login is required."
        });

        assert_eq!(
            provider_auth_failure_message(&event),
            Some("Claude login is required.")
        );
    }

    #[test]
    fn completed_provider_stop_cannot_mark_login_profile_auth_missing() {
        let event = serde_json::json!({
            "type": "provider_stop",
            "provider_stop_reason": "auth_missing",
            "provider_status": "completed",
            "final_content": "No failure occurred."
        });

        assert_eq!(provider_auth_failure_message(&event), None);
    }

    #[test]
    fn codex_chatgpt_session_profile_can_be_created_without_secret() {
        let (_dir, db) = open_test_db();
        let vault = MemoryVault::new();
        let profile = upsert_login_profile_with_vault(
            &db,
            &vault,
            UpsertLoginProfileRequest {
                id: Some("codex-session-profile".to_string()),
                provider: "codex".to_string(),
                display_name: "Codex Work".to_string(),
                auth_type: "codex_chatgpt_session".to_string(),
                secret: None,
                config: None,
                make_default: Some(true),
            },
        )
        .expect("create codex session profile");

        assert_eq!(profile.provider, "codex");
        assert_eq!(profile.auth_type, "codex_chatgpt_session");
        assert_eq!(profile.redacted_hint, None);
        assert_eq!(profile.status, "unchecked");
        assert!(vault
            .get_secret(&secret_account_id("codex-session-profile", "primary"))
            .is_err());
    }

    #[test]
    fn parses_codex_device_code_from_ansi_output() {
        let mut expecting_code = false;
        assert_eq!(
            parse_codex_device_code_line(
                "2. Enter this one-time code \u{1b}[90m(expires in 15 minutes)\u{1b}[0m",
                &mut expecting_code,
            ),
            None
        );
        assert_eq!(
            parse_codex_device_code_line("   \u{1b}[94m1K96-KUM0M\u{1b}[0m", &mut expecting_code),
            Some("1K96-KUM0M".to_string())
        );
    }

    #[test]
    fn secret_account_id_is_stable_and_namespaced() {
        assert_eq!(
            secret_account_id("profile-1", "primary"),
            "login-profile:profile-1:primary"
        );
    }

    #[test]
    fn rejects_auth_type_for_wrong_provider() {
        let (_dir, db) = open_test_db();
        let vault = MemoryVault::new();

        let error = upsert_login_profile_with_vault(
            &db,
            &vault,
            UpsertLoginProfileRequest {
                id: None,
                provider: "codex".to_string(),
                display_name: "Wrong auth".to_string(),
                auth_type: "claude_api_key".to_string(),
                secret: Some("sk-ant-api03-example".to_string()),
                config: None,
                make_default: None,
            },
        )
        .expect_err("provider-specific auth validation should reject mismatches");

        assert!(error.contains("not supported for provider codex"));
    }

    #[test]
    fn requires_secret_for_new_managed_profile() {
        let (_dir, db) = open_test_db();
        let vault = MemoryVault::new();

        let error = upsert_login_profile_with_vault(
            &db,
            &vault,
            UpsertLoginProfileRequest {
                id: None,
                provider: "codex".to_string(),
                display_name: "Codex API".to_string(),
                auth_type: "codex_api_key".to_string(),
                secret: None,
                config: None,
                make_default: None,
            },
        )
        .expect_err("new managed profiles need secret material");

        assert!(error.contains("secret is required"));
    }

    #[test]
    fn editing_profile_without_secret_preserves_runtime_metadata() {
        let (_dir, db) = open_test_db();
        let vault = MemoryVault::new();
        let created = upsert_login_profile_with_vault(
            &db,
            &vault,
            UpsertLoginProfileRequest {
                id: Some("profile-codex".to_string()),
                provider: "codex".to_string(),
                display_name: "Codex API".to_string(),
                auth_type: "codex_api_key".to_string(),
                secret: Some("sk-proj-1234567890abcdef".to_string()),
                config: Some(serde_json::json!({ "openai_project_id": "old" })),
                make_default: Some(true),
            },
        )
        .expect("create profile");
        db.mark_login_profile_status(&created.id, "ready", Some("Ready"), Some("pro"), 1234)
            .expect("mark ready");

        let edited = upsert_login_profile_with_vault(
            &db,
            &vault,
            UpsertLoginProfileRequest {
                id: Some(created.id.clone()),
                provider: "codex".to_string(),
                display_name: "Renamed Codex API".to_string(),
                auth_type: "codex_api_key".to_string(),
                secret: None,
                config: Some(serde_json::json!({ "openai_project_id": "new" })),
                make_default: None,
            },
        )
        .expect("edit profile");

        assert_eq!(edited.display_name, "Renamed Codex API");
        assert_eq!(edited.redacted_hint.as_deref(), Some("sk-proj...cdef"));
        assert_eq!(edited.status, "ready");
        assert_eq!(edited.status_message.as_deref(), Some("Ready"));
        assert_eq!(edited.plan_type.as_deref(), Some("pro"));
        assert!(edited.is_default);
        assert_eq!(edited.created_at, created.created_at);
        assert_eq!(edited.last_checked_at, Some(1234));
    }

    #[test]
    fn credential_delete_failure_restores_profile_for_retry() {
        let (_dir, db) = open_test_db();
        let vault = MemoryVault::new();
        let created = upsert_login_profile_with_vault(
            &db,
            &vault,
            UpsertLoginProfileRequest {
                id: Some("profile-to-delete".to_string()),
                provider: "codex".to_string(),
                display_name: "Codex Work".to_string(),
                auth_type: "codex_api_key".to_string(),
                secret: Some("sk-proj-1234567890abcdef".to_string()),
                config: Some(serde_json::json!({ "openai_project_id": "project-1" })),
                make_default: Some(true),
            },
        )
        .expect("create profile");
        let sibling = upsert_login_profile_with_vault(
            &db,
            &vault,
            UpsertLoginProfileRequest {
                id: Some("profile-sibling".to_string()),
                provider: "codex".to_string(),
                display_name: "Codex Personal".to_string(),
                auth_type: "codex_api_key".to_string(),
                secret: Some("sk-proj-abcdef1234567890".to_string()),
                config: None,
                make_default: Some(false),
            },
        )
        .expect("create sibling profile");
        let expected = db
            .mark_login_profile_status(
                &created.id,
                "ready",
                Some("Login is ready"),
                Some("pro"),
                1234,
            )
            .expect("mark profile ready");

        vault.fail_next_delete();
        let error = delete_login_profile_with_vault(&db, &vault, &created.id)
            .expect_err("credential deletion should fail");

        assert_eq!(error, "simulated credential deletion failure");
        let restored = db
            .get_login_profile(&created.id)
            .expect("profile should remain available for retry");
        assert_eq!(
            serde_json::to_value(restored).expect("serialize restored profile"),
            serde_json::to_value(expected).expect("serialize expected profile")
        );
        assert_eq!(
            serde_json::to_value(
                db.get_login_profile(&sibling.id)
                    .expect("sibling profile should be unchanged")
            )
            .expect("serialize sibling profile"),
            serde_json::to_value(sibling).expect("serialize expected sibling")
        );
        assert!(vault
            .get_secret(&secret_account_id(&created.id, "primary"))
            .is_ok());

        delete_login_profile_with_vault(&db, &vault, &created.id)
            .expect("retry should delete profile and credentials");
        assert!(db.get_login_profile(&created.id).is_err());
        assert!(vault
            .get_secret(&secret_account_id(&created.id, "primary"))
            .is_err());
    }

    #[test]
    fn discovery_candidates_redact_env_sources_without_codex_auth_files() {
        let env = HashMap::from([
            (
                "OPENAI_API_KEY".to_string(),
                "sk-proj-1234567890abcdef".to_string(),
            ),
            (
                "ANTHROPIC_API_KEY".to_string(),
                "sk-ant-api03-1234567890abcdef".to_string(),
            ),
        ]);

        let candidates = discover_login_import_candidates_from_sources(&env);

        assert!(candidates
            .iter()
            .any(|candidate| candidate.id == "env:OPENAI_API_KEY"
                && candidate.auth_type == "codex_api_key"
                && candidate.redacted_hint.as_deref() == Some("sk-proj...cdef")));
        assert!(candidates
            .iter()
            .any(|candidate| candidate.id == "env:ANTHROPIC_API_KEY"
                && candidate.auth_type == "claude_api_key"
                && candidate.redacted_hint.as_deref() == Some("sk-ant-...cdef")));
        assert!(!candidates
            .iter()
            .any(|candidate| candidate.id.starts_with("file:codex:")));
        assert!(!candidates
            .iter()
            .any(|candidate| candidate.id == "cli:claude"));
        assert!(!candidates
            .iter()
            .any(|candidate| format!("{candidate:?}").contains("1234567890abcdef")));
    }

    #[test]
    fn importing_discovered_env_candidate_requires_confirmation_and_stores_secret() {
        let (_dir, db) = open_test_db();
        let vault = MemoryVault::new();
        let env = HashMap::from([(
            "OPENAI_API_KEY".to_string(),
            "sk-proj-1234567890abcdef".to_string(),
        )]);

        let imported = import_discovered_login_profile_with_vault(
            &db,
            &vault,
            &env,
            ImportLoginCandidateRequest {
                candidate_id: "env:OPENAI_API_KEY".to_string(),
                display_name: Some("Imported OpenAI key".to_string()),
                make_default: Some(true),
            },
        )
        .expect("import env key");

        assert_eq!(imported.provider, "codex");
        assert_eq!(imported.auth_type, "codex_api_key");
        assert_eq!(imported.display_name, "Imported OpenAI key");
        assert_eq!(imported.redacted_hint.as_deref(), Some("sk-proj...cdef"));
        let secret = vault
            .get_secret(&secret_account_id(&imported.id, "primary"))
            .expect("stored secret");
        assert_eq!(secret, "sk-proj-1234567890abcdef");
    }

    #[test]
    fn discovers_and_imports_opencode_auth_without_exposing_its_contents() {
        let (_dir, db) = open_test_db();
        let vault = MemoryVault::new();
        let source_dir = tempfile::tempdir().expect("OpenCode source");
        let auth_path = source_dir.path().join("auth.json");
        let auth_json = r#"{"openrouter":{"type":"api","key":"sensitive-key"}}"#;
        fs::write(&auth_path, auth_json).expect("write OpenCode auth");

        let candidate = opencode_import_candidate(&auth_path).expect("OpenCode candidate");
        assert_eq!(candidate.id, "file:opencode:default");
        assert_eq!(candidate.provider, "opencode");
        assert_eq!(candidate.auth_type, "opencode_auth");
        assert_eq!(
            candidate.redacted_hint.as_deref(),
            Some("Connected OpenCode providers")
        );
        assert!(!format!("{candidate:?}").contains("sensitive-key"));

        let imported = import_discovered_login_profile_with_vault_and_sources(
            &db,
            &vault,
            &HashMap::new(),
            Some(&auth_path),
            ImportLoginCandidateRequest {
                candidate_id: candidate.id,
                display_name: None,
                make_default: Some(true),
            },
        )
        .expect("import OpenCode auth");

        assert_eq!(imported.provider, "opencode");
        assert_eq!(imported.auth_type, "opencode_auth");
        assert_eq!(imported.display_name, "Existing OpenCode setup");
        assert_eq!(
            imported.redacted_hint.as_deref(),
            Some("Managed OpenCode credentials")
        );
        assert_eq!(
            vault
                .get_secret(&secret_account_id(&imported.id, "primary"))
                .expect("stored OpenCode auth"),
            auth_json
        );
    }

    #[test]
    fn opencode_import_rejects_a_missing_or_invalid_auth_file() {
        let (_dir, db) = open_test_db();
        let vault = MemoryVault::new();
        let source_dir = tempfile::tempdir().expect("OpenCode source");
        let missing_path = source_dir.path().join("missing-auth.json");
        let request = || ImportLoginCandidateRequest {
            candidate_id: "file:opencode:default".to_string(),
            display_name: None,
            make_default: Some(true),
        };

        let missing = import_discovered_login_profile_with_vault_and_sources(
            &db,
            &vault,
            &HashMap::new(),
            Some(&missing_path),
            request(),
        )
        .expect_err("missing OpenCode auth must fail");
        assert!(missing.contains("no longer available"));

        let invalid_path = source_dir.path().join("invalid-auth.json");
        fs::write(&invalid_path, "not-json").expect("write invalid auth");
        let invalid = import_discovered_login_profile_with_vault_and_sources(
            &db,
            &vault,
            &HashMap::new(),
            Some(&invalid_path),
            request(),
        )
        .expect_err("invalid OpenCode auth must fail");
        assert!(invalid.contains("valid auth.json"));
    }

    #[test]
    fn rejects_duplicate_managed_secret_for_same_provider_auth_type() {
        let (_dir, db) = open_test_db();
        let vault = MemoryVault::new();
        upsert_login_profile_with_vault(
            &db,
            &vault,
            UpsertLoginProfileRequest {
                id: None,
                provider: "codex".to_string(),
                display_name: "Codex API".to_string(),
                auth_type: "codex_api_key".to_string(),
                secret: Some("sk-proj-1234567890abcdef".to_string()),
                config: None,
                make_default: Some(true),
            },
        )
        .expect("create first profile");

        let error = upsert_login_profile_with_vault(
            &db,
            &vault,
            UpsertLoginProfileRequest {
                id: None,
                provider: "codex".to_string(),
                display_name: "Duplicate Codex API".to_string(),
                auth_type: "codex_api_key".to_string(),
                secret: Some("sk-proj-1234567890abcdef".to_string()),
                config: None,
                make_default: Some(true),
            },
        )
        .expect_err("same managed secret should not create a second profile");

        assert!(error.contains("already exists"));
    }

    #[test]
    fn importing_external_cli_candidate_is_not_supported() {
        let (_dir, db) = open_test_db();
        let vault = MemoryVault::new();
        let env = HashMap::new();

        let error = import_discovered_login_profile_with_vault(
            &db,
            &vault,
            &env,
            ImportLoginCandidateRequest {
                candidate_id: "cli:claude".to_string(),
                display_name: Some("Claude CLI login".to_string()),
                make_default: Some(false),
            },
        )
        .expect_err("Claude CLI import should be removed");

        assert!(error.contains("managed Claude profile"));
        assert_eq!(db.list_login_profiles().expect("profiles").len(), 0);
    }

    #[test]
    fn importing_discovered_codex_auth_file_is_not_supported() {
        let (_dir, db) = open_test_db();
        let vault = MemoryVault::new();
        let env = HashMap::new();

        let error = import_discovered_login_profile_with_vault(
            &db,
            &vault,
            &env,
            ImportLoginCandidateRequest {
                candidate_id: "file:codex:test".to_string(),
                display_name: Some("Imported Codex auth file".to_string()),
                make_default: Some(true),
            },
        )
        .expect_err("Codex auth file import should be removed");

        assert!(error.contains("not supported"));
    }

    #[test]
    fn importing_existing_runtime_codex_login_is_not_supported() {
        let (_dir, db) = open_test_db();
        let vault = MemoryVault::new();

        let error =
            import_existing_runtime_login_with_vault(&db, &vault, "codex", "Current Codex login")
                .expect_err("Codex runtime import should be removed");

        assert!(error.contains("managed Codex profile"));
    }

    #[test]
    fn importing_existing_runtime_claude_login_is_not_supported() {
        let (_dir, db) = open_test_db();
        let vault = MemoryVault::new();

        let error =
            import_existing_runtime_login_with_vault(&db, &vault, "claude", "Current Claude login")
                .expect_err("Claude runtime import should be removed");

        assert!(error.contains("managed Claude profile"));
    }

    #[test]
    fn live_check_failure_prefers_structured_error_event_over_provider_stop_json() {
        let stdout = concat!(
            r#"{"type":"error","content":"Codex adapter failed: Codex app-server closed stdout. stderr_tail=error: unexpected argument '--listen' found","provider_error_code":"codex_transport_closed","timestamp":1}"#,
            "\n",
            r#"{"type":"provider_stop","provider_stop_reason":"error","provider_status":"failed","final_content":"","provider_thread_id":null,"provider_turn_id":null,"timestamp":1}"#,
        );
        let failure = extract_live_check_failure(stdout, "");
        assert!(failure.message.contains("--listen"));
        assert!(!failure.message.contains("provider_stop"));
        assert_eq!(failure.code.as_deref(), Some("codex_transport_closed"));
        assert_eq!(status_for_live_check_failure(&failure), "unknown_error");
    }

    #[test]
    fn live_check_failure_surfaces_module_not_found_instead_of_node_banner() {
        let stderr = concat!(
            "node:internal/errors:496\n",
            "    ErrorCaptureStackTrace(err);\n",
            "    ^\n",
            "\n",
            "Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@anthropic-ai/claude-agent-sdk' imported from /app/scripts/claude-agent-sdk-adapter.mjs\n",
            "    at packageResolve (node:internal/modules/esm/resolve:916:9)\n",
            "\n",
            "Node.js v18.19.1\n",
        );
        let failure = extract_live_check_failure("", stderr);
        assert!(failure.message.contains("Cannot find package"));
        assert!(!failure.message.contains("Node.js v18.19.1"));
        assert_eq!(failure.code.as_deref(), Some("claude_runtime_missing"));
        assert_eq!(status_for_live_check_failure(&failure), "runtime_error");
    }

    #[test]
    fn live_check_failure_identifies_missing_opencode_sdk() {
        let stderr = concat!(
            "node:internal/modules/package_json_reader:314\n",
            "Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@opencode-ai/sdk' imported from /app/scripts/opencode-agent-sdk-adapter.mjs\n",
            "Node.js v22.21.1\n",
        );
        let failure = extract_live_check_failure("", stderr);
        assert!(failure.message.contains("OpenCode runtime dependency"));
        assert!(!failure.message.contains("Claude runtime"));
        assert_eq!(failure.code.as_deref(), Some("opencode_runtime_missing"));
        assert_eq!(status_for_live_check_failure(&failure), "runtime_error");
    }

    #[test]
    fn managed_runtime_failures_keep_the_actionable_repair_message() {
        let failure = LiveCheckFailure::uncoded(
            "Agentree's managed OpenCode runtime could not be installed or repaired: Extracted runtime content fingerprint mismatch. Open Runtime Health and retry.",
        );
        let status = status_for_live_check_failure(&failure);

        assert_eq!(status, "runtime_error");
        assert_eq!(
            readiness_failure_status_message("opencode", status, &failure),
            failure.message,
        );
    }

    #[test]
    fn live_check_failure_uses_failed_provider_stop_content_when_present() {
        let stdout = r#"{"type":"provider_stop","provider_status":"failed","final_content":"Usage limit reached for this account."}"#;
        let failure = extract_live_check_failure(stdout, "");
        assert_eq!(failure.message, "Usage limit reached for this account.");
        assert_eq!(status_for_live_check_failure(&failure), "usage_limited");
    }

    #[test]
    fn live_check_error_status_classifies_auth_and_usage_failures() {
        assert_eq!(
            status_from_live_check_error("Unauthorized: invalid API key"),
            "auth_missing"
        );
        assert_eq!(
            status_from_live_check_error("Failed to refresh token: 400 Bad Request: Your session has ended. Please log in again."),
            "auth_missing"
        );
        assert_eq!(
            status_from_live_check_error("usageLimitExceeded: rate limit reached"),
            "usage_limited"
        );
        assert_eq!(status_from_live_check_error("model not found"), "invalid");
        assert_eq!(
            readiness_status_message("codex", "auth_missing"),
            "Log in to Codex in Managed Accounts."
        );
        assert_eq!(
            readiness_status_message("claude", "auth_missing"),
            "Log in to Claude in Managed Accounts."
        );
        assert!(!readiness_status_message("codex", "unknown_error").contains("failed"));
    }

    #[test]
    fn claude_api_key_profile_injects_only_environment() {
        let materialized = materialize_runtime_credentials_for_test(
            "profile-claude",
            "claude",
            "claude_api_key",
            "sk-ant-api03-example",
            serde_json::json!({}),
        )
        .expect("credentials materialize");

        assert_eq!(
            materialized
                .env
                .get("ANTHROPIC_API_KEY")
                .map(String::as_str),
            Some("sk-ant-api03-example")
        );
        assert_eq!(materialized.profile_id, "profile-claude");
        assert_eq!(materialized.auth_type, "claude_api_key");
        assert!(materialized.codex_home.is_none());
    }

    #[test]
    fn codex_chatgpt_profile_writes_restricted_auth_json() {
        let materialized = materialize_runtime_credentials_for_test(
            "profile-codex",
            "codex",
            "codex_chatgpt_session",
            r#"{"tokens":{"access_token":"secret"}}"#,
            serde_json::json!({}),
        )
        .expect("credentials materialize");

        assert!(materialized.env.contains_key("CODEX_HOME"));
        assert!(materialized.codex_home.unwrap().join("auth.json").exists());
    }

    #[test]
    fn codex_profile_home_syncs_global_instruction_files() {
        let app_cache_dir = tempfile::tempdir().expect("cache");
        let user_codex_home = tempfile::tempdir().expect("user codex home");
        fs::write(
            user_codex_home.path().join("AGENTS.md"),
            "Personal defaults\n",
        )
        .expect("global instructions");
        fs::write(
            user_codex_home.path().join("AGENTS.override.md"),
            "Personal override\n",
        )
        .expect("global override");

        let managed_codex_home = prepare_codex_profile_home_with_instructions(
            app_cache_dir.path(),
            "profile-codex",
            Some(user_codex_home.path()),
        )
        .expect("managed codex home");

        assert_eq!(
            fs::read_to_string(managed_codex_home.join("AGENTS.md")).expect("synced instructions"),
            "Personal defaults\n"
        );
        assert_eq!(
            fs::read_to_string(managed_codex_home.join("AGENTS.override.md"))
                .expect("synced override"),
            "Personal override\n"
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(managed_codex_home.join("AGENTS.md"))
                .expect("instruction metadata")
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600);
        }
    }

    #[test]
    fn codex_profile_home_syncs_global_config_and_custom_skills() {
        let app_cache_dir = tempfile::tempdir().expect("cache");
        let user_codex_home = tempfile::tempdir().expect("user codex home");
        fs::write(
            user_codex_home.path().join("config.toml"),
            r#"model = "gpt-5.5"
cli_auth_credentials_store = "keychain"

[mcp_servers.personal]
command = "personal-mcp"
"#,
        )
        .expect("global config");
        let skill_dir = user_codex_home.path().join("skills").join("personal-skill");
        fs::create_dir_all(&skill_dir).expect("skill dir");
        fs::write(skill_dir.join("SKILL.md"), "# Personal Skill\n").expect("skill doc");

        let managed_codex_home = prepare_codex_profile_home_with_instructions(
            app_cache_dir.path(),
            "profile-codex",
            Some(user_codex_home.path()),
        )
        .expect("managed codex home");

        let config =
            fs::read_to_string(managed_codex_home.join("config.toml")).expect("synced config");
        assert!(config.contains(CODEX_AUTH_CONFIG_LINE));
        assert!(config.contains(r#"model = "gpt-5.5""#));
        assert!(config.contains("[mcp_servers.personal]"));
        assert!(config.contains(r#"command = "personal-mcp""#));
        assert!(!config.contains(r#"cli_auth_credentials_store = "keychain""#));
        assert!(managed_codex_home
            .join("skills")
            .join("personal-skill")
            .join("SKILL.md")
            .exists());
    }

    #[test]
    fn codex_profile_home_keeps_managed_system_skills_when_syncing_custom_skills() {
        let app_cache_dir = tempfile::tempdir().expect("cache");
        let user_codex_home = tempfile::tempdir().expect("user codex home");
        let managed_skills = app_cache_dir
            .path()
            .join("login-profiles")
            .join("profile-codex")
            .join("codex-home")
            .join("skills")
            .join(".system")
            .join("system-skill");
        fs::create_dir_all(&managed_skills).expect("managed system skill dir");
        fs::write(managed_skills.join("SKILL.md"), "# System Skill\n").expect("system skill");
        let stale_skill = app_cache_dir
            .path()
            .join("login-profiles")
            .join("profile-codex")
            .join("codex-home")
            .join("skills")
            .join("stale-custom-skill");
        fs::create_dir_all(&stale_skill).expect("stale skill dir");
        fs::write(stale_skill.join("SKILL.md"), "# Stale Skill\n").expect("stale skill");
        let user_system_skill = user_codex_home
            .path()
            .join("skills")
            .join(".system")
            .join("different-system-skill");
        fs::create_dir_all(&user_system_skill).expect("user system skill dir");
        fs::write(user_system_skill.join("SKILL.md"), "# Other System Skill\n")
            .expect("user system skill");

        let managed_codex_home = prepare_codex_profile_home_with_instructions(
            app_cache_dir.path(),
            "profile-codex",
            Some(user_codex_home.path()),
        )
        .expect("managed codex home");

        assert!(managed_codex_home
            .join("skills")
            .join(".system")
            .join("system-skill")
            .join("SKILL.md")
            .exists());
        assert!(!managed_codex_home
            .join("skills")
            .join(".system")
            .join("different-system-skill")
            .exists());
        assert!(!managed_codex_home
            .join("skills")
            .join("stale-custom-skill")
            .exists());
    }

    #[test]
    fn global_instruction_sync_refreshes_and_removes_stale_files() {
        let user_codex_home = tempfile::tempdir().expect("user codex home");
        let managed_codex_home = tempfile::tempdir().expect("managed codex home");
        fs::write(user_codex_home.path().join("AGENTS.md"), "First version\n")
            .expect("global instructions");
        fs::write(
            managed_codex_home.path().join("AGENTS.override.md"),
            "Stale override\n",
        )
        .expect("stale override");

        sync_global_codex_instructions(user_codex_home.path(), managed_codex_home.path())
            .expect("initial sync");
        assert_eq!(
            fs::read_to_string(managed_codex_home.path().join("AGENTS.md"))
                .expect("synced instructions"),
            "First version\n"
        );
        assert!(!managed_codex_home
            .path()
            .join("AGENTS.override.md")
            .exists());

        fs::write(user_codex_home.path().join("AGENTS.md"), "Second version\n")
            .expect("updated instructions");
        fs::write(
            user_codex_home.path().join("AGENTS.override.md"),
            "Current override\n",
        )
        .expect("current override");
        sync_global_codex_instructions(user_codex_home.path(), managed_codex_home.path())
            .expect("refresh sync");
        assert_eq!(
            fs::read_to_string(managed_codex_home.path().join("AGENTS.md"))
                .expect("refreshed instructions"),
            "Second version\n"
        );
        assert_eq!(
            fs::read_to_string(managed_codex_home.path().join("AGENTS.override.md"))
                .expect("refreshed override"),
            "Current override\n"
        );

        fs::remove_file(user_codex_home.path().join("AGENTS.md"))
            .expect("remove global instructions");
        sync_global_codex_instructions(user_codex_home.path(), managed_codex_home.path())
            .expect("removal sync");
        assert!(!managed_codex_home.path().join("AGENTS.md").exists());
        assert!(managed_codex_home
            .path()
            .join("AGENTS.override.md")
            .exists());
    }

    #[test]
    fn codex_chatgpt_profile_does_not_overwrite_live_auth_json() {
        let app_cache_dir = tempfile::tempdir().expect("cache");
        let codex_home = app_cache_dir
            .path()
            .join("login-profiles")
            .join("profile-codex")
            .join("codex-home");
        fs::create_dir_all(&codex_home).expect("codex home");
        fs::write(
            codex_home.join("auth.json"),
            r#"{"tokens":{"refresh_token":"live"}}"#,
        )
        .expect("live auth");

        let materialized = materialize_runtime_credentials(
            test_profile(
                "profile-codex",
                "codex",
                "codex_chatgpt_session",
                serde_json::json!({}),
            ),
            r#"{"tokens":{"refresh_token":"vault"}}"#,
            app_cache_dir.path().to_path_buf(),
        )
        .expect("credentials materialize");

        let auth_json = fs::read_to_string(
            materialized
                .codex_home
                .expect("codex home")
                .join("auth.json"),
        )
        .expect("auth json");
        assert!(auth_json.contains(r#""refresh_token":"live""#));
        assert!(!auth_json.contains(r#""refresh_token":"vault""#));
    }

    #[test]
    fn codex_chatgpt_profile_restores_auth_json_when_missing() {
        let app_cache_dir = tempfile::tempdir().expect("cache");

        let materialized = materialize_runtime_credentials(
            test_profile(
                "profile-codex",
                "codex",
                "codex_chatgpt_session",
                serde_json::json!({}),
            ),
            r#"{"tokens":{"refresh_token":"vault"}}"#,
            app_cache_dir.path().to_path_buf(),
        )
        .expect("credentials materialize");

        let auth_json = fs::read_to_string(
            materialized
                .codex_home
                .expect("codex home")
                .join("auth.json"),
        )
        .expect("auth json");
        assert!(auth_json.contains(r#""refresh_token":"vault""#));
    }

    #[test]
    fn persist_codex_auth_state_updates_vault_from_live_auth_json() {
        let (_dir, db) = open_test_db();
        let vault = MemoryVault::new();
        let profile = upsert_login_profile_with_vault(
            &db,
            &vault,
            UpsertLoginProfileRequest {
                id: Some("profile-codex".to_string()),
                provider: "codex".to_string(),
                display_name: "Codex Account".to_string(),
                auth_type: "codex_chatgpt_session".to_string(),
                secret: Some(r#"{"tokens":{"refresh_token":"vault"}}"#.to_string()),
                config: None,
                make_default: Some(true),
            },
        )
        .expect("create profile");
        let codex_home = tempfile::tempdir().expect("codex home");
        fs::write(
            codex_home.path().join("auth.json"),
            r#"{"tokens":{"refresh_token":"live"}}"#,
        )
        .expect("live auth");

        persist_codex_auth_state(&db, &vault, &profile.id, codex_home.path())
            .expect("persist auth state");

        let secret = vault
            .get_secret(&secret_account_id(&profile.id, "primary"))
            .expect("stored secret");
        assert!(secret.contains(r#""refresh_token":"live""#));
    }

    #[test]
    fn codex_api_key_profile_injects_openai_environment() {
        let materialized = materialize_runtime_credentials_for_test(
            "profile-codex",
            "codex",
            "codex_api_key",
            "sk-proj-example",
            serde_json::json!({
                "openai_project_id": "proj_123",
                "api_key": "must-not-copy",
            }),
        )
        .expect("credentials materialize");

        assert_eq!(
            materialized.env.get("OPENAI_API_KEY").map(String::as_str),
            Some("sk-proj-example")
        );
        assert_eq!(
            materialized
                .env
                .get("OPENAI_PROJECT_ID")
                .map(String::as_str),
            Some("proj_123")
        );
    }

    #[test]
    fn claude_bedrock_profile_sets_documented_switch() {
        let materialized = materialize_runtime_credentials_for_test(
            "profile-bedrock",
            "claude",
            "claude_bedrock",
            r#"{"aws_access_key_id":"AKIA","aws_secret_access_key":"secret"}"#,
            serde_json::json!({ "aws_region": "us-east-1" }),
        )
        .expect("credentials materialize");

        assert_eq!(
            materialized
                .env
                .get("CLAUDE_CODE_USE_BEDROCK")
                .map(String::as_str),
            Some("1")
        );
        assert_eq!(
            materialized.env.get("AWS_REGION").map(String::as_str),
            Some("us-east-1")
        );
    }

    #[test]
    fn claude_vertex_profile_sets_documented_switch() {
        let materialized = materialize_runtime_credentials_for_test(
            "profile-vertex",
            "claude",
            "claude_vertex",
            r#"{}"#,
            serde_json::json!({ "google_cloud_project": "proj" }),
        )
        .expect("credentials materialize");

        assert_eq!(
            materialized
                .env
                .get("CLAUDE_CODE_USE_VERTEX")
                .map(String::as_str),
            Some("1")
        );
    }

    #[test]
    fn claude_foundry_profile_sets_documented_switch() {
        let materialized = materialize_runtime_credentials_for_test(
            "profile-foundry",
            "claude",
            "claude_azure_foundry",
            r#"{"azure_openai_api_key":"secret"}"#,
            serde_json::json!({ "azure_openai_endpoint": "https://example.test" }),
        )
        .expect("credentials materialize");

        assert_eq!(
            materialized
                .env
                .get("CLAUDE_CODE_USE_FOUNDRY")
                .map(String::as_str),
            Some("1")
        );
        assert_eq!(
            materialized
                .env
                .get("AZURE_OPENAI_ENDPOINT")
                .map(String::as_str),
            Some("https://example.test")
        );
    }

    #[test]
    fn claude_oauth_profile_injects_setup_token_environment() {
        let materialized = materialize_runtime_credentials_for_test(
            "profile-claude-oauth",
            "claude",
            "claude_oauth",
            "sk-ant-at01-abcdefghijklmnopqrstuvwxyz0123456789ABCDE",
            serde_json::json!({}),
        )
        .expect("credentials materialize");

        assert_eq!(
            materialized
                .env
                .get("CLAUDE_CODE_OAUTH_TOKEN")
                .map(String::as_str),
            Some("sk-ant-at01-abcdefghijklmnopqrstuvwxyz0123456789ABCDE")
        );
        assert!(materialized.codex_home.is_none());
    }

    #[test]
    fn claude_oauth_profile_accepts_current_setup_token_format() {
        let token = "sk-ant-at01-abcdefghijklmnopqrstuvwxyz0123456789ABCD";
        let materialized = materialize_runtime_credentials_for_test(
            "profile-claude-oauth-current",
            "claude",
            "claude_oauth",
            token,
            serde_json::json!({}),
        )
        .expect("current credentials materialize");

        assert_eq!(
            materialized
                .env
                .get("CLAUDE_CODE_OAUTH_TOKEN")
                .map(String::as_str),
            Some(token)
        );
    }

    #[test]
    fn claude_oauth_profile_rejects_legacy_snapshot_secret() {
        let error = materialize_runtime_credentials_for_test(
            "profile-claude-oauth-legacy",
            "claude",
            "claude_oauth",
            r#"{"oauthKeychainJson":"{}","claudeConfigJson":"{}"}"#,
            serde_json::json!({}),
        )
        .expect_err("legacy snapshot secrets must require a reconnect");
        assert!(error.contains("Reconnect"));
    }

    #[test]
    fn extracts_full_login_url_from_osc8_terminal_output() {
        // OSC 8 hyperlink: the unwrapped target URL, then the same URL as
        // display text hard-wrapped by the terminal at column width.
        let raw = "If the browser didn't open, visit: \u{1b}]8;;https://claude.com/cai/oauth/authorize?code=true&client_id=abc&state=xyz\u{7}https://claude.com/cai/oauth/au\r\nthorize?code=true&client_id=abc&state=xyz\u{1b}]8;;\u{7}\r\nPaste code here if prompted >";
        let url = extract_claude_login_url(raw).expect("url extracted");
        assert_eq!(
            url,
            "https://claude.com/cai/oauth/authorize?code=true&client_id=abc&state=xyz"
        );
    }

    #[test]
    fn extracts_login_url_when_display_copy_is_concatenated() {
        // Piped (non-wrapped) output concatenates target and display copies
        // with no separator between them.
        let raw = "visit: \u{1b}]8;;https://claude.com/oauth/authorize?state=abchttps://claude.com/oauth/authorize?state=abc\u{1b}\\";
        let url = extract_claude_login_url(raw).expect("url extracted");
        assert_eq!(url, "https://claude.com/oauth/authorize?state=abc");
    }

    #[test]
    fn extracts_setup_token_from_ansi_decorated_output() {
        let raw = "\u{1b}[32mYour token:\u{1b}[0m sk-ant-at01-abcdefghijklmnopqrstuvwxyz0123456789ABCDE\r\nStore it somewhere safe.";
        let token = extract_claude_setup_token(raw).expect("token extracted");
        assert_eq!(
            token,
            "sk-ant-at01-abcdefghijklmnopqrstuvwxyz0123456789ABCDE"
        );
    }

    #[test]
    fn extracts_legacy_oauth_setup_tokens_during_migration() {
        let token = "sk-ant-oat01-abcdefghijklmnopqrstuvwxyz0123456789ABCD";
        assert_eq!(extract_claude_setup_token(token).as_deref(), Some(token));
    }

    #[test]
    fn ignores_short_and_non_oauth_claude_token_fragments() {
        assert!(extract_claude_setup_token("sk-ant-at01-tooshort").is_none());
        assert!(extract_claude_setup_token(
            "sk-ant-api01-abcdefghijklmnopqrstuvwxyz0123456789ABCDE"
        )
        .is_none());
        assert!(extract_claude_setup_token(
            "sk-ant-attack-abcdefghijklmnopqrstuvwxyz0123456789ABCDE"
        )
        .is_none());
    }

    #[test]
    fn redacts_current_and_unknown_claude_tokens_from_diagnostics() {
        let current = "sk-ant-at01-abcdefghijklmnopqrstuvwxyz0123456789ABCDE";
        let future = "sk-ant-future01-abcdefghijklmnopqrstuvwxyz0123456789ABCDE";
        let sanitized = redact_claude_tokens(&format!("created {} and then {}", current, future));

        assert_eq!(
            sanitized,
            "created [REDACTED_CLAUDE_TOKEN] and then [REDACTED_CLAUDE_TOKEN]"
        );
        assert!(!sanitized.contains(current));
        assert!(!sanitized.contains(future));
    }

    #[test]
    fn claude_login_failure_lines_never_return_tokens() {
        let token = "sk-ant-at01-abcdefghijklmnopqrstuvwxyz0123456789ABCDE";
        let failure =
            find_claude_login_failure_line(&format!("OAuth error after creating {}", token))
                .expect("failure line");

        assert_eq!(
            failure,
            "OAuth error after creating [REDACTED_CLAUDE_TOKEN]"
        );
    }

    #[test]
    fn invalid_claude_setup_token_is_rejected_before_vault_write() {
        let (_dir, db) = open_test_db();
        let vault = MemoryVault::new();
        let profile = test_profile(
            "claude-invalid-token",
            "claude",
            "claude_oauth",
            serde_json::json!({}),
        );
        db.upsert_login_profile_metadata(&profile, None)
            .expect("store profile metadata");

        let error = persist_claude_oauth_token(
            &db,
            &vault,
            &profile.id,
            "sk-ant-api01-abcdefghijklmnopqrstuvwxyz0123456789ABCDE",
        )
        .expect_err("API keys must not be stored as OAuth setup tokens");

        assert!(error.contains("not a recognized Claude setup token"));
        assert!(vault
            .get_secret(&secret_account_id(&profile.id, "primary"))
            .is_err());
    }

    #[test]
    fn strip_ansi_removes_osc_hyperlink_sequences() {
        let raw = "before \u{1b}]8;;https://example.test\u{7}label\u{1b}]8;;\u{7} after";
        assert_eq!(strip_ansi(raw), "before label after");
    }
}
