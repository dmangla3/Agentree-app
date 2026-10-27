use serde::{Deserialize, Serialize};
use serde_json::{json, Value as JsonValue};
use std::collections::HashMap;
use std::fs;
use std::process::{Command, Output};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::db::TelemetryDb;
use crate::login_profiles::{KeyringCredentialVault, MaterializedRuntimeCredentials};
use crate::process_runner::command_output_with_timeout;

const CACHE_PREFIX: &str = "runtime_model_catalog:v1";
const CATALOG_TTL_MS: i64 = 24 * 60 * 60 * 1_000;
const CATALOG_REFRESH_TIMEOUT: Duration = Duration::from_secs(45);
const BACKGROUND_INITIAL_DELAY: Duration = Duration::from_secs(20);
const BACKGROUND_REFRESH_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);
const SUPPORTED_PROVIDERS: [&str; 3] = ["codex", "claude", "opencode"];

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeModelCatalogRecord {
    pub provider: String,
    pub canonical_model_id: String,
    pub cli_model_id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub supported_reasoning_efforts: Vec<String>,
    #[serde(default)]
    pub default_reasoning_effort: Option<String>,
    #[serde(default)]
    pub input_modalities: Vec<String>,
    #[serde(default)]
    pub output_modalities: Vec<String>,
    #[serde(default)]
    pub hidden: bool,
    #[serde(default)]
    pub is_default: Option<bool>,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub is_free: Option<bool>,
    #[serde(default)]
    pub source_version: Option<String>,
    pub checked_at: i64,
    #[serde(default)]
    pub upstream_provider_id: Option<String>,
    #[serde(default)]
    pub provider_name: Option<String>,
    #[serde(default)]
    pub reasoning: Option<bool>,
    #[serde(default)]
    pub attachment: Option<bool>,
    #[serde(default)]
    pub tool_call: Option<bool>,
    #[serde(default)]
    pub context_window: Option<u64>,
    #[serde(default)]
    pub max_output_tokens: Option<u64>,
    #[serde(default)]
    pub release_date: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeModelCatalogSnapshot {
    pub provider: String,
    pub scope: String,
    pub profile_id: Option<String>,
    pub source_version: Option<String>,
    pub checked_at: i64,
    pub models: Vec<RuntimeModelCatalogRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeModelCatalogCache {
    pub supported: Vec<RuntimeModelCatalogSnapshot>,
    pub opencode_accessible: Option<RuntimeModelCatalogSnapshot>,
    pub stale_providers: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeModelCatalogRefreshFailure {
    pub provider: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeModelCatalogRefreshResult {
    pub cache: RuntimeModelCatalogCache,
    pub failures: Vec<RuntimeModelCatalogRefreshFailure>,
}

struct CatalogRefreshFlight {
    result: Mutex<Option<Result<RuntimeModelCatalogSnapshot, String>>>,
    completed: Condvar,
}

static CATALOG_REFRESH_FLIGHTS: OnceLock<Mutex<HashMap<String, Arc<CatalogRefreshFlight>>>> =
    OnceLock::new();

fn refresh_flights() -> &'static Mutex<HashMap<String, Arc<CatalogRefreshFlight>>> {
    CATALOG_REFRESH_FLIGHTS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

fn supported_cache_key(provider: &str) -> String {
    format!("{CACHE_PREFIX}:supported:{provider}")
}

fn accessible_cache_key(profile_id: &str) -> String {
    format!("{CACHE_PREFIX}:accessible:opencode:{profile_id}")
}

fn load_snapshot(
    db: &TelemetryDb,
    key: &str,
) -> Result<Option<RuntimeModelCatalogSnapshot>, String> {
    db.local_app_kv_get(key)?
        .map(|raw| {
            serde_json::from_str(&raw)
                .map_err(|error| format!("Could not decode cached runtime model catalog: {error}"))
        })
        .transpose()
}

fn save_snapshot(
    db: &TelemetryDb,
    key: &str,
    snapshot: &RuntimeModelCatalogSnapshot,
) -> Result<(), String> {
    if snapshot.scope == "supported" && snapshot.models.is_empty() {
        return Err(format!(
            "Refusing to replace the {} model catalog with an empty snapshot.",
            snapshot.provider
        ));
    }
    let encoded = serde_json::to_string(snapshot)
        .map_err(|error| format!("Could not encode runtime model catalog: {error}"))?;
    db.local_app_kv_set(key, &encoded)
}

fn snapshot_is_stale(snapshot: &RuntimeModelCatalogSnapshot, at_ms: i64) -> bool {
    snapshot.checked_at <= 0 || at_ms.saturating_sub(snapshot.checked_at) >= CATALOG_TTL_MS
}

fn cached_catalogs(
    db: &TelemetryDb,
    opencode_profile_id: Option<&str>,
) -> Result<RuntimeModelCatalogCache, String> {
    let at_ms = now_ms();
    let mut supported = Vec::new();
    let mut stale_providers = Vec::new();
    for provider in SUPPORTED_PROVIDERS {
        match load_snapshot(db, &supported_cache_key(provider))? {
            Some(snapshot) => {
                if snapshot_is_stale(&snapshot, at_ms) {
                    stale_providers.push(provider.to_string());
                }
                supported.push(snapshot);
            }
            None => stale_providers.push(provider.to_string()),
        }
    }
    let opencode_accessible = opencode_profile_id
        .map(accessible_cache_key)
        .map(|key| load_snapshot(db, &key))
        .transpose()?
        .flatten();
    Ok(RuntimeModelCatalogCache {
        supported,
        opencode_accessible,
        stale_providers,
    })
}

#[tauri::command]
#[specta::specta]
pub fn get_runtime_model_catalogs(
    db: State<TelemetryDb>,
    opencode_profile_id: Option<String>,
) -> Result<RuntimeModelCatalogCache, String> {
    cached_catalogs(&db, opencode_profile_id.as_deref())
}

fn selected_profile_credentials(
    app: &AppHandle,
    provider: &str,
) -> Result<MaterializedRuntimeCredentials, String> {
    // Codex and Claude expose their authoritative catalog through the runtime SDK,
    // whose initialization requires a login. Use the same selected ready profile as
    // launch and retain its id on the snapshot as provenance. OpenCode's global
    // supported catalog is intentionally fetched without user credentials below.
    let db = app.state::<TelemetryDb>();
    let profiles = db.list_login_profiles()?;
    let profile =
        crate::login_profiles::select_login_profile_for_provider(&profiles, provider, None)
            .ok_or_else(|| format!("No managed {provider} login profile is available."))?;
    if profile.status != "ready" {
        return Err(format!(
            "The selected {provider} login profile is not ready for model catalog refresh."
        ));
    }
    let cache_dir = app
        .path()
        .app_cache_dir()
        .map_err(|error| format!("Could not resolve app cache directory: {error}"))?;
    crate::login_profiles::resolve_runtime_credentials(
        &db,
        &KeyringCredentialVault,
        &profile.id,
        cache_dir,
    )
}

fn apply_credentials(command: &mut Command, credentials: &MaterializedRuntimeCredentials) {
    match credentials.provider.as_str() {
        "codex" => {
            for key in [
                "CODEX_HOME",
                "OPENAI_API_KEY",
                "CODEX_API_KEY",
                "OPENAI_ORG_ID",
                "OPENAI_PROJECT_ID",
            ] {
                command.env_remove(key);
            }
        }
        "claude" => {
            for key in [
                "ANTHROPIC_API_KEY",
                "ANTHROPIC_AUTH_TOKEN",
                "ANTHROPIC_BASE_URL",
                "ANTHROPIC_MODEL",
                "ANTHROPIC_DEFAULT_HAIKU_MODEL",
                "ANTHROPIC_DEFAULT_OPUS_MODEL",
                "ANTHROPIC_DEFAULT_SONNET_MODEL",
                "ANTHROPIC_BEDROCK_BASE_URL",
                "ANTHROPIC_VERTEX_BASE_URL",
                "ANTHROPIC_FOUNDRY_BASE_URL",
                "CLAUDE_CODE_OAUTH_TOKEN",
                "CLAUDE_CONFIG_DIR",
                "CLAUDE_CODE_USE_BEDROCK",
                "CLAUDE_CODE_USE_VERTEX",
                "CLAUDE_CODE_USE_FOUNDRY",
                "CLAUDE_CODE_USE_ANTHROPIC_AWS",
                "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST",
                "CLAUDE_CODE_SKIP_BEDROCK_AUTH",
                "CLAUDE_CODE_SKIP_VERTEX_AUTH",
                "CLAUDE_CODE_SKIP_FOUNDRY_AUTH",
                "AWS_REGION",
                "AWS_PROFILE",
                "AWS_ACCESS_KEY_ID",
                "AWS_SECRET_ACCESS_KEY",
                "AWS_SESSION_TOKEN",
                "GOOGLE_APPLICATION_CREDENTIALS",
                "GOOGLE_CLOUD_PROJECT",
                "GOOGLE_CLOUD_LOCATION",
                "CLOUD_ML_REGION",
                "AZURE_OPENAI_ENDPOINT",
                "AZURE_AI_FOUNDRY_ENDPOINT",
                "AZURE_OPENAI_DEPLOYMENT",
                "AZURE_OPENAI_API_KEY",
                "AZURE_API_KEY",
                "AZURE_CLIENT_ID",
                "AZURE_CLIENT_SECRET",
                "AZURE_TENANT_ID",
            ] {
                command.env_remove(key);
            }
        }
        _ => {}
    }
    for (key, value) in &credentials.env {
        command.env(key, value);
    }
}

fn isolated_opencode_catalog_environment(
    app: &AppHandle,
    command: &mut Command,
) -> Result<(), String> {
    let root = app
        .path()
        .app_cache_dir()
        .map_err(|error| format!("Could not resolve app cache directory: {error}"))?
        .join("runtime-model-catalog")
        .join("opencode-supported");
    for (environment, directory) in [
        ("XDG_DATA_HOME", "data"),
        ("XDG_CONFIG_HOME", "config"),
        ("XDG_STATE_HOME", "state"),
        ("XDG_CACHE_HOME", "cache"),
    ] {
        let path = root.join(directory);
        fs::create_dir_all(&path).map_err(|error| {
            format!(
                "Could not prepare isolated OpenCode catalog directory {}: {error}",
                path.display()
            )
        })?;
        command.env(environment, path);
    }
    for key in [
        "ANTHROPIC_API_KEY",
        "OPENAI_API_KEY",
        "OPENROUTER_API_KEY",
        "GROQ_API_KEY",
        "DEEPSEEK_API_KEY",
        "GOOGLE_GENERATIVE_AI_API_KEY",
        "AWS_ACCESS_KEY_ID",
        "AWS_SECRET_ACCESS_KEY",
        "AWS_SESSION_TOKEN",
    ] {
        command.env_remove(key);
    }
    Ok(())
}

fn command_for_provider(
    app: &AppHandle,
    provider: &str,
) -> Result<(Command, Option<String>), String> {
    let (mut command, source_profile_id) = match provider {
        "codex" => {
            let invocation = crate::runtime_scripts::codex_adapter_command(app)?;
            let mut command = Command::new(invocation.program);
            command.args(invocation.args_prefix).arg("--list-models");
            let credentials = selected_profile_credentials(app, provider)?;
            apply_credentials(&mut command, &credentials);
            (command, Some(credentials.profile_id))
        }
        "claude" => {
            let invocation = crate::managed_runtime::claude_adapter_invocation(app)?;
            let mut command = Command::new(invocation.node_program);
            command.arg(invocation.adapter_script).arg("--list-models");
            let credentials = selected_profile_credentials(app, provider)?;
            apply_credentials(&mut command, &credentials);
            (command, Some(credentials.profile_id))
        }
        "opencode" => {
            let invocation = crate::managed_runtime::opencode_adapter_invocation(app)?;
            let mut command = Command::new(invocation.node_program);
            command
                .arg(invocation.adapter_script)
                .arg("--opencode-bin")
                .arg(invocation.opencode_program)
                .arg("--list-supported-models");
            isolated_opencode_catalog_environment(app, &mut command)?;
            (command, None)
        }
        _ => {
            return Err(format!(
                "Unsupported runtime model catalog provider: {provider}"
            ))
        }
    };
    command
        .current_dir(std::env::temp_dir())
        .env("PATH", crate::cli_path::build_tool_path());
    Ok((command, source_profile_id))
}

fn parse_catalog_output(
    provider: &str,
    output: Output,
) -> Result<RuntimeModelCatalogSnapshot, String> {
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if !output.status.success() {
        return Err(format!(
            "{provider} model catalog refresh exited with {}. stderr={stderr}",
            output.status
        ));
    }
    let event = stdout
        .lines()
        .rev()
        .filter_map(|line| serde_json::from_str::<JsonValue>(line.trim()).ok())
        .find(|value| {
            value.get("type").and_then(JsonValue::as_str) == Some("model_catalog")
                && value.get("provider").and_then(JsonValue::as_str) == Some(provider)
        })
        .ok_or_else(|| format!("{provider} model catalog refresh returned no catalog event."))?;
    let checked_at = event
        .get("checkedAt")
        .and_then(JsonValue::as_i64)
        .unwrap_or_else(now_ms);
    let source_version = event
        .get("sourceVersion")
        .or_else(|| event.get("cli_version"))
        .and_then(JsonValue::as_str)
        .map(str::to_string);
    let mut models = serde_json::from_value::<Vec<RuntimeModelCatalogRecord>>(
        event.get("models").cloned().unwrap_or_else(|| json!([])),
    )
    .map_err(|error| format!("Could not decode {provider} model catalog: {error}"))?;
    models.retain(|model| {
        model.provider == provider
            && !model.hidden
            && !model.canonical_model_id.trim().is_empty()
            && !model.cli_model_id.trim().is_empty()
    });
    let mut canonical_indexes = HashMap::<String, usize>::new();
    let mut canonical_models: Vec<RuntimeModelCatalogRecord> = Vec::new();
    for model in models {
        if let Some(index) = canonical_indexes.get(&model.canonical_model_id).copied() {
            let current = &canonical_models[index];
            let candidate_is_better = model.is_default == Some(true)
                && current.is_default != Some(true)
                || model.cli_model_id == model.canonical_model_id
                    && current.cli_model_id != current.canonical_model_id;
            if candidate_is_better {
                canonical_models[index] = model;
            }
        } else {
            canonical_indexes.insert(model.canonical_model_id.clone(), canonical_models.len());
            canonical_models.push(model);
        }
    }
    let models = canonical_models;
    if models.is_empty() {
        return Err(format!(
            "{provider} model catalog refresh returned no usable models."
        ));
    }
    Ok(RuntimeModelCatalogSnapshot {
        provider: provider.to_string(),
        scope: "supported".to_string(),
        profile_id: None,
        source_version,
        checked_at,
        models,
    })
}

fn refresh_provider_uncached(
    app: &AppHandle,
    provider: &str,
) -> Result<RuntimeModelCatalogSnapshot, String> {
    let (mut command, source_profile_id) = command_for_provider(app, provider)?;
    let output = command_output_with_timeout(
        &mut command,
        CATALOG_REFRESH_TIMEOUT,
        &format!("{provider} model catalog refresh"),
    )
    .map_err(|error| error.to_string())?;
    let mut snapshot = parse_catalog_output(provider, output)?;
    snapshot.profile_id = source_profile_id;
    let db = app.state::<TelemetryDb>();
    save_snapshot(&db, &supported_cache_key(provider), &snapshot)?;
    Ok(snapshot)
}

fn refresh_provider_single_flight(
    app: &AppHandle,
    provider: &str,
) -> Result<RuntimeModelCatalogSnapshot, String> {
    let (flight, owner) = {
        let mut flights = refresh_flights()
            .lock()
            .map_err(|error| error.to_string())?;
        if let Some(flight) = flights.get(provider) {
            (Arc::clone(flight), false)
        } else {
            let flight = Arc::new(CatalogRefreshFlight {
                result: Mutex::new(None),
                completed: Condvar::new(),
            });
            flights.insert(provider.to_string(), Arc::clone(&flight));
            (flight, true)
        }
    };

    if owner {
        let result = refresh_provider_uncached(app, provider);
        if let Ok(mut slot) = flight.result.lock() {
            *slot = Some(result.clone());
            flight.completed.notify_all();
        }
        if let Ok(mut flights) = refresh_flights().lock() {
            flights.remove(provider);
        }
        return result;
    }

    let mut result = flight.result.lock().map_err(|error| error.to_string())?;
    while result.is_none() {
        result = flight
            .completed
            .wait(result)
            .map_err(|error| error.to_string())?;
    }
    result
        .as_ref()
        .cloned()
        .unwrap_or_else(|| Err("Runtime model catalog refresh ended without a result.".to_string()))
}

fn refresh_supported_catalogs_blocking(app: &AppHandle) -> RuntimeModelCatalogRefreshResult {
    let mut workers = Vec::new();
    for provider in SUPPORTED_PROVIDERS {
        let worker_app = app.clone();
        workers.push((
            provider.to_string(),
            thread::spawn(move || refresh_provider_single_flight(&worker_app, provider)),
        ));
    }
    let mut failures = Vec::new();
    for (provider, worker) in workers {
        match worker.join() {
            Ok(Ok(_)) => {}
            Ok(Err(message)) => {
                failures.push(RuntimeModelCatalogRefreshFailure { provider, message })
            }
            Err(_) => failures.push(RuntimeModelCatalogRefreshFailure {
                provider,
                message: "Runtime model catalog worker panicked.".to_string(),
            }),
        }
    }
    let db = app.state::<TelemetryDb>();
    let cache = cached_catalogs(&db, None).unwrap_or_else(|error| {
        failures.push(RuntimeModelCatalogRefreshFailure {
            provider: "cache".to_string(),
            message: error,
        });
        RuntimeModelCatalogCache {
            supported: Vec::new(),
            opencode_accessible: None,
            stale_providers: SUPPORTED_PROVIDERS
                .iter()
                .map(|value| value.to_string())
                .collect(),
        }
    });
    RuntimeModelCatalogRefreshResult { cache, failures }
}

#[tauri::command]
#[specta::specta]
pub async fn refresh_runtime_model_catalogs(
    app: AppHandle,
) -> Result<RuntimeModelCatalogRefreshResult, String> {
    let worker_app = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        refresh_supported_catalogs_blocking(&worker_app)
    })
    .await
    .map_err(|error| format!("Runtime model catalog refresh task failed: {error}"))?;
    let _ = app.emit("runtime-model-catalog:changed", &result.cache);
    Ok(result)
}

pub fn start_background_refresh(app: AppHandle) {
    thread::spawn(move || {
        thread::sleep(BACKGROUND_INITIAL_DELAY);
        loop {
            let should_refresh = {
                let db = app.state::<TelemetryDb>();
                cached_catalogs(&db, None)
                    .map(|cache| !cache.stale_providers.is_empty())
                    .unwrap_or(true)
            };
            if should_refresh {
                let result = refresh_supported_catalogs_blocking(&app);
                let _ = app.emit("runtime-model-catalog:changed", &result.cache);
                if !result.failures.is_empty() {
                    crate::app_log!(
                        "[RUNTIME_MODEL_CATALOG] event=background_refresh.partial_failure failures={}",
                        result.failures.len()
                    );
                }
            }
            thread::sleep(BACKGROUND_REFRESH_INTERVAL);
        }
    });
}

pub(crate) fn cache_opencode_accessible_catalog(
    db: &TelemetryDb,
    profile_id: &str,
    catalog: &JsonValue,
) -> Result<(), String> {
    let rows = catalog
        .as_array()
        .ok_or_else(|| "OpenCode accessible model catalog must contain an array.".to_string())?;
    let checked_at = now_ms();
    let mut models = Vec::new();
    for row in rows {
        let id = row
            .get("id")
            .and_then(JsonValue::as_str)
            .unwrap_or("")
            .trim();
        let model_id = row
            .get("modelId")
            .and_then(JsonValue::as_str)
            .unwrap_or("")
            .trim();
        let upstream_provider_id = row
            .get("providerId")
            .and_then(JsonValue::as_str)
            .unwrap_or("")
            .trim();
        let cli_model_id = row
            .get("cliModelId")
            .and_then(JsonValue::as_str)
            .unwrap_or(id)
            .trim();
        if id.is_empty() || model_id.is_empty() || upstream_provider_id.is_empty() {
            continue;
        }
        let strings = |key: &str| {
            row.get(key)
                .and_then(JsonValue::as_array)
                .map(|values| {
                    values
                        .iter()
                        .filter_map(JsonValue::as_str)
                        .map(str::to_string)
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default()
        };
        models.push(RuntimeModelCatalogRecord {
            provider: "opencode".to_string(),
            canonical_model_id: row
                .get("canonicalModelId")
                .and_then(JsonValue::as_str)
                .unwrap_or(id)
                .to_string(),
            cli_model_id: cli_model_id.to_string(),
            name: row
                .get("name")
                .and_then(JsonValue::as_str)
                .unwrap_or(model_id)
                .to_string(),
            description: row
                .get("description")
                .and_then(JsonValue::as_str)
                .unwrap_or("")
                .to_string(),
            supported_reasoning_efforts: strings("variants"),
            default_reasoning_effort: None,
            input_modalities: strings("inputModalities"),
            output_modalities: strings("outputModalities"),
            hidden: false,
            is_default: None,
            status: row
                .get("status")
                .and_then(JsonValue::as_str)
                .map(str::to_string),
            is_free: row.get("isFree").and_then(JsonValue::as_bool),
            source_version: row
                .get("sourceVersion")
                .and_then(JsonValue::as_str)
                .map(str::to_string),
            checked_at,
            upstream_provider_id: Some(upstream_provider_id.to_string()),
            provider_name: row
                .get("providerName")
                .and_then(JsonValue::as_str)
                .map(str::to_string),
            reasoning: row.get("reasoning").and_then(JsonValue::as_bool),
            attachment: row.get("attachment").and_then(JsonValue::as_bool),
            tool_call: row.get("toolCall").and_then(JsonValue::as_bool),
            context_window: row.get("contextWindow").and_then(JsonValue::as_u64),
            max_output_tokens: row.get("maxOutputTokens").and_then(JsonValue::as_u64),
            release_date: row
                .get("releaseDate")
                .and_then(JsonValue::as_str)
                .map(str::to_string),
        });
    }
    let snapshot = RuntimeModelCatalogSnapshot {
        provider: "opencode".to_string(),
        scope: "accessible".to_string(),
        profile_id: Some(profile_id.to_string()),
        source_version: models.iter().find_map(|model| model.source_version.clone()),
        checked_at,
        models,
    };
    save_snapshot(db, &accessible_cache_key(profile_id), &snapshot)
}

pub(crate) fn cached_provider_supports_model(
    db: &TelemetryDb,
    provider: &str,
    model_id: &str,
) -> Result<Option<bool>, String> {
    let Some(snapshot) = load_snapshot(db, &supported_cache_key(provider))? else {
        return Ok(None);
    };
    if snapshot_is_stale(&snapshot, now_ms()) {
        return Ok(None);
    }
    Ok(Some(snapshot.models.iter().any(|model| {
        model.cli_model_id == model_id || model.canonical_model_id == model_id
    })))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_snapshot(checked_at: i64, model_id: &str) -> RuntimeModelCatalogSnapshot {
        RuntimeModelCatalogSnapshot {
            provider: "codex".to_string(),
            scope: "supported".to_string(),
            profile_id: None,
            source_version: Some("1.0".to_string()),
            checked_at,
            models: vec![RuntimeModelCatalogRecord {
                provider: "codex".to_string(),
                canonical_model_id: model_id.to_string(),
                cli_model_id: model_id.to_string(),
                name: model_id.to_string(),
                description: String::new(),
                supported_reasoning_efforts: vec!["medium".to_string()],
                default_reasoning_effort: Some("medium".to_string()),
                input_modalities: vec!["text".to_string()],
                output_modalities: vec!["text".to_string()],
                hidden: false,
                is_default: Some(true),
                status: Some("active".to_string()),
                is_free: None,
                source_version: Some("1.0".to_string()),
                checked_at,
                upstream_provider_id: None,
                provider_name: None,
                reasoning: Some(true),
                attachment: None,
                tool_call: None,
                context_window: None,
                max_output_tokens: None,
                release_date: None,
            }],
        }
    }

    #[test]
    fn stale_catalog_uses_twenty_four_hour_ttl() {
        let snapshot = sample_snapshot(1_000, "gpt-6");
        assert!(!snapshot_is_stale(&snapshot, 1_000 + CATALOG_TTL_MS - 1));
        assert!(snapshot_is_stale(&snapshot, 1_000 + CATALOG_TTL_MS));
    }

    #[test]
    fn empty_refresh_cannot_replace_last_good_snapshot() {
        let directory = tempfile::tempdir().expect("temp directory");
        let db = TelemetryDb::open(directory.path()).expect("open test database");
        let good = sample_snapshot(100, "gpt-6");
        let key = supported_cache_key("codex");
        save_snapshot(&db, &key, &good).expect("save good catalog");
        let mut empty = good.clone();
        empty.checked_at = 200;
        empty.models.clear();

        assert!(save_snapshot(&db, &key, &empty).is_err());
        assert_eq!(load_snapshot(&db, &key).unwrap(), Some(good));
    }

    #[test]
    fn explicit_empty_accessible_catalog_clears_previous_access() {
        let directory = tempfile::tempdir().expect("temp directory");
        let db = TelemetryDb::open(directory.path()).expect("open test database");
        let key = accessible_cache_key("profile-1");
        let mut accessible = sample_snapshot(100, "openrouter/model");
        accessible.provider = "opencode".to_string();
        accessible.scope = "accessible".to_string();
        accessible.profile_id = Some("profile-1".to_string());
        accessible.models[0].provider = "opencode".to_string();
        save_snapshot(&db, &key, &accessible).expect("save accessible catalog");
        accessible.checked_at = 200;
        accessible.models.clear();

        save_snapshot(&db, &key, &accessible).expect("clear accessible catalog");
        assert_eq!(load_snapshot(&db, &key).unwrap(), Some(accessible));
    }

    #[test]
    fn cached_validation_accepts_canonical_ids_and_cli_aliases() {
        let directory = tempfile::tempdir().expect("temp directory");
        let db = TelemetryDb::open(directory.path()).expect("open test database");
        let mut snapshot = sample_snapshot(now_ms(), "gpt-6");
        snapshot.models[0].cli_model_id = "gpt-latest".to_string();
        save_snapshot(&db, &supported_cache_key("codex"), &snapshot).unwrap();

        assert_eq!(
            cached_provider_supports_model(&db, "codex", "gpt-6").unwrap(),
            Some(true)
        );
        assert_eq!(
            cached_provider_supports_model(&db, "codex", "gpt-latest").unwrap(),
            Some(true)
        );
        assert_eq!(
            cached_provider_supports_model(&db, "codex", "gpt-old").unwrap(),
            Some(false)
        );
    }
}
