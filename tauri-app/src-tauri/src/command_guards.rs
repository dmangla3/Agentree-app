use std::collections::BTreeMap;
use std::fs;
use std::io::ErrorKind;
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use tauri::AppHandle;

use crate::worktree_config::AgentWorktreeConfig;

const PACKAGE_MANAGER_GUARD_COMMANDS: &[&str] = &[
    "npm", "pnpm", "yarn", "bun", "pip", "pip3", "poetry", "uv", "cargo",
];

#[derive(Debug, Clone)]
struct AgentRuntimeLayout {
    pub sandbox_path: PathBuf,
    pub vars: BTreeMap<String, String>,
    dirs: Vec<PathBuf>,
}

pub fn build_agent_path() -> String {
    crate::cli_path::build_tool_path()
}

fn configured_sandbox_root(override_root: Option<&Path>) -> Option<PathBuf> {
    override_root
        .map(Path::to_path_buf)
        .or_else(|| std::env::var_os("AGENTREE_AGENT_SANDBOX_ROOT").map(PathBuf::from))
}

fn default_cache_root() -> PathBuf {
    // Build outputs can run to multiple GB. Keep them off a RAM-backed system
    // temp directory while retaining per-run cleanup and durable shared downloads.
    dirs::cache_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join("agentree")
}

fn runtime_roots(
    sandbox_override: Option<&Path>,
    shared_cache_override: Option<&Path>,
) -> (PathBuf, PathBuf) {
    let cache_root = default_cache_root();
    let sandbox_root =
        configured_sandbox_root(sandbox_override).unwrap_or_else(|| cache_root.join("agents"));
    let shared_cache_root = shared_cache_override
        .map(Path::to_path_buf)
        .or_else(|| std::env::var_os("AGENTREE_SHARED_CACHE_ROOT").map(PathBuf::from))
        .unwrap_or_else(|| cache_root.join("shared"));
    (sandbox_root, shared_cache_root)
}

fn sandbox_root(override_root: Option<&Path>) -> PathBuf {
    runtime_roots(override_root, None).0
}

pub fn agent_sandbox_root() -> PathBuf {
    sandbox_root(None)
}

#[tauri::command]
#[specta::specta]
pub fn get_agent_sandbox_root() -> String {
    path_string(&agent_sandbox_root())
}

fn sanitize_sandbox_segment(raw: &str) -> String {
    let mut sanitized = String::new();
    let mut last_was_dash = false;

    for character in raw.chars() {
        if character.is_ascii_alphanumeric()
            || character == '.'
            || character == '_'
            || character == '-'
        {
            sanitized.push(character);
            last_was_dash = false;
        } else if !last_was_dash {
            sanitized.push('-');
            last_was_dash = true;
        }
    }

    let trimmed = sanitized.trim_matches('-');
    if trimmed.is_empty() {
        "unknown".to_string()
    } else {
        trimmed.to_string()
    }
}

fn path_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn insert_path_var(
    vars: &mut BTreeMap<String, String>,
    dirs: &mut Vec<PathBuf>,
    key: &str,
    path: PathBuf,
) {
    vars.insert(key.to_string(), path_string(&path));
    dirs.push(path);
}

fn agent_runtime_layout(
    agent_id: &str,
    cwd: &Path,
    sandbox_override: Option<&Path>,
    shared_cache_override: Option<&Path>,
) -> AgentRuntimeLayout {
    let agent_id = sanitize_sandbox_segment(agent_id);
    let worktree_id = cwd
        .file_name()
        .and_then(|segment| segment.to_str())
        .map(sanitize_sandbox_segment)
        .unwrap_or_else(|| "unknown-worktree".to_string());
    let (sandbox_root, shared_cache_root) = runtime_roots(sandbox_override, shared_cache_override);
    let sandbox_path = sandbox_root.join(worktree_id).join(&agent_id);

    let mut vars = BTreeMap::new();
    let mut dirs = Vec::new();

    vars.insert("AGENT_ID".to_string(), agent_id.clone());
    vars.insert("AGENTREE_AGENT_ID".to_string(), agent_id.clone());
    vars.insert("AGENT_SANDBOX".to_string(), path_string(&sandbox_path));
    vars.insert(
        "AGENTREE_AGENT_SANDBOX".to_string(),
        path_string(&sandbox_path),
    );
    vars.insert(
        "AGENTREE_SHARED_CACHE".to_string(),
        path_string(&shared_cache_root),
    );
    dirs.push(sandbox_path.clone());
    dirs.push(shared_cache_root.clone());

    // Per-run temporary files and project-derived build output are deleted with
    // the agent sandbox.
    insert_path_var(&mut vars, &mut dirs, "TMPDIR", sandbox_path.join("tmp"));
    insert_path_var(&mut vars, &mut dirs, "TMP", sandbox_path.join("tmp"));
    insert_path_var(&mut vars, &mut dirs, "TEMP", sandbox_path.join("tmp"));
    insert_path_var(
        &mut vars,
        &mut dirs,
        "XDG_CACHE_HOME",
        sandbox_path.join("cache"),
    );
    insert_path_var(
        &mut vars,
        &mut dirs,
        "TURBO_CACHE_DIR",
        sandbox_path.join("turbo"),
    );
    insert_path_var(
        &mut vars,
        &mut dirs,
        "NX_CACHE_DIRECTORY",
        sandbox_path.join("nx"),
    );
    insert_path_var(
        &mut vars,
        &mut dirs,
        "PYTHONPYCACHEPREFIX",
        sandbox_path.join("pycache"),
    );
    insert_path_var(
        &mut vars,
        &mut dirs,
        "CARGO_TARGET_DIR",
        sandbox_path.join("cargo-target"),
    );

    // Package downloads and installed test browsers are safe to reuse. Keeping
    // them outside the per-run sandbox avoids repeated downloads after cleanup.
    insert_path_var(
        &mut vars,
        &mut dirs,
        "npm_config_cache",
        shared_cache_root.join("npm-cache"),
    );
    insert_path_var(
        &mut vars,
        &mut dirs,
        "YARN_CACHE_FOLDER",
        shared_cache_root.join("yarn-cache"),
    );
    insert_path_var(
        &mut vars,
        &mut dirs,
        "pnpm_config_store_dir",
        shared_cache_root.join("pnpm-store"),
    );
    insert_path_var(
        &mut vars,
        &mut dirs,
        "PLAYWRIGHT_BROWSERS_PATH",
        shared_cache_root.join("playwright"),
    );
    insert_path_var(
        &mut vars,
        &mut dirs,
        "CYPRESS_CACHE_FOLDER",
        shared_cache_root.join("cypress"),
    );
    insert_path_var(
        &mut vars,
        &mut dirs,
        "PIP_CACHE_DIR",
        shared_cache_root.join("pip"),
    );
    insert_path_var(
        &mut vars,
        &mut dirs,
        "UV_CACHE_DIR",
        shared_cache_root.join("uv"),
    );
    insert_path_var(
        &mut vars,
        &mut dirs,
        "GOCACHE",
        shared_cache_root.join("go-cache"),
    );

    AgentRuntimeLayout {
        sandbox_path,
        vars,
        dirs,
    }
}

fn add_isolated_tool_paths(layout: &mut AgentRuntimeLayout) {
    // Restricted agents need writable homes inside their allowed roots. Full
    // access deliberately preserves the user's normal tool state and settings.
    for (key, folder) in [
        ("XDG_STATE_HOME", "state"),
        ("PNPM_HOME", "pnpm-home"),
        ("CARGO_HOME", "cargo"),
    ] {
        insert_path_var(
            &mut layout.vars,
            &mut layout.dirs,
            key,
            layout.sandbox_path.join(folder),
        );
    }
}

pub fn agent_sandbox_path(agent_id: &str, cwd: &Path) -> PathBuf {
    agent_runtime_layout(agent_id, cwd, None, None).sandbox_path
}

pub fn cleanup_agent_sandbox(agent_id: &str, cwd: &Path) -> Result<Option<PathBuf>, String> {
    let sandbox_path = agent_sandbox_path(agent_id, cwd);
    match fs::remove_dir_all(&sandbox_path) {
        Ok(()) => Ok(Some(sandbox_path)),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!(
            "Failed to remove agent sandbox {}: {}",
            sandbox_path.display(),
            error
        )),
    }
}

fn command_guard_root() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or_else(|| "Failed to resolve home directory".to_string())?;
    Ok(home
        .join(".agentree")
        .join("runtime")
        .join("command-guards"))
}

fn write_file_if_changed(path: &Path, contents: &str) -> Result<(), String> {
    let existing = fs::read_to_string(path).ok();
    if existing.as_deref() == Some(contents) {
        return Ok(());
    }
    fs::write(path, contents).map_err(|e| format!("Failed to write {:?}: {}", path, e))
}

#[cfg(unix)]
fn mark_executable(path: &Path) -> Result<(), String> {
    let metadata = fs::metadata(path).map_err(|e| format!("Failed to read {:?}: {}", path, e))?;
    let mut permissions = metadata.permissions();
    permissions.set_mode(0o755);
    fs::set_permissions(path, permissions)
        .map_err(|e| format!("Failed to set permissions on {:?}: {}", path, e))
}

#[cfg(not(unix))]
fn mark_executable(_path: &Path) -> Result<(), String> {
    Ok(())
}

#[cfg(unix)]
fn write_guard_wrapper(bin_dir: &Path, command_name: &str) -> Result<(), String> {
    let wrapper_path = bin_dir.join(command_name);
    let contents = format!(
        "#!/bin/sh\nexec /bin/sh \"$AGENTREE_PACKAGE_MANAGER_GUARD\" \"{}\" \"$@\"\n",
        command_name
    );
    write_file_if_changed(&wrapper_path, &contents)?;
    mark_executable(&wrapper_path)
}

#[cfg(not(unix))]
fn write_guard_wrapper(_bin_dir: &Path, _command_name: &str) -> Result<(), String> {
    Ok(())
}

fn ensure_command_guard_bin() -> Result<PathBuf, String> {
    let bin_dir = command_guard_root()?.join("bin");
    fs::create_dir_all(&bin_dir)
        .map_err(|e| format!("Failed to create command guard dir {:?}: {}", bin_dir, e))?;

    for command_name in PACKAGE_MANAGER_GUARD_COMMANDS {
        write_guard_wrapper(&bin_dir, command_name)?;
    }

    Ok(bin_dir)
}

fn prepend_path_entry(entry: &Path, existing_path: &str) -> Result<String, String> {
    let mut parts = vec![entry.to_path_buf()];
    parts.extend(std::env::split_paths(existing_path).collect::<Vec<_>>());
    std::env::join_paths(parts)
        .map(|joined| joined.to_string_lossy().into_owned())
        .map_err(|e| format!("Failed to build guarded PATH: {}", e))
}

fn apply_runtime_layout(command: &mut Command, layout: &AgentRuntimeLayout) -> Result<(), String> {
    for dir in &layout.dirs {
        fs::create_dir_all(dir)
            .map_err(|e| format!("Failed to create agent runtime dir {:?}: {}", dir, e))?;
    }

    command.envs(layout.vars.iter());
    Ok(())
}

/// Apply the worktree's temporary, build-output, and cache layout without
/// installing permission guards. Every permission mode uses this layout.
pub fn apply_agent_runtime_layout(
    command: &mut Command,
    agent_id: &str,
    cwd: &Path,
) -> Result<(), String> {
    let layout = agent_runtime_layout(agent_id, cwd, None, None);
    apply_runtime_layout(command, &layout)
}

pub fn apply_agent_command_env_with_config(
    command: &mut Command,
    app: &AppHandle,
    agent_id: &str,
    cwd: &Path,
    config: &AgentWorktreeConfig,
) -> Result<(), String> {
    let base_path = build_agent_path();
    let guarded_path = if config.block_dependency_mutation_commands {
        let guard_bin = ensure_command_guard_bin()?;
        prepend_path_entry(&guard_bin, &base_path)?
    } else {
        base_path.clone()
    };
    let mut layout = agent_runtime_layout(agent_id, cwd, None, None);
    add_isolated_tool_paths(&mut layout);
    apply_runtime_layout(command, &layout)?;

    command
        .env("PATH", guarded_path)
        .env("AGENTREE_GUARD_REAL_PATH", base_path);

    if config.block_dependency_mutation_commands {
        let guard_script =
            crate::runtime_scripts::runtime_script_path(app, "package-manager-guard.sh")?;
        command.env(
            "AGENTREE_PACKAGE_MANAGER_GUARD",
            guard_script.to_string_lossy().into_owned(),
        );
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        add_isolated_tool_paths, agent_runtime_layout, agent_sandbox_root,
        apply_agent_runtime_layout, build_agent_path, cleanup_agent_sandbox,
        sanitize_sandbox_segment,
    };
    use std::ffi::OsString;
    use std::path::Path;
    use std::process::Command;
    use std::sync::Mutex;

    static ENV_LOCK: Mutex<()> = Mutex::new(());

    struct EnvVarGuard {
        name: &'static str,
        previous: Option<OsString>,
    }

    impl EnvVarGuard {
        fn set(name: &'static str, value: impl AsRef<std::ffi::OsStr>) -> Self {
            let previous = std::env::var_os(name);
            std::env::set_var(name, value);
            Self { name, previous }
        }
    }

    impl Drop for EnvVarGuard {
        fn drop(&mut self) {
            match self.previous.as_ref() {
                Some(value) => std::env::set_var(self.name, value),
                None => std::env::remove_var(self.name),
            }
        }
    }

    #[test]
    fn runtime_layout_separates_per_run_output_from_shared_downloads() {
        let layout = agent_runtime_layout(
            "assistant/node:1",
            Path::new("/repos/agentree/worktrees/worktree-123"),
            Some(Path::new("/tmp/agentree-test")),
            Some(Path::new("/tmp/agentree-shared-test")),
        );

        assert_eq!(
            layout.vars.get("AGENT_ID").map(String::as_str),
            Some("assistant-node-1")
        );
        assert_eq!(
            layout.sandbox_path.to_string_lossy(),
            "/tmp/agentree-test/worktree-123/assistant-node-1"
        );

        assert_eq!(
            layout.vars.get("AGENT_SANDBOX").map(String::as_str),
            Some("/tmp/agentree-test/worktree-123/assistant-node-1")
        );
        assert_eq!(
            layout.vars.get("TMPDIR").map(String::as_str),
            Some("/tmp/agentree-test/worktree-123/assistant-node-1/tmp")
        );
        assert_eq!(
            layout.vars.get("CARGO_TARGET_DIR").map(String::as_str),
            Some("/tmp/agentree-test/worktree-123/assistant-node-1/cargo-target")
        );
        assert_eq!(
            layout.vars.get("AGENTREE_SHARED_CACHE").map(String::as_str),
            Some("/tmp/agentree-shared-test")
        );
        assert_eq!(
            layout.vars.get("pnpm_config_store_dir").map(String::as_str),
            Some("/tmp/agentree-shared-test/pnpm-store")
        );
        assert_eq!(
            layout
                .vars
                .get("PLAYWRIGHT_BROWSERS_PATH")
                .map(String::as_str),
            Some("/tmp/agentree-shared-test/playwright")
        );
        assert_eq!(
            layout.vars.get("GOCACHE").map(String::as_str),
            Some("/tmp/agentree-shared-test/go-cache")
        );

        for preserved_key in ["CARGO_HOME", "PNPM_HOME", "XDG_STATE_HOME"] {
            assert!(
                !layout.vars.contains_key(preserved_key),
                "{preserved_key} should remain inherited in full-access runs"
            );
        }
    }

    #[test]
    fn restricted_layout_adds_private_writable_tool_homes() {
        let mut layout = agent_runtime_layout(
            "assistant-1",
            Path::new("/repos/agentree/worktrees/worktree-123"),
            Some(Path::new("/tmp/agentree-test")),
            Some(Path::new("/tmp/agentree-shared-test")),
        );
        add_isolated_tool_paths(&mut layout);

        assert_eq!(
            layout.vars.get("XDG_STATE_HOME").map(String::as_str),
            Some("/tmp/agentree-test/worktree-123/assistant-1/state")
        );
        assert_eq!(
            layout.vars.get("PNPM_HOME").map(String::as_str),
            Some("/tmp/agentree-test/worktree-123/assistant-1/pnpm-home")
        );
        assert_eq!(
            layout.vars.get("CARGO_HOME").map(String::as_str),
            Some("/tmp/agentree-test/worktree-123/assistant-1/cargo")
        );
        assert_eq!(
            layout.vars.get("XDG_CACHE_HOME").map(String::as_str),
            Some("/tmp/agentree-test/worktree-123/assistant-1/cache")
        );
    }

    #[test]
    fn sandbox_segment_sanitizing_never_returns_empty_values() {
        assert_eq!(
            sanitize_sandbox_segment("agent 1/branch:x"),
            "agent-1-branch-x"
        );
        assert_eq!(sanitize_sandbox_segment("///"), "unknown");
        assert_eq!(sanitize_sandbox_segment(""), "unknown");
    }

    #[test]
    fn sandbox_root_honors_env_override() {
        let _env_lock = ENV_LOCK.lock().unwrap();
        let _root = EnvVarGuard::set("AGENTREE_AGENT_SANDBOX_ROOT", "/tmp/custom-agentree-root");

        assert_eq!(
            agent_sandbox_root().to_string_lossy(),
            "/tmp/custom-agentree-root"
        );
    }

    #[test]
    fn sandbox_root_defaults_to_cache_dir_not_temp_dir() {
        let _env_lock = ENV_LOCK.lock().unwrap();
        let previous = std::env::var_os("AGENTREE_AGENT_SANDBOX_ROOT");
        std::env::remove_var("AGENTREE_AGENT_SANDBOX_ROOT");

        let root = agent_sandbox_root();

        match previous {
            Some(value) => std::env::set_var("AGENTREE_AGENT_SANDBOX_ROOT", value),
            None => std::env::remove_var("AGENTREE_AGENT_SANDBOX_ROOT"),
        }

        // Build caches must not land on a tmpfs. /tmp is RAM-backed on Fedora,
        // Arch and openSUSE, and cargo target dirs there exhaust memory.
        if let Some(cache_dir) = dirs::cache_dir() {
            assert!(
                root.starts_with(&cache_dir),
                "sandbox root {root:?} should live under the cache dir {cache_dir:?}"
            );
            assert_eq!(root, cache_dir.join("agentree").join("agents"));
        }
    }

    #[test]
    fn runtime_layout_applies_without_touching_permissions_or_user_tool_homes() {
        let _env_lock = ENV_LOCK.lock().unwrap();
        let temp_dir = tempfile::tempdir().unwrap();
        let shared_dir = tempfile::tempdir().unwrap();
        let _root = EnvVarGuard::set("AGENTREE_AGENT_SANDBOX_ROOT", temp_dir.path());
        let _shared_root = EnvVarGuard::set("AGENTREE_SHARED_CACHE_ROOT", shared_dir.path());

        let mut command = Command::new("true");
        apply_agent_runtime_layout(
            &mut command,
            "assistant-1",
            Path::new("/repos/agentree/worktrees/worktree-123"),
        )
        .unwrap();

        let envs: Vec<(String, Option<String>)> = command
            .get_envs()
            .map(|(k, v)| {
                (
                    k.to_string_lossy().into_owned(),
                    v.map(|value| value.to_string_lossy().into_owned()),
                )
            })
            .collect();
        let get = |key: &str| {
            envs.iter()
                .find(|(k, _)| k == key)
                .and_then(|(_, v)| v.clone())
        };

        let expected = temp_dir.path().join("worktree-123").join("assistant-1");
        assert_eq!(
            get("CARGO_TARGET_DIR"),
            Some(expected.join("cargo-target").to_string_lossy().into_owned())
        );
        assert_eq!(
            get("TMPDIR"),
            Some(expected.join("tmp").to_string_lossy().into_owned())
        );
        assert_eq!(
            get("PLAYWRIGHT_BROWSERS_PATH"),
            Some(
                shared_dir
                    .path()
                    .join("playwright")
                    .to_string_lossy()
                    .into_owned()
            )
        );

        // Full-access applies this helper, so permission controls and stateful
        // user homes must remain untouched.
        assert_eq!(get("PATH"), None);
        assert_eq!(get("AGENTREE_PACKAGE_MANAGER_GUARD"), None);
        assert_eq!(get("CARGO_HOME"), None);
        assert_eq!(get("PNPM_HOME"), None);
        assert_eq!(get("XDG_STATE_HOME"), None);
    }

    #[test]
    fn cleanup_agent_sandbox_removes_only_computed_agent_dir() {
        let _env_lock = ENV_LOCK.lock().unwrap();
        let temp_dir = tempfile::tempdir().unwrap();
        let shared_dir = tempfile::tempdir().unwrap();
        let _root = EnvVarGuard::set("AGENTREE_AGENT_SANDBOX_ROOT", temp_dir.path());
        let _shared_root = EnvVarGuard::set("AGENTREE_SHARED_CACHE_ROOT", shared_dir.path());
        let cwd = Path::new("/repos/agentree/worktrees/worktree-123");
        let sandbox = temp_dir.path().join("worktree-123").join("assistant-1");
        let sibling = temp_dir.path().join("worktree-123").join("assistant-2");
        let shared_cache = shared_dir.path().join("npm-cache");
        std::fs::create_dir_all(sandbox.join("turbo")).unwrap();
        std::fs::create_dir_all(&sibling).unwrap();
        std::fs::create_dir_all(&shared_cache).unwrap();
        std::fs::write(sandbox.join("turbo").join("index"), "run cache").unwrap();
        std::fs::write(shared_cache.join("index"), "shared cache").unwrap();

        let removed = cleanup_agent_sandbox("assistant-1", cwd).expect("cleanup sandbox");

        assert_eq!(removed.as_deref(), Some(sandbox.as_path()));
        assert!(!sandbox.exists());
        assert!(sibling.exists());
        assert!(shared_cache.exists());
    }

    #[test]
    fn agent_path_includes_nvm_cli_bins_when_app_path_is_limited() {
        let temp_dir = tempfile::tempdir().unwrap();
        let nvm_bin = temp_dir
            .path()
            .join(".nvm")
            .join("versions")
            .join("node")
            .join("v22.22.1")
            .join("bin");
        std::fs::create_dir_all(&nvm_bin).unwrap();

        let _home = EnvVarGuard::set("HOME", temp_dir.path());
        let _path = EnvVarGuard::set("PATH", "/usr/bin:/bin");

        let built_path = build_agent_path();
        let entries = std::env::split_paths(&built_path).collect::<Vec<_>>();

        assert!(entries.iter().any(|entry| entry == &nvm_bin));
    }
}
