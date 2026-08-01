use std::path::{Path, PathBuf};
use tauri::{path::BaseDirectory, AppHandle, Manager};

const RUNTIME_SCRIPTS: &[&str] = &[
    "bash-adapter.cjs",
    "claude-agent-sdk-adapter.mjs",
    "codex-app-server-adapter.py",
    "merge-review-runner.cjs",
    "package-manager-guard.sh",
];

fn is_known_script(script_name: &str) -> bool {
    RUNTIME_SCRIPTS
        .iter()
        .any(|known_script| *known_script == script_name)
}

fn dev_script_path(script_name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("scripts")
        .join(script_name)
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

fn find_on_path(command: &str) -> Option<String> {
    for path in std::env::split_paths(&build_probe_path()) {
        let candidate = path.join(command);
        if candidate.exists() {
            return Some(candidate.to_string_lossy().into_owned());
        }
    }
    None
}

fn python_sdk_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .resolve("python-sdk", BaseDirectory::Resource)
        .ok()
        .filter(|path| path.exists())
        .or_else(|| {
            let dev_path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("python-sdk");
            dev_path.exists().then_some(dev_path)
        })
}

fn python_command_for_sdk(sdk_path: &Path) -> Option<String> {
    let core_dir = sdk_path.join("pydantic_core");
    let entries = std::fs::read_dir(core_dir).ok()?;
    for entry in entries.flatten() {
        let filename = entry.file_name().to_string_lossy().into_owned();
        let Some(version_start) = filename.find(".cpython-") else {
            continue;
        };
        let version = filename
            .get(version_start + ".cpython-".len()..)?
            .chars()
            .take_while(|ch| ch.is_ascii_digit())
            .collect::<String>();
        if version.len() < 2 {
            continue;
        }
        let command = format!("python{}.{}", &version[0..1], &version[1..]);
        if let Some(path) = find_on_path(&command) {
            return Some(path);
        }
        return Some(command);
    }
    None
}

pub fn runtime_python_command(app: &AppHandle) -> String {
    if let Ok(explicit) = std::env::var("PYTHON_BIN") {
        if !explicit.trim().is_empty() {
            return explicit;
        }
    }
    python_sdk_path(app)
        .as_deref()
        .and_then(python_command_for_sdk)
        .unwrap_or_else(|| find_on_path("python3").unwrap_or_else(|| "python3".to_string()))
}

pub fn runtime_script_path(app: &AppHandle, script_name: &str) -> Result<PathBuf, String> {
    if !is_known_script(script_name) {
        return Err(format!("Unknown runtime script: {}", script_name));
    }

    let resource_path = app
        .path()
        .resolve(format!("scripts/{}", script_name), BaseDirectory::Resource)
        .map_err(|err| err.to_string())?;
    if resource_path.exists() {
        return Ok(resource_path);
    }

    let source_path = dev_script_path(script_name);
    if source_path.exists() {
        Ok(source_path)
    } else {
        Err(format!("Runtime script not found: {}", script_name))
    }
}
