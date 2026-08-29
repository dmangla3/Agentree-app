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

fn dev_binary_path(binary_name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("binaries")
        .join(binary_name)
}

fn find_on_path(command: &str) -> Option<String> {
    crate::cli_path::find_on_tool_path(command)
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
        return None;
    }
    None
}

fn codex_adapter_binary_name_for(target_os: &str, target_arch: &str) -> Option<String> {
    let triple = match (target_os, target_arch) {
        ("linux", "x86_64") => "x86_64-unknown-linux-gnu",
        ("macos", "aarch64") => "aarch64-apple-darwin",
        _ => return None,
    };
    Some(format!("codex-app-server-adapter-{}", triple))
}

fn codex_adapter_binary_name() -> Option<String> {
    codex_adapter_binary_name_for(std::env::consts::OS, std::env::consts::ARCH)
}

fn requires_codex_adapter_helper(target_os: &str) -> bool {
    target_os == "linux"
}

pub struct RuntimeCommand {
    pub program: String,
    pub args_prefix: Vec<String>,
}

pub fn codex_adapter_command(app: &AppHandle) -> Result<RuntimeCommand, String> {
    let binary_name = codex_adapter_binary_name();
    if let Some(binary_name) = binary_name.as_deref() {
        let resource_path = app
            .path()
            .resolve(format!("binaries/{}", binary_name), BaseDirectory::Resource)
            .map_err(|err| err.to_string())?;
        if resource_path.exists() {
            return Ok(RuntimeCommand {
                program: resource_path.to_string_lossy().into_owned(),
                args_prefix: Vec::new(),
            });
        }

        let source_path = dev_binary_path(&binary_name);
        if source_path.exists() {
            return Ok(RuntimeCommand {
                program: source_path.to_string_lossy().into_owned(),
                args_prefix: Vec::new(),
            });
        }
    }

    if requires_codex_adapter_helper(std::env::consts::OS) {
        return Err(match binary_name {
            Some(binary_name) => format!(
                "Codex adapter helper is missing for this platform: binaries/{}. Agentree requires the native helper on Linux.",
                binary_name
            ),
            None => format!(
                "Codex adapter helper is not available for this platform: {} {}.",
                std::env::consts::OS,
                std::env::consts::ARCH
            ),
        });
    }

    // macOS currently keeps the legacy Python adapter path so existing Apple
    // development machines continue to work until the Apple helper is added.
    // To make macOS helper-only later, add the aarch64 helper to binaries/ and
    // include "macos" in requires_codex_adapter_helper.
    Ok(RuntimeCommand {
        program: runtime_python_command(app),
        args_prefix: vec![runtime_script_path(app, "codex-app-server-adapter.py")?
            .to_string_lossy()
            .into_owned()],
    })
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

#[cfg(test)]
mod tests {
    use super::{
        codex_adapter_binary_name_for, python_command_for_sdk, requires_codex_adapter_helper,
    };

    #[test]
    fn python_command_for_sdk_does_not_return_missing_version_specific_python() {
        let temp_dir = tempfile::tempdir().unwrap();
        let core_dir = temp_dir.path().join("pydantic_core");
        std::fs::create_dir_all(&core_dir).unwrap();
        std::fs::write(
            core_dir.join("_pydantic_core.cpython-399-x86_64-linux-gnu.so"),
            "",
        )
        .unwrap();

        assert_eq!(python_command_for_sdk(temp_dir.path()), None);
    }

    #[test]
    fn codex_adapter_binary_name_matches_linux_x86_64_sidecar() {
        assert_eq!(
            codex_adapter_binary_name_for("linux", "x86_64").as_deref(),
            Some("codex-app-server-adapter-x86_64-unknown-linux-gnu")
        );
    }

    #[test]
    fn codex_adapter_binary_name_matches_macos_apple_silicon_sidecar() {
        assert_eq!(
            codex_adapter_binary_name_for("macos", "aarch64").as_deref(),
            Some("codex-app-server-adapter-aarch64-apple-darwin")
        );
    }

    #[test]
    fn codex_adapter_sidecar_support_is_limited_to_distribution_targets() {
        assert_eq!(codex_adapter_binary_name_for("macos", "x86_64"), None);
        assert_eq!(codex_adapter_binary_name_for("windows", "x86_64"), None);
    }

    #[test]
    fn codex_adapter_helper_is_required_only_on_linux_for_now() {
        assert!(requires_codex_adapter_helper("linux"));
        assert!(!requires_codex_adapter_helper("macos"));
    }
}
