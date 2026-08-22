use serde::{Deserialize, Serialize};
use serde_json::{Map as JsonMap, Value as JsonValue};
use std::process::{Command, Output, Stdio};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, State};

use crate::db::TelemetryDb;

const PROVIDER_LIMITS_REFRESH_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeReadiness {
    provider: String,
    status: String,
    cli_path: Option<String>,
    cli_version: Option<String>,
    home_dir: Option<String>,
    auth_mode: Option<String>,
    plan_type: Option<String>,
    has_auth_file: Option<bool>,
    recommended_command: Option<String>,
    message: String,
    #[specta(type = specta_typescript::Unknown)]
    diagnostics: JsonValue,
}

fn build_probe_path() -> String {
    crate::cli_path::build_tool_path()
}

fn command_output_with_timeout(
    command: &mut Command,
    timeout: Duration,
    label: &str,
) -> Result<Output, String> {
    let mut child = command
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("Failed to run {}: {}", label, error))?;
    let started_at = Instant::now();

    loop {
        match child.try_wait() {
            Ok(Some(_status)) => {
                return child
                    .wait_with_output()
                    .map_err(|error| format!("Failed to collect {} output: {}", label, error));
            }
            Ok(None) => {
                if started_at.elapsed() >= timeout {
                    let _ = child.kill();
                    let output = child.wait_with_output().map_err(|error| {
                        format!("Failed to collect timed out {} output: {}", label, error)
                    })?;
                    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
                    return Err(format!(
                        "{} timed out after {}ms. stderr={}",
                        label,
                        timeout.as_millis(),
                        stderr
                    ));
                }
                thread::sleep(Duration::from_millis(25));
            }
            Err(error) => {
                let _ = child.kill();
                return Err(format!("Failed while waiting for {}: {}", label, error));
            }
        }
    }
}

fn readiness_from_managed_profile(
    profile: &crate::login_profiles::LoginProfile,
) -> RuntimeReadiness {
    let mut diagnostics = JsonMap::new();
    diagnostics.insert(
        "managedProfileId".to_string(),
        JsonValue::String(profile.id.clone()),
    );
    diagnostics.insert(
        "managedProfileAuthType".to_string(),
        JsonValue::String(profile.auth_type.clone()),
    );
    diagnostics.insert("managedByAgentree".to_string(), JsonValue::Bool(true));

    RuntimeReadiness {
        provider: profile.provider.clone(),
        status: profile.status.clone(),
        cli_path: None,
        cli_version: None,
        home_dir: None,
        auth_mode: Some(profile.auth_type.clone()),
        plan_type: profile.plan_type.clone(),
        has_auth_file: Some(profile.auth_type == "codex_chatgpt_session"),
        recommended_command: None,
        message: profile.status_message.clone().unwrap_or_else(|| {
            format!(
                "{} managed login profile is {}.",
                profile.provider, profile.status
            )
        }),
        diagnostics: JsonValue::Object(diagnostics),
    }
}

fn default_managed_profile_for_provider(
    db: &TelemetryDb,
    provider: &str,
) -> Option<crate::login_profiles::LoginProfile> {
    let mut profiles = db.list_login_profiles().ok()?;
    profiles.retain(|profile| profile.provider == provider);
    profiles
        .iter()
        .find(|profile| profile.is_default)
        .cloned()
        .or_else(|| profiles.into_iter().next())
}

fn missing_login_profile_readiness(provider: &str) -> RuntimeReadiness {
    let label = if provider == "codex" {
        "Codex"
    } else {
        "Claude"
    };
    let mut diagnostics = JsonMap::new();
    diagnostics.insert("loginProfilesRequired".to_string(), JsonValue::Bool(true));
    diagnostics.insert("managedByAgentree".to_string(), JsonValue::Bool(true));
    RuntimeReadiness {
        provider: provider.to_string(),
        status: "auth_missing".to_string(),
        cli_path: None,
        cli_version: None,
        home_dir: None,
        auth_mode: None,
        plan_type: None,
        has_auth_file: None,
        recommended_command: None,
        message: format!("No active {} login profile is ready.", label),
        diagnostics: JsonValue::Object(diagnostics),
    }
}

#[tauri::command]
#[specta::specta]
pub fn check_runtime_readiness(
    db: State<TelemetryDb>,
    provider: String,
) -> Result<RuntimeReadiness, String> {
    match provider.trim().to_lowercase().as_str() {
        "codex" => {
            if let Some(profile) = default_managed_profile_for_provider(&db, "codex") {
                return Ok(readiness_from_managed_profile(&profile));
            }
            Ok(missing_login_profile_readiness("codex"))
        }
        "claude" => {
            if let Some(profile) = default_managed_profile_for_provider(&db, "claude") {
                return Ok(readiness_from_managed_profile(&profile));
            }
            Ok(missing_login_profile_readiness("claude"))
        }
        other => Ok(RuntimeReadiness {
            provider: other.to_string(),
            status: "unknown_error".to_string(),
            cli_path: None,
            cli_version: None,
            home_dir: None,
            auth_mode: None,
            plan_type: None,
            has_auth_file: None,
            recommended_command: None,
            message: format!(
                "Runtime provider `{}` does not have a readiness probe yet.",
                other
            ),
            diagnostics: JsonValue::Object(JsonMap::new()),
        }),
    }
}

#[tauri::command]
#[specta::specta]
pub fn check_all_runtime_readiness(
    db: State<TelemetryDb>,
) -> Result<Vec<RuntimeReadiness>, String> {
    let codex = if let Some(profile) = default_managed_profile_for_provider(&db, "codex") {
        readiness_from_managed_profile(&profile)
    } else {
        missing_login_profile_readiness("codex")
    };
    let claude = if let Some(profile) = default_managed_profile_for_provider(&db, "claude") {
        readiness_from_managed_profile(&profile)
    } else {
        missing_login_profile_readiness("claude")
    };
    Ok(vec![codex, claude])
}

fn read_codex_provider_limits(app: &AppHandle) -> Result<String, String> {
    let script_path =
        crate::runtime_scripts::runtime_script_path(app, "codex-app-server-adapter.py")?;
    let mut command = Command::new(crate::runtime_scripts::runtime_python_command(app));
    command
        .arg(script_path)
        .arg("--rate-limits-read")
        .env("PATH", build_probe_path());
    let output = command_output_with_timeout(
        &mut command,
        PROVIDER_LIMITS_REFRESH_TIMEOUT,
        "Codex provider limit refresh",
    )?;

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();

    if !output.status.success() {
        return Err(format!(
            "Codex provider limit refresh failed. exit={} stderr={}",
            output
                .status
                .code()
                .map(|code| code.to_string())
                .unwrap_or_else(|| "unknown".to_string()),
            stderr
        ));
    }
    if stdout.is_empty() {
        return Err(format!(
            "Codex provider limit refresh produced no output. stderr={}",
            stderr
        ));
    }

    serde_json::from_str::<JsonValue>(&stdout).map_err(|error| {
        format!(
            "Failed to parse Codex provider limit refresh output: {}. output={}",
            error, stdout
        )
    })?;
    Ok(stdout)
}

#[tauri::command]
#[specta::specta]
pub fn refresh_provider_limits(app: AppHandle, provider: String) -> Result<String, String> {
    match provider.trim().to_lowercase().as_str() {
        "codex" => read_codex_provider_limits(&app),
        other => Err(format!("Unsupported provider for usage refresh: {}", other)),
    }
}
