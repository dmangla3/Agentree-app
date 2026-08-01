use serde::{Deserialize, Serialize};
use serde_json::{Map as JsonMap, Value as JsonValue};
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use tauri::AppHandle;

#[derive(Debug, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
struct CommandProbe {
    ok: bool,
    exit_code: Option<i32>,
    output_excerpt: Option<String>,
    error_type: Option<String>,
}

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
    let mut parts: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|raw| std::env::split_paths(&raw).collect())
        .unwrap_or_default();

    for extra in [
        "/opt/homebrew/bin",
        "/usr/local/bin",
        "/usr/bin",
        "/bin",
        "/usr/sbin",
        "/sbin",
    ] {
        let path = PathBuf::from(extra);
        if !parts.iter().any(|entry| entry == &path) {
            parts.push(path);
        }
    }

    std::env::join_paths(parts)
        .map(|joined| joined.to_string_lossy().into_owned())
        .unwrap_or_else(|_| {
            "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin".to_string()
        })
}

fn command_excerpt(output: &Output) -> String {
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let combined = if stdout.trim().is_empty() {
        stderr.trim().to_string()
    } else if stderr.trim().is_empty() {
        stdout.trim().to_string()
    } else {
        format!("{} {}", stdout.trim(), stderr.trim())
    };
    combined.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn run_probe(command: &str, args: &[&str]) -> CommandProbe {
    match Command::new(command)
        .args(args)
        .env("PATH", build_probe_path())
        .output()
    {
        Ok(output) => CommandProbe {
            ok: output.status.success(),
            exit_code: output.status.code(),
            output_excerpt: Some(command_excerpt(&output)),
            error_type: None,
        },
        Err(error) => CommandProbe {
            ok: false,
            exit_code: None,
            output_excerpt: Some(error.to_string()),
            error_type: Some(format!("{:?}", error.kind())),
        },
    }
}

fn find_cli(command: &str) -> Option<String> {
    let probe_path = build_probe_path();
    for path in std::env::split_paths(&probe_path) {
        let candidate = path.join(command);
        if candidate.exists() {
            return Some(candidate.to_string_lossy().into_owned());
        }
    }
    None
}

fn home_dir_path(name: &str) -> Option<PathBuf> {
    dirs::home_dir().map(|home| home.join(name))
}

fn json_value<T: Serialize>(value: T) -> JsonValue {
    serde_json::to_value(value).unwrap_or_else(|_| JsonValue::Object(JsonMap::new()))
}

fn normalize_codex_payload(mut payload: JsonValue) -> JsonValue {
    if let Some(object) = payload.as_object_mut() {
        object.insert(
            "provider".to_string(),
            JsonValue::String("codex".to_string()),
        );
        if let Some(value) = object.remove("codexBin") {
            object.insert("cliPath".to_string(), value);
        }
        if let Some(value) = object.remove("codexVersion") {
            object.insert("cliVersion".to_string(), value);
        }
        if let Some(value) = object.remove("codexHome") {
            object.insert("homeDir".to_string(), value);
        }
        if let Some(value) = object.remove("hasAuthJson") {
            object.insert("hasAuthFile".to_string(), value);
        }

        let diagnostics = object
            .get("diagnostics")
            .cloned()
            .unwrap_or_else(|| JsonValue::Object(JsonMap::new()));
        if !object.contains_key("diagnostics") {
            object.insert("diagnostics".to_string(), diagnostics);
        }
    }
    payload
}

fn check_codex(app: &AppHandle) -> Result<RuntimeReadiness, String> {
    let script_path =
        crate::runtime_scripts::runtime_script_path(app, "codex-app-server-adapter.py")?;
    let output = Command::new(crate::runtime_scripts::runtime_python_command(app))
        .arg(script_path)
        .arg("--readiness-check")
        .env("PATH", build_probe_path())
        .output()
        .map_err(|error| format!("Failed to run Codex readiness check: {}", error))?;

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();

    if stdout.is_empty() {
        return Err(format!(
            "Codex readiness check produced no output. exit={} stderr={}",
            output
                .status
                .code()
                .map(|code| code.to_string())
                .unwrap_or_else(|| "unknown".to_string()),
            stderr
        ));
    }

    let parsed = serde_json::from_str::<JsonValue>(&stdout).map_err(|error| {
        format!(
            "Failed to parse Codex readiness check output: {}. output={}",
            error, stdout
        )
    })?;
    serde_json::from_value(normalize_codex_payload(parsed))
        .map_err(|error| format!("Failed to decode Codex readiness payload: {}", error))
}

fn check_claude() -> RuntimeReadiness {
    let cli_path = find_cli("claude");
    let version_probe = run_probe("claude", &["--version"]);
    let auth_probe = run_probe("claude", &["auth", "status"]);
    let home_dir = home_dir_path(".claude");
    let has_auth_file = home_dir.as_ref().map(|home| {
        ["auth.json", ".credentials.json", "credentials.json"]
            .iter()
            .any(|file| Path::new(home).join(file).exists())
    });

    let mut diagnostics = JsonMap::new();
    diagnostics.insert("versionProbe".to_string(), json_value(&version_probe));
    diagnostics.insert("authProbe".to_string(), json_value(&auth_probe));

    if !version_probe.ok {
        return RuntimeReadiness {
            provider: "claude".to_string(),
            status: if cli_path.is_some() {
                "cli_not_executable".to_string()
            } else {
                "cli_missing".to_string()
            },
            cli_path,
            cli_version: None,
            home_dir: home_dir.map(|path| path.to_string_lossy().into_owned()),
            auth_mode: None,
            plan_type: None,
            has_auth_file,
            recommended_command: Some(
                "Install Claude Code, then run `claude auth login`.".to_string(),
            ),
            message: "Claude Code is not available to Agentree.".to_string(),
            diagnostics: JsonValue::Object(diagnostics),
        };
    }

    if !auth_probe.ok {
        return RuntimeReadiness {
            provider: "claude".to_string(),
            status: "auth_missing".to_string(),
            cli_path,
            cli_version: version_probe.output_excerpt.clone(),
            home_dir: home_dir.map(|path| path.to_string_lossy().into_owned()),
            auth_mode: None,
            plan_type: None,
            has_auth_file,
            recommended_command: Some("claude auth login".to_string()),
            message: "Claude Code is installed, but Agentree cannot verify Claude authentication."
                .to_string(),
            diagnostics: JsonValue::Object(diagnostics),
        };
    }

    RuntimeReadiness {
        provider: "claude".to_string(),
        status: "ready".to_string(),
        cli_path,
        cli_version: version_probe.output_excerpt.clone(),
        home_dir: home_dir.map(|path| path.to_string_lossy().into_owned()),
        auth_mode: Some("cli".to_string()),
        plan_type: None,
        has_auth_file,
        recommended_command: None,
        message: "Claude Code is ready for Agentree.".to_string(),
        diagnostics: JsonValue::Object(diagnostics),
    }
}

#[tauri::command]
#[specta::specta]
pub fn check_runtime_readiness(
    app: AppHandle,
    provider: String,
) -> Result<RuntimeReadiness, String> {
    match provider.trim().to_lowercase().as_str() {
        "codex" => check_codex(&app),
        "claude" => Ok(check_claude()),
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
pub fn check_all_runtime_readiness(app: AppHandle) -> Result<Vec<RuntimeReadiness>, String> {
    let codex = check_codex(&app)?;
    let claude = check_claude();
    Ok(vec![codex, claude])
}

#[tauri::command]
#[specta::specta]
pub fn check_codex_readiness(app: AppHandle) -> Result<RuntimeReadiness, String> {
    check_codex(&app)
}
