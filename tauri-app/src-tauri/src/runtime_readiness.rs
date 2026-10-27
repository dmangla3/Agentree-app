use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use std::process::Command;
use std::time::Duration;
use tauri::{AppHandle, Manager};

use crate::db::TelemetryDb;
use crate::process_runner::command_output_with_timeout;

const PROVIDER_LIMITS_REFRESH_TIMEOUT: Duration = Duration::from_secs(10);

fn build_probe_path() -> String {
    crate::cli_path::build_tool_path()
}

#[derive(Debug, Serialize, Deserialize, Clone, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ManagedRuntimeDoctorEntry {
    pub component: String,
    pub label: String,
    pub pinned_version: String,
    /// "ready" | "missing" | "unpublished"
    pub status: String,
    pub install_dir: Option<String>,
    pub downloadable: bool,
    pub detail: String,
}

fn doctor_entry(
    app: &AppHandle,
    component: &str,
    label: &str,
    force_fingerprint: bool,
) -> ManagedRuntimeDoctorEntry {
    let manifest = crate::managed_runtime::manifest();
    let pinned_version = manifest
        .ok()
        .and_then(|manifest| manifest.components.get(component))
        .map(|spec| spec.version.clone())
        .unwrap_or_default();
    let validation_error = crate::managed_runtime::component_install_validation_error(
        app,
        component,
        force_fingerprint,
    )
    .ok()
    .flatten();
    let installed = if validation_error.is_none() {
        if force_fingerprint {
            crate::managed_runtime::installed_component_dir(app, component)
                .ok()
                .flatten()
        } else {
            crate::managed_runtime::structurally_valid_component_dir(app, component)
                .ok()
                .flatten()
        }
    } else {
        None
    };
    let downloadable = crate::managed_runtime::component_available_for_download(component);

    let (status, detail) = match (&installed, validation_error, downloadable) {
        (Some(dir), _, _) => (
            "ready",
            format!("{} {} installed at {}.", label, pinned_version, dir.display()),
        ),
        (None, Some(error), true) => (
            "missing",
            format!("{} Repair will download a verified replacement.", error),
        ),
        (None, _, true) => (
            "missing",
            format!(
                "{} {} is not installed yet. It downloads automatically on first use, or install it now.",
                label, pinned_version
            ),
        ),
        (None, Some(error), false) => ("unpublished", error),
        (None, _, false) => (
            "unpublished",
            format!(
                "{} {} has no published archive for {}. Provider features cannot start until a verified archive is published.",
                label,
                pinned_version,
                crate::managed_runtime::current_platform_key()
            ),
        ),
    };

    ManagedRuntimeDoctorEntry {
        component: component.to_string(),
        label: label.to_string(),
        pinned_version,
        status: status.to_string(),
        install_dir: installed.map(|dir| dir.display().to_string()),
        downloadable,
        detail,
    }
}

#[tauri::command]
#[specta::specta]
pub async fn check_managed_runtime_doctor(
    app: AppHandle,
    force_fingerprint: Option<bool>,
) -> Result<Vec<ManagedRuntimeDoctorEntry>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let force_fingerprint = force_fingerprint.unwrap_or(false);
        Ok(vec![
            doctor_entry(
                &app,
                crate::managed_runtime::COMPONENT_NODE,
                "Node runtime",
                force_fingerprint,
            ),
            doctor_entry(
                &app,
                crate::managed_runtime::COMPONENT_CLAUDE_SDK,
                "Claude runtime",
                force_fingerprint,
            ),
            doctor_entry(
                &app,
                crate::managed_runtime::COMPONENT_CODEX,
                "Codex CLI",
                force_fingerprint,
            ),
            doctor_entry(
                &app,
                crate::managed_runtime::COMPONENT_OPENCODE,
                "OpenCode runtime",
                force_fingerprint,
            ),
        ])
    })
    .await
    .map_err(|error| format!("Managed runtime doctor task failed: {}", error))?
}

#[tauri::command]
#[specta::specta]
pub async fn repair_managed_runtime_component(
    app: AppHandle,
    component: String,
) -> Result<ManagedRuntimeDoctorEntry, String> {
    tauri::async_runtime::spawn_blocking(move || {
        repair_managed_runtime_component_blocking(app, component)
    })
    .await
    .map_err(|error| format!("Managed runtime repair task failed: {}", error))?
}

fn repair_managed_runtime_component_blocking(
    app: AppHandle,
    component: String,
) -> Result<ManagedRuntimeDoctorEntry, String> {
    let label = match component.as_str() {
        "node" => "Node runtime",
        "claude-sdk" => "Claude runtime",
        "codex" => "Codex CLI",
        "opencode" => "OpenCode runtime",
        other => return Err(format!("Unknown managed runtime component: {}", other)),
    };
    crate::managed_runtime::reinstall_component(&app, &component)?;
    Ok(doctor_entry(&app, &component, label, false))
}

fn read_codex_provider_limits(app: &AppHandle, profile_id: Option<&str>) -> Result<String, String> {
    let command_plan = crate::runtime_scripts::codex_adapter_command(app)?;
    let mut command = Command::new(&command_plan.program);
    command
        .args(command_plan.args_prefix)
        .arg("--rate-limits-read")
        .env("PATH", build_probe_path());
    let materialized = if let Some(profile_id) = profile_id {
        let telemetry = app.state::<TelemetryDb>();
        let cache_dir = app
            .path()
            .app_cache_dir()
            .map_err(|error| format!("Could not resolve app cache dir: {}", error))?;
        let materialized = crate::login_profiles::resolve_runtime_credentials(
            &telemetry,
            &crate::login_profiles::KeyringCredentialVault,
            profile_id,
            cache_dir,
        )?;
        if materialized.provider != "codex" {
            return Err(format!(
                "Login profile {} is for {}, not codex",
                profile_id, materialized.provider
            ));
        }
        Some(materialized)
    } else {
        None
    };
    if let Some(materialized) = materialized.as_ref() {
        for (key, value) in &materialized.env {
            command.env(key, value);
        }
    }
    let output = command_output_with_timeout(
        &mut command,
        PROVIDER_LIMITS_REFRESH_TIMEOUT,
        "Codex provider limit refresh",
    )
    .map_err(|error| error.to_string())?;

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
    if let Some(materialized) = materialized.as_ref() {
        if materialized.auth_type == "codex_chatgpt_session" {
            if let (Some(profile_id), Some(codex_home)) =
                (profile_id, materialized.codex_home.as_deref())
            {
                let telemetry = app.state::<TelemetryDb>();
                crate::login_profiles::persist_codex_auth_state(
                    &telemetry,
                    &crate::login_profiles::KeyringCredentialVault,
                    profile_id,
                    codex_home,
                )?;
            }
        }
    }
    Ok(stdout)
}

#[tauri::command]
#[specta::specta]
pub async fn refresh_provider_limits(
    app: AppHandle,
    provider: String,
    profile_id: Option<String>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || match provider.trim().to_lowercase().as_str() {
        "codex" => read_codex_provider_limits(&app, profile_id.as_deref()),
        other => Err(format!("Unsupported provider for usage refresh: {}", other)),
    })
    .await
    .map_err(|error| format!("Provider limits refresh task failed: {}", error))?
}
