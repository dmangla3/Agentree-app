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
pub struct AgentSandboxEnv {
    pub agent_id: String,
    pub sandbox_path: PathBuf,
    pub vars: BTreeMap<String, String>,
    dirs: Vec<PathBuf>,
}

pub fn build_agent_path() -> String {
    crate::cli_path::build_tool_path()
}

fn sandbox_root(override_root: Option<&Path>) -> PathBuf {
    if let Some(root) = override_root {
        return root.to_path_buf();
    }

    std::env::var_os("AGENTREE_AGENT_SANDBOX_ROOT")
        .map(PathBuf::from)
        .unwrap_or_else(|| std::env::temp_dir().join("agentree").join("agents"))
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

fn agent_sandbox_env(agent_id: &str, cwd: &Path, root_override: Option<&Path>) -> AgentSandboxEnv {
    let agent_id = sanitize_sandbox_segment(agent_id);
    let worktree_id = cwd
        .file_name()
        .and_then(|segment| segment.to_str())
        .map(sanitize_sandbox_segment)
        .unwrap_or_else(|| "unknown-worktree".to_string());
    let sandbox_path = sandbox_root(root_override)
        .join(worktree_id)
        .join(&agent_id);

    let mut vars = BTreeMap::new();
    let mut dirs = Vec::new();

    vars.insert("AGENT_ID".to_string(), agent_id.clone());
    vars.insert("AGENTREE_AGENT_ID".to_string(), agent_id.clone());
    vars.insert("AGENT_SANDBOX".to_string(), path_string(&sandbox_path));
    vars.insert(
        "AGENTREE_AGENT_SANDBOX".to_string(),
        path_string(&sandbox_path),
    );
    dirs.push(sandbox_path.clone());

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
        "XDG_STATE_HOME",
        sandbox_path.join("state"),
    );
    insert_path_var(
        &mut vars,
        &mut dirs,
        "npm_config_cache",
        sandbox_path.join("npm-cache"),
    );
    insert_path_var(
        &mut vars,
        &mut dirs,
        "YARN_CACHE_FOLDER",
        sandbox_path.join("yarn-cache"),
    );
    insert_path_var(
        &mut vars,
        &mut dirs,
        "PNPM_HOME",
        sandbox_path.join("pnpm-home"),
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
        "PLAYWRIGHT_BROWSERS_PATH",
        sandbox_path.join("playwright"),
    );
    insert_path_var(
        &mut vars,
        &mut dirs,
        "CYPRESS_CACHE_FOLDER",
        sandbox_path.join("cypress"),
    );
    insert_path_var(
        &mut vars,
        &mut dirs,
        "PIP_CACHE_DIR",
        sandbox_path.join("pip"),
    );
    insert_path_var(
        &mut vars,
        &mut dirs,
        "UV_CACHE_DIR",
        sandbox_path.join("uv"),
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
        "GOCACHE",
        sandbox_path.join("go-cache"),
    );
    insert_path_var(
        &mut vars,
        &mut dirs,
        "CARGO_HOME",
        sandbox_path.join("cargo"),
    );
    insert_path_var(
        &mut vars,
        &mut dirs,
        "CARGO_TARGET_DIR",
        sandbox_path.join("cargo-target"),
    );

    AgentSandboxEnv {
        agent_id,
        sandbox_path,
        vars,
        dirs,
    }
}

pub fn agent_sandbox_path(agent_id: &str, cwd: &Path) -> PathBuf {
    agent_sandbox_env(agent_id, cwd, None).sandbox_path
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
    let sandbox = agent_sandbox_env(agent_id, cwd, None);

    for dir in &sandbox.dirs {
        fs::create_dir_all(dir)
            .map_err(|e| format!("Failed to create agent sandbox dir {:?}: {}", dir, e))?;
    }

    command
        .env("PATH", guarded_path)
        .env(
            "PYTHON_BIN",
            crate::runtime_scripts::runtime_python_command(app),
        )
        .env("AGENTREE_GUARD_REAL_PATH", base_path)
        .envs(sandbox.vars.iter());

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
        agent_sandbox_env, agent_sandbox_root, build_agent_path, cleanup_agent_sandbox,
        sanitize_sandbox_segment,
    };
    use std::ffi::OsString;
    use std::path::Path;
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
    fn sandbox_env_uses_stable_worktree_and_agent_segments() {
        let env = agent_sandbox_env(
            "assistant/node:1",
            Path::new("/repos/agentree/worktrees/worktree-123"),
            Some(Path::new("/tmp/agentree-test")),
        );

        assert_eq!(env.agent_id, "assistant-node-1");
        assert_eq!(
            env.sandbox_path.to_string_lossy(),
            "/tmp/agentree-test/worktree-123/assistant-node-1"
        );

        assert_eq!(
            env.vars.get("AGENT_SANDBOX").map(String::as_str),
            Some("/tmp/agentree-test/worktree-123/assistant-node-1")
        );
        assert_eq!(
            env.vars.get("TMPDIR").map(String::as_str),
            Some("/tmp/agentree-test/worktree-123/assistant-node-1/tmp")
        );
        assert_eq!(
            env.vars.get("XDG_CACHE_HOME").map(String::as_str),
            Some("/tmp/agentree-test/worktree-123/assistant-node-1/cache")
        );
        assert_eq!(
            env.vars.get("CARGO_TARGET_DIR").map(String::as_str),
            Some("/tmp/agentree-test/worktree-123/assistant-node-1/cargo-target")
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
    fn cleanup_agent_sandbox_removes_only_computed_agent_dir() {
        let _env_lock = ENV_LOCK.lock().unwrap();
        let temp_dir = tempfile::tempdir().unwrap();
        let _root = EnvVarGuard::set("AGENTREE_AGENT_SANDBOX_ROOT", temp_dir.path());
        let cwd = Path::new("/repos/agentree/worktrees/worktree-123");
        let sandbox = temp_dir.path().join("worktree-123").join("assistant-1");
        let sibling = temp_dir.path().join("worktree-123").join("assistant-2");
        std::fs::create_dir_all(sandbox.join("npm-cache")).unwrap();
        std::fs::create_dir_all(&sibling).unwrap();
        std::fs::write(sandbox.join("npm-cache").join("index"), "cache").unwrap();

        let removed = cleanup_agent_sandbox("assistant-1", cwd).expect("cleanup sandbox");

        assert_eq!(removed.as_deref(), Some(sandbox.as_path()));
        assert!(!sandbox.exists());
        assert!(sibling.exists());
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
