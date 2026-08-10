use std::fs;
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use tauri::AppHandle;

const PACKAGE_MANAGER_GUARD_COMMANDS: &[&str] = &[
    "npm", "pnpm", "yarn", "bun", "pip", "pip3", "poetry", "uv", "cargo",
];

pub fn build_agent_path() -> String {
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
        if !parts.iter().any(|p| p == &path) {
            parts.push(path);
        }
    }

    std::env::join_paths(parts)
        .map(|joined| joined.to_string_lossy().into_owned())
        .unwrap_or_else(|_| {
            "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin".to_string()
        })
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

pub fn apply_agent_command_env(command: &mut Command, app: &AppHandle) -> Result<(), String> {
    let base_path = build_agent_path();
    let guard_bin = ensure_command_guard_bin()?;
    let guarded_path = prepend_path_entry(&guard_bin, &base_path)?;
    let guard_script =
        crate::runtime_scripts::runtime_script_path(app, "package-manager-guard.sh")?;

    command
        .env("PATH", guarded_path)
        .env("PYTHON_BIN", crate::runtime_scripts::runtime_python_command(app))
        .env("AGENTREE_GUARD_REAL_PATH", base_path)
        .env(
            "AGENTREE_PACKAGE_MANAGER_GUARD",
            guard_script.to_string_lossy().into_owned(),
        );

    Ok(())
}
