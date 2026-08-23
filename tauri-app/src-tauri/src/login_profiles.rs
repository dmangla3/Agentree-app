use keyring::Entry;
use serde::{Deserialize, Serialize};
use serde_json::{Map as JsonMap, Value as JsonValue};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{Emitter, Manager, State};
use uuid::Uuid;

use crate::db::TelemetryDb;

const KEYCHAIN_SERVICE: &str = "com.agentree.agentree.login-profiles";
const LIVE_CHECK_TIMEOUT: Duration = Duration::from_secs(45);

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

#[derive(Debug, Clone)]
#[allow(dead_code)]
pub struct MaterializedRuntimeCredentials {
    pub profile_id: String,
    pub provider: String,
    pub auth_type: String,
    pub env: HashMap<String, String>,
    pub codex_home: Option<PathBuf>,
}

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
        "codex" => matches!(
            auth_type,
            "codex_chatgpt_session" | "codex_api_key" | "external_cli"
        ),
        "claude" => matches!(
            auth_type,
            "claude_api_key"
                | "claude_auth_token"
                | "claude_bedrock"
                | "claude_vertex"
                | "claude_azure_foundry"
                | "external_cli"
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
    if existing.is_none() && auth_type != "external_cli" && secret.is_none() {
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
        "claude_auth_token" => {
            env.insert("ANTHROPIC_AUTH_TOKEN".to_string(), secret.to_string());
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
    })
}

fn materialize_codex_home(
    profile: LoginProfile,
    secret: &str,
    app_cache_dir: PathBuf,
    mut env: HashMap<String, String>,
) -> Result<MaterializedRuntimeCredentials, String> {
    let codex_home = app_cache_dir
        .join("login-profiles")
        .join(&profile.id)
        .join("codex-home");
    fs::create_dir_all(&codex_home)
        .map_err(|error| format!("failed to create profile CODEX_HOME: {}", error))?;
    write_restricted_file(&codex_home.join("auth.json"), secret)?;
    write_restricted_file(
        &codex_home.join("config.toml"),
        "cli_auth_credentials_store = \"file\"\n",
    )?;
    env.insert(
        "CODEX_HOME".to_string(),
        codex_home.to_string_lossy().into_owned(),
    );
    materialized(profile, env, Some(codex_home))
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
    profile
        .config
        .get("live_check_model")
        .or_else(|| profile.config.get("model"))
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| {
            if profile.provider == "claude" {
                "claude-sonnet-4-6".to_string()
            } else {
                "gpt-5.5".to_string()
            }
        })
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
                        .map(ToOwned::to_owned)
                })
                .or_else(|| Some(trimmed.to_string()))
        })
        .unwrap_or_else(|| "Live check failed without provider output.".to_string());
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
        .arg("--model")
        .arg(live_check_model(profile))
        .arg("--permission-mode")
        .arg("bypassPermissions")
        .arg("hi")
        .current_dir(std::env::temp_dir())
        .env("PATH", crate::cli_path::build_tool_path());
    if let Some(materialized) = materialized {
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
    Err(concise_live_check_error(&format!("{}\n{}", stdout, stderr)))
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
                "codex" => run_codex_live_check(app, profile, &materialized),
                "claude" => run_claude_live_check(app, profile, Some(&materialized)),
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
    codex_auth_paths: Vec<(String, PathBuf, String)>,
    claude_cli_available: bool,
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
    if let Some(candidate) = env_import_candidate(
        env,
        "ANTHROPIC_AUTH_TOKEN",
        "claude",
        "claude_auth_token",
        "Anthropic auth token",
    ) {
        candidates.push(candidate);
    }

    for (id, path, label) in codex_auth_paths {
        let Ok(metadata) = fs::metadata(&path) else {
            continue;
        };
        if !metadata.is_file() || metadata.len() == 0 {
            continue;
        }
        candidates.push(LoginImportCandidate {
            id,
            provider: "codex".to_string(),
            display_name: "Codex ChatGPT session".to_string(),
            auth_type: "codex_chatgpt_session".to_string(),
            source_kind: "file".to_string(),
            source_label: label,
            redacted_hint: Some("auth.json".to_string()),
            importable: true,
        });
    }

    if claude_cli_available {
        candidates.push(LoginImportCandidate {
            id: "cli:claude".to_string(),
            provider: "claude".to_string(),
            display_name: "Claude CLI login".to_string(),
            auth_type: "external_cli".to_string(),
            source_kind: "cli".to_string(),
            source_label: "claude auth status".to_string(),
            redacted_hint: None,
            importable: true,
        });
    }

    candidates
}

fn default_codex_auth_sources() -> Vec<(String, PathBuf, String)> {
    let mut sources = Vec::new();
    let mut seen = HashSet::new();

    if let Ok(codex_home) = std::env::var("CODEX_HOME") {
        let trimmed = codex_home.trim();
        if !trimmed.is_empty() {
            let path = PathBuf::from(trimmed).join("auth.json");
            if seen.insert(path.clone()) {
                sources.push((
                    "file:codex:codex_home".to_string(),
                    path,
                    "CODEX_HOME/auth.json".to_string(),
                ));
            }
        }
    }

    if let Some(home) = dirs::home_dir() {
        let path = home.join(".codex").join("auth.json");
        if seen.insert(path.clone()) {
            sources.push((
                "file:codex:home".to_string(),
                path,
                "~/.codex/auth.json".to_string(),
            ));
        }
    }

    sources
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

fn existing_external_cli_profile(db: &TelemetryDb, provider: &str) -> Option<LoginProfile> {
    db.list_login_profiles()
        .ok()?
        .into_iter()
        .find(|profile| profile.provider == provider && profile.auth_type == "external_cli")
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

fn cleanup_duplicate_external_cli_profiles(
    db: &TelemetryDb,
    vault: &dyn CredentialVault,
    keep_profile_id: &str,
    provider: &str,
) -> Result<(), String> {
    let profiles = db.list_login_profiles()?;
    for profile in profiles {
        if profile.id == keep_profile_id
            || profile.provider != provider
            || profile.auth_type != "external_cli"
        {
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
    codex_auth_paths: &[(String, PathBuf, String)],
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
            let secret = env
                .get("ANTHROPIC_AUTH_TOKEN")
                .map(String::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| "ANTHROPIC_AUTH_TOKEN is not available".to_string())?;
            upsert_imported_managed_profile(
                db,
                vault,
                "claude",
                "claude_auth_token",
                "ANTHROPIC_AUTH_TOKEN",
                display_name_or_default(request.display_name, "Anthropic auth token"),
                secret.to_string(),
                request.make_default,
            )
        }
        "cli:claude" => {
            if let Some(profile) = existing_external_cli_profile(db, "claude") {
                cleanup_duplicate_external_cli_profiles(db, vault, &profile.id, "claude")?;
                return Ok(profile);
            }
            let display_name = display_name_or_default(request.display_name, "Claude CLI login");
            let now = unix_timestamp();
            let profile = LoginProfile {
                id: Uuid::new_v4().to_string(),
                provider: "claude".to_string(),
                display_name,
                auth_type: "external_cli".to_string(),
                redacted_hint: None,
                config: serde_json::json!({
                    "read_only": true,
                    "imported_from": "claude auth status",
                }),
                status: "unchecked".to_string(),
                status_message: Some(
                    "External Claude CLI login is tracked as read-only.".to_string(),
                ),
                plan_type: None,
                is_default: request.make_default.unwrap_or(false),
                created_at: now,
                updated_at: now,
                last_checked_at: None,
            };
            let profile = db.upsert_login_profile_metadata(&profile, None)?;
            cleanup_duplicate_external_cli_profiles(db, vault, &profile.id, "claude")?;
            Ok(profile)
        }
        candidate_id if candidate_id.starts_with("file:codex:") => {
            let (_, path, label) = codex_auth_paths
                .iter()
                .find(|(id, _, _)| id == candidate_id)
                .ok_or_else(|| "selected Codex auth file is not available".to_string())?;
            let auth_json = fs::read_to_string(path)
                .map_err(|error| format!("could not read Codex auth file: {}", error))?;
            if auth_json.trim().is_empty() {
                return Err("selected Codex auth file is empty".to_string());
            }
            upsert_imported_managed_profile(
                db,
                vault,
                "codex",
                "codex_chatgpt_session",
                label,
                display_name_or_default(request.display_name, "Codex ChatGPT session"),
                auth_json,
                request.make_default,
            )
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
    db: &TelemetryDb,
    vault: &dyn CredentialVault,
    provider: &str,
    display_name: &str,
) -> Result<LoginProfile, String> {
    match provider.trim().to_ascii_lowercase().as_str() {
        "codex" => {
            let auth_path = std::env::var("CODEX_HOME")
                .ok()
                .filter(|value| !value.trim().is_empty())
                .map(PathBuf::from)
                .or_else(|| dirs::home_dir().map(|home| home.join(".codex")))
                .map(|home| home.join("auth.json"))
                .ok_or_else(|| "could not resolve Codex auth path".to_string())?;
            let auth_json = fs::read_to_string(&auth_path)
                .map_err(|error| format!("could not read Codex auth file: {}", error))?;
            let imported_from = auth_path.to_string_lossy().to_string();
            upsert_imported_managed_profile(
                db,
                vault,
                "codex",
                "codex_chatgpt_session",
                &imported_from,
                display_name.to_string(),
                auth_json,
                Some(true),
            )
        }
        "claude" => {
            if let Some(profile) = existing_external_cli_profile(db, "claude") {
                cleanup_duplicate_external_cli_profiles(db, vault, &profile.id, "claude")?;
                return Ok(profile);
            }
            let now = unix_timestamp();
            let profile = LoginProfile {
                id: Uuid::new_v4().to_string(),
                provider: "claude".to_string(),
                display_name: display_name.trim().to_string(),
                auth_type: "external_cli".to_string(),
                redacted_hint: None,
                config: serde_json::json!({ "read_only": true }),
                status: "unchecked".to_string(),
                status_message: Some(
                    "External Claude CLI login is tracked as read-only.".to_string(),
                ),
                plan_type: None,
                is_default: false,
                created_at: now,
                updated_at: now,
                last_checked_at: None,
            };
            let profile = db.upsert_login_profile_metadata(&profile, None)?;
            cleanup_duplicate_external_cli_profiles(db, vault, &profile.id, "claude")?;
            Ok(profile)
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
    fn discovery_candidates_redact_env_and_codex_auth_file_sources() {
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
        assert!(candidates
            .iter()
            .any(|candidate| candidate.id == "file:codex:test"
                && candidate.auth_type == "codex_chatgpt_session"
                && candidate.redacted_hint.as_deref() == Some("auth.json")));
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
