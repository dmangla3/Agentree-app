use std::path::PathBuf;
use tauri::{path::BaseDirectory, AppHandle, Manager};

const RUNTIME_SCRIPTS: &[&str] = &[
    "ai-label-prompt.txt",
    "bash-adapter.cjs",
    "claude-agent-sdk-adapter.mjs",
    "merge-review-runner.cjs",
    "opencode-agent-sdk-adapter.mjs",
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

pub struct RuntimeCommand {
    pub program: String,
    pub args_prefix: Vec<String>,
}

pub fn codex_adapter_command(app: &AppHandle) -> Result<RuntimeCommand, String> {
    let install_dir =
        crate::managed_runtime::ensure_component(app, crate::managed_runtime::COMPONENT_CODEX)
            .map_err(|error| {
                format!(
                    "Agentree's managed Codex runtime could not be installed or repaired: {} Open Runtime Health and retry.",
                    error
                )
            })?;
    let codex_bin = crate::managed_runtime::codex_binary_path(&install_dir);
    let current_exe = std::env::current_exe().map_err(|error| {
        format!(
            "Could not resolve Agentree executable for Codex adapter: {}",
            error
        )
    })?;
    Ok(RuntimeCommand {
        program: current_exe.to_string_lossy().into_owned(),
        args_prefix: vec![
            crate::codex_adapter::helper_arg().to_string(),
            crate::codex_adapter::managed_codex_bin_arg().to_string(),
            codex_bin.to_string_lossy().into_owned(),
        ],
    })
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
    use super::RUNTIME_SCRIPTS;

    fn assert_bundle_resources_match_runtime_scripts(config_source: &str) {
        let config: serde_json::Value =
            serde_json::from_str(config_source).expect("Tauri config should parse");
        let resources = config["bundle"]["resources"]
            .as_array()
            .expect("bundle.resources should be an array")
            .iter()
            .map(|value| value.as_str().expect("resource entries are strings"))
            .collect::<Vec<_>>();
        let expected = RUNTIME_SCRIPTS
            .iter()
            .map(|script| format!("scripts/{}", script))
            .collect::<Vec<_>>();
        assert_eq!(resources, expected);
    }

    /// Bundled resources must list exactly the runtime scripts — globs would
    /// ship test files to users, and a missing entry breaks packaged builds.
    #[test]
    fn bundle_resources_match_runtime_scripts() {
        assert_bundle_resources_match_runtime_scripts(include_str!("../tauri.conf.json"));
        assert_bundle_resources_match_runtime_scripts(include_str!("../tauri.dev.conf.json"));
    }
}
