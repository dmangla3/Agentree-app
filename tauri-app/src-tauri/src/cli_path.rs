use std::ffi::OsString;
use std::path::{Path, PathBuf};

const SYSTEM_PATH_ENTRIES: &[&str] = &[
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
];

const STATIC_HOME_BIN_ENTRIES: &[&str] = &[
    ".volta/bin",
    ".asdf/shims",
    ".local/bin",
    ".npm-global/bin",
    ".bun/bin",
    "Library/pnpm",
];

pub fn build_tool_path() -> String {
    let base = build_tool_path_from(std::env::var_os("PATH"), dirs::home_dir());
    let merged = merge_login_shell_path(base);
    prepend_managed_node_bin(merged)
}

/// The managed Node bin dir leads the tool path so adapters (and the SDK's
/// own `node` lookup in child processes) resolve the pinned runtime before
/// any system or version-manager install.
fn prepend_managed_node_bin(base: String) -> String {
    let Some(install_dir) = crate::managed_runtime::installed_component_dir_without_app(
        crate::managed_runtime::COMPONENT_NODE,
    ) else {
        return base;
    };
    let bin_dir = match crate::managed_runtime::node_binary_path(&install_dir).parent() {
        Some(dir) => dir.to_path_buf(),
        None => return base,
    };
    let mut parts = vec![bin_dir];
    parts.extend(std::env::split_paths(&base));
    std::env::join_paths(parts)
        .map(|joined| joined.to_string_lossy().into_owned())
        .unwrap_or(base)
}

/// GUI-launched apps (AppImage, .app) get a bare desktop PATH; the user's
/// terminal sees version-manager dirs prepended by their shell profile.
/// Append the login shell's PATH entries so both resolve the same tools.
fn merge_login_shell_path(base: String) -> String {
    let Some(login_path) = login_shell_path() else {
        return base;
    };
    let mut parts: Vec<PathBuf> = std::env::split_paths(&base).collect();
    for entry in std::env::split_paths(login_path) {
        push_unique(&mut parts, entry);
    }
    std::env::join_paths(parts)
        .map(|joined| joined.to_string_lossy().into_owned())
        .unwrap_or(base)
}

#[cfg(unix)]
fn login_shell_path() -> Option<&'static str> {
    use once_cell::sync::OnceCell;
    static LOGIN_PATH: OnceCell<Option<String>> = OnceCell::new();
    LOGIN_PATH
        .get_or_init(|| {
            let shell = std::env::var("SHELL")
                .ok()
                .filter(|value| !value.trim().is_empty())?;
            let (sender, receiver) = std::sync::mpsc::channel();
            std::thread::spawn(move || {
                let output = std::process::Command::new(shell)
                    .args(["-lc", "printf %s \"$PATH\""])
                    .stdin(std::process::Stdio::null())
                    .output();
                let _ = sender.send(output);
            });
            let output = receiver
                .recv_timeout(std::time::Duration::from_secs(3))
                .ok()?
                .ok()?;
            if !output.status.success() {
                return None;
            }
            let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if path.is_empty() {
                None
            } else {
                Some(path)
            }
        })
        .as_deref()
}

#[cfg(not(unix))]
fn login_shell_path() -> Option<&'static str> {
    None
}

fn build_tool_path_from(base_path: Option<OsString>, home_dir: Option<PathBuf>) -> String {
    let mut parts: Vec<PathBuf> = base_path
        .map(|raw| std::env::split_paths(&raw).collect())
        .unwrap_or_default();

    if let Some(home) = home_dir.as_deref() {
        for path in shell_manager_bin_dirs(home) {
            push_unique(&mut parts, path);
        }
    }

    for extra in SYSTEM_PATH_ENTRIES {
        push_unique(&mut parts, PathBuf::from(extra));
    }

    std::env::join_paths(parts)
        .map(|joined| joined.to_string_lossy().into_owned())
        .unwrap_or_else(|_| SYSTEM_PATH_ENTRIES.join(":"))
}

pub fn find_on_tool_path(command: &str) -> Option<String> {
    for path in std::env::split_paths(&build_tool_path()) {
        let candidate = path.join(command);
        if candidate.exists() {
            return Some(candidate.to_string_lossy().into_owned());
        }
    }
    None
}

/// Every match on the tool path, in path order. Lets callers version-check
/// candidates instead of trusting the first (possibly stale) hit.
pub fn find_all_on_tool_path(command: &str) -> Vec<String> {
    let mut matches = Vec::new();
    for path in std::env::split_paths(&build_tool_path()) {
        let candidate = path.join(command);
        if candidate.exists() {
            let resolved = candidate.to_string_lossy().into_owned();
            if !matches.contains(&resolved) {
                matches.push(resolved);
            }
        }
    }
    matches
}

fn shell_manager_bin_dirs(home: &Path) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    append_node_version_bins(&mut dirs, &home.join(".nvm").join("versions").join("node"));
    append_fnm_version_bins(&mut dirs, &home.join(".fnm").join("node-versions"));

    for relative in STATIC_HOME_BIN_ENTRIES {
        let path = home.join(relative);
        if path.exists() {
            dirs.push(path);
        }
    }

    dirs
}

fn append_node_version_bins(dirs: &mut Vec<PathBuf>, versions_dir: &Path) {
    let Ok(entries) = std::fs::read_dir(versions_dir) else {
        return;
    };
    let mut version_bins = entries
        .flatten()
        .map(|entry| entry.path().join("bin"))
        .filter(|path| path.exists())
        .collect::<Vec<_>>();
    version_bins.sort();
    version_bins.reverse();
    dirs.extend(version_bins);
}

fn append_fnm_version_bins(dirs: &mut Vec<PathBuf>, versions_dir: &Path) {
    let Ok(entries) = std::fs::read_dir(versions_dir) else {
        return;
    };
    let mut version_bins = entries
        .flatten()
        .map(|entry| entry.path().join("installation").join("bin"))
        .filter(|path| path.exists())
        .collect::<Vec<_>>();
    version_bins.sort();
    version_bins.reverse();
    dirs.extend(version_bins);
}

fn push_unique(parts: &mut Vec<PathBuf>, path: PathBuf) {
    if !parts.iter().any(|entry| entry == &path) {
        parts.push(path);
    }
}

#[cfg(test)]
mod tests {
    use super::build_tool_path_from;
    use std::ffi::OsString;

    #[test]
    fn tool_path_includes_nvm_cli_bins_when_base_path_is_limited() {
        let temp_dir = tempfile::tempdir().unwrap();
        let nvm_bin = temp_dir
            .path()
            .join(".nvm")
            .join("versions")
            .join("node")
            .join("v22.22.1")
            .join("bin");
        std::fs::create_dir_all(&nvm_bin).unwrap();

        let built_path = build_tool_path_from(
            Some(OsString::from("/usr/bin:/bin")),
            Some(temp_dir.path().to_path_buf()),
        );
        let entries = std::env::split_paths(&built_path).collect::<Vec<_>>();

        assert!(entries.iter().any(|entry| entry == &nvm_bin));
    }
}
