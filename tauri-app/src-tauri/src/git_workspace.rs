use crate::types::{DiffHunk, DiffRelationship, DiffResult, DiffStats, FileDiff, FileStatus};
use once_cell::sync::Lazy;
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::fs;
#[cfg(unix)]
use std::os::unix::fs as unix_fs;
#[cfg(windows)]
use std::os::windows::fs as windows_fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager};
use tempfile::TempDir;
use walkdir::WalkDir;

fn log_agent_worktree_lifecycle(
    event: &str,
    repo_path: &str,
    node_id: &str,
    worktree_path: &Path,
    detail: &str,
) {
    crate::app_log!(
        "[AGENT_WORKTREE] event={} node_id={} path={} exists={} repo={} detail={}",
        event,
        node_id,
        worktree_path.to_string_lossy(),
        worktree_path.exists(),
        repo_path,
        detail
    );
}

static REPO_GIT_LOCKS: Lazy<Mutex<HashMap<String, Arc<Mutex<()>>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

fn repo_git_lock(repo_path: &str) -> Result<Arc<Mutex<()>>, String> {
    let key = fs::canonicalize(repo_path)
        .unwrap_or_else(|_| PathBuf::from(repo_path))
        .to_string_lossy()
        .to_string();
    let mut locks = REPO_GIT_LOCKS.lock().map_err(|e| e.to_string())?;
    Ok(locks
        .entry(key)
        .or_insert_with(|| Arc::new(Mutex::new(())))
        .clone())
}

fn with_repo_git_lock<T, F>(repo_path: &str, operation: &str, run: F) -> Result<T, String>
where
    F: FnOnce() -> Result<T, String>,
{
    let lock = repo_git_lock(repo_path)?;
    let _guard = lock.lock().map_err(|e| e.to_string())?;
    crate::app_log!(
        "[AGENT_WORKTREE] event=repo_scheduler.enter repo={} operation={}",
        repo_path,
        operation
    );
    let result = run();
    crate::app_log!(
        "[AGENT_WORKTREE] event=repo_scheduler.exit repo={} operation={} ok={}",
        repo_path,
        operation,
        result.is_ok()
    );
    result
}

#[derive(Debug, Serialize, specta::Type)]
pub struct WorkspaceInfo {
    pub repo_path: String,
    pub base_commit: Option<String>,
    pub needs_git_init: bool,
    pub has_uncommitted_changes: bool,
    pub changed_files: Vec<String>,
}

#[derive(Debug, Serialize, specta::Type)]
pub struct WorktreeInfo {
    pub node_id: String,
    pub worktree_path: String,
    pub branch_name: String,
    pub parent_commit: String,
}

#[derive(Debug, Serialize, specta::Type)]
pub struct BranchPointerInfo {
    pub name: String,
    pub commit_sha: String,
    pub git_ref: String,
}

#[derive(Debug, Serialize, specta::Type)]
pub struct GitLocalRefInfo {
    pub git_ref: String,
    pub short_name: String,
    pub commit_sha: String,
    pub committed_at: Option<String>,
}

#[derive(Debug, Serialize, specta::Type)]
pub struct GitRefTipInfo {
    pub git_ref: String,
    pub commit_sha: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Serialize, specta::Type)]
pub struct GitRefSnapshot {
    pub head_sha: Option<String>,
    pub current_branch_ref: Option<String>,
    pub refs: Vec<GitRefTipInfo>,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct GitCommitMetadata {
    pub sha: String,
    pub parents: Vec<String>,
    pub subject: String,
    pub author_name: Option<String>,
    pub author_email: Option<String>,
    pub authored_at: Option<String>,
    pub files_changed_count: Option<usize>,
    pub total_additions: Option<usize>,
    pub total_deletions: Option<usize>,
}

#[derive(Debug, Serialize, Clone, specta::Type)]
pub struct GitCommitRefLabel {
    pub git_ref: String,
    pub short_name: String,
    pub kind: String,
    pub is_current_branch: bool,
}

#[derive(Debug, Serialize, specta::Type)]
pub struct AddableCommitCandidate {
    pub sha: String,
    pub parents: Vec<String>,
    pub subject: String,
    pub author_name: Option<String>,
    pub author_email: Option<String>,
    pub authored_at: Option<String>,
    pub refs: Vec<GitCommitRefLabel>,
    pub is_head: bool,
    pub is_ref_tip: bool,
    pub is_known_graph_commit: bool,
    pub ahead_count: usize,
    pub rank_group: usize,
}

#[derive(Debug, Serialize, specta::Type)]
pub struct GitMergePreview {
    pub has_conflicts: bool,
    pub conflicted_files: Vec<String>,
    pub auto_mergeable_files: Vec<String>,
    pub merge_tree_sha: Option<String>,
    pub base_commit: String,
}

#[derive(Debug, Serialize, specta::Type)]
pub struct GitMergeResult {
    pub status: String,
    pub commit_sha: Option<String>,
    pub conflicts: Vec<String>,
    pub merge_worktree_path: Option<String>,
    pub message: Option<String>,
}

#[derive(Debug, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct FinalizeAgentWorktreeResult {
    pub commit_sha: Option<String>,
    pub commit_created: bool,
}

#[derive(Debug, Serialize, specta::Type)]
pub struct GitBlameEntry {
    pub line_start: usize,
    pub line_end: usize,
    pub content: String,
    pub author_node_id: String,
    pub is_base: bool,
}

#[derive(Debug, Serialize, specta::Type)]
pub struct GitBlameResult {
    pub node_id: String,
    pub file_path: String,
    pub total_lines: usize,
    pub entries: Vec<GitBlameEntry>,
    pub file_hash: Option<String>,
    pub is_binary: bool,
    pub file_exists: bool,
    pub warnings: Vec<String>,
}

#[derive(Debug, Serialize, specta::Type)]
pub struct CliToolStatus {
    pub installed: bool,
    pub version: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Serialize, specta::Type)]
pub struct LocalEnvironmentStatus {
    pub git: CliToolStatus,
    pub codex: CliToolStatus,
    pub codex_auth: CliToolStatus,
    pub claude: CliToolStatus,
    pub claude_auth: CliToolStatus,
}

fn run_git_with_status(repo_path: &str, args: &[&str]) -> Result<Output, String> {
    let output = Command::new("git")
        .args(args)
        .current_dir(repo_path)
        .output()
        .map_err(|e| format!("git {:?} failed: {}", args, e))?;
    Ok(output)
}

fn run_cli_probe(command: &str, args: &[&str]) -> CliToolStatus {
    match Command::new(command).args(args).output() {
        Ok(output) if output.status.success() => {
            let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            let version = if !stdout.is_empty() {
                Some(stdout)
            } else if !stderr.is_empty() {
                Some(stderr)
            } else {
                None
            };

            CliToolStatus {
                installed: true,
                version,
                error: None,
            }
        }
        Ok(output) => {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
            let detail = if !stderr.is_empty() { stderr } else { stdout };

            CliToolStatus {
                installed: false,
                version: None,
                error: Some(if detail.is_empty() {
                    format!("`{}` returned a non-zero exit status.", command)
                } else {
                    detail
                }),
            }
        }
        Err(error) => CliToolStatus {
            installed: false,
            version: None,
            error: Some(error.to_string()),
        },
    }
}

fn run_git(repo_path: &str, args: &[&str]) -> Result<String, String> {
    let output = run_git_with_status(repo_path, args)?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let detail = if !stderr.is_empty() { stderr } else { stdout };
        return Err(format!("git {:?} failed: {}", args, detail));
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

fn run_git_owned(repo_path: &str, args: Vec<String>) -> Result<String, String> {
    let arg_refs = args.iter().map(String::as_str).collect::<Vec<_>>();
    run_git(repo_path, &arg_refs)
}

fn run_git_success(repo_path: &str, args: &[&str]) -> bool {
    match run_git_with_status(repo_path, args) {
        Ok(output) => output.status.success(),
        Err(_) => false,
    }
}

fn sanitize_commit_author_name(author_name: Option<&str>) -> String {
    let raw = author_name.unwrap_or("Agentree").trim();
    let sanitized: String = raw.chars().filter(|c| *c != '\n' && *c != '\r').collect();
    if sanitized.is_empty() {
        "Agentree".to_string()
    } else {
        sanitized
    }
}

fn run_git_commit_with_author(
    repo_path: &str,
    args: &[&str],
    author_name: Option<&str>,
) -> Result<String, String> {
    let author = sanitize_commit_author_name(author_name);
    let user_name_cfg = format!("user.name={}", author);
    let output = Command::new("git")
        .args([
            "-c",
            user_name_cfg.as_str(),
            "-c",
            "user.email=agentree@local",
        ])
        .args(args)
        .current_dir(repo_path)
        .output()
        .map_err(|e| format!("git commit failed: {}", e))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let detail = if !stderr.is_empty() { stderr } else { stdout };
        return Err(format!("git {:?} failed: {}", args, detail));
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

fn run_git_commit(repo_path: &str, args: &[&str]) -> Result<String, String> {
    run_git_commit_with_author(repo_path, args, None)
}

fn ensure_directory(path: &Path) -> Result<(), String> {
    fs::create_dir_all(path).map_err(|e| format!("Failed to create {:?}: {}", path, e))
}

fn resolve_git_dir(repo_path: &str) -> Result<PathBuf, String> {
    let git_dir = run_git(repo_path, &["rev-parse", "--git-dir"])?;
    let git_dir = git_dir.trim();
    let path = PathBuf::from(git_dir);
    if path.is_absolute() {
        Ok(path)
    } else {
        Ok(Path::new(repo_path).join(path))
    }
}

fn resolve_git_common_dir(repo_path: &str) -> Result<PathBuf, String> {
    let git_dir = run_git(repo_path, &["rev-parse", "--git-common-dir"])?;
    let git_dir = git_dir.trim();
    let path = PathBuf::from(git_dir);
    if path.is_absolute() {
        Ok(path)
    } else {
        Ok(Path::new(repo_path).join(path))
    }
}

fn worktree_root(repo_path: &str) -> Result<PathBuf, String> {
    let git_dir = resolve_git_dir(repo_path)?;
    let root = git_dir.join("agentree").join("worktrees");
    ensure_directory(&root)?;
    Ok(root)
}

fn list_worktrees_for_branch(repo_path: &str, branch_name: &str) -> Result<Vec<String>, String> {
    let output = run_git(repo_path, &["worktree", "list", "--porcelain"])?;
    let target_ref = format!("refs/heads/{}", branch_name);
    let mut current_path: Option<String> = None;
    let mut current_branch: Option<String> = None;
    let mut matches = Vec::new();

    let flush_record = |path: &Option<String>, branch: &Option<String>, acc: &mut Vec<String>| {
        if let (Some(path), Some(branch)) = (path.as_ref(), branch.as_ref()) {
            if branch == &target_ref {
                acc.push(path.clone());
            }
        }
    };

    for line in output.lines() {
        if line.trim().is_empty() {
            flush_record(&current_path, &current_branch, &mut matches);
            current_path = None;
            current_branch = None;
            continue;
        }
        if let Some(path) = line.strip_prefix("worktree ") {
            current_path = Some(path.to_string());
            continue;
        }
        if let Some(branch) = line.strip_prefix("branch ") {
            current_branch = Some(branch.to_string());
            continue;
        }
    }
    flush_record(&current_path, &current_branch, &mut matches);
    Ok(matches)
}

fn list_attached_head_branches(repo_path: &str) -> Result<HashSet<String>, String> {
    let output = run_git(repo_path, &["worktree", "list", "--porcelain"])?;
    let mut branches = HashSet::new();

    for line in output.lines() {
        if let Some(branch_ref) = line.strip_prefix("branch refs/heads/") {
            branches.insert(branch_ref.to_string());
        }
    }

    Ok(branches)
}

fn archive_and_delete_node_head(
    repo_path: &str,
    head_branch_name: &str,
    node_id: &str,
) -> Result<(), String> {
    let head_ref = format!("refs/heads/{}", head_branch_name);
    if !run_git_success(repo_path, &["rev-parse", "--verify", &head_ref]) {
        return Ok(());
    }

    let head_sha = run_git(repo_path, &["rev-parse", &head_ref])?;
    let node_ref = format!("refs/agentree/nodes/{}", node_id);
    run_git(repo_path, &["update-ref", &node_ref, head_sha.trim()])?;
    run_git(repo_path, &["branch", "-D", head_branch_name])?;
    Ok(())
}

fn prune_stale_node_heads(repo_path: &str) -> Result<(), String> {
    let attached_branches = list_attached_head_branches(repo_path)?;
    let heads = run_git(
        repo_path,
        &[
            "for-each-ref",
            "--format=%(refname:short)",
            "refs/heads/agentree",
        ],
    )?;

    for branch_name in heads
        .lines()
        .map(|line| line.trim())
        .filter(|line| !line.is_empty())
    {
        if branch_name == "agentree/base" || branch_name.starts_with("agentree/merge-") {
            continue;
        }
        if attached_branches.contains(branch_name) {
            continue;
        }
        let Some(node_id) = branch_name.strip_prefix("agentree/") else {
            continue;
        };
        if node_id.is_empty() {
            continue;
        }
        archive_and_delete_node_head(repo_path, branch_name, node_id)?;
    }

    Ok(())
}

fn merge_root(_repo_path: &str) -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or_else(|| "Failed to resolve home directory".to_string())?;
    let root = home.join(".agentree").join("merge-tmp");
    ensure_directory(&root)?;
    Ok(root)
}

const DEPENDENCY_DIR_NAMES: &[&str] = &[
    "node_modules",
    ".venv",
    "venv",
    "vendor",
    ".gradle",
    "target",
];

const SCAFFOLDING_EXCLUDE_START: &str = "# agentree-managed-scaffolding:start";
const SCAFFOLDING_EXCLUDE_END: &str = "# agentree-managed-scaffolding:end";
const RUNTIME_SKILL_DIRS: &[&str] = &[".agents/skills", ".claude/skills"];

#[cfg(unix)]
fn symlink_dependency_dir(source: &Path, target: &Path) -> Result<(), String> {
    unix_fs::symlink(source, target)
        .map_err(|e| format!("Failed to symlink {:?} -> {:?}: {}", target, source, e))
}

#[cfg(windows)]
fn symlink_dependency_dir(source: &Path, target: &Path) -> Result<(), String> {
    windows_fs::symlink_dir(source, target)
        .map_err(|e| format!("Failed to symlink {:?} -> {:?}: {}", target, source, e))
}

fn candidate_dependency_roots(repo_path: &Path) -> Result<Vec<PathBuf>, String> {
    let mut roots = vec![repo_path.to_path_buf()];
    let read_dir = fs::read_dir(repo_path)
        .map_err(|e| format!("Failed to read repo directory {:?}: {}", repo_path, e))?;

    for entry in read_dir {
        let entry = entry.map_err(|e| format!("Failed to read repo entry: {}", e))?;
        let entry_type = entry
            .file_type()
            .map_err(|e| format!("Failed to read file type for {:?}: {}", entry.path(), e))?;
        if !entry_type.is_dir() {
            continue;
        }

        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') || DEPENDENCY_DIR_NAMES.contains(&name.as_str()) {
            continue;
        }

        roots.push(entry.path());
    }

    Ok(roots)
}

fn collect_dependency_dirs(repo_path: &str) -> Result<Vec<PathBuf>, String> {
    let repo_root = Path::new(repo_path);
    let mut seen = HashSet::new();
    let mut dependency_dirs = Vec::new();

    for root in candidate_dependency_roots(repo_root)? {
        for dir_name in DEPENDENCY_DIR_NAMES {
            let source = root.join(dir_name);
            if !source.is_dir() {
                continue;
            }

            let relative = source
                .strip_prefix(repo_root)
                .map_err(|e| format!("Failed to relativize dependency dir {:?}: {}", source, e))?
                .to_path_buf();
            if seen.insert(relative.clone()) {
                dependency_dirs.push(relative);
            }
        }
    }

    Ok(dependency_dirs)
}

fn relative_path_to_git_path(path: &Path) -> String {
    path.components()
        .map(|component| component.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/")
}

fn gitignore_anchor_pattern(path: &str) -> String {
    let mut pattern = String::from("/");
    for ch in path.chars() {
        match ch {
            '\\' | ' ' | '*' | '?' | '[' | ']' => {
                pattern.push('\\');
                pattern.push(ch);
            }
            _ => pattern.push(ch),
        }
    }
    pattern
}

fn replace_managed_block(content: &str, block_lines: &[String]) -> String {
    let mut kept = Vec::new();
    let mut skipping = false;
    for line in content.lines() {
        if line.trim() == SCAFFOLDING_EXCLUDE_START {
            skipping = true;
            continue;
        }
        if skipping {
            if line.trim() == SCAFFOLDING_EXCLUDE_END {
                skipping = false;
            }
            continue;
        }
        kept.push(line.to_string());
    }

    while kept.last().map(|line| line.is_empty()).unwrap_or(false) {
        kept.pop();
    }
    if !kept.is_empty() {
        kept.push(String::new());
    }
    kept.push(SCAFFOLDING_EXCLUDE_START.to_string());
    kept.extend(block_lines.iter().cloned());
    kept.push(SCAFFOLDING_EXCLUDE_END.to_string());
    format!("{}\n", kept.join("\n"))
}

fn install_scaffolding_excludes(repo_path: &str, paths: &HashSet<String>) -> Result<(), String> {
    if paths.is_empty() {
        return Ok(());
    }
    let common_git_dir = resolve_git_common_dir(repo_path)?;
    let info_dir = common_git_dir.join("info");
    ensure_directory(&info_dir)?;
    let exclude_path = info_dir.join("exclude");
    let existing = fs::read_to_string(&exclude_path).unwrap_or_default();
    let mut existing_paths = HashSet::new();
    let mut in_block = false;
    for line in existing.lines() {
        if line.trim() == SCAFFOLDING_EXCLUDE_START {
            in_block = true;
            continue;
        }
        if line.trim() == SCAFFOLDING_EXCLUDE_END {
            in_block = false;
            continue;
        }
        if in_block {
            existing_paths.insert(line.trim().to_string());
        }
    }

    for path in paths {
        existing_paths.insert(gitignore_anchor_pattern(path));
    }
    let mut block_lines = existing_paths.into_iter().collect::<Vec<_>>();
    block_lines.sort();
    let updated = replace_managed_block(&existing, &block_lines);
    fs::write(&exclude_path, updated)
        .map_err(|e| format!("Failed to write git exclude {:?}: {}", exclude_path, e))
}

fn collect_worktree_scaffolding_paths(
    repo_path: &str,
    worktree_path: &str,
) -> Result<HashSet<String>, String> {
    let repo_root = Path::new(repo_path);
    let worktree_root = Path::new(worktree_path);
    let mut paths = HashSet::new();

    for relative_dir in collect_dependency_dirs(repo_path)? {
        let worktree_link = worktree_root.join(&relative_dir);
        let Ok(metadata) = fs::symlink_metadata(&worktree_link) else {
            continue;
        };
        if !metadata.file_type().is_symlink() {
            continue;
        }
        let Ok(link_target) = fs::read_link(&worktree_link) else {
            continue;
        };
        let expected_target = repo_root.join(&relative_dir);
        if link_target == expected_target {
            paths.insert(relative_path_to_git_path(&relative_dir));
        }
    }

    paths.extend(collect_runtime_skill_scaffolding_paths(worktree_path)?);

    Ok(paths)
}

fn collect_runtime_skill_scaffolding_paths(worktree_path: &str) -> Result<HashSet<String>, String> {
    let worktree_root = Path::new(worktree_path);
    let store_root = dirs::home_dir()
        .map(|home| home.join(".agentree").join("skills"))
        .ok_or_else(|| "Failed to resolve home directory".to_string())?;
    let mut paths = HashSet::new();

    for relative_dir in RUNTIME_SKILL_DIRS {
        let runtime_dir = worktree_root.join(relative_dir);
        let Ok(entries) = fs::read_dir(&runtime_dir) else {
            continue;
        };

        for entry in entries {
            let entry = entry.map_err(|e| {
                format!(
                    "Failed to read runtime skill entry in {}: {}",
                    runtime_dir.display(),
                    e
                )
            })?;
            let path = entry.path();
            let Ok(metadata) = fs::symlink_metadata(&path) else {
                continue;
            };
            if !metadata.file_type().is_symlink() {
                continue;
            }
            let Ok(link_target) = fs::read_link(&path) else {
                continue;
            };
            let resolved_target = if link_target.is_absolute() {
                link_target
            } else {
                path.parent()
                    .map(|parent| parent.join(link_target))
                    .unwrap_or_else(|| PathBuf::from(""))
            };
            if !resolved_target.starts_with(&store_root) {
                continue;
            }
            let relative = path.strip_prefix(worktree_root).map_err(|e| {
                format!(
                    "Failed to relativize runtime skill path {}: {}",
                    path.display(),
                    e
                )
            })?;
            paths.insert(relative_path_to_git_path(relative));
        }
    }

    Ok(paths)
}

fn link_dependencies(repo_path: &str, worktree_path: &str) -> Result<Vec<PathBuf>, String> {
    let repo_root = Path::new(repo_path);
    let worktree_root = Path::new(worktree_path);
    let mut linked_paths = Vec::new();
    let mut scaffolding_paths = HashSet::new();

    for relative_dir in collect_dependency_dirs(repo_path)? {
        let source = repo_root.join(&relative_dir);
        let target = worktree_root.join(&relative_dir);
        if target.exists() {
            continue;
        }
        if let Some(parent) = target.parent() {
            ensure_directory(parent)?;
        }
        symlink_dependency_dir(&source, &target)?;
        scaffolding_paths.insert(relative_path_to_git_path(&relative_dir));
        linked_paths.push(relative_dir);
    }

    if !linked_paths.is_empty() {
        install_scaffolding_excludes(repo_path, &scaffolding_paths)?;
    }

    Ok(linked_paths)
}

fn split_nul_paths(output: &str) -> impl Iterator<Item = String> + '_ {
    output
        .split('\0')
        .map(str::trim)
        .filter(|path| !path.is_empty())
        .map(ToString::to_string)
}

fn collect_git_changed_paths(worktree_path: &str) -> Result<HashSet<String>, String> {
    let mut paths = HashSet::new();

    let tracked_changes = run_git(worktree_path, &["diff", "--name-only", "-z", "HEAD"])?;
    paths.extend(split_nul_paths(&tracked_changes));

    let staged_changes = run_git(
        worktree_path,
        &["diff", "--cached", "--name-only", "-z", "HEAD"],
    )?;
    paths.extend(split_nul_paths(&staged_changes));

    let untracked = run_git(
        worktree_path,
        &["ls-files", "--others", "--exclude-standard", "-z"],
    )?;
    paths.extend(split_nul_paths(&untracked));

    Ok(paths)
}

fn committable_changed_paths(repo_path: &str, worktree_path: &str) -> Result<Vec<String>, String> {
    let scaffolding_paths = collect_worktree_scaffolding_paths(repo_path, worktree_path)?;
    let mut paths = collect_git_changed_paths(worktree_path)?
        .into_iter()
        .filter(|path| !scaffolding_paths.contains(path))
        .collect::<Vec<_>>();
    paths.sort();
    Ok(paths)
}

fn stage_committable_paths(repo_path: &str, worktree_path: &str) -> Result<Vec<String>, String> {
    let paths = committable_changed_paths(repo_path, worktree_path)?;
    if paths.is_empty() {
        return Ok(paths);
    }

    let mut args = vec!["add".to_string(), "-A".to_string(), "--".to_string()];
    args.extend(paths.iter().cloned());
    run_git_owned(worktree_path, args)?;
    Ok(paths)
}

fn is_env_file(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .map(|name| name.starts_with(".env"))
        .unwrap_or(false)
}

fn copy_env_files(repo_path: &str, worktree_path: &str) -> Result<(), String> {
    let repo_root = Path::new(repo_path);
    let worktree_root = Path::new(worktree_path);

    for entry in WalkDir::new(repo_root)
        .follow_links(false)
        .into_iter()
        .filter_entry(|entry| {
            let path = entry.path();
            if path == repo_root {
                return true;
            }
            let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
                return true;
            };
            name != ".git" && !DEPENDENCY_DIR_NAMES.contains(&name)
        })
    {
        let entry = entry.map_err(|e| format!("Failed to walk repo for env files: {}", e))?;
        if !entry.file_type().is_file() || !is_env_file(entry.path()) {
            continue;
        }

        let relative = entry
            .path()
            .strip_prefix(repo_root)
            .map_err(|e| format!("Failed to relativize env file {:?}: {}", entry.path(), e))?;
        let target = worktree_root.join(relative);

        if let Some(parent) = target.parent() {
            ensure_directory(parent)?;
        }

        fs::copy(entry.path(), &target).map_err(|e| {
            format!(
                "Failed to copy env file {:?} -> {:?}: {}",
                entry.path(),
                target,
                e
            )
        })?;
    }

    Ok(())
}

fn sanitize_pointer_name(name: &str) -> String {
    name.trim().trim_matches('/').replace(' ', "-")
}

fn parse_commit_metadata_line(line: &str) -> Option<GitCommitMetadata> {
    let parts: Vec<&str> = line.splitn(6, '\t').collect();
    if parts.len() < 6 {
        return None;
    }

    let sha = parts[0].trim().to_string();
    if sha.is_empty() {
        return None;
    }
    let parents = parts[1]
        .split_whitespace()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>();
    let subject = parts[2].trim().to_string();
    let author_name = if parts[3].trim().is_empty() {
        None
    } else {
        Some(parts[3].trim().to_string())
    };
    let author_email = if parts[4].trim().is_empty() {
        None
    } else {
        Some(parts[4].trim().to_string())
    };
    let authored_at = if parts[5].trim().is_empty() {
        None
    } else {
        Some(parts[5].trim().to_string())
    };

    Some(GitCommitMetadata {
        sha,
        parents,
        subject,
        author_name,
        author_email,
        authored_at,
        files_changed_count: None,
        total_additions: None,
        total_deletions: None,
    })
}

fn attach_commit_stats(repo_path: &str, commit: &mut GitCommitMetadata) {
    let output = match run_git(
        repo_path,
        &[
            "show",
            "--numstat",
            "--format=",
            "--first-parent",
            "--root",
            &commit.sha,
        ],
    ) {
        Ok(output) => output,
        Err(_) => return,
    };
    let numstats = parse_numstat(&output);
    commit.files_changed_count = Some(numstats.len());
    commit.total_additions = Some(numstats.values().map(|(additions, _)| *additions).sum());
    commit.total_deletions = Some(numstats.values().map(|(_, deletions)| *deletions).sum());
}

fn attach_commit_stats_to_all(repo_path: &str, commits: &mut [GitCommitMetadata]) {
    for commit in commits {
        attach_commit_stats(repo_path, commit);
    }
}

pub fn read_commit_metadata_sync(
    repo_path: &str,
    commit_sha: &str,
) -> Result<GitCommitMetadata, String> {
    let output = run_git(
        repo_path,
        &[
            "show",
            "-s",
            "--format=%H\t%P\t%s\t%an\t%ae\t%aI",
            commit_sha.trim(),
        ],
    )?;
    let first_line = output
        .lines()
        .next()
        .ok_or_else(|| "Commit metadata not found".to_string())?;
    let mut commit = parse_commit_metadata_line(first_line)
        .ok_or_else(|| "Failed to parse commit metadata".to_string())?;
    attach_commit_stats(repo_path, &mut commit);
    Ok(commit)
}

pub fn read_commit_metadata_range_sync(
    repo_path: &str,
    base_commit: &str,
    tip_commit: &str,
) -> Result<Vec<GitCommitMetadata>, String> {
    let normalized_base = run_git(
        repo_path,
        &["rev-parse", &format!("{}^{{commit}}", base_commit.trim())],
    )?
    .trim()
    .to_string();
    let normalized_tip = run_git(
        repo_path,
        &["rev-parse", &format!("{}^{{commit}}", tip_commit.trim())],
    )?
    .trim()
    .to_string();

    if normalized_base == normalized_tip {
        return Ok(Vec::new());
    }
    if !commit_is_descendant(repo_path, &normalized_base, &normalized_tip) {
        return Err("Tip commit is not a descendant of the base commit.".to_string());
    }

    let range = format!("{}..{}", normalized_base, normalized_tip);
    let output = run_git(
        repo_path,
        &[
            "log",
            "--first-parent",
            "--reverse",
            "--format=%H\t%P\t%s\t%an\t%ae\t%aI",
            &range,
        ],
    )?;
    let mut commits = output
        .lines()
        .filter(|line| !line.trim().is_empty())
        .filter_map(parse_commit_metadata_line)
        .collect::<Vec<_>>();
    attach_commit_stats_to_all(repo_path, &mut commits);
    Ok(commits)
}

fn ref_kind(git_ref: &str) -> String {
    if git_ref.starts_with("refs/heads/") {
        "branch".to_string()
    } else if git_ref.starts_with("refs/agentree/pointers/") {
        "pointer".to_string()
    } else {
        "ref".to_string()
    }
}

fn commit_is_descendant(repo_path: &str, base_commit: &str, candidate_commit: &str) -> bool {
    run_git_success(
        repo_path,
        &[
            "merge-base",
            "--is-ancestor",
            base_commit.trim(),
            candidate_commit.trim(),
        ],
    )
}

fn first_parent_ahead_count(
    repo_path: &str,
    base_commit: &str,
    tip_commit: &str,
) -> Result<usize, String> {
    if base_commit.trim() == tip_commit.trim() {
        return Ok(0);
    }
    let range = format!("{}..{}", base_commit.trim(), tip_commit.trim());
    let output = run_git(
        repo_path,
        &["rev-list", "--first-parent", "--count", &range],
    )?;
    Ok(output.trim().parse::<usize>().unwrap_or(0))
}

fn candidate_rank_group(
    is_head: bool,
    refs: &[GitCommitRefLabel],
    is_known_graph_commit: bool,
) -> usize {
    if is_head {
        return 0;
    }
    if refs.iter().any(|label| label.is_current_branch) {
        return 1;
    }
    if refs
        .iter()
        .any(|label| label.git_ref.starts_with("refs/heads/"))
    {
        return 2;
    }
    if refs
        .iter()
        .any(|label| label.git_ref.starts_with("refs/agentree/pointers/"))
    {
        return 3;
    }
    if !refs.is_empty() {
        return 4;
    }
    if is_known_graph_commit {
        return 5;
    }
    6
}

fn candidate_from_metadata(
    repo_path: &str,
    base_commit: &str,
    metadata: GitCommitMetadata,
    refs: Vec<GitCommitRefLabel>,
    is_head: bool,
    is_known_graph_commit: bool,
) -> Result<Option<AddableCommitCandidate>, String> {
    if metadata.sha == base_commit.trim() {
        return Ok(None);
    }
    if !commit_is_descendant(repo_path, base_commit, &metadata.sha) {
        return Ok(None);
    }
    let ahead_count = first_parent_ahead_count(repo_path, base_commit, &metadata.sha)?;
    if ahead_count == 0 {
        return Ok(None);
    }
    let rank_group = candidate_rank_group(is_head, &refs, is_known_graph_commit);
    Ok(Some(AddableCommitCandidate {
        sha: metadata.sha,
        parents: metadata.parents,
        subject: metadata.subject,
        author_name: metadata.author_name,
        author_email: metadata.author_email,
        authored_at: metadata.authored_at,
        is_ref_tip: !refs.is_empty(),
        refs,
        is_head,
        is_known_graph_commit,
        ahead_count,
        rank_group,
    }))
}

fn read_commit_metadata_many(
    repo_path: &str,
    shas: &[String],
) -> Result<Vec<GitCommitMetadata>, String> {
    if shas.is_empty() {
        return Ok(Vec::new());
    }
    let mut args = vec!["show", "-s", "--format=%H\t%P\t%s\t%an\t%ae\t%aI"];
    for sha in shas {
        args.push(sha.as_str());
    }
    let output = run_git(repo_path, &args)?;
    Ok(output
        .lines()
        .filter(|line| !line.trim().is_empty())
        .filter_map(parse_commit_metadata_line)
        .collect())
}

fn diff_name_status(
    repo_path: &str,
    from_commit: &str,
    to_commit: &str,
) -> Result<Vec<(String, Option<String>, FileStatus)>, String> {
    let output = run_git(
        repo_path,
        &["diff", "--name-status", from_commit, to_commit],
    )?;
    let mut results = Vec::new();
    for line in output.lines().filter(|line| !line.trim().is_empty()) {
        let parts: Vec<&str> = line.split('\t').collect();
        if parts.is_empty() {
            continue;
        }
        let status_code = parts[0];
        let status_char = status_code.chars().next().unwrap_or('M');
        match status_char {
            'A' => results.push((
                parts.get(1).unwrap_or(&"").to_string(),
                None,
                FileStatus::Added,
            )),
            'D' => results.push((
                parts.get(1).unwrap_or(&"").to_string(),
                None,
                FileStatus::Deleted,
            )),
            'R' => results.push((
                parts.get(2).unwrap_or(&"").to_string(),
                Some(parts.get(1).unwrap_or(&"").to_string()),
                FileStatus::Renamed,
            )),
            _ => results.push((
                parts.get(1).unwrap_or(&"").to_string(),
                None,
                FileStatus::Modified,
            )),
        }
    }
    Ok(results)
}

fn parse_numstat(output: &str) -> HashMap<String, (usize, usize)> {
    let mut stats = HashMap::new();
    for line in output.lines().filter(|line| !line.trim().is_empty()) {
        let parts: Vec<&str> = line.split('\t').collect();
        if parts.len() < 3 {
            continue;
        }
        let path = parts[parts.len() - 1].to_string();
        let additions = parts[0].parse::<usize>().unwrap_or(0);
        let deletions = parts[1].parse::<usize>().unwrap_or(0);
        stats.insert(path, (additions, deletions));
    }
    stats
}

fn parse_hunks(patch: &str) -> Vec<DiffHunk> {
    let mut hunks = Vec::new();
    let mut current: Option<DiffHunk> = None;

    for line in patch.lines() {
        if let Some(header) = line.strip_prefix("@@") {
            if let Some(hunk) = current.take() {
                hunks.push(hunk);
            }
            let header = header.trim().trim_end_matches("@@").trim();
            let parts: Vec<&str> = header.split_whitespace().collect();
            if parts.len() >= 2 {
                let (old_start, old_lines) = parse_range(parts[0].trim_start_matches('-'));
                let (new_start, new_lines) = parse_range(parts[1].trim_start_matches('+'));
                current = Some(DiffHunk {
                    old_start,
                    old_lines,
                    new_start,
                    new_lines,
                    content: String::new(),
                });
            }
            continue;
        }

        if let Some(hunk) = current.as_mut() {
            hunk.content.push_str(line);
            hunk.content.push('\n');
        }
    }

    if let Some(hunk) = current {
        hunks.push(hunk);
    }

    hunks
}

fn parse_range(input: &str) -> (usize, usize) {
    let mut parts = input.split(',');
    let start = parts
        .next()
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(0);
    let lines = parts
        .next()
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(1);
    (start, lines)
}

fn build_diff_result(from_commit: &str, to_commit: &str, files: Vec<FileDiff>) -> DiffResult {
    let mut stats = DiffStats::default();
    for file in &files {
        match file.status {
            FileStatus::Added => stats.files_added += 1,
            FileStatus::Deleted => stats.files_deleted += 1,
            FileStatus::Modified | FileStatus::Renamed => stats.files_modified += 1,
            FileStatus::Unchanged => {}
        }
        stats.total_additions += file.additions;
        stats.total_deletions += file.deletions;
    }

    DiffResult {
        from_node: from_commit.to_string(),
        to_node: to_commit.to_string(),
        common_ancestor: None,
        relationship: DiffRelationship::Unrelated,
        files,
        stats,
    }
}

fn file_exists_at_ref(repo_path: &str, git_ref: &str, file_path: &str) -> bool {
    Command::new("git")
        .args(["cat-file", "-e", &format!("{git_ref}:{file_path}")])
        .current_dir(repo_path)
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
}

fn write_ref_file_or_remove(
    repo_path: &str,
    worktree_path: &str,
    git_ref: &str,
    file_path: &str,
) -> Result<(), String> {
    let target_path = Path::new(worktree_path).join(file_path);
    if file_exists_at_ref(repo_path, git_ref, file_path) {
        let content = run_git(repo_path, &["show", &format!("{git_ref}:{file_path}")])?;
        if let Some(parent) = target_path.parent() {
            ensure_directory(parent)?;
        }
        fs::write(&target_path, content)
            .map_err(|e| format!("Failed to write {:?}: {}", target_path, e))?;
        run_git(worktree_path, &["add", "--", file_path])?;
    } else if target_path.exists() {
        fs::remove_file(&target_path)
            .map_err(|e| format!("Failed to remove {:?}: {}", target_path, e))?;
        let _ = run_git(
            worktree_path,
            &["rm", "--cached", "--ignore-unmatch", "--", file_path],
        );
    }
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn check_local_environment() -> Result<LocalEnvironmentStatus, String> {
    Ok(LocalEnvironmentStatus {
        git: run_cli_probe("git", &["--version"]),
        codex: run_cli_probe("codex", &["--version"]),
        codex_auth: run_cli_probe("codex", &["login", "status"]),
        claude: run_cli_probe("claude", &["--version"]),
        claude_auth: run_cli_probe("claude", &["auth", "status"]),
    })
}

#[tauri::command]
#[specta::specta]
pub async fn attach_workspace(path: String) -> Result<WorkspaceInfo, String> {
    let workspace_path = Path::new(&path);
    if !workspace_path.exists() {
        return Err(format!("Path does not exist: {}", path));
    }
    if !workspace_path.is_dir() {
        return Err(format!("Path is not a directory: {}", path));
    }

    let is_git_repo = run_git(&path, &["rev-parse", "--is-inside-work-tree"]).is_ok();
    if !is_git_repo {
        return Ok(WorkspaceInfo {
            repo_path: path,
            base_commit: None,
            needs_git_init: true,
            has_uncommitted_changes: false,
            changed_files: vec![],
        });
    }

    run_git(&path, &["worktree", "prune"]).ok();
    prune_stale_node_heads(&path).ok();

    let status = run_git(&path, &["status", "--porcelain"])?;
    let changed_files = status
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| line.to_string())
        .collect::<Vec<_>>();
    let head_output = run_git_with_status(&path, &["rev-parse", "HEAD"])?;
    let head_commit = if head_output.status.success() {
        Some(
            String::from_utf8_lossy(&head_output.stdout)
                .trim()
                .to_string(),
        )
    } else {
        None
    };
    let mut changed_files = changed_files;
    if head_commit.is_none() && changed_files.is_empty() {
        changed_files.push("Repository has no commits yet.".to_string());
    }

    Ok(WorkspaceInfo {
        repo_path: path,
        base_commit: head_commit,
        needs_git_init: false,
        has_uncommitted_changes: !changed_files.is_empty(),
        changed_files,
    })
}

#[tauri::command]
#[specta::specta]
pub async fn init_git_repo(repo_path: String) -> Result<String, String> {
    run_git(&repo_path, &["init"])?;
    run_git(&repo_path, &["add", "-A"])?;
    run_git_commit(
        &repo_path,
        &["commit", "--allow-empty", "-m", "Initial commit"],
    )?;
    let sha = run_git(&repo_path, &["rev-parse", "HEAD"])?;
    Ok(sha.trim().to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn commit_uncommitted(repo_path: String, message: String) -> Result<String, String> {
    run_git(&repo_path, &["add", "-A"])?;
    run_git_commit(&repo_path, &["commit", "--allow-empty", "-m", &message])?;
    let sha = run_git(&repo_path, &["rev-parse", "HEAD"])?;
    Ok(sha.trim().to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn create_base_branch(repo_path: String) -> Result<String, String> {
    with_repo_git_lock(&repo_path, "create_base_branch", || {
        let head = run_git(&repo_path, &["rev-parse", "HEAD"])?;
        run_git(
            &repo_path,
            &["update-ref", "refs/heads/agentree/base", head.trim()],
        )?;
        Ok(head.trim().to_string())
    })
}

#[tauri::command]
#[specta::specta]
pub async fn create_agent_worktree(
    app: AppHandle,
    repo_path: String,
    node_id: String,
    parent_commit: String,
    run_id: Option<String>,
    workspace_id: Option<String>,
    agent_type: Option<String>,
) -> Result<WorktreeInfo, String> {
    let worktree_path = worktree_root(&repo_path)?.join(&node_id);
    let worktree_path_string = worktree_path.to_string_lossy().to_string();
    let branch_name = format!("agentree/{}", node_id);
    if let Some(run_id) = run_id.as_deref() {
        let telemetry = app.state::<crate::db::TelemetryDb>();
        let run = crate::db::AgentRunLedgerUpsert {
            run_id: run_id.to_string(),
            user_node_id: None,
            assistant_node_id: node_id.clone(),
            workspace_id: workspace_id.clone(),
            repo_path: Some(repo_path.clone()),
            worktree_path: Some(worktree_path_string.clone()),
            branch_name: Some(branch_name.clone()),
            parent_commit: Some(parent_commit.clone()),
            pid: None,
            agent_type: agent_type.clone(),
            status: "preparing_worktree".to_string(),
            phase: "preparing_worktree".to_string(),
            login_profile_id: None,
        };
        telemetry.upsert_agent_run_ledger(&run)?;
    }
    log_agent_worktree_lifecycle(
        "create.start",
        &repo_path,
        &node_id,
        &worktree_path,
        &format!("parent_commit={} branch={}", parent_commit, branch_name),
    );
    with_repo_git_lock(&repo_path, "worktree_create", || {
        for existing in list_worktrees_for_branch(&repo_path, &branch_name).unwrap_or_default() {
            log_agent_worktree_lifecycle(
                "create.remove_existing_branch.before",
                &repo_path,
                &node_id,
                Path::new(&existing),
                &format!("branch={}", branch_name),
            );
            let _ = run_git(&repo_path, &["worktree", "remove", &existing, "--force"]);
            log_agent_worktree_lifecycle(
                "create.remove_existing_branch.after",
                &repo_path,
                &node_id,
                Path::new(&existing),
                &format!("branch={}", branch_name),
            );
        }

        if worktree_path.exists() {
            log_agent_worktree_lifecycle(
                "create.remove_existing_path.before",
                &repo_path,
                &node_id,
                &worktree_path,
                "",
            );
            let _ = run_git(
                &repo_path,
                &["worktree", "remove", &worktree_path_string, "--force"],
            );
            let _ = fs::remove_dir_all(&worktree_path);
            log_agent_worktree_lifecycle(
                "create.remove_existing_path.after",
                &repo_path,
                &node_id,
                &worktree_path,
                "",
            );
        }

        if run_git_success(
            &repo_path,
            &[
                "rev-parse",
                "--verify",
                &format!("refs/heads/{}", branch_name),
            ],
        ) {
            log_agent_worktree_lifecycle(
                "create.delete_existing_branch.before",
                &repo_path,
                &node_id,
                &worktree_path,
                &format!("branch={}", branch_name),
            );
            let _ = run_git(&repo_path, &["branch", "-D", &branch_name]);
            log_agent_worktree_lifecycle(
                "create.delete_existing_branch.after",
                &repo_path,
                &node_id,
                &worktree_path,
                &format!("branch={}", branch_name),
            );
        }

        if let Err(err) = run_git(
            &repo_path,
            &[
                "worktree",
                "add",
                &worktree_path_string,
                "-B",
                &branch_name,
                &parent_commit,
            ],
        ) {
            log_agent_worktree_lifecycle(
                "create.add.error",
                &repo_path,
                &node_id,
                &worktree_path,
                &err,
            );
            return Err(err);
        }
        log_agent_worktree_lifecycle(
            "create.add.after",
            &repo_path,
            &node_id,
            &worktree_path,
            "ok",
        );
        Ok(())
    })?;
    link_dependencies(&repo_path, &worktree_path_string)?;
    // Preserve dotenv-style runtime config in the agent worktree even when git ignores it.
    copy_env_files(&repo_path, &worktree_path_string)?;
    log_agent_worktree_lifecycle(
        "create.ready",
        &repo_path,
        &node_id,
        &worktree_path,
        "dependencies_linked=true",
    );
    if run_id.is_some() {
        let _ = app
            .state::<crate::db::TelemetryDb>()
            .update_agent_run_phase(&node_id, "spawning", "spawning", None);
    }

    Ok(WorktreeInfo {
        node_id,
        worktree_path: worktree_path.to_string_lossy().to_string(),
        branch_name,
        parent_commit,
    })
}

#[tauri::command]
#[specta::specta]
pub async fn preview_agent_worktree(
    repo_path: String,
    node_id: String,
    parent_commit: String,
) -> Result<WorktreeInfo, String> {
    let worktree_path = worktree_root(&repo_path)?.join(&node_id);
    Ok(WorktreeInfo {
        node_id: node_id.clone(),
        worktree_path: worktree_path.to_string_lossy().to_string(),
        branch_name: format!("agentree/{}", node_id),
        parent_commit,
    })
}

pub async fn agent_worktree_has_changes(
    repo_path: String,
    node_id: String,
) -> Result<bool, String> {
    let worktree_path = worktree_root(&repo_path)?.join(&node_id);
    let worktree_path_string = worktree_path.to_string_lossy().to_string();
    log_agent_worktree_lifecycle(
        "has_changes.start",
        &repo_path,
        &node_id,
        &worktree_path,
        "",
    );
    let changed_paths = match committable_changed_paths(&repo_path, &worktree_path_string) {
        Ok(paths) => paths,
        Err(err) => {
            log_agent_worktree_lifecycle(
                "has_changes.error",
                &repo_path,
                &node_id,
                &worktree_path,
                &err,
            );
            return Err(err);
        }
    };
    log_agent_worktree_lifecycle(
        "has_changes.result",
        &repo_path,
        &node_id,
        &worktree_path,
        if changed_paths.is_empty() {
            "changed=false"
        } else {
            "changed=true"
        },
    );
    Ok(!changed_paths.is_empty())
}

pub fn agent_worktree_head_commit_if_advanced(
    repo_path: &str,
    node_id: &str,
    parent_commit: &str,
) -> Result<Option<GitCommitMetadata>, String> {
    let parent_commit = parent_commit.trim();
    if parent_commit.is_empty() {
        return Ok(None);
    }

    let worktree_path = worktree_root(repo_path)?.join(node_id);
    let worktree_path_string = worktree_path.to_string_lossy().to_string();
    let normalized_parent = run_git(
        &worktree_path_string,
        &["rev-parse", &format!("{}^{{commit}}", parent_commit)],
    )?
    .trim()
    .to_string();
    let head = run_git(&worktree_path_string, &["rev-parse", "HEAD"])?
        .trim()
        .to_string();

    if head.is_empty() || head == normalized_parent {
        return Ok(None);
    }

    if !run_git_success(
        &worktree_path_string,
        &["merge-base", "--is-ancestor", &normalized_parent, &head],
    ) {
        log_agent_worktree_lifecycle(
            "head_advanced.non_ancestor",
            repo_path,
            node_id,
            &worktree_path,
            &format!("parent={} head={}", normalized_parent, head),
        );
        return Ok(None);
    }

    read_commit_metadata_sync(&worktree_path_string, &head).map(Some)
}

#[tauri::command]
#[specta::specta]
pub async fn finalize_agent_worktree(
    repo_path: String,
    node_id: String,
    commit_message: String,
    author_name: Option<String>,
) -> Result<FinalizeAgentWorktreeResult, String> {
    let worktree_path = worktree_root(&repo_path)?.join(&node_id);
    let worktree_path_string = worktree_path.to_string_lossy().to_string();
    log_agent_worktree_lifecycle(
        "finalize.start",
        &repo_path,
        &node_id,
        &worktree_path,
        &format!("author_present={}", author_name.is_some()),
    );
    with_repo_git_lock(&repo_path, "worktree_finalize", || {
        let staged_paths = match stage_committable_paths(&repo_path, &worktree_path_string) {
            Ok(paths) => paths,
            Err(err) => {
                log_agent_worktree_lifecycle(
                    "finalize.add.error",
                    &repo_path,
                    &node_id,
                    &worktree_path,
                    &err,
                );
                return Err(err);
            }
        };
        if staged_paths.is_empty() {
            log_agent_worktree_lifecycle(
                "finalize.no_changes",
                &repo_path,
                &node_id,
                &worktree_path,
                "committable_paths=0",
            );
            return Ok(FinalizeAgentWorktreeResult {
                commit_sha: None,
                commit_created: false,
            });
        }
        if run_git_success(
            &worktree_path_string,
            &["diff", "--cached", "--quiet", "HEAD"],
        ) {
            log_agent_worktree_lifecycle(
                "finalize.no_changes",
                &repo_path,
                &node_id,
                &worktree_path,
                "staged_diff=empty",
            );
            return Ok(FinalizeAgentWorktreeResult {
                commit_sha: None,
                commit_created: false,
            });
        }
        if let Err(err) = run_git_commit_with_author(
            &worktree_path_string,
            &["commit", "-m", &commit_message],
            author_name.as_deref(),
        ) {
            log_agent_worktree_lifecycle(
                "finalize.commit.error",
                &repo_path,
                &node_id,
                &worktree_path,
                &err,
            );
            return Err(err);
        }
        let commit_sha = match run_git(&worktree_path_string, &["rev-parse", "HEAD"]) {
            Ok(commit_sha) => commit_sha.trim().to_string(),
            Err(err) => {
                log_agent_worktree_lifecycle(
                    "finalize.rev_parse.error",
                    &repo_path,
                    &node_id,
                    &worktree_path,
                    &err,
                );
                return Err(err);
            }
        };
        log_agent_worktree_lifecycle(
            "finalize.committed",
            &repo_path,
            &node_id,
            &worktree_path,
            &format!("commit_sha={}", commit_sha),
        );
        Ok(FinalizeAgentWorktreeResult {
            commit_sha: Some(commit_sha),
            commit_created: true,
        })
    })
}

fn normalize_commit(repo_path: &str, commit: &str) -> Result<String, String> {
    run_git(
        repo_path,
        &["rev-parse", &format!("{}^{{commit}}", commit.trim())],
    )
    .map(|value| value.trim().to_string())
}

fn normalize_target_branch_name(target_branch: &str) -> Option<String> {
    let trimmed = target_branch.trim();
    let name = trimmed
        .strip_prefix("refs/heads/")
        .unwrap_or(trimmed)
        .trim();
    if name.is_empty() || name.starts_with("agentree/") {
        return None;
    }
    Some(name.to_string())
}

fn advance_target_branch_to_commit(
    repo_path: &str,
    target_branch: Option<&str>,
    expected_old_commit: &str,
    new_commit: &str,
) -> Result<bool, String> {
    let Some(branch_name) = target_branch.and_then(normalize_target_branch_name) else {
        return Ok(false);
    };
    let branch_ref = format!("refs/heads/{}", branch_name);
    if !run_git_success(repo_path, &["check-ref-format", &branch_ref]) {
        return Err(format!("Invalid target branch name: {}", branch_name));
    }
    if !run_git_success(repo_path, &["rev-parse", "--verify", &branch_ref]) {
        return Ok(false);
    }

    let current_commit = normalize_commit(repo_path, &branch_ref)?;
    let expected_old_commit = normalize_commit(repo_path, expected_old_commit)?;
    if current_commit != expected_old_commit {
        return Err(format!(
            "Target branch {} moved while AI merge was running. Expected {}, found {}.",
            branch_name, expected_old_commit, current_commit
        ));
    }

    let checked_out_paths = list_worktrees_for_branch(repo_path, &branch_name)?;
    if checked_out_paths.is_empty() {
        run_git(
            repo_path,
            &["update-ref", &branch_ref, new_commit, &current_commit],
        )?;
        return Ok(true);
    }

    for path in &checked_out_paths {
        let status = run_git(path, &["status", "--porcelain"])?;
        if !status.trim().is_empty() {
            crate::app_log!(
                "[AGENT_WORKTREE] event=target_branch_update_skipped branch={} path={} reason=dirty_worktree",
                branch_name,
                path
            );
            return Ok(false);
        }
    }
    run_git(&checked_out_paths[0], &["reset", "--hard", new_commit])?;
    Ok(true)
}

pub fn finalize_agent_merge_worktree(
    repo_path: &str,
    node_id: &str,
    target_commit: &str,
    source_commits: &[String],
    commit_message: &str,
    author_name: Option<&str>,
    target_branch: Option<&str>,
) -> Result<(GitCommitMetadata, bool), String> {
    if source_commits.is_empty() {
        return Err("AI merge finalization requires at least one source commit.".to_string());
    }

    let worktree_path = worktree_root(repo_path)?.join(node_id);
    let worktree_path_string = worktree_path.to_string_lossy().to_string();
    log_agent_worktree_lifecycle(
        "finalize_merge.start",
        repo_path,
        node_id,
        &worktree_path,
        &format!("sources={}", source_commits.len()),
    );

    with_repo_git_lock(repo_path, "worktree_finalize_merge", || {
        stage_committable_paths(repo_path, &worktree_path_string)?;
        let tree_sha = run_git(&worktree_path_string, &["write-tree"])?
            .trim()
            .to_string();
        let target_commit = normalize_commit(repo_path, target_commit)?;
        let mut parents = vec![target_commit.clone()];
        let mut seen = HashSet::from([target_commit.clone()]);
        for source in source_commits {
            let source_commit = normalize_commit(repo_path, source)?;
            if seen.insert(source_commit.clone()) {
                parents.push(source_commit);
            }
        }
        if parents.len() < 2 {
            return Err("AI merge finalization requires at least one source commit distinct from the target commit.".to_string());
        }

        let mut commit_args = vec![
            "commit-tree".to_string(),
            tree_sha,
            "-p".to_string(),
            parents[0].clone(),
        ];
        for parent in parents.iter().skip(1) {
            commit_args.push("-p".to_string());
            commit_args.push(parent.clone());
        }
        commit_args.push("-m".to_string());
        commit_args.push(commit_message.to_string());
        let commit_arg_refs = commit_args.iter().map(String::as_str).collect::<Vec<_>>();
        let commit_sha = run_git_commit_with_author(repo_path, &commit_arg_refs, author_name)?
            .trim()
            .to_string();

        run_git(&worktree_path_string, &["reset", "--hard", &commit_sha])?;
        let target_updated =
            advance_target_branch_to_commit(repo_path, target_branch, &target_commit, &commit_sha)?;
        log_agent_worktree_lifecycle(
            "finalize_merge.committed",
            repo_path,
            node_id,
            &worktree_path,
            &format!(
                "commit_sha={} target_updated={}",
                commit_sha, target_updated
            ),
        );
        let metadata = read_commit_metadata_sync(repo_path, &commit_sha)?;
        Ok((metadata, target_updated))
    })
}

pub async fn cleanup_worktree_owned(
    repo_path: String,
    node_id: String,
    worktree_path_string: String,
    branch_name: String,
) -> Result<(), String> {
    let worktree_path = PathBuf::from(&worktree_path_string);
    log_agent_worktree_lifecycle("cleanup.start", &repo_path, &node_id, &worktree_path, "");
    with_repo_git_lock(&repo_path, "worktree_cleanup", || {
        if worktree_path.exists() {
            if let Err(err) = run_git(
                &repo_path,
                &["worktree", "remove", &worktree_path_string, "--force"],
            ) {
                log_agent_worktree_lifecycle(
                    "cleanup.remove.error",
                    &repo_path,
                    &node_id,
                    &worktree_path,
                    &err,
                );
                return Err(err);
            }
            log_agent_worktree_lifecycle(
                "cleanup.remove.after",
                &repo_path,
                &node_id,
                &worktree_path,
                "ok",
            );
        } else {
            log_agent_worktree_lifecycle(
                "cleanup.path_missing",
                &repo_path,
                &node_id,
                &worktree_path,
                "",
            );
        }
        if let Err(err) = archive_and_delete_node_head(&repo_path, &branch_name, &node_id) {
            log_agent_worktree_lifecycle(
                "cleanup.archive_head.error",
                &repo_path,
                &node_id,
                &worktree_path,
                &format!("branch={} err={}", branch_name, err),
            );
            return Err(err);
        }
        log_agent_worktree_lifecycle(
            "cleanup.done",
            &repo_path,
            &node_id,
            &worktree_path,
            &format!("branch={}", branch_name),
        );
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::{
        agent_worktree_head_commit_if_advanced, finalize_agent_merge_worktree,
        finalize_agent_worktree, is_env_file, link_dependencies, read_commit_metadata_range_sync,
        symlink_dependency_dir, worktree_root,
    };
    use std::fs;
    use std::path::Path;
    use std::process::Command;

    fn run_test_git(repo_path: &Path, args: &[&str]) -> String {
        let output = Command::new("git")
            .args(args)
            .current_dir(repo_path)
            .output()
            .expect("run git");
        assert!(
            output.status.success(),
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).trim().to_string()
    }

    fn init_test_repo() -> tempfile::TempDir {
        let dir = tempfile::tempdir().expect("repo tempdir");
        run_test_git(dir.path(), &["init"]);
        run_test_git(dir.path(), &["config", "user.name", "Agentree Test"]);
        run_test_git(
            dir.path(),
            &["config", "user.email", "agentree@example.com"],
        );
        fs::write(dir.path().join("base.txt"), "base\n").expect("write base file");
        run_test_git(dir.path(), &["add", "base.txt"]);
        run_test_git(dir.path(), &["commit", "-m", "base commit"]);
        dir
    }

    fn add_source_dependency_dirs(repo_path: &Path) {
        fs::create_dir_all(repo_path.join("client/node_modules")).expect("create client deps");
        fs::create_dir_all(repo_path.join("server/venv")).expect("create server venv");
        fs::write(
            repo_path.join("client/node_modules/package.txt"),
            "dependency\n",
        )
        .expect("write client dependency marker");
        fs::write(repo_path.join("server/venv/pyvenv.cfg"), "venv\n").expect("write venv marker");
    }

    fn add_runtime_skill_symlink(worktree_path: &Path, runtime_dir: &str) -> tempfile::TempDir {
        let store_root = dirs::home_dir()
            .expect("home directory")
            .join(".agentree")
            .join("skills");
        fs::create_dir_all(&store_root).expect("create skill store root");
        let skill_dir = tempfile::Builder::new()
            .prefix("agentree-test-runtime-skill-")
            .tempdir_in(&store_root)
            .expect("create test skill");
        fs::write(skill_dir.path().join("SKILL.md"), "# Test skill\n").expect("write skill doc");

        let runtime_path = worktree_path.join(runtime_dir);
        fs::create_dir_all(&runtime_path).expect("create runtime skill dir");
        let target = runtime_path.join(skill_dir.path().file_name().expect("skill dirname"));
        symlink_dependency_dir(skill_dir.path(), &target).expect("link runtime skill");
        skill_dir
    }

    fn create_test_agent_worktree(
        repo_path: &Path,
        repo_path_string: &str,
        node_id: &str,
        parent_commit: &str,
    ) -> std::path::PathBuf {
        let worktree_path = worktree_root(repo_path_string)
            .expect("worktree root")
            .join(node_id);
        let worktree_path_string = worktree_path.to_string_lossy().to_string();
        run_test_git(
            repo_path,
            &[
                "worktree",
                "add",
                &worktree_path_string,
                "-B",
                &format!("agentree/{node_id}"),
                parent_commit,
            ],
        );
        worktree_path
    }

    fn clear_repo_excludes(repo_path: &Path) {
        let git_common_dir = run_test_git(repo_path, &["rev-parse", "--git-common-dir"]);
        let git_common_dir = Path::new(&git_common_dir);
        let git_common_dir = if git_common_dir.is_absolute() {
            git_common_dir.to_path_buf()
        } else {
            repo_path.join(git_common_dir)
        };
        fs::create_dir_all(git_common_dir.join("info")).expect("create git info dir");
        fs::write(git_common_dir.join("info/exclude"), "").expect("clear git exclude");
    }

    #[test]
    fn env_file_detection_matches_dotenv_variants() {
        assert!(is_env_file(Path::new(".env")));
        assert!(is_env_file(Path::new(".env.local")));
        assert!(is_env_file(Path::new("nested/.env.production")));
        assert!(!is_env_file(Path::new("README.md")));
        assert!(!is_env_file(Path::new(".gitignore")));
    }

    #[test]
    fn read_commit_metadata_range_sync_returns_first_parent_commit_stack() {
        let dir = init_test_repo();
        let repo_path = dir.path().to_string_lossy().to_string();
        let base_commit = run_test_git(dir.path(), &["rev-parse", "HEAD"]);

        fs::write(dir.path().join("first.txt"), "first\n").expect("write first file");
        run_test_git(dir.path(), &["add", "first.txt"]);
        run_test_git(dir.path(), &["commit", "-m", "agent commit 1"]);
        let first_commit = run_test_git(dir.path(), &["rev-parse", "HEAD"]);

        fs::write(dir.path().join("second.txt"), "second\n").expect("write second file");
        run_test_git(dir.path(), &["add", "second.txt"]);
        run_test_git(dir.path(), &["commit", "-m", "agent commit 2"]);
        let second_commit = run_test_git(dir.path(), &["rev-parse", "HEAD"]);

        let commits = read_commit_metadata_range_sync(&repo_path, &base_commit, &second_commit)
            .expect("read commit range");

        assert_eq!(
            commits
                .iter()
                .map(|commit| commit.sha.as_str())
                .collect::<Vec<_>>(),
            vec![first_commit.as_str(), second_commit.as_str()]
        );
        assert_eq!(
            commits
                .iter()
                .map(|commit| commit.subject.as_str())
                .collect::<Vec<_>>(),
            vec!["agent commit 1", "agent commit 2"]
        );
        assert_eq!(commits[0].parents.first(), Some(&base_commit));
    }

    #[test]
    fn linked_dependency_symlinks_are_ignored_in_agent_worktree_status() {
        let dir = init_test_repo();
        add_source_dependency_dirs(dir.path());
        let repo_path = dir.path().to_string_lossy().to_string();
        let parent_commit = run_test_git(dir.path(), &["rev-parse", "HEAD"]);
        let node_id = "assistant-linked-dependencies";
        let worktree_path =
            create_test_agent_worktree(dir.path(), &repo_path, node_id, &parent_commit);
        let worktree_path_string = worktree_path.to_string_lossy().to_string();

        link_dependencies(&repo_path, &worktree_path_string).expect("link dependencies");

        assert!(
            worktree_path.join("client/node_modules").is_symlink(),
            "client dependency should be linked as worktree scaffolding"
        );
        assert!(
            worktree_path.join("server/venv").is_symlink(),
            "server venv should be linked as worktree scaffolding"
        );
        assert!(
            run_test_git(
                &worktree_path,
                &[
                    "status",
                    "--porcelain",
                    "--untracked-files=all",
                    "--",
                    "client/node_modules",
                    "server/venv",
                ],
            )
            .is_empty(),
            "Agentree-created dependency symlinks must not appear as user changes"
        );
    }

    #[test]
    fn finalize_agent_worktree_skips_symlink_only_scaffolding_changes() {
        let dir = init_test_repo();
        add_source_dependency_dirs(dir.path());
        let repo_path = dir.path().to_string_lossy().to_string();
        let parent_commit = run_test_git(dir.path(), &["rev-parse", "HEAD"]);
        let node_id = "assistant-noop-with-linked-dependencies";
        let worktree_path =
            create_test_agent_worktree(dir.path(), &repo_path, node_id, &parent_commit);
        let worktree_path_string = worktree_path.to_string_lossy().to_string();
        link_dependencies(&repo_path, &worktree_path_string).expect("link dependencies");

        let result = tauri::async_runtime::block_on(finalize_agent_worktree(
            repo_path.clone(),
            node_id.to_string(),
            "No-op agent turn".to_string(),
            Some("Agentree Test".to_string()),
        ))
        .expect("finalize agent worktree");

        assert!(!result.commit_created);
        assert_eq!(result.commit_sha, None);
        assert_eq!(
            run_test_git(&worktree_path, &["rev-parse", "HEAD"]),
            parent_commit
        );
        assert!(
            run_test_git(
                &worktree_path,
                &[
                    "status",
                    "--porcelain",
                    "--untracked-files=all",
                    "--",
                    "client/node_modules",
                    "server/venv",
                ],
            )
            .is_empty(),
            "scaffolding symlinks should remain ignored after no-op finalization"
        );
    }

    #[test]
    fn finalize_agent_worktree_filters_scaffolding_even_without_git_excludes() {
        let dir = init_test_repo();
        add_source_dependency_dirs(dir.path());
        let repo_path = dir.path().to_string_lossy().to_string();
        let parent_commit = run_test_git(dir.path(), &["rev-parse", "HEAD"]);
        let node_id = "assistant-noop-without-excludes";
        let worktree_path =
            create_test_agent_worktree(dir.path(), &repo_path, node_id, &parent_commit);
        let worktree_path_string = worktree_path.to_string_lossy().to_string();
        link_dependencies(&repo_path, &worktree_path_string).expect("link dependencies");
        clear_repo_excludes(dir.path());

        assert!(
            !run_test_git(
                &worktree_path,
                &[
                    "status",
                    "--porcelain",
                    "--untracked-files=all",
                    "--",
                    "client/node_modules",
                    "server/venv",
                ],
            )
            .is_empty(),
            "raw git status should see symlinks when the exclude convenience layer is absent"
        );

        let result = tauri::async_runtime::block_on(finalize_agent_worktree(
            repo_path,
            node_id.to_string(),
            "No-op agent turn".to_string(),
            Some("Agentree Test".to_string()),
        ))
        .expect("finalize agent worktree");

        assert!(!result.commit_created);
        assert_eq!(result.commit_sha, None);
        assert_eq!(
            run_test_git(&worktree_path, &["rev-parse", "HEAD"]),
            parent_commit
        );
    }

    #[test]
    fn finalize_agent_worktree_skips_runtime_skill_symlink_only_changes() {
        let dir = init_test_repo();
        let repo_path = dir.path().to_string_lossy().to_string();
        let parent_commit = run_test_git(dir.path(), &["rev-parse", "HEAD"]);
        let node_id = "assistant-noop-with-runtime-skills";
        let worktree_path =
            create_test_agent_worktree(dir.path(), &repo_path, node_id, &parent_commit);
        let skill_dir = add_runtime_skill_symlink(&worktree_path, ".agents/skills");

        let runtime_skill_path = format!(
            ".agents/skills/{}",
            skill_dir
                .path()
                .file_name()
                .expect("skill dirname")
                .to_string_lossy()
        );
        assert!(
            !run_test_git(
                &worktree_path,
                &[
                    "status",
                    "--porcelain",
                    "--untracked-files=all",
                    "--",
                    &runtime_skill_path,
                ],
            )
            .is_empty(),
            "raw git status should see runtime skill symlinks without an exclude rule"
        );

        let result = tauri::async_runtime::block_on(finalize_agent_worktree(
            repo_path,
            node_id.to_string(),
            "No-op agent turn".to_string(),
            Some("Agentree Test".to_string()),
        ))
        .expect("finalize agent worktree");

        assert!(!result.commit_created);
        assert_eq!(result.commit_sha, None);
        assert_eq!(
            run_test_git(&worktree_path, &["rev-parse", "HEAD"]),
            parent_commit
        );
    }

    #[test]
    fn finalize_agent_worktree_commits_real_changes_without_scaffolding_symlinks() {
        let dir = init_test_repo();
        add_source_dependency_dirs(dir.path());
        let repo_path = dir.path().to_string_lossy().to_string();
        let parent_commit = run_test_git(dir.path(), &["rev-parse", "HEAD"]);
        let node_id = "assistant-real-change-with-linked-dependencies";
        let worktree_path =
            create_test_agent_worktree(dir.path(), &repo_path, node_id, &parent_commit);
        let worktree_path_string = worktree_path.to_string_lossy().to_string();
        link_dependencies(&repo_path, &worktree_path_string).expect("link dependencies");
        fs::write(worktree_path.join("assistant.txt"), "assistant output\n")
            .expect("write assistant output");

        let result = tauri::async_runtime::block_on(finalize_agent_worktree(
            repo_path,
            node_id.to_string(),
            "Assistant output".to_string(),
            Some("Agentree Test".to_string()),
        ))
        .expect("finalize agent worktree");
        let commit_sha = result.commit_sha.expect("commit sha");

        assert!(result.commit_created);
        assert_eq!(
            run_test_git(
                &worktree_path,
                &["show", &format!("{commit_sha}:assistant.txt")]
            ),
            "assistant output"
        );
        let tree_files = run_test_git(
            &worktree_path,
            &["ls-tree", "-r", "--name-only", &commit_sha],
        );
        assert!(tree_files.lines().any(|path| path == "assistant.txt"));
        assert!(!tree_files.lines().any(|path| path == "client/node_modules"));
        assert!(!tree_files.lines().any(|path| path == "server/venv"));
    }

    #[test]
    fn finalize_agent_worktree_commits_real_changes_without_runtime_skill_symlinks() {
        let dir = init_test_repo();
        let repo_path = dir.path().to_string_lossy().to_string();
        let parent_commit = run_test_git(dir.path(), &["rev-parse", "HEAD"]);
        let node_id = "assistant-real-change-with-runtime-skills";
        let worktree_path =
            create_test_agent_worktree(dir.path(), &repo_path, node_id, &parent_commit);
        add_runtime_skill_symlink(&worktree_path, ".agents/skills");
        add_runtime_skill_symlink(&worktree_path, ".claude/skills");
        fs::write(worktree_path.join("assistant.txt"), "assistant output\n")
            .expect("write assistant output");

        let result = tauri::async_runtime::block_on(finalize_agent_worktree(
            repo_path,
            node_id.to_string(),
            "Assistant output".to_string(),
            Some("Agentree Test".to_string()),
        ))
        .expect("finalize agent worktree");
        let commit_sha = result.commit_sha.expect("commit sha");

        assert!(result.commit_created);
        assert_eq!(
            run_test_git(
                &worktree_path,
                &["show", &format!("{commit_sha}:assistant.txt")]
            ),
            "assistant output"
        );
        let tree_files = run_test_git(
            &worktree_path,
            &["ls-tree", "-r", "--name-only", &commit_sha],
        );
        assert!(tree_files.lines().any(|path| path == "assistant.txt"));
        assert!(!tree_files.lines().any(|path| path.starts_with(".agents/")));
        assert!(!tree_files.lines().any(|path| path.starts_with(".claude/")));
    }

    #[test]
    fn agent_worktree_head_commit_if_advanced_detects_clean_committed_output() {
        let dir = init_test_repo();
        let repo_path = dir.path().to_string_lossy().to_string();
        let parent_commit = run_test_git(dir.path(), &["rev-parse", "HEAD"]);
        let node_id = "assistant-clean-commit";
        let worktree_path = worktree_root(&repo_path)
            .expect("worktree root")
            .join(node_id);
        let worktree_path_string = worktree_path.to_string_lossy().to_string();
        run_test_git(
            dir.path(),
            &[
                "worktree",
                "add",
                &worktree_path_string,
                "-B",
                &format!("agentree/{node_id}"),
                &parent_commit,
            ],
        );
        fs::write(worktree_path.join("assistant.txt"), "assistant output\n")
            .expect("write assistant output");
        run_test_git(&worktree_path, &["add", "assistant.txt"]);
        run_test_git(&worktree_path, &["commit", "-m", "assistant output"]);
        assert!(run_test_git(&worktree_path, &["status", "--porcelain"]).is_empty());

        let detected = agent_worktree_head_commit_if_advanced(&repo_path, node_id, &parent_commit)
            .expect("detect advanced head")
            .expect("advanced head commit");

        assert_eq!(detected.subject, "assistant output");
        assert_eq!(detected.parents, vec![parent_commit]);
    }

    #[test]
    fn finalize_agent_merge_worktree_creates_merge_commit_and_advances_target_branch() {
        let dir = init_test_repo();
        let repo_path = dir.path().to_string_lossy().to_string();
        run_test_git(dir.path(), &["branch", "-M", "main"]);
        let target_commit = run_test_git(dir.path(), &["rev-parse", "main"]);

        run_test_git(dir.path(), &["checkout", "-b", "feature", "main"]);
        fs::write(dir.path().join("feature.txt"), "feature\n").expect("write feature file");
        run_test_git(dir.path(), &["add", "feature.txt"]);
        run_test_git(dir.path(), &["commit", "-m", "feature commit"]);
        let source_commit = run_test_git(dir.path(), &["rev-parse", "feature"]);
        run_test_git(dir.path(), &["checkout", "main"]);

        let node_id = "assistant-merge-commit";
        let worktree_path = worktree_root(&repo_path)
            .expect("worktree root")
            .join(node_id);
        let worktree_path_string = worktree_path.to_string_lossy().to_string();
        run_test_git(
            dir.path(),
            &[
                "worktree",
                "add",
                &worktree_path_string,
                "-B",
                &format!("agentree/{node_id}"),
                &target_commit,
            ],
        );
        fs::write(worktree_path.join("feature.txt"), "feature\n").expect("write resolved file");
        fs::write(worktree_path.join("decision.txt"), "ai decision\n")
            .expect("write decision file");

        let (merge_commit, target_updated) = finalize_agent_merge_worktree(
            &repo_path,
            node_id,
            &target_commit,
            &[source_commit.clone()],
            "AI merge result",
            None,
            Some("main"),
        )
        .expect("finalize merge worktree");

        assert!(target_updated);
        assert_eq!(
            merge_commit.parents,
            vec![target_commit.clone(), source_commit]
        );
        assert_eq!(merge_commit.subject, "AI merge result");
        assert_eq!(
            run_test_git(dir.path(), &["rev-parse", "main"]),
            merge_commit.sha
        );
        assert_eq!(
            run_test_git(
                dir.path(),
                &["show", &format!("{}:decision.txt", merge_commit.sha)]
            ),
            "ai decision"
        );
    }

    #[test]
    fn finalize_agent_merge_worktree_keeps_merge_commit_when_target_branch_is_dirty() {
        let dir = init_test_repo();
        let repo_path = dir.path().to_string_lossy().to_string();
        run_test_git(dir.path(), &["branch", "-M", "main"]);
        let target_commit = run_test_git(dir.path(), &["rev-parse", "main"]);

        run_test_git(dir.path(), &["checkout", "-b", "feature", "main"]);
        fs::write(dir.path().join("feature.txt"), "feature\n").expect("write feature file");
        run_test_git(dir.path(), &["add", "feature.txt"]);
        run_test_git(dir.path(), &["commit", "-m", "feature commit"]);
        let source_commit = run_test_git(dir.path(), &["rev-parse", "feature"]);
        run_test_git(dir.path(), &["checkout", "main"]);
        fs::write(dir.path().join("dirty.txt"), "local dirty work\n").expect("write dirty file");

        let node_id = "assistant-merge-dirty-target";
        let worktree_path = worktree_root(&repo_path)
            .expect("worktree root")
            .join(node_id);
        let worktree_path_string = worktree_path.to_string_lossy().to_string();
        run_test_git(
            dir.path(),
            &[
                "worktree",
                "add",
                &worktree_path_string,
                "-B",
                &format!("agentree/{node_id}"),
                &target_commit,
            ],
        );
        fs::write(worktree_path.join("feature.txt"), "feature\n").expect("write resolved file");
        fs::write(worktree_path.join("decision.txt"), "ai decision\n")
            .expect("write decision file");

        let (merge_commit, target_updated) = finalize_agent_merge_worktree(
            &repo_path,
            node_id,
            &target_commit,
            &[source_commit.clone()],
            "AI merge result",
            None,
            Some("main"),
        )
        .expect("finalize merge worktree");

        assert!(!target_updated);
        assert_eq!(
            merge_commit.parents,
            vec![target_commit.clone(), source_commit]
        );
        assert_eq!(
            run_test_git(dir.path(), &["rev-parse", "main"]),
            target_commit
        );
        assert_eq!(
            run_test_git(
                dir.path(),
                &["show", &format!("{}:decision.txt", merge_commit.sha)]
            ),
            "ai decision"
        );
        assert_eq!(
            run_test_git(&worktree_path, &["rev-parse", "HEAD"]),
            merge_commit.sha
        );
    }
}

#[tauri::command]
#[specta::specta]
pub async fn checkout_commit_detached(
    repo_path: String,
    commit_sha: String,
) -> Result<String, String> {
    let normalized_commit = run_git(
        &repo_path,
        &["rev-parse", &format!("{}^{{commit}}", commit_sha.trim())],
    )?
    .trim()
    .to_string();
    let status = run_git(&repo_path, &["status", "--porcelain"])?;
    if !status.trim().is_empty() {
        return Err("Repository has uncommitted changes. Commit, stash, or discard them before auto checkout can detach HEAD.".to_string());
    }

    run_git(&repo_path, &["checkout", "--detach", &normalized_commit])?;
    Ok(normalized_commit)
}

#[tauri::command]
#[specta::specta]
pub async fn diff_commits(
    repo_path: String,
    from_commit: String,
    to_commit: String,
    include_content: bool,
) -> Result<DiffResult, String> {
    let statuses = diff_name_status(&repo_path, &from_commit, &to_commit)?;
    let numstat_output = run_git(&repo_path, &["diff", "--numstat", &from_commit, &to_commit])?;
    let numstats = parse_numstat(&numstat_output);

    let mut files = Vec::new();
    for (path, old_path, status) in statuses {
        let stat_key = old_path.clone().unwrap_or_else(|| path.clone());
        let (additions, deletions) = numstats
            .get(&path)
            .or_else(|| numstats.get(&stat_key))
            .copied()
            .unwrap_or((0, 0));
        let patch = if include_content {
            run_git(&repo_path, &["diff", &from_commit, &to_commit, "--", &path])
                .unwrap_or_default()
        } else {
            String::new()
        };
        let is_binary = patch.contains("Binary files");
        let hunks = if include_content && !is_binary {
            Some(parse_hunks(&patch))
        } else {
            None
        };
        files.push(FileDiff {
            path,
            status,
            old_path,
            additions,
            deletions,
            hunks,
            is_binary,
            size: None,
            truncated: Some(false),
        });
    }

    Ok(build_diff_result(&from_commit, &to_commit, files))
}

#[tauri::command]
#[specta::specta]
pub async fn diff_file_between_commits(
    repo_path: String,
    from_commit: String,
    to_commit: String,
    file_path: String,
) -> Result<FileDiff, String> {
    let statuses = diff_name_status(&repo_path, &from_commit, &to_commit)?;
    let file = statuses
        .into_iter()
        .find(|(path, old_path, _)| path == &file_path || old_path.as_ref() == Some(&file_path))
        .ok_or_else(|| format!("File not found in diff: {}", file_path))?;
    let patch = run_git(
        &repo_path,
        &["diff", &from_commit, &to_commit, "--", &file_path],
    )?;
    let numstat_output = run_git(
        &repo_path,
        &[
            "diff",
            "--numstat",
            &from_commit,
            &to_commit,
            "--",
            &file_path,
        ],
    )?;
    let numstats = parse_numstat(&numstat_output);
    let (additions, deletions) = numstats.get(&file_path).copied().unwrap_or((0, 0));

    Ok(FileDiff {
        path: file.0,
        old_path: file.1,
        status: file.2,
        additions,
        deletions,
        hunks: Some(parse_hunks(&patch)),
        is_binary: patch.contains("Binary files"),
        size: None,
        truncated: Some(false),
    })
}

#[tauri::command]
#[specta::specta]
pub async fn show_file_at_commit(
    repo_path: String,
    commit: String,
    file_path: String,
) -> Result<String, String> {
    run_git(&repo_path, &["show", &format!("{commit}:{file_path}")])
}

#[tauri::command]
#[specta::specta]
pub async fn list_files_at_commit(
    repo_path: String,
    commit: String,
) -> Result<Vec<String>, String> {
    let output = run_git(&repo_path, &["ls-tree", "-r", "--name-only", &commit])?;
    Ok(output.lines().map(|line| line.to_string()).collect())
}

#[tauri::command]
#[specta::specta]
pub async fn merge_preview(
    repo_path: String,
    source_branches: Vec<String>,
    target_branch: String,
) -> Result<GitMergePreview, String> {
    if source_branches.is_empty() {
        return Err("No source branches provided".to_string());
    }

    let mut all_conflicted = HashSet::new();
    let mut all_auto_mergeable = HashSet::new();

    // Iterate through sources to detect overlaps against the target
    for source in &source_branches {
        let base = run_git(&repo_path, &["merge-base", &target_branch, source])?;
        let base = base.trim().to_string();

        let source_changed = run_git(&repo_path, &["diff", "--name-only", &base, source])?;
        let target_changed = run_git(&repo_path, &["diff", "--name-only", &base, &target_branch])?;

        let source_set = source_changed
            .lines()
            .filter(|line| !line.is_empty())
            .map(|line| line.to_string())
            .collect::<HashSet<_>>();
        let target_set = target_changed
            .lines()
            .filter(|line| !line.is_empty())
            .map(|line| line.to_string())
            .collect::<HashSet<_>>();

        let overlapping_files = source_set
            .intersection(&target_set)
            .cloned()
            .collect::<Vec<_>>();

        // For files that overlap, we do a proper in-memory merge-tree to check for true textual conflicts
        if !overlapping_files.is_empty() {
            let merge_tree_output =
                run_git(&repo_path, &["merge-tree", &base, &target_branch, source])
                    .unwrap_or_default();
            // git merge-tree (legacy mode) outputs "changed in both" and "<<<<<<<" for textual conflicts.
            // If it has conflict markers, we count the overlapping files as conflicted.
            // A more modern approach is `git merge-tree --write-tree`, but let's use the output parsing for safety here:
            if merge_tree_output.contains("<<<<<<<") {
                // If there's a conflict anywhere, conservatively flag all overlapping files as conflicted for now,
                // or parse the merge-tree output to find exactly which files failed.
                for file in overlapping_files {
                    all_conflicted.insert(file);
                }
            } else {
                for file in overlapping_files {
                    all_auto_mergeable.insert(file);
                }
            }
        }

        // Files only changed in source are auto-mergeable
        for file in source_set.difference(&target_set) {
            all_auto_mergeable.insert(file.clone());
        }
    }

    // A file cannot be both auto-mergeable and conflicted. Conflict takes precedence.
    for conflicted in &all_conflicted {
        all_auto_mergeable.remove(conflicted);
    }

    Ok(GitMergePreview {
        has_conflicts: !all_conflicted.is_empty(),
        conflicted_files: all_conflicted.into_iter().collect(),
        auto_mergeable_files: all_auto_mergeable.into_iter().collect(),
        merge_tree_sha: None, // We don't have a single clean tree SHA for octopus merges yet
        base_commit: run_git(
            &repo_path,
            &["merge-base", &target_branch, &source_branches[0]],
        )?
        .trim()
        .to_string(), // Approximate base
    })
}

#[tauri::command]
#[specta::specta]
pub async fn git_merge_apply(
    repo_path: String,
    source_branches: Vec<String>,
    target_branch: String,
    node_id: String,
    commit_message: String,
    conflict_resolutions: Option<Vec<crate::types::ConflictResolution>>,
) -> Result<GitMergeResult, String> {
    if source_branches.is_empty() {
        return Err("No source branches provided".to_string());
    }

    let merge_worktree = merge_root(&repo_path)?.join(&node_id);
    let merge_worktree_string = merge_worktree.to_string_lossy().to_string();
    if merge_worktree.exists() {
        let _ = run_git(
            &repo_path,
            &["worktree", "remove", &merge_worktree_string, "--force"],
        );
        let _ = fs::remove_dir_all(&merge_worktree);
    }

    let merge_branch = format!("agentree/merge-{}", node_id);
    run_git(
        &repo_path,
        &[
            "worktree",
            "add",
            &merge_worktree_string,
            "-B",
            &merge_branch,
            &target_branch,
        ],
    )?;

    // If resolutions are provided (which they are in the new flow), we apply them directly to the worktree
    if let Some(resolutions) = conflict_resolutions {
        let base_ref = run_git(
            &repo_path,
            &["merge-base", &target_branch, &source_branches[0]],
        )?;

        for resolution in resolutions {
            match resolution.action {
                crate::types::ResolutionAction::Source => {
                    let mut checked_out = false;

                    if let Some(source_commit) = resolution.source_commit.as_deref() {
                        if run_git_with_status(
                            &merge_worktree_string,
                            &["checkout", source_commit, "--", &resolution.path],
                        )
                        .is_ok()
                        {
                            checked_out = true;
                        }
                    }

                    if !checked_out {
                        // Find which source branch actually has the file / changed it
                        for source in &source_branches {
                            if run_git_with_status(
                                &merge_worktree_string,
                                &["checkout", source, "--", &resolution.path],
                            )
                            .is_ok()
                            {
                                checked_out = true;
                                break;
                            }
                        }
                    }

                    if !checked_out {
                        // Fallback if none of the sources had it
                        let _ = write_ref_file_or_remove(
                            &repo_path,
                            &merge_worktree_string,
                            &source_branches[0],
                            &resolution.path,
                        );
                    }
                }
                crate::types::ResolutionAction::Target => {
                    // Already at target, but enforce just in case
                    let _ = write_ref_file_or_remove(
                        &repo_path,
                        &merge_worktree_string,
                        &target_branch,
                        &resolution.path,
                    );
                }
                crate::types::ResolutionAction::Base => {
                    let _ = write_ref_file_or_remove(
                        &repo_path,
                        &merge_worktree_string,
                        base_ref.trim(),
                        &resolution.path,
                    );
                }
                crate::types::ResolutionAction::Manual => {
                    let target_path = Path::new(&merge_worktree_string).join(&resolution.path);
                    if let Some(parent) = target_path.parent() {
                        ensure_directory(parent)?;
                    }
                    fs::write(&target_path, resolution.content.unwrap_or_default()).map_err(
                        |e| format!("Failed to write resolution {:?}: {}", target_path, e),
                    )?;
                    run_git(&merge_worktree_string, &["add", "--", &resolution.path])?;
                }
            }
        }

        // Add all changes to index
        run_git(&merge_worktree_string, &["add", "-A"])?;

        // Write the tree
        let tree_sha = run_git(&merge_worktree_string, &["write-tree"])?;
        let tree_sha = tree_sha.trim();
        let target_tree = run_git(
            &repo_path,
            &["rev-parse", &format!("{}^{{tree}}", target_branch)],
        )?;
        let target_tree = target_tree.trim().to_string();

        if tree_sha == target_tree {
            run_git(
                &repo_path,
                &["worktree", "remove", &merge_worktree_string, "--force"],
            )?;
            archive_and_delete_node_head(&repo_path, &merge_branch, &node_id)?;
            return Ok(GitMergeResult {
                status: "noop".to_string(),
                commit_sha: None,
                conflicts: vec![],
                merge_worktree_path: None,
                message: Some(
                    "Nothing to merge. The resolved merge tree is identical to the target commit."
                        .to_string(),
                ),
            });
        }

        // Construct the commit-tree command with multiple parents
        let mut commit_args = vec!["commit-tree", tree_sha, "-p", &target_branch];
        for source in &source_branches {
            commit_args.push("-p");
            commit_args.push(source);
        }
        commit_args.push("-m");
        commit_args.push(&commit_message);

        // Create the multi-parent commit!
        let commit_sha = run_git(&repo_path, &commit_args)?;
        let commit_sha = commit_sha.trim().to_string();

        // Update the branch pointer to the new commit
        run_git(
            &repo_path,
            &[
                "update-ref",
                &format!("refs/heads/{}", merge_branch),
                &commit_sha,
            ],
        )?;

        // Cleanup
        run_git(
            &repo_path,
            &["worktree", "remove", &merge_worktree_string, "--force"],
        )?;
        archive_and_delete_node_head(&repo_path, &merge_branch, &node_id)?;

        return Ok(GitMergeResult {
            status: "resolved".to_string(),
            commit_sha: Some(commit_sha),
            conflicts: vec![],
            merge_worktree_path: None,
            message: None,
        });
    }

    // Fallback if no resolutions are provided: let git apply a clean merge.
    // This supports both normal two-parent merges and clean octopus merges.
    let mut merge_args = vec!["merge", "--no-commit", "--no-ff"];
    for source in &source_branches {
        merge_args.push(source);
    }

    let merge_result = run_git_with_status(&merge_worktree_string, &merge_args)?;

    if merge_result.status.success() {
        let has_no_changes = run_git_with_status(
            &merge_worktree_string,
            &["diff-index", "--quiet", "HEAD", "--"],
        )
        .map(|output| output.status.success())
        .unwrap_or(false);

        if has_no_changes {
            run_git(
                &repo_path,
                &["worktree", "remove", &merge_worktree_string, "--force"],
            )?;
            archive_and_delete_node_head(&repo_path, &merge_branch, &node_id)?;
            return Ok(GitMergeResult {
                status: "noop".to_string(),
                commit_sha: None,
                conflicts: vec![],
                merge_worktree_path: None,
                message: Some("Nothing to merge. The selected sources are already contained in the target commit.".to_string()),
            });
        }

        run_git_commit(&merge_worktree_string, &["commit", "-m", &commit_message])?;
        let sha = run_git(&merge_worktree_string, &["rev-parse", "HEAD"])?;
        run_git(
            &repo_path,
            &["worktree", "remove", &merge_worktree_string, "--force"],
        )?;
        archive_and_delete_node_head(&repo_path, &merge_branch, &node_id)?;
        return Ok(GitMergeResult {
            status: "clean".to_string(),
            commit_sha: Some(sha.trim().to_string()),
            conflicts: vec![],
            merge_worktree_path: None,
            message: None,
        });
    }

    let conflicts_output = run_git(
        &merge_worktree_string,
        &["diff", "--name-only", "--diff-filter=U"],
    )
    .unwrap_or_default();
    let conflicts = conflicts_output
        .lines()
        .filter(|line| !line.is_empty())
        .map(|line| line.to_string())
        .collect::<Vec<_>>();

    Ok(GitMergeResult {
        status: "conflicts".to_string(),
        commit_sha: None,
        conflicts,
        merge_worktree_path: Some(merge_worktree_string),
        message: None,
    })
}

#[tauri::command]
#[specta::specta]
pub async fn git_compute_blame(
    repo_path: String,
    commit: String,
    file_path: String,
) -> Result<GitBlameResult, String> {
    let show = run_git_with_status(&repo_path, &["show", &format!("{commit}:{file_path}")])?;
    if !show.status.success() {
        return Ok(GitBlameResult {
            node_id: commit,
            file_path,
            total_lines: 0,
            entries: vec![],
            file_hash: None,
            is_binary: false,
            file_exists: false,
            warnings: vec!["File not found at commit".to_string()],
        });
    }

    let blame = run_git(
        &repo_path,
        &["blame", "--porcelain", &commit, "--", &file_path],
    )?;
    let file_content = String::from_utf8_lossy(&show.stdout).to_string();
    let mut entries = Vec::new();
    let mut current_commit = String::new();
    let mut current_line = 1usize;
    for line in blame.lines() {
        let first_token_is_sha = line
            .split_whitespace()
            .next()
            .map(|token| token.len() == 40)
            .unwrap_or(false);
        if first_token_is_sha {
            current_commit = line.split_whitespace().next().unwrap_or("").to_string();
            continue;
        }
        if let Some(content) = line.strip_prefix('\t') {
            entries.push(GitBlameEntry {
                line_start: current_line,
                line_end: current_line,
                content: content.to_string(),
                author_node_id: current_commit.clone(),
                is_base: current_commit == commit,
            });
            current_line += 1;
        }
    }

    let temp_dir = TempDir::new().map_err(|e| e.to_string())?;
    let temp_file = temp_dir.path().join("blame.tmp");
    fs::write(&temp_file, &file_content).map_err(|e| e.to_string())?;
    let temp_dir_string = temp_dir.path().to_string_lossy().to_string();
    let temp_file_string = temp_file.to_string_lossy().to_string();
    let file_hash = run_git(&temp_dir_string, &["hash-object", &temp_file_string]).ok();

    Ok(GitBlameResult {
        node_id: commit.clone(),
        file_path,
        total_lines: entries.len(),
        entries,
        file_hash: file_hash.map(|value| value.trim().to_string()),
        is_binary: false,
        file_exists: true,
        warnings: vec![],
    })
}

#[tauri::command]
#[specta::specta]
pub async fn create_branch_pointer(
    repo_path: String,
    pointer_name: String,
    commit_sha: String,
) -> Result<String, String> {
    let name = sanitize_pointer_name(&pointer_name);
    let git_ref = format!("refs/agentree/pointers/{}", name);
    run_git(&repo_path, &["update-ref", &git_ref, &commit_sha])?;
    Ok(git_ref)
}

#[tauri::command]
#[specta::specta]
pub async fn delete_branch_pointer(repo_path: String, pointer_name: String) -> Result<(), String> {
    let name = sanitize_pointer_name(&pointer_name);
    let git_ref = format!("refs/agentree/pointers/{}", name);
    run_git(&repo_path, &["update-ref", "-d", &git_ref])?;
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn move_branch_pointer(
    repo_path: String,
    pointer_name: String,
    new_commit_sha: String,
) -> Result<(), String> {
    let name = sanitize_pointer_name(&pointer_name);
    let git_ref = format!("refs/agentree/pointers/{}", name);
    run_git(&repo_path, &["update-ref", &git_ref, &new_commit_sha])?;
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn update_git_ref(
    repo_path: String,
    git_ref: String,
    new_commit_sha: String,
    expected_current_sha: Option<String>,
) -> Result<(), String> {
    if !git_ref.starts_with("refs/heads/") && !git_ref.starts_with("refs/agentree/pointers/") {
        return Err("Only local branches and Agentree pointers can be updated.".to_string());
    }

    if let Some(expected_sha) = expected_current_sha
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
    {
        run_git(
            &repo_path,
            &["update-ref", &git_ref, &new_commit_sha, &expected_sha],
        )?;
    } else {
        run_git(&repo_path, &["update-ref", &git_ref, &new_commit_sha])?;
    }
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn list_branch_pointers(repo_path: String) -> Result<Vec<BranchPointerInfo>, String> {
    let output = run_git(
        &repo_path,
        &[
            "for-each-ref",
            "refs/agentree/pointers/",
            "--format=%(refname)\t%(refname:strip=3)\t%(objectname)",
        ],
    )?;
    Ok(output
        .lines()
        .filter(|line| !line.is_empty())
        .filter_map(|line| {
            let parts: Vec<&str> = line.splitn(3, '\t').collect();
            if parts.len() != 3 {
                return None;
            }
            Some(BranchPointerInfo {
                git_ref: parts[0].to_string(),
                name: parts[1].to_string(),
                commit_sha: parts[2].to_string(),
            })
        })
        .collect())
}

#[tauri::command]
#[specta::specta]
pub async fn list_local_refs(repo_path: String) -> Result<Vec<GitLocalRefInfo>, String> {
    let output = run_git(
        &repo_path,
        &[
            "for-each-ref",
            "--sort=-committerdate",
            "--format=%(refname)\t%(refname:short)\t%(objectname)\t%(committerdate:iso-strict)",
            "refs/heads",
            "refs/agentree/pointers",
        ],
    )?;

    Ok(output
        .lines()
        .filter(|line| !line.is_empty())
        .filter_map(|line| {
            let parts: Vec<&str> = line.splitn(4, '\t').collect();
            if parts.len() != 4 {
                return None;
            }
            Some(GitLocalRefInfo {
                git_ref: parts[0].to_string(),
                short_name: parts[1].to_string(),
                commit_sha: parts[2].to_string(),
                committed_at: if parts[3].is_empty() {
                    None
                } else {
                    Some(parts[3].to_string())
                },
            })
        })
        .collect())
}

#[tauri::command]
#[specta::specta]
pub async fn resolve_ref_tip(repo_path: String, git_ref: String) -> Result<String, String> {
    let commit = run_git(
        &repo_path,
        &["rev-parse", &format!("{}^{{commit}}", git_ref)],
    )?;
    Ok(commit.trim().to_string())
}

fn resolve_ref_tip_quiet(repo_path: &str, git_ref: &str) -> Result<Option<String>, String> {
    let spec = format!("{}^{{commit}}", git_ref.trim());
    let output = run_git_with_status(repo_path, &["rev-parse", "--verify", "--quiet", &spec])?;
    if !output.status.success() {
        return Ok(None);
    }

    let commit = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if commit.is_empty() {
        Ok(None)
    } else {
        Ok(Some(commit))
    }
}

fn resolve_current_branch_ref_sync(repo_path: &str) -> Result<Option<String>, String> {
    let output = run_git_with_status(repo_path, &["symbolic-ref", "--quiet", "--short", "HEAD"])?;
    if !output.status.success() {
        return Ok(None);
    }

    let branch = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if branch.is_empty() {
        return Ok(None);
    }

    Ok(Some(format!("refs/heads/{branch}")))
}

#[tauri::command]
#[specta::specta]
pub async fn snapshot_git_refs(
    repo_path: String,
    git_refs: Vec<String>,
) -> Result<GitRefSnapshot, String> {
    let head_sha = resolve_ref_tip_quiet(&repo_path, "HEAD")?;
    let current_branch_ref = resolve_current_branch_ref_sync(&repo_path)?;
    let mut refs = Vec::with_capacity(git_refs.len());

    for git_ref in git_refs {
        let trimmed = git_ref.trim().to_string();
        if trimmed.is_empty() {
            continue;
        }

        match resolve_ref_tip_quiet(&repo_path, &trimmed) {
            Ok(commit_sha) => refs.push(GitRefTipInfo {
                git_ref: trimmed,
                commit_sha,
                error: None,
            }),
            Err(error) => refs.push(GitRefTipInfo {
                git_ref: trimmed,
                commit_sha: None,
                error: Some(error),
            }),
        }
    }

    Ok(GitRefSnapshot {
        head_sha,
        current_branch_ref,
        refs,
    })
}

#[tauri::command]
#[specta::specta]
pub async fn resolve_current_branch_ref(repo_path: String) -> Result<Option<String>, String> {
    resolve_current_branch_ref_sync(&repo_path)
}

#[tauri::command]
#[specta::specta]
pub async fn list_missing_commits(
    repo_path: String,
    from_commit: Option<String>,
    to_commit: String,
    limit: Option<usize>,
) -> Result<Vec<GitCommitMetadata>, String> {
    let starts_from_scratch = from_commit
        .as_ref()
        .map(|value| value.trim().is_empty())
        .unwrap_or(true);
    let mut args = vec![
        "log",
        "--first-parent",
        "--reverse",
        "--format=%H\t%P\t%s\t%an\t%ae\t%aI",
    ];
    let max_count_arg: String;
    if let Some(max_count) = limit.filter(|value| *value > 0) {
        max_count_arg = format!("--max-count={max_count}");
        args.push(&max_count_arg);
    }
    let range_owned: String;
    if let Some(from) = from_commit
        .as_ref()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
    {
        let to = to_commit.trim();
        let effective_from =
            if run_git_success(&repo_path, &["merge-base", "--is-ancestor", from, to]) {
                from.to_string()
            } else {
                run_git(&repo_path, &["merge-base", from, to])?
                    .trim()
                    .to_string()
            };
        range_owned = format!("{effective_from}..{to}");
        args.push(&range_owned);
    } else {
        args.push(to_commit.trim());
    }

    let output = run_git(&repo_path, &args)?;
    let mut commits: Vec<GitCommitMetadata> = output
        .lines()
        .filter(|line| !line.trim().is_empty())
        .filter_map(parse_commit_metadata_line)
        .collect();

    if starts_from_scratch && limit.filter(|value| *value > 0).is_some() {
        if let Some(first_parent_sha) = commits
            .first()
            .and_then(|commit| commit.parents.first())
            .map(|sha| sha.trim())
            .filter(|sha| !sha.is_empty())
        {
            let already_included = commits.iter().any(|commit| commit.sha == first_parent_sha);
            if !already_included {
                let parent_output = run_git(
                    &repo_path,
                    &[
                        "show",
                        "-s",
                        "--format=%H\t%P\t%s\t%an\t%ae\t%aI",
                        first_parent_sha,
                    ],
                )?;
                if let Some(parent_commit) = parent_output
                    .lines()
                    .next()
                    .and_then(parse_commit_metadata_line)
                {
                    commits.insert(0, parent_commit);
                }
            }
        }
    }

    attach_commit_stats_to_all(&repo_path, &mut commits);
    Ok(commits)
}

#[tauri::command]
#[specta::specta]
pub async fn read_commit_metadata(
    repo_path: String,
    commit_sha: String,
) -> Result<GitCommitMetadata, String> {
    read_commit_metadata_sync(&repo_path, &commit_sha)
}

#[tauri::command]
#[specta::specta]
pub async fn list_addable_commit_candidates(
    repo_path: String,
    base_commit: String,
    limit: Option<usize>,
    known_graph_commits: Option<Vec<String>>,
) -> Result<Vec<AddableCommitCandidate>, String> {
    let normalized_base = run_git(
        &repo_path,
        &["rev-parse", &format!("{}^{{commit}}", base_commit.trim())],
    )?
    .trim()
    .to_string();
    let current_branch_ref = resolve_current_branch_ref_sync(&repo_path)?;
    let head_sha = resolve_ref_tip_quiet(&repo_path, "HEAD")?;
    let local_refs = list_local_refs(repo_path.clone()).await?;
    let mut refs_by_sha: HashMap<String, Vec<GitCommitRefLabel>> = HashMap::new();
    for local_ref in local_refs {
        refs_by_sha
            .entry(local_ref.commit_sha.clone())
            .or_default()
            .push(GitCommitRefLabel {
                git_ref: local_ref.git_ref.clone(),
                short_name: local_ref.short_name.clone(),
                kind: ref_kind(&local_ref.git_ref),
                is_current_branch: current_branch_ref
                    .as_ref()
                    .map(|current| current == &local_ref.git_ref)
                    .unwrap_or(false),
            });
    }

    let known_graph_set: HashSet<String> = known_graph_commits
        .unwrap_or_default()
        .into_iter()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .collect();
    let mut candidate_shas: HashSet<String> = HashSet::new();
    for sha in refs_by_sha.keys() {
        candidate_shas.insert(sha.clone());
    }
    for sha in &known_graph_set {
        candidate_shas.insert(sha.clone());
    }
    if let Some(head) = &head_sha {
        candidate_shas.insert(head.clone());
    }

    let range = format!("{}..", normalized_base);
    let recent_limit = limit.unwrap_or(40).min(60).max(1).to_string();
    let recent_output = run_git_with_status(
        &repo_path,
        &[
            "log",
            "--all",
            "--date-order",
            &format!("-{}", recent_limit),
            "--format=%H",
            &range,
        ],
    )?;
    if recent_output.status.success() {
        for line in String::from_utf8_lossy(&recent_output.stdout).lines() {
            let sha = line.trim();
            if !sha.is_empty() {
                candidate_shas.insert(sha.to_string());
            }
        }
    }

    let candidate_sha_list = candidate_shas.into_iter().collect::<Vec<_>>();
    let metadata_list = read_commit_metadata_many(&repo_path, &candidate_sha_list)?;
    let mut candidates: Vec<AddableCommitCandidate> = Vec::new();
    for metadata in metadata_list {
        let refs = refs_by_sha.get(&metadata.sha).cloned().unwrap_or_default();
        let is_head = head_sha
            .as_ref()
            .map(|head| head == &metadata.sha)
            .unwrap_or(false);
        let is_known_graph_commit = known_graph_set.contains(&metadata.sha);
        if let Some(candidate) = candidate_from_metadata(
            &repo_path,
            &normalized_base,
            metadata,
            refs,
            is_head,
            is_known_graph_commit,
        )? {
            candidates.push(candidate);
        }
    }

    candidates.sort_by(|left, right| {
        left.rank_group
            .cmp(&right.rank_group)
            .then_with(|| left.ahead_count.cmp(&right.ahead_count))
            .then_with(|| right.authored_at.cmp(&left.authored_at))
            .then_with(|| left.sha.cmp(&right.sha))
    });

    let max_results = limit.unwrap_or(80).max(1);
    candidates.truncate(max_results);
    Ok(candidates)
}

#[tauri::command]
#[specta::specta]
pub async fn list_addable_commit_range(
    repo_path: String,
    base_commit: String,
    tip_commit: String,
    limit: Option<usize>,
) -> Result<Vec<GitCommitMetadata>, String> {
    let normalized_base = run_git(
        &repo_path,
        &["rev-parse", &format!("{}^{{commit}}", base_commit.trim())],
    )?
    .trim()
    .to_string();
    let normalized_tip = run_git(
        &repo_path,
        &["rev-parse", &format!("{}^{{commit}}", tip_commit.trim())],
    )?
    .trim()
    .to_string();

    if normalized_base == normalized_tip {
        return Ok(Vec::new());
    }
    if !commit_is_descendant(&repo_path, &normalized_base, &normalized_tip) {
        return Err(
            "Selected commit is not a descendant of this node's current code commit.".to_string(),
        );
    }

    let mut args = vec![
        "log",
        "--first-parent",
        "--reverse",
        "--format=%H\t%P\t%s\t%an\t%ae\t%aI",
    ];
    let max_count_arg: String;
    if let Some(max_count) = limit.filter(|value| *value > 0) {
        max_count_arg = format!("--max-count={max_count}");
        args.push(&max_count_arg);
    }
    let range = format!("{}..{}", normalized_base, normalized_tip);
    args.push(&range);

    let output = run_git(&repo_path, &args)?;
    let mut commits = output
        .lines()
        .filter(|line| !line.trim().is_empty())
        .filter_map(parse_commit_metadata_line)
        .collect::<Vec<_>>();
    attach_commit_stats_to_all(&repo_path, &mut commits);
    Ok(commits)
}

#[tauri::command]
#[specta::specta]
pub async fn list_all_commits(
    repo_path: String,
    limit: Option<usize>,
    exclusions: Option<Vec<String>>,
    exclude_descendants_of: Option<String>,
) -> Result<Vec<GitCommitMetadata>, String> {
    let mut args = vec!["log", "--all", "--format=%H\t%P\t%s\t%an\t%ae\t%aI"];

    if let Some(excl_list) = &exclusions {
        for excl in excl_list {
            if !excl.trim().is_empty() {
                args.push("--not");
                args.push(excl.trim());
            }
        }
    }

    let limit_str: String;
    if let Some(l) = limit {
        limit_str = format!("-{}", l);
        args.push(&limit_str);
    } else {
        args.push("-100"); // Default limit
    }

    let output = run_git(&repo_path, &args)?;
    let mut commits: Vec<GitCommitMetadata> = output
        .lines()
        .filter(|line| !line.trim().is_empty())
        .filter_map(parse_commit_metadata_line)
        .collect();

    // If requested, filter out descendants of a specific commit (e.g. the target)
    if let Some(target_sha) = exclude_descendants_of {
        if !target_sha.trim().is_empty() {
            // Get all descendants of the target commit
            let desc_output = run_git(
                &repo_path,
                &[
                    "rev-list",
                    "--all",
                    "--ancestry-path",
                    &format!("{}..", target_sha.trim()),
                ],
            )
            .unwrap_or_default();
            let descendant_shas: HashSet<String> = desc_output
                .lines()
                .filter(|l| !l.trim().is_empty())
                .map(|l| l.trim().to_string())
                .collect();

            commits.retain(|c| !descendant_shas.contains(&c.sha));
        }
    }

    attach_commit_stats_to_all(&repo_path, &mut commits);
    Ok(commits)
}
