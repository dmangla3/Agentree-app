use keyring::Entry;
use serde::{Deserialize, Serialize};
use serde_json::{Map as JsonMap, Value as JsonValue};
use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::sync::{mpsc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{Emitter, Manager, State};
use tauri_plugin_opener::OpenerExt;
use uuid::Uuid;

use crate::db::TelemetryDb;

const KEYCHAIN_SERVICE: &str = "com.agentree.agentree.login-profiles";
const CLAUDE_CODE_KEYCHAIN_SERVICE: &str = "Claude Code-credentials";
const LIVE_CHECK_TIMEOUT: Duration = Duration::from_secs(45);
const CODEX_DEVICE_LOGIN_URL: &str = "https://auth.openai.com/codex/device";
const CODEX_LOGIN_START_TIMEOUT: Duration = Duration::from_secs(20);
const CLAUDE_LOGIN_START_TIMEOUT: Duration = Duration::from_secs(20);

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

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
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
    pub claude_config_dir: Option<PathBuf>,
}

struct PendingClaudeOAuthLogin {
    child: std::process::Child,
    stdin: std::process::ChildStdin,
    _stdout: std::process::ChildStdout,
    claude_config_dir: PathBuf,
    started_at: SystemTime,
}

static PENDING_CLAUDE_OAUTH_LOGINS: OnceLock<Mutex<HashMap<String, PendingClaudeOAuthLogin>>> =
    OnceLock::new();
static CLAUDE_OAUTH_ACTIVE_PROFILE: OnceLock<Mutex<Option<String>>> = OnceLock::new();

pub trait CredentialVault {
    fn set_secret(&self, account: &str, secret: &str) -> Result<(), String>;
    fn get_secret(&self, account: &str) -> Result<String, String>;
    fn delete_secret(&self, account: &str) -> Result<(), String>;
}

pub struct KeyringCredentialVault;

fn file_secret_path(account: &str) -> Result<PathBuf, String> {
    let data_dir = dirs::data_dir()
        .or_else(dirs::data_local_dir)
        .ok_or_else(|| "could not resolve app data directory".to_string())?;
    let safe_account = account
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
                ch
            } else {
                '_'
            }
        })
        .collect::<String>();
    Ok(data_dir
        .join("com.agentree.agentree")
        .join("login-profile-secrets")
        .join(safe_account))
}

fn write_file_secret(account: &str, secret: &str) -> Result<(), String> {
    let path = file_secret_path(account)?;
    let parent = path
        .parent()
        .ok_or_else(|| "could not resolve login profile secret directory".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("failed to create login profile secret directory: {}", error))?;
    write_restricted_file(&path, secret)
}

fn read_file_secret(account: &str) -> Result<String, String> {
    let path = file_secret_path(account)?;
    fs::read_to_string(&path).map_err(|error| {
        format!(
            "failed to read login profile secret fallback {}: {}",
            path.display(),
            error
        )
    })
}

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
        let keyring_result = Entry::new(KEYCHAIN_SERVICE, account)
            .map_err(|error| error.to_string())?
            .set_password(secret)
            .map_err(|error| error.to_string());
        write_file_secret(account, secret)?;
        keyring_result.or(Ok(()))
    }

    fn get_secret(&self, account: &str) -> Result<String, String> {
        let keyring_result = Entry::new(KEYCHAIN_SERVICE, account)
            .map_err(|error| error.to_string())?
            .get_password()
            .map_err(|error| error.to_string());
        match keyring_result {
            Ok(secret) => Ok(secret),
            Err(_) => read_file_secret(account),
        }
    }

    fn delete_secret(&self, account: &str) -> Result<(), String> {
        let entry = Entry::new(KEYCHAIN_SERVICE, account).map_err(|error| error.to_string())?;
        let keyring_result = match entry.delete_credential() {
            Ok(()) => Ok(()),
            Err(error) => {
                let message = error.to_string();
                let lower = message.to_lowercase();
                if lower.contains("no entry")
                    || lower.contains("no matching entry")
                    || lower.contains("not found")
                    || lower.contains("could not be found")
                {
                    Ok(())
                } else {
                    Err(message)
                }
            }
        };
        delete_file_secret(account)?;
        keyring_result
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
    matches!(provider, "codex" | "claude")
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
    let allows_deferred_secret =
        (provider == "codex" && auth_type == "codex_chatgpt_session")
            || (provider == "claude" && auth_type == "claude_oauth");
    if existing.is_none() && !allows_deferred_secret && secret.is_none() {
        return Err("a secret is required for managed login profiles".to_string());
    }
    if let Some(secret) = secret {
        ensure_no_duplicate_managed_secret(db, vault, &profile_id, &provider, &auth_type, secret)?;
        let account = secret_account_id(&profile_id, "primary");
        vault.set_secret(&account, secret)?;
        secret_ref = Some(account);
        redacted_hint = Some(redacted_secret_hint(secret));
        secret_was_updated = true;
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
        config: sanitize_config(request.config.unwrap_or_else(|| serde_json::json!({}))),
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
            release_claude_oauth_activation(profile_id);
        }
    }
    db.delete_login_profile_metadata(profile_id)?;
    vault.delete_secret(&secret_account_id(profile_id, "primary"))
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
        "claude_oauth" => materialize_claude_oauth(profile, secret, app_cache_dir, env),
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
        claude_config_dir: None,
    })
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClaudeOAuthProfileSecret {
    oauth_keychain_json: String,
    claude_config_json: String,
}

fn claude_oauth_active_profiles() -> &'static Mutex<Option<String>> {
    CLAUDE_OAUTH_ACTIVE_PROFILE.get_or_init(|| Mutex::new(None))
}

fn acquire_claude_oauth_activation(profile_id: &str) -> Result<(), String> {
    let mut active = claude_oauth_active_profiles()
        .lock()
        .map_err(|_| "Claude OAuth activation lock is poisoned.".to_string())?;
    match active.as_deref() {
        None => {
            *active = Some(profile_id.to_string());
            Ok(())
        }
        Some(current) if current == profile_id => Ok(()),
        Some(_) => Err(
            "Another Claude subscription account is currently active. Try again after that run finishes."
                .to_string(),
        ),
    }
}

pub fn release_claude_oauth_activation(profile_id: &str) {
    if let Ok(mut active) = claude_oauth_active_profiles().lock() {
        if active.as_deref() == Some(profile_id) {
            *active = None;
        }
    }
}

fn push_unique_account(accounts: &mut Vec<String>, account: impl Into<String>) {
    let account = account.into();
    let trimmed = account.trim();
    if !trimmed.is_empty() && !accounts.iter().any(|existing| existing == trimmed) {
        accounts.push(trimmed.to_string());
    }
}

fn parse_keychain_account_from_security_output(output: &str) -> Option<String> {
    output.lines().find_map(|line| {
        let line = line.trim();
        if !line.starts_with("\"acct\"<blob>=") {
            return None;
        }
        let (_, value) = line.split_once('=')?;
        value
            .trim()
            .trim_matches('"')
            .split('\0')
            .next()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned)
    })
}

#[cfg(target_os = "macos")]
fn discover_claude_code_keychain_account() -> Option<String> {
    let output = Command::new("security")
        .arg("find-generic-password")
        .arg("-s")
        .arg(CLAUDE_CODE_KEYCHAIN_SERVICE)
        .output()
        .ok()?;
    let mut combined = String::new();
    combined.push_str(&String::from_utf8_lossy(&output.stdout));
    combined.push_str(&String::from_utf8_lossy(&output.stderr));
    parse_keychain_account_from_security_output(&combined)
}

#[cfg(not(target_os = "macos"))]
fn discover_claude_code_keychain_account() -> Option<String> {
    None
}

#[cfg(target_os = "macos")]
fn read_claude_code_oauth_blob_with_security() -> Result<String, String> {
    let output = Command::new("security")
        .arg("find-generic-password")
        .arg("-w")
        .arg("-s")
        .arg(CLAUDE_CODE_KEYCHAIN_SERVICE)
        .output()
        .map_err(|error| format!("security find-generic-password failed to start: {}", error))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            format!("security find-generic-password exited with {}", output.status)
        } else {
            stderr
        });
    }
    let secret = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if secret.is_empty() {
        Err("security find-generic-password returned an empty OAuth state".to_string())
    } else {
        Ok(secret)
    }
}

#[cfg(not(target_os = "macos"))]
fn read_claude_code_oauth_blob_with_security() -> Result<String, String> {
    Err("security CLI is only available on macOS".to_string())
}

#[cfg(target_os = "macos")]
fn write_claude_code_oauth_blob_with_security(account: &str, secret: &str) -> Result<(), String> {
    let output = Command::new("security")
        .arg("add-generic-password")
        .arg("-U")
        .arg("-s")
        .arg(CLAUDE_CODE_KEYCHAIN_SERVICE)
        .arg("-a")
        .arg(account)
        .arg("-w")
        .arg(secret)
        .output()
        .map_err(|error| format!("security add-generic-password failed to start: {}", error))?;
    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(if stderr.is_empty() {
            format!("security add-generic-password exited with {}", output.status)
        } else {
            stderr
        })
    }
}

#[cfg(not(target_os = "macos"))]
fn write_claude_code_oauth_blob_with_security(_account: &str, _secret: &str) -> Result<(), String> {
    Err("security CLI is only available on macOS".to_string())
}

fn claude_code_keychain_accounts() -> Vec<String> {
    let mut accounts = Vec::new();
    if let Some(account) = discover_claude_code_keychain_account() {
        push_unique_account(&mut accounts, account);
    }
    for key in ["USER", "LOGNAME"] {
        if let Ok(value) = std::env::var(key) {
            push_unique_account(&mut accounts, value);
        }
    }
    if let Some(home_dir) = dirs::home_dir() {
        if let Some(user_name) = home_dir.file_name().and_then(|value| value.to_str()) {
            push_unique_account(&mut accounts, user_name.to_string());
        }
    }
    push_unique_account(&mut accounts, "default".to_string());
    accounts
}

fn read_claude_code_oauth_blob() -> Result<String, String> {
    let mut errors = Vec::new();
    for account in claude_code_keychain_accounts() {
        match Entry::new(CLAUDE_CODE_KEYCHAIN_SERVICE, &account) {
            Ok(entry) => match entry.get_password() {
                Ok(secret) => return Ok(secret),
                Err(error) => errors.push(format!("{}: {}", account, error)),
            },
            Err(error) => errors.push(format!("{}: {}", account, error)),
        }
    }
    match read_claude_code_oauth_blob_with_security() {
        Ok(secret) => return Ok(secret),
        Err(error) => errors.push(format!("security: {}", error)),
    }
    Err(format!(
        "failed to read Claude Code OAuth state: {}",
        errors.join("; ")
    ))
}

fn write_claude_code_oauth_blob(secret: &str) -> Result<(), String> {
    let mut errors = Vec::new();
    for account in claude_code_keychain_accounts() {
        match Entry::new(CLAUDE_CODE_KEYCHAIN_SERVICE, &account) {
            Ok(entry) => match entry.set_password(secret) {
                Ok(()) => return Ok(()),
                Err(error) => errors.push(format!("{}: {}", account, error)),
            },
            Err(error) => errors.push(format!("{}: {}", account, error)),
        }
    }
    if let Some(account) = discover_claude_code_keychain_account()
        .or_else(|| claude_code_keychain_accounts().into_iter().next())
    {
        match write_claude_code_oauth_blob_with_security(&account, secret) {
            Ok(()) => return Ok(()),
            Err(error) => errors.push(format!("security: {}", error)),
        }
    }
    Err(format!(
        "failed to write Claude Code OAuth state: {}",
        errors.join("; ")
    ))
}

#[cfg(target_os = "macos")]
fn delete_claude_code_oauth_blob_with_security() -> Result<(), String> {
    let output = Command::new("security")
        .arg("delete-generic-password")
        .arg("-s")
        .arg(CLAUDE_CODE_KEYCHAIN_SERVICE)
        .output()
        .map_err(|error| format!("security delete-generic-password failed to start: {}", error))?;
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let lower = stderr.to_ascii_lowercase();
    if lower.contains("could not be found") || lower.contains("no matching") {
        Ok(())
    } else if stderr.is_empty() {
        Err(format!("security delete-generic-password exited with {}", output.status))
    } else {
        Err(stderr)
    }
}

#[cfg(not(target_os = "macos"))]
fn delete_claude_code_oauth_blob_with_security() -> Result<(), String> {
    Ok(())
}

fn delete_claude_code_oauth_blob() -> Result<(), String> {
    let mut errors = Vec::new();
    for account in claude_code_keychain_accounts() {
        match Entry::new(CLAUDE_CODE_KEYCHAIN_SERVICE, &account) {
            Ok(entry) => match entry.delete_credential() {
                Ok(()) => {}
                Err(error) => {
                    let message = error.to_string();
                    let lower = message.to_ascii_lowercase();
                    if !lower.contains("no entry")
                        && !lower.contains("no matching")
                        && !lower.contains("not found")
                    {
                        errors.push(format!("{}: {}", account, message));
                    }
                }
            },
            Err(error) => errors.push(format!("{}: {}", account, error)),
        }
    }
    if let Err(error) = delete_claude_code_oauth_blob_with_security() {
        errors.push(format!("security: {}", error));
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "failed to clear Claude Code OAuth state: {}",
            errors.join("; ")
        ))
    }
}

fn reset_global_claude_oauth_login_state() -> Result<(), String> {
    let config_path = claude_global_config_json_path()?;
    if let Ok(raw_config) = fs::read_to_string(&config_path) {
        if let Ok(mut value) = serde_json::from_str::<JsonValue>(&raw_config) {
            if let Some(object) = value.as_object_mut() {
                object.remove("oauthAccount");
                object.remove("hasAvailableSubscription");
                object.remove("recommendedSubscription");
                let serialized = serde_json::to_string_pretty(&value)
                    .map_err(|error| format!("failed to serialize Claude config: {}", error))?;
                write_restricted_file(&config_path, &serialized)?;
            }
        }
    }
    delete_claude_code_oauth_blob()
}

fn parse_claude_oauth_secret(secret: &str) -> Result<ClaudeOAuthProfileSecret, String> {
    serde_json::from_str::<ClaudeOAuthProfileSecret>(secret)
        .map_err(|error| format!("failed to parse Claude OAuth profile state: {}", error))
}

fn claude_profile_config_dir(app_cache_dir: &Path, profile_id: &str) -> PathBuf {
    app_cache_dir
        .join("login-profiles")
        .join(profile_id)
        .join("claude-config")
}

fn prepare_claude_profile_config_dir(
    app_cache_dir: &Path,
    profile_id: &str,
) -> Result<PathBuf, String> {
    let config_dir = claude_profile_config_dir(app_cache_dir, profile_id);
    fs::create_dir_all(&config_dir)
        .map_err(|error| format!("failed to create profile Claude home: {}", error))?;
    fs::create_dir_all(config_dir.join(".claude"))
        .map_err(|error| format!("failed to create profile CLAUDE_CONFIG_DIR: {}", error))?;
    Ok(config_dir)
}

fn claude_global_config_json_path() -> Result<PathBuf, String> {
    dirs::home_dir()
        .map(|home| home.join(".claude.json"))
        .ok_or_else(|| "failed to resolve home directory for Claude config".to_string())
}

fn apply_claude_oauth_command_env(command: &mut Command, _claude_home_dir: &Path) {
    for key in ["HOME", "USER", "LOGNAME", "SHELL"] {
        if let Ok(value) = std::env::var(key) {
            command.env(key, value);
        }
    }
    command.env("PATH", crate::cli_path::build_tool_path());
    command.env_remove("CLAUDE_CONFIG_DIR");
    for key in [
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_AUTH_TOKEN",
        "ANTHROPIC_BASE_URL",
        "ANTHROPIC_MODEL",
        "ANTHROPIC_DEFAULT_HAIKU_MODEL",
        "ANTHROPIC_DEFAULT_OPUS_MODEL",
        "ANTHROPIC_DEFAULT_SONNET_MODEL",
        "CLAUDE_CODE_OAUTH_TOKEN",
    ] {
        command.env_remove(key);
    }
}

fn materialize_claude_oauth(
    profile: LoginProfile,
    secret: &str,
    app_cache_dir: PathBuf,
    mut env: HashMap<String, String>,
) -> Result<MaterializedRuntimeCredentials, String> {
    let profile_id = profile.id.clone();
    acquire_claude_oauth_activation(&profile_id)?;
    let result = (|| {
        let payload = parse_claude_oauth_secret(secret)?;
        let claude_config_dir = prepare_claude_profile_config_dir(&app_cache_dir, &profile.id)?;
        write_restricted_file(
            &claude_global_config_json_path()?,
            payload.claude_config_json.trim(),
        )?;
        write_claude_code_oauth_blob(payload.oauth_keychain_json.trim())?;
        for key in ["HOME", "USER", "LOGNAME", "SHELL"] {
            if let Ok(value) = std::env::var(key) {
                env.insert(key.to_string(), value);
            }
        }
        env.remove("CLAUDE_CONFIG_DIR");
        Ok(MaterializedRuntimeCredentials {
            profile_id: profile.id,
            provider: profile.provider,
            auth_type: profile.auth_type,
            env,
            codex_home: None,
            claude_config_dir: Some(claude_config_dir),
        })
    })();
    if result.is_err() {
        release_claude_oauth_activation(&profile_id);
    }
    result
}

pub fn persist_claude_oauth_state(
    db: &TelemetryDb,
    vault: &dyn CredentialVault,
    profile_id: &str,
    _claude_config_dir: &Path,
) -> Result<(), String> {
    let mut profile = db.get_login_profile(profile_id)?;
    if profile.provider != "claude" || profile.auth_type != "claude_oauth" {
        return Ok(());
    }
    let config_path = claude_global_config_json_path()?;
    let claude_config_json =
        fs::read_to_string(&config_path).map_err(|error| {
            format!(
                "failed to read Claude profile config {}: {}",
                config_path.display(),
                error
            )
        })?;
    let oauth_keychain_json = read_claude_code_oauth_blob()?;
    let payload = ClaudeOAuthProfileSecret {
        oauth_keychain_json: oauth_keychain_json.trim().to_string(),
        claude_config_json: claude_config_json.trim().to_string(),
    };
    let serialized = serde_json::to_string(&payload)
        .map_err(|error| format!("failed to serialize Claude OAuth state: {}", error))?;
    let account = secret_account_id(profile_id, "primary");
    vault.set_secret(&account, &serialized)?;
    profile.redacted_hint = None;
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
    fs::create_dir_all(&codex_home)
        .map_err(|error| format!("failed to create profile CODEX_HOME: {}", error))?;
    write_restricted_file(
        &codex_home.join("config.toml"),
        "cli_auth_credentials_store = \"file\"\n",
    )?;
    Ok(codex_home)
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
        if ch == '\u{1b}' && chars.peek() == Some(&'[') {
            let _ = chars.next();
            for next in chars.by_ref() {
                if next.is_ascii_alphabetic() {
                    break;
                }
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

fn parse_claude_login_url_line(line: &str) -> Option<String> {
    let cleaned = strip_ansi(line);
    let trimmed = cleaned.trim();
    let marker = "visit:";
    if let Some(index) = trimmed.find(marker) {
        return trimmed[index + marker.len()..]
            .split_whitespace()
            .next()
            .map(str::trim)
            .filter(|value| value.starts_with("http://") || value.starts_with("https://"))
            .map(ToOwned::to_owned);
    }
    trimmed
        .split_whitespace()
        .find(|part| part.starts_with("https://claude.com/") || part.starts_with("https://www.claude.com/"))
        .map(ToOwned::to_owned)
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
                crate::app_log!("[LOGIN_PROFILE] event=codex_login_device_code profile_id={}", profile_id);
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
        let message = db_result.err().unwrap_or_else(|| "failed to open telemetry db".to_string());
        let _ = app.emit(
            "login-profiles:changed",
            LoginProfilesChangedEvent {
                profile_id,
                status: "error".to_string(),
            },
        );
        crate::app_log!("[LOGIN_PROFILE] event=codex_login_db_open_failed error={}", message);
        return;
    };

    let vault = KeyringCredentialVault;
    match status {
        Ok(exit_status) if exit_status.success() => {
            crate::app_log!("[LOGIN_PROFILE] event=codex_login_process_completed profile_id={}", profile_id);
            let result = persist_codex_auth_state(&db, &vault, &profile_id, &codex_home)
                .and_then(|_| {
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
                    crate::app_log!("[LOGIN_PROFILE] event=codex_login_profile_ready profile_id={}", profile_id);
                    let _ = app.emit(
                        "login-profiles:changed",
                        LoginProfilesChangedEvent {
                            profile_id,
                            status: "ready".to_string(),
                        },
                    );
                }
                Err(error) => {
                    let _ = mark_login_profile_status(
                        &db,
                        &profile_id,
                        "error",
                        Some(error.clone()),
                    );
                    let _ = app.emit(
                        "login-profiles:changed",
                        LoginProfilesChangedEvent {
                            profile_id,
                            status: "error".to_string(),
                        },
                    );
                    crate::app_log!("[LOGIN_PROFILE] event=codex_login_persist_failed error={}", error);
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
    fs::write(path, contents)
        .map_err(|error| format!("failed to write {}: {}", path.display(), error))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))
            .map_err(|error| format!("failed to restrict {}: {}", path.display(), error))?;
    }
    Ok(())
}

fn command_output_with_timeout(command: &mut Command, timeout: Duration) -> Result<Output, String> {
    let mut child = command
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("failed to start live check: {}", error))?;
    let started_at = Instant::now();

    loop {
        match child.try_wait() {
            Ok(Some(_status)) => {
                return child
                    .wait_with_output()
                    .map_err(|error| format!("failed to collect live check output: {}", error));
            }
            Ok(None) => {
                if started_at.elapsed() >= timeout {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(
                        "Live check timed out before receiving a provider response.".to_string()
                    );
                }
                thread::sleep(Duration::from_millis(50));
            }
            Err(error) => {
                let _ = child.kill();
                return Err(format!("failed while waiting for live check: {}", error));
            }
        }
    }
}

fn live_check_model(profile: &LoginProfile) -> String {
    explicit_live_check_model(profile).unwrap_or_else(|| {
        if profile.provider == "claude" {
            "claude-sonnet-4-6".to_string()
        } else {
            "gpt-5.5".to_string()
        }
    })
}

fn explicit_live_check_model(profile: &LoginProfile) -> Option<String> {
    profile
        .config
        .get("live_check_model")
        .or_else(|| profile.config.get("model"))
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn concise_live_check_error(raw: &str) -> String {
    let mut message = raw
        .lines()
        .rev()
        .find_map(|line| {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                return None;
            }
            serde_json::from_str::<JsonValue>(trimmed)
                .ok()
                .and_then(|value| {
                    value
                        .get("content")
                        .or_else(|| value.get("final_content"))
                        .and_then(|field| field.as_str())
                        .map(str::trim)
                        .filter(|value| !value.is_empty())
                        .map(ToOwned::to_owned)
                })
                .or_else(|| Some(trimmed.to_string()))
        })
        .unwrap_or_else(|| "Live check failed without provider output.".to_string());
    if message.trim().is_empty() {
        message = "Live check failed without provider output.".to_string();
    }
    if message.len() > 500 {
        message.truncate(500);
        message.push('…');
    }
    message
}

fn status_from_live_check_error(message: &str) -> &'static str {
    let lower = message.to_ascii_lowercase();
    if lower.contains("auth")
        || lower.contains("unauthorized")
        || lower.contains("401")
        || lower.contains("login")
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

fn parse_live_check_success(output: &str) -> Option<String> {
    let mut completed = false;
    let mut final_content = None;
    let mut message_completed = None;
    for line in output.lines() {
        let Ok(value) = serde_json::from_str::<JsonValue>(line.trim()) else {
            continue;
        };
        match value.get("type").and_then(|field| field.as_str()) {
            Some("message_completed") => {
                message_completed = value
                    .get("content")
                    .and_then(|field| field.as_str())
                    .map(ToOwned::to_owned);
            }
            Some("provider_stop") => {
                completed = value
                    .get("provider_status")
                    .and_then(|field| field.as_str())
                    == Some("completed");
                final_content = value
                    .get("final_content")
                    .and_then(|field| field.as_str())
                    .map(ToOwned::to_owned);
            }
            _ => {}
        }
    }
    if !completed {
        return None;
    }
    final_content
        .filter(|value| !value.trim().is_empty())
        .or_else(|| message_completed.filter(|value| !value.trim().is_empty()))
}

fn run_codex_live_check(
    app: &tauri::AppHandle,
    profile: &LoginProfile,
    materialized: &MaterializedRuntimeCredentials,
) -> Result<String, String> {
    let script = crate::runtime_scripts::runtime_script_path(app, "codex-app-server-adapter.py")?;
    let mut command = Command::new(crate::runtime_scripts::runtime_python_command(app));
    command
        .arg(script)
        .arg("--model")
        .arg(live_check_model(profile))
        .arg("--cwd")
        .arg(std::env::temp_dir())
        .arg("hi")
        .env("PATH", crate::cli_path::build_tool_path());
    for (key, value) in &materialized.env {
        command.env(key, value);
    }
    let output = command_output_with_timeout(&mut command, LIVE_CHECK_TIMEOUT)?;
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    if output.status.success() {
        if let Some(response) = parse_live_check_success(&stdout) {
            return Ok(response);
        }
    }
    if stdout.trim().is_empty() && stderr.trim().is_empty() {
        return Err(format!("Live check process exited with {}.", output.status));
    }
    Err(concise_live_check_error(&format!("{}\n{}", stdout, stderr)))
}

fn run_claude_live_check(
    app: &tauri::AppHandle,
    profile: &LoginProfile,
    materialized: Option<&MaterializedRuntimeCredentials>,
) -> Result<String, String> {
    let script = crate::runtime_scripts::runtime_script_path(app, "claude-agent-sdk-adapter.mjs")?;
    let node = crate::cli_path::find_on_tool_path("node").unwrap_or_else(|| "node".to_string());
    let mut command = Command::new(node);
    command
        .arg(script)
        .arg("--permission-mode")
        .arg("bypassPermissions")
        .arg("hi")
        .current_dir(std::env::temp_dir())
        .env("PATH", crate::cli_path::build_tool_path());
    if let Some(model) = if materialized
        .map(|credentials| credentials.auth_type.as_str() == "claude_oauth")
        .unwrap_or(false)
    {
        explicit_live_check_model(profile)
    } else {
        Some(live_check_model(profile))
    } {
        command.arg("--model").arg(model);
    }
    if let Some(materialized) = materialized {
        if materialized.auth_type == "claude_oauth" {
            if let Some(claude_config_dir) = materialized.claude_config_dir.as_deref() {
                apply_claude_oauth_command_env(&mut command, claude_config_dir);
            }
        }
        for (key, value) in &materialized.env {
            command.env(key, value);
        }
    }
    let output = command_output_with_timeout(&mut command, LIVE_CHECK_TIMEOUT)?;
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    if output.status.success() {
        if let Some(response) = parse_live_check_success(&stdout) {
            return Ok(response);
        }
    }
    if stdout.trim().is_empty() && stderr.trim().is_empty() {
        return Err(format!("Live check process exited with {}.", output.status));
    }
    Err(concise_live_check_error(&format!("{}\n{}", stdout, stderr)))
}

fn run_claude_oauth_connect_smoke_check(claude_config_dir: &Path) -> Result<(), String> {
    let claude = crate::cli_path::find_on_tool_path("claude").unwrap_or_else(|| "claude".to_string());
    let mut command = Command::new(claude);
    command
        .arg("-p")
        .arg("--permission-mode")
        .arg("bypassPermissions")
        .arg("hi")
        .current_dir(std::env::temp_dir());
    apply_claude_oauth_command_env(&mut command, claude_config_dir);
    let output = command_output_with_timeout(&mut command, LIVE_CHECK_TIMEOUT)?;
    if output.status.success() {
        return Ok(());
    }
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    if stdout.trim().is_empty() && stderr.trim().is_empty() {
        return Err(format!("Claude login validation exited with {}.", output.status));
    }
    Err(format!(
        "Claude login validation failed: {}",
        concise_live_check_error(&format!("{}\n{}", stdout, stderr))
    ))
}

fn finish_claude_oauth_login_success(
    app: &tauri::AppHandle,
    db: &TelemetryDb,
    profile_id: &str,
    claude_config_dir: &Path,
) -> Result<LoginProfile, String> {
    persist_claude_oauth_state(db, &KeyringCredentialVault, profile_id, claude_config_dir)?;
    run_claude_oauth_connect_smoke_check(claude_config_dir)?;
    let profile = mark_login_profile_status(
        db,
        profile_id,
        "ready",
        Some("Claude account connected.".to_string()),
    )?;
    emit_login_profiles_changed(app, &profile);
    Ok(profile)
}

fn run_login_profile_live_check(
    app: &tauri::AppHandle,
    db: &TelemetryDb,
    vault: &dyn CredentialVault,
    profile: &LoginProfile,
    cache_dir: PathBuf,
) -> Result<String, String> {
    match (profile.provider.as_str(), profile.auth_type.as_str()) {
        ("claude", "external_cli") => run_claude_live_check(app, profile, None),
        ("codex", _) | ("claude", _) => {
            let materialized = resolve_runtime_credentials(db, vault, &profile.id, cache_dir)?;
            if materialized.provider != profile.provider {
                return Err(format!(
                    "Login profile is for {}, not {}.",
                    materialized.provider, profile.provider
                ));
            }
            match profile.provider.as_str() {
                "codex" => {
                    let result = run_codex_live_check(app, profile, &materialized);
                    if result.is_ok() {
                        if let Some(codex_home) = materialized.codex_home.as_deref() {
                            persist_codex_auth_state(db, vault, &profile.id, codex_home)?;
                        }
                    }
                    result
                }
                "claude" => {
                    let result = run_claude_live_check(app, profile, Some(&materialized));
                    if materialized.auth_type == "claude_oauth" {
                        if result.is_ok() {
                            if let Some(claude_config_dir) = materialized.claude_config_dir.as_deref()
                            {
                                if let Err(error) = persist_claude_oauth_state(
                                    db,
                                    vault,
                                    &profile.id,
                                    claude_config_dir,
                                ) {
                                    release_claude_oauth_activation(&profile.id);
                                    return Err(error);
                                }
                            }
                        }
                        release_claude_oauth_activation(&profile.id);
                    }
                    result
                }
                _ => Err(format!("Unsupported login provider: {}", profile.provider)),
            }
        }
        _ => Err(format!(
            "Unsupported login profile auth type: {}",
            profile.auth_type
        )),
    }
}

fn emit_login_profiles_changed(app: &tauri::AppHandle, profile: &LoginProfile) {
    let _ = app.emit(
        "login-profiles:changed",
        LoginProfilesChangedEvent {
            profile_id: profile.id.clone(),
            status: profile.status.clone(),
        },
    );
}

pub fn check_login_profile_readiness_with_vault(
    app: &tauri::AppHandle,
    db: &TelemetryDb,
    vault: &dyn CredentialVault,
    profile_id: &str,
) -> Result<LoginProfile, String> {
    let profile = db.get_login_profile(profile_id)?;
    let cache_dir = app
        .path()
        .app_cache_dir()
        .map_err(|error| format!("Could not resolve app cache dir: {}", error))?;
    let live_result = run_login_profile_live_check(app, db, vault, &profile, cache_dir);
    let (status, message) = match live_result {
        Ok(response) => (
            "ready",
            format!(
                "Live check succeeded. Received response: {}",
                response.trim()
            ),
        ),
        Err(error) => (
            status_from_live_check_error(&error),
            format!("Live check failed: {}", error),
        ),
    };
    db.mark_login_profile_status(profile_id, status, Some(&message), None, unix_timestamp())
}

fn spawn_login_profile_live_check(app: tauri::AppHandle, profile_id: String) {
    thread::spawn(move || {
        let db = app.state::<TelemetryDb>();
        let result = check_login_profile_readiness_with_vault(
            &app,
            &db,
            &KeyringCredentialVault,
            &profile_id,
        );
        match result {
            Ok(profile) => emit_login_profiles_changed(&app, &profile),
            Err(error) => {
                if let Ok(profile) = db.mark_login_profile_status(
                    &profile_id,
                    "unknown_error",
                    Some(&format!("Live check failed: {}", error)),
                    None,
                    unix_timestamp(),
                ) {
                    emit_login_profiles_changed(&app, &profile);
                }
            }
        }
    });
}

fn enqueue_login_profile_live_check(
    app: tauri::AppHandle,
    db: &TelemetryDb,
    profile_id: &str,
) -> Result<LoginProfile, String> {
    let profile = db.mark_login_profile_status(
        profile_id,
        "checking",
        Some("Running a live check with a tiny `hi` prompt. The result will appear here shortly."),
        None,
        unix_timestamp(),
    )?;
    emit_login_profiles_changed(&app, &profile);
    spawn_login_profile_live_check(app, profile_id.to_string());
    Ok(profile)
}

#[tauri::command]
#[specta::specta]
pub fn list_login_profiles(db: State<TelemetryDb>) -> Result<Vec<LoginProfile>, String> {
    db.list_login_profiles()
}

#[tauri::command]
#[specta::specta]
pub fn upsert_login_profile(
    db: State<TelemetryDb>,
    request: UpsertLoginProfileRequest,
) -> Result<LoginProfile, String> {
    upsert_login_profile_with_vault(&db, &KeyringCredentialVault, request)
}

#[tauri::command]
#[specta::specta]
pub fn delete_login_profile(db: State<TelemetryDb>, profile_id: String) -> Result<(), String> {
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
    enqueue_login_profile_live_check(app, &db, &profile_id)
}

#[tauri::command]
#[specta::specta]
pub fn connect_codex_login_profile(
    app: tauri::AppHandle,
    db: State<TelemetryDb>,
    profile_id: String,
) -> Result<CodexLoginStart, String> {
    let profile = db.get_login_profile(&profile_id)?;
    if profile.provider != "codex" || profile.auth_type != "codex_chatgpt_session" {
        return Err("Connect is only supported for managed Codex ChatGPT session profiles.".to_string());
    }
    let cache_dir = app
        .path()
        .app_cache_dir()
        .map_err(|error| format!("failed to resolve app cache dir: {}", error))?;
    let codex_home = prepare_codex_profile_home(&cache_dir, &profile.id)?;
    let codex = crate::cli_path::find_on_tool_path("codex").unwrap_or_else(|| "codex".to_string());
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
        &db,
        &profile.id,
        "checking",
        Some("Waiting for Codex browser sign in.".to_string()),
    );
    emit_login_profiles_changed(&app, &LoginProfile {
        status: "checking".to_string(),
        ..profile.clone()
    });

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
    if let Err(error) = app
        .opener()
        .open_url(CODEX_DEVICE_LOGIN_URL, None::<&str>)
    {
        crate::app_log!("[LOGIN_PROFILE] event=codex_login_open_browser_failed error={}", error);
    }
    Ok(CodexLoginStart {
        profile_id: profile.id,
        device_url: CODEX_DEVICE_LOGIN_URL.to_string(),
        device_code,
    })
}

#[tauri::command]
#[specta::specta]
pub fn connect_claude_oauth_login_profile(
    app: tauri::AppHandle,
    db: State<TelemetryDb>,
    profile_id: String,
) -> Result<ClaudeOAuthLoginStart, String> {
    let profile = db.get_login_profile(&profile_id)?;
    if profile.provider != "claude" || profile.auth_type != "claude_oauth" {
        return Err("Connect is only supported for Claude subscription profiles.".to_string());
    }
    acquire_claude_oauth_activation(&profile.id)?;
    let result = (|| {
        let cache_dir = app
            .path()
            .app_cache_dir()
            .map_err(|error| format!("failed to resolve app cache dir: {}", error))?;
        let claude_config_dir = prepare_claude_profile_config_dir(&cache_dir, &profile.id)?;
        reset_global_claude_oauth_login_state()?;
        let claude =
            crate::cli_path::find_on_tool_path("claude").unwrap_or_else(|| "claude".to_string());
        let mut command = Command::new(claude);
        command
            .arg("auth")
            .arg("login")
            .arg("--claudeai")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        apply_claude_oauth_command_env(&mut command, &claude_config_dir);
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
        let _ = mark_login_profile_status(
            &db,
            &profile.id,
            "checking",
            Some("Waiting for Claude browser sign in.".to_string()),
        );
        emit_login_profiles_changed(&app, &LoginProfile {
            status: "checking".to_string(),
            ..profile.clone()
        });

        let started_at = Instant::now();
        let mut reader = BufReader::new(stdout);
        let mut login_url = None;
        let mut line = String::new();
        while started_at.elapsed() < CLAUDE_LOGIN_START_TIMEOUT {
            line.clear();
            match reader.read_line(&mut line) {
                Ok(0) => break,
                Ok(_) => {
                    if let Some(url) = parse_claude_login_url_line(&line) {
                        login_url = Some(url);
                        break;
                    }
                }
                Err(error) => {
                    return Err(format!("failed to read Claude login output: {}", error));
                }
            }
        }
        let stdout = reader.into_inner();
        let login_url =
            login_url.ok_or_else(|| "Claude did not print a browser login URL.".to_string())?;
        pending_claude_oauth_logins()
            .lock()
            .map_err(|_| "Claude login state lock is poisoned.".to_string())?
            .insert(
                profile.id.clone(),
                PendingClaudeOAuthLogin {
                    child,
                    stdin,
                    _stdout: stdout,
                    claude_config_dir,
                    started_at: process_started_at,
                },
            );
        if let Err(error) = app.opener().open_url(&login_url, None::<&str>) {
            crate::app_log!(
                "[LOGIN_PROFILE] event=claude_login_open_browser_failed error={}",
                error
            );
        }
        Ok(ClaudeOAuthLoginStart {
            profile_id: profile.id,
            login_url,
        })
    })();
    if result.is_err() {
        release_claude_oauth_activation(&profile_id);
    }
    result
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

    match pending.child.try_wait() {
        Ok(None) => {
            let global_config_updated = claude_global_config_json_path()
                .ok()
                .and_then(|path| fs::metadata(path).ok())
                .and_then(|metadata| metadata.modified().ok())
                .map(|modified| modified >= pending.started_at)
                .unwrap_or(false);
            if global_config_updated {
                match finish_claude_oauth_login_success(
                    app,
                    db,
                    profile_id,
                    &pending.claude_config_dir,
                ) {
                    Ok(profile) => {
                        let _ = pending.child.kill();
                        let _ = pending.child.wait();
                        release_claude_oauth_activation(profile_id);
                        return Ok(profile);
                    }
                    Err(error) => {
                        crate::app_log!(
                            "[LOGIN_PROFILE] event=claude_oauth_login_state_not_ready profile_id={} error={}",
                            profile_id,
                            error
                        );
                    }
                }
            }
            pending_claude_oauth_logins()
                .lock()
                .map_err(|_| "Claude login state lock is poisoned.".to_string())?
                .insert(profile_id.to_string(), pending);
            db.get_login_profile(profile_id)
        }
        Ok(Some(status)) if status.success() => {
            let profile = finish_claude_oauth_login_success(
                app,
                db,
                profile_id,
                &pending.claude_config_dir,
            )?;
            release_claude_oauth_activation(profile_id);
            Ok(profile)
        }
        Ok(Some(status)) => {
            release_claude_oauth_activation(profile_id);
            let message = format!("Claude login exited with status {}.", status);
            let profile = mark_login_profile_status(db, profile_id, "error", Some(message.clone()))?;
            emit_login_profiles_changed(app, &profile);
            Err(message)
        }
        Err(error) => {
            release_claude_oauth_activation(profile_id);
            let message = format!("failed to check Claude login status: {}", error);
            let profile = mark_login_profile_status(db, profile_id, "error", Some(message.clone()))?;
            emit_login_profiles_changed(app, &profile);
            Err(message)
        }
    }
}

#[tauri::command]
#[specta::specta]
pub fn poll_claude_oauth_login_profile(
    app: tauri::AppHandle,
    db: State<TelemetryDb>,
    profile_id: String,
) -> Result<LoginProfile, String> {
    poll_claude_oauth_login(&app, &db, &profile_id)
}

#[tauri::command]
#[specta::specta]
pub fn submit_claude_oauth_login_code(
    app: tauri::AppHandle,
    db: State<TelemetryDb>,
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
        pending
            .stdin
            .write_all(format!("{}\n", trimmed_code).as_bytes())
            .map_err(|error| format!("failed to submit Claude login code: {}", error))?;
        drop(pending.stdin);
        let status = pending
            .child
            .wait()
            .map_err(|error| format!("failed to wait for Claude login: {}", error))?;
        if !status.success() {
            return Err(format!("Claude login exited with status {}.", status));
        }
        persist_claude_oauth_state(
            &db,
            &KeyringCredentialVault,
            &profile_id,
            &pending.claude_config_dir,
        )
        .and_then(|_| {
            run_claude_oauth_connect_smoke_check(&pending.claude_config_dir)?;
            mark_login_profile_status(
                &db,
                &profile_id,
                "ready",
                Some("Claude account connected.".to_string()),
            )
        })
    })();
    release_claude_oauth_activation(&profile_id);
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
pub fn check_all_login_profile_readiness(
    app: tauri::AppHandle,
    db: State<TelemetryDb>,
) -> Result<Vec<LoginProfile>, String> {
    let profiles = db.list_login_profiles()?;
    for profile in profiles {
        let _ = enqueue_login_profile_live_check(app.clone(), &db, &profile.id);
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
    _codex_auth_paths: Vec<(String, PathBuf, String)>,
    _claude_cli_available: bool,
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

fn default_codex_auth_sources() -> Vec<(String, PathBuf, String)> {
    Vec::new()
}

fn claude_cli_auth_available() -> bool {
    Command::new("claude")
        .args(["auth", "status"])
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
}

#[tauri::command]
#[specta::specta]
pub fn discover_login_import_candidates() -> Result<Vec<LoginImportCandidate>, String> {
    let env = std::env::vars().collect::<HashMap<_, _>>();
    Ok(discover_login_import_candidates_from_sources(
        &env,
        default_codex_auth_sources(),
        claude_cli_auth_available(),
    ))
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

pub fn import_discovered_login_profile_with_vault_and_sources(
    db: &TelemetryDb,
    vault: &dyn CredentialVault,
    env: &HashMap<String, String>,
    _codex_auth_paths: &[(String, PathBuf, String)],
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
    db: State<TelemetryDb>,
    request: ImportLoginCandidateRequest,
) -> Result<LoginProfile, String> {
    let env = std::env::vars().collect::<HashMap<_, _>>();
    import_discovered_login_profile_with_vault_and_sources(
        &db,
        &KeyringCredentialVault,
        &env,
        &default_codex_auth_sources(),
        request,
    )
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

    struct MemoryVault {
        secrets: Mutex<HashMap<String, String>>,
    }

    impl MemoryVault {
        fn new() -> Self {
            Self {
                secrets: Mutex::new(HashMap::new()),
            }
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
    fn discovery_candidates_redact_env_sources_without_codex_auth_files() {
        let temp = tempfile::tempdir().expect("tempdir");
        let codex_home = temp.path().join("codex-home");
        fs::create_dir_all(&codex_home).expect("codex home");
        fs::write(
            codex_home.join("auth.json"),
            r#"{"tokens":{"access_token":"secret"}}"#,
        )
        .expect("auth json");
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

        let candidates = discover_login_import_candidates_from_sources(
            &env,
            vec![(
                "file:codex:test".to_string(),
                codex_home.join("auth.json"),
                "test auth.json".to_string(),
            )],
            false,
        );

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

        let imported = import_discovered_login_profile_with_vault_and_sources(
            &db,
            &vault,
            &env,
            &[],
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
    fn importing_external_cli_candidate_reuses_existing_profile() {
        let (_dir, db) = open_test_db();
        let vault = MemoryVault::new();
        let env = HashMap::new();

        let first = import_discovered_login_profile_with_vault_and_sources(
            &db,
            &vault,
            &env,
            &[],
            ImportLoginCandidateRequest {
                candidate_id: "cli:claude".to_string(),
                display_name: Some("Claude CLI login".to_string()),
                make_default: Some(false),
            },
        )
        .expect("import cli profile");
        let second = import_discovered_login_profile_with_vault_and_sources(
            &db,
            &vault,
            &env,
            &[],
            ImportLoginCandidateRequest {
                candidate_id: "cli:claude".to_string(),
                display_name: Some("Claude CLI again".to_string()),
                make_default: Some(false),
            },
        )
        .expect("reuse cli profile");

        assert_eq!(first.id, second.id);
        assert_eq!(db.list_login_profiles().expect("profiles").len(), 1);
    }

    #[test]
    fn importing_discovered_codex_auth_file_is_not_supported() {
        let (_dir, db) = open_test_db();
        let vault = MemoryVault::new();
        let env = HashMap::new();
        let temp = tempfile::tempdir().expect("tempdir");
        let auth_path = temp.path().join("auth.json");
        fs::write(&auth_path, r#"{"tokens":{"access_token":"secret"}}"#).expect("auth json");

        let error = import_discovered_login_profile_with_vault_and_sources(
            &db,
            &vault,
            &env,
            &[(
                "file:codex:test".to_string(),
                auth_path,
                "test auth.json".to_string(),
            )],
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
    fn live_check_error_status_classifies_auth_and_usage_failures() {
        assert_eq!(
            status_from_live_check_error("Unauthorized: invalid API key"),
            "auth_missing"
        );
        assert_eq!(
            status_from_live_check_error("usageLimitExceeded: rate limit reached"),
            "usage_limited"
        );
        assert_eq!(status_from_live_check_error("model not found"), "invalid");
    }

    #[test]
    fn live_check_success_requires_completed_provider_response() {
        let output = r#"
{"type":"message_completed","content":"Hello!"}
{"type":"provider_stop","provider_status":"completed","final_content":"Hello!"}
"#;
        assert_eq!(parse_live_check_success(output).as_deref(), Some("Hello!"));

        let failed_output = r#"
{"type":"provider_stop","provider_status":"failed","final_content":"Nope"}
"#;
        assert_eq!(parse_live_check_success(failed_output), None);
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
}
