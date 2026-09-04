use keyring::Entry;
use serde::{Deserialize, Serialize};
use serde_json::{Map as JsonMap, Value as JsonValue};
use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::sync::{mpsc, Arc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{Emitter, Manager, State};
use tauri_plugin_opener::OpenerExt;
use uuid::Uuid;

use crate::db::TelemetryDb;

const KEYCHAIN_SERVICE: &str = "com.agentree.agentree.login-profiles";
const LIVE_CHECK_TIMEOUT: Duration = Duration::from_secs(45);
const CODEX_DEVICE_LOGIN_URL: &str = "https://auth.openai.com/codex/device";
const CODEX_LOGIN_START_TIMEOUT: Duration = Duration::from_secs(20);
const CLAUDE_LOGIN_START_TIMEOUT: Duration = Duration::from_secs(20);
const CLAUDE_LOGIN_PENDING_TIMEOUT: Duration = Duration::from_secs(15 * 60);
const CLAUDE_LOGIN_CODE_TIMEOUT: Duration = Duration::from_secs(120);

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
}

struct PendingClaudeOAuthLogin {
    child: std::process::Child,
    stdin: std::process::ChildStdin,
    output: Arc<Mutex<String>>,
    started_at: SystemTime,
}

static PENDING_CLAUDE_OAUTH_LOGINS: OnceLock<Mutex<HashMap<String, PendingClaudeOAuthLogin>>> =
    OnceLock::new();

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
    let allows_deferred_secret = (provider == "codex" && auth_type == "codex_chatgpt_session")
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

const CLAUDE_SETUP_TOKEN_PREFIX: &str = "sk-ant-oat";

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
            Some(line.to_string())
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
    let start = cleaned.find(CLAUDE_SETUP_TOKEN_PREFIX)?;
    let token: String = cleaned[start..]
        .chars()
        .take_while(|ch| ch.is_ascii_alphanumeric() || *ch == '-' || *ch == '_')
        .collect();
    if token.len() >= 40 {
        Some(token)
    } else {
        None
    }
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
    if !token.starts_with(CLAUDE_SETUP_TOKEN_PREFIX) {
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
        return Some(LiveCheckFailure {
            code: Some("claude_runtime_missing".to_string()),
            message: format!(
                "Claude runtime dependency is missing or broken: {}. Reinstall or repair the Claude runtime.",
                line
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
        .unwrap_or_else(|| LiveCheckFailure::uncoded("Live check failed without provider output."));
    LiveCheckFailure {
        code: failure.code,
        message: truncate_live_check_message(failure.message),
    }
}

fn status_for_live_check_failure(failure: &LiveCheckFailure) -> &'static str {
    match failure.code.as_deref() {
        Some("auth_missing") | Some("codex_auth_missing") | Some("claude_auth_missing") => {
            return "auth_missing"
        }
        Some("usage_limited") | Some("rate_limited") => return "usage_limited",
        Some("claude_runtime_missing")
        | Some("codex_cli_missing")
        | Some("codex_cli_outdated")
        | Some("node_runtime_missing")
        | Some("codex_transport_closed") => return "unknown_error",
        _ => {}
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

fn run_codex_live_check(
    app: &tauri::AppHandle,
    profile: &LoginProfile,
    materialized: &MaterializedRuntimeCredentials,
) -> Result<String, LiveCheckFailure> {
    crate::managed_runtime::ensure_component_best_effort(
        app,
        crate::managed_runtime::COMPONENT_CODEX,
    );
    let command_plan = crate::runtime_scripts::codex_adapter_command(app)?;
    let mut command = Command::new(&command_plan.program);
    command
        .args(command_plan.args_prefix)
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
        return Err(LiveCheckFailure::uncoded(format!(
            "Live check process exited with {}.",
            output.status
        )));
    }
    Err(live_check_failure_with_log(
        app,
        &format!("codex live check (profile {})", profile.id),
        &stdout,
        &stderr,
    ))
}

fn run_claude_live_check(
    app: &tauri::AppHandle,
    profile: &LoginProfile,
    materialized: Option<&MaterializedRuntimeCredentials>,
) -> Result<String, LiveCheckFailure> {
    let invocation = crate::managed_runtime::claude_adapter_invocation(app)?;
    let mut command = Command::new(&invocation.node_program);
    command
        .arg(&invocation.adapter_script)
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
        scrub_claude_auth_env(&mut command);
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
        return Err(LiveCheckFailure::uncoded(format!(
            "Live check process exited with {}.",
            output.status
        )));
    }
    Err(live_check_failure_with_log(
        app,
        &format!("claude live check (profile {})", profile.id),
        &stdout,
        &stderr,
    ))
}

/// Validates a freshly connected OAuth token through the same SDK adapter
/// the live check uses — previously this went through the `claude` CLI from
/// PATH, so connect could "succeed" via one toolchain and the live check
/// then fail via another.
fn run_claude_oauth_connect_smoke_check(app: &tauri::AppHandle, token: &str) -> Result<(), String> {
    let invocation = crate::managed_runtime::claude_adapter_invocation(app)
        .map_err(|error| format!("Claude login validation failed: {}", error))?;
    let mut command = Command::new(&invocation.node_program);
    command
        .arg(&invocation.adapter_script)
        .arg("--permission-mode")
        .arg("bypassPermissions")
        .arg("hi")
        .current_dir(std::env::temp_dir())
        .env("PATH", crate::cli_path::build_tool_path());
    scrub_claude_auth_env(&mut command);
    command.env("CLAUDE_CODE_OAUTH_TOKEN", token.trim());
    let output = command_output_with_timeout(&mut command, LIVE_CHECK_TIMEOUT)?;
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    if output.status.success() && parse_live_check_success(&stdout).is_some() {
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

fn run_login_profile_live_check(
    app: &tauri::AppHandle,
    db: &TelemetryDb,
    vault: &dyn CredentialVault,
    profile: &LoginProfile,
    cache_dir: PathBuf,
) -> Result<String, LiveCheckFailure> {
    match (profile.provider.as_str(), profile.auth_type.as_str()) {
        ("claude", "external_cli") => run_claude_live_check(app, profile, None),
        ("codex", _) | ("claude", _) => {
            let materialized = resolve_runtime_credentials(db, vault, &profile.id, cache_dir)?;
            if materialized.provider != profile.provider {
                return Err(LiveCheckFailure::uncoded(format!(
                    "Login profile is for {}, not {}.",
                    materialized.provider, profile.provider
                )));
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
                "claude" => run_claude_live_check(app, profile, Some(&materialized)),
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
        Err(failure) => (
            status_for_live_check_failure(&failure),
            format!("Live check failed: {}", failure.message),
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

pub fn reconcile_login_profiles_on_startup(db: &TelemetryDb) -> Result<usize, String> {
    let profiles = db.list_login_profiles()?;
    let mut reconciled = 0usize;
    for profile in profiles {
        if profile.status == "checking" {
            db.mark_login_profile_status(
                &profile.id,
                "unchecked",
                Some("Previous sign in or live check was interrupted. Re-check or reconnect this account."),
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
        return Err(
            "Connect is only supported for managed Codex ChatGPT session profiles.".to_string(),
        );
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
    emit_login_profiles_changed(
        &app,
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
        let claude =
            crate::cli_path::find_on_tool_path("claude").unwrap_or_else(|| "claude".to_string());
        let mut command = claude_setup_token_command(&claude, &cache_dir)?;
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
            // Surface raw TUI output in the app log so failed sign-ins are
            // diagnosable from the field.
            if snapshot.len() > logged_output_len {
                let fresh = strip_ansi(&snapshot[logged_output_len..]);
                let fresh = fresh.trim();
                if !fresh.is_empty() && !fresh.contains(CLAUDE_SETUP_TOKEN_PREFIX) {
                    crate::app_log!(
                        "[LOGIN_PROFILE] event=claude_setup_token_output profile_id={} output={}",
                        profile_id,
                        fresh.replace(['\r', '\n'], " | ")
                    );
                }
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
        assert_eq!(status_for_live_check_failure(&failure), "unknown_error");
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

    #[test]
    fn claude_oauth_profile_injects_setup_token_environment() {
        let materialized = materialize_runtime_credentials_for_test(
            "profile-claude-oauth",
            "claude",
            "claude_oauth",
            "sk-ant-oat01-abcdefghijklmnopqrstuvwxyz0123456789ABCD",
            serde_json::json!({}),
        )
        .expect("credentials materialize");

        assert_eq!(
            materialized
                .env
                .get("CLAUDE_CODE_OAUTH_TOKEN")
                .map(String::as_str),
            Some("sk-ant-oat01-abcdefghijklmnopqrstuvwxyz0123456789ABCD")
        );
        assert!(materialized.codex_home.is_none());
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
        let raw = "\u{1b}[32mYour token:\u{1b}[0m sk-ant-oat01-abcdefghijklmnopqrstuvwxyz0123456789ABCD\r\nStore it somewhere safe.";
        let token = extract_claude_setup_token(raw).expect("token extracted");
        assert_eq!(
            token,
            "sk-ant-oat01-abcdefghijklmnopqrstuvwxyz0123456789ABCD"
        );
    }

    #[test]
    fn ignores_short_token_like_fragments() {
        assert!(extract_claude_setup_token("sk-ant-oat01-tooshort").is_none());
    }

    #[test]
    fn strip_ansi_removes_osc_hyperlink_sequences() {
        let raw = "before \u{1b}]8;;https://example.test\u{7}label\u{1b}]8;;\u{7} after";
        assert_eq!(strip_ansi(raw), "before label after");
    }
}
