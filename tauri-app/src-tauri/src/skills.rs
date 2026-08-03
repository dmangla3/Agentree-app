use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use tauri::{AppHandle, Emitter};
use tempfile::tempdir;
use walkdir::WalkDir;

const SKILL_DOC_FILENAME: &str = "SKILL.md";
const SKILL_METADATA_FILENAME: &str = ".agentree-source.json";

#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct SkillSummary {
    pub id: String,
    pub name: String,
    pub description: String,
    pub installed: bool,
    pub source: String,
    pub path: Option<String>,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct SkillProgressEvent {
    pub op_id: String,
    pub operation: String,
    pub skill_id: Option<String>,
    pub stage: String,
    pub message: String,
    pub done: bool,
    pub error: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
struct SkillSourceMetadata {
    canonical_id: String,
    source: String,
}

#[derive(Clone)]
struct SkillProgress {
    app: AppHandle,
    op_id: String,
    operation: String,
    skill_id: Option<String>,
}

impl SkillProgress {
    fn new(
        app: AppHandle,
        op_id: Option<String>,
        operation: &str,
        skill_id: Option<String>,
    ) -> Self {
        Self {
            app,
            op_id: op_id.unwrap_or_else(|| {
                format!(
                    "{}:{}",
                    operation,
                    skill_id.clone().unwrap_or_else(|| "all".to_string())
                )
            }),
            operation: operation.to_string(),
            skill_id,
        }
    }

    fn emit(&self, stage: &str, message: &str, done: bool, error: bool) {
        let _ = self.app.emit(
            "skills:progress",
            SkillProgressEvent {
                op_id: self.op_id.clone(),
                operation: self.operation.clone(),
                skill_id: self.skill_id.clone(),
                stage: stage.to_string(),
                message: message.to_string(),
                done,
                error,
            },
        );
    }

    fn stage(&self, stage: &str, message: &str) {
        self.emit(stage, message, false, false);
    }

    fn finish(&self, stage: &str, message: &str) {
        self.emit(stage, message, true, false);
    }

    fn fail(&self, stage: &str, message: &str) {
        self.emit(stage, message, true, true);
    }
}

fn agentree_skills_dir() -> Result<PathBuf, String> {
    let home_dir =
        dirs::home_dir().ok_or_else(|| "Failed to resolve home directory".to_string())?;
    Ok(home_dir.join(".agentree").join("skills"))
}

fn runtime_skill_dir(agent_type: &str, cwd: &Path) -> Option<PathBuf> {
    match agent_type {
        "claude" => Some(cwd.join(".claude").join("skills")),
        "codex" => Some(cwd.join(".agents").join("skills")),
        _ => None,
    }
}

fn skill_directories(root: &Path) -> Result<Vec<PathBuf>, String> {
    let mut skills = Vec::new();
    if !root.exists() {
        return Ok(skills);
    }

    let entries = fs::read_dir(root)
        .map_err(|e| format!("Failed to read skill store {}: {}", root.display(), e))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("Failed to read skill store entry: {}", e))?;
        let path = entry.path();
        if path.is_dir() && path.join(SKILL_DOC_FILENAME).exists() {
            skills.push(path);
        }
    }
    skills.sort();
    Ok(skills)
}

fn remove_existing_path(path: &Path) -> Result<(), String> {
    if !path.exists() && fs::symlink_metadata(path).is_err() {
        return Ok(());
    }

    let metadata = fs::symlink_metadata(path)
        .map_err(|e| format!("Failed to inspect {}: {}", path.display(), e))?;
    if metadata.file_type().is_symlink() || metadata.is_file() {
        fs::remove_file(path)
            .map_err(|e| format!("Failed to remove existing file {}: {}", path.display(), e))?;
        return Ok(());
    }

    if metadata.is_dir() {
        fs::remove_dir_all(path).map_err(|e| {
            format!(
                "Failed to remove existing directory {}: {}",
                path.display(),
                e
            )
        })?;
    }
    Ok(())
}

#[cfg(unix)]
fn symlink_dir(source: &Path, target: &Path) -> Result<(), String> {
    std::os::unix::fs::symlink(source, target).map_err(|e| {
        format!(
            "Failed to create symlink {} -> {}: {}",
            target.display(),
            source.display(),
            e
        )
    })
}

#[cfg(windows)]
fn symlink_dir(source: &Path, target: &Path) -> Result<(), String> {
    std::os::windows::fs::symlink_dir(source, target).map_err(|e| {
        format!(
            "Failed to create symlink {} -> {}: {}",
            target.display(),
            source.display(),
            e
        )
    })
}

fn sync_skill_entry(runtime_dir: &Path, source_dir: &Path) -> Result<(), String> {
    let skill_name = source_dir
        .file_name()
        .ok_or_else(|| format!("Invalid skill path {}", source_dir.display()))?;
    let target_path = runtime_dir.join(skill_name);

    if let Ok(existing_target) = fs::read_link(&target_path) {
        if existing_target == source_dir {
            return Ok(());
        }
    }

    if target_path.exists() || fs::symlink_metadata(&target_path).is_ok() {
        let metadata = fs::symlink_metadata(&target_path)
            .map_err(|e| format!("Failed to inspect {}: {}", target_path.display(), e))?;
        if !metadata.file_type().is_symlink() {
            crate::app_log!(
                "[Skills] Skipping existing non-symlink runtime skill {}",
                target_path.display()
            );
            return Ok(());
        }
        remove_existing_path(&target_path)?;
    }

    symlink_dir(source_dir, &target_path)
}

fn infer_skill_name(skill_folder: &str, content: &str) -> String {
    if let Some(name) = frontmatter_value(content, "name") {
        return name;
    }

    content
        .lines()
        .find_map(|line| line.strip_prefix("# ").map(str::trim))
        .filter(|line| !line.is_empty())
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| skill_folder.replace('-', " "))
}

fn infer_skill_description(content: &str) -> String {
    if let Some(description) = frontmatter_value(content, "description") {
        return description;
    }

    let mut in_frontmatter = false;
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed == "---" {
            in_frontmatter = !in_frontmatter;
            continue;
        }
        if in_frontmatter || trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        return trimmed.to_string();
    }
    "No description available.".to_string()
}

fn frontmatter_value(content: &str, key: &str) -> Option<String> {
    let mut lines = content.lines();
    if lines.next()?.trim() != "---" {
        return None;
    }

    let prefix = format!("{}:", key);
    for line in lines {
        let trimmed = line.trim();
        if trimmed == "---" {
            return None;
        }
        if let Some(value) = trimmed.strip_prefix(&prefix) {
            let normalized = value.trim().trim_matches('"').trim_matches('\'');
            if !normalized.is_empty() {
                return Some(normalized.to_string());
            }
        }
    }
    None
}

fn parse_source_metadata(skill_dir: &Path) -> Option<SkillSourceMetadata> {
    let metadata_path = skill_dir.join(SKILL_METADATA_FILENAME);
    let raw = fs::read_to_string(metadata_path).ok()?;
    serde_json::from_str(&raw).ok()
}

fn summarize_local_skill(skill_dir: &Path) -> Result<SkillSummary, String> {
    let folder_name = skill_dir
        .file_name()
        .ok_or_else(|| format!("Invalid skill path {}", skill_dir.display()))?
        .to_string_lossy()
        .into_owned();
    let skill_doc = fs::read_to_string(skill_dir.join(SKILL_DOC_FILENAME))
        .map_err(|e| format!("Failed to read {}: {}", skill_dir.display(), e))?;
    let metadata = parse_source_metadata(skill_dir);
    let id = metadata
        .as_ref()
        .map(|meta| meta.canonical_id.clone())
        .unwrap_or_else(|| folder_name.clone());
    let source = metadata
        .as_ref()
        .map(|meta| meta.source.clone())
        .unwrap_or_else(|| "local".to_string());

    Ok(SkillSummary {
        id,
        name: infer_skill_name(&folder_name, &skill_doc),
        description: infer_skill_description(&skill_doc),
        installed: true,
        source,
        path: Some(skill_dir.to_string_lossy().into_owned()),
    })
}

fn installed_skill_ids(store_dir: &Path) -> Result<HashSet<String>, String> {
    let mut ids = HashSet::new();
    for skill_dir in skill_directories(store_dir)? {
        let folder_name = skill_dir
            .file_name()
            .ok_or_else(|| format!("Invalid skill path {}", skill_dir.display()))?
            .to_string_lossy()
            .into_owned();
        ids.insert(folder_name);
        if let Some(metadata) = parse_source_metadata(&skill_dir) {
            ids.insert(metadata.canonical_id);
        }
    }
    Ok(ids)
}

fn strip_ansi(input: &str) -> String {
    let mut output = String::new();
    let mut chars = input.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '\u{1b}' {
            if let Some('[') = chars.peek() {
                chars.next();
                while let Some(next) = chars.next() {
                    if ('@'..='~').contains(&next) {
                        break;
                    }
                }
            }
            continue;
        }
        output.push(ch);
    }
    output
}

fn split_canonical_id(canonical_id: &str) -> (String, String) {
    if let Some((source, skill_name)) = canonical_id.split_once('@') {
        return (source.to_string(), skill_name.to_string());
    }
    ("registry".to_string(), canonical_id.to_string())
}

fn parse_search_results(output: &str, installed_ids: &HashSet<String>) -> Vec<SkillSummary> {
    let cleaned = strip_ansi(output);
    let mut pending_ref: Option<(String, String)> = None;
    let mut results = Vec::new();

    for raw_line in cleaned.lines() {
        let line = raw_line.trim();
        if line.is_empty() {
            continue;
        }

        if line.starts_with("└ https://skills.sh/") || line.starts_with("https://skills.sh/") {
            if let Some((canonical_id, install_info)) = pending_ref.take() {
                let (source, skill_name) = split_canonical_id(&canonical_id);
                let description = if install_info.is_empty() {
                    "Registry result".to_string()
                } else {
                    install_info
                };
                results.push(SkillSummary {
                    id: canonical_id.clone(),
                    name: skill_name,
                    description,
                    installed: installed_ids.contains(&canonical_id),
                    source,
                    path: None,
                });
            }
            continue;
        }

        if line.contains('@') && line.contains('/') {
            let first_token = line.split_whitespace().next().unwrap_or_default();
            if first_token.contains('@') && first_token.contains('/') {
                let remainder = line[first_token.len()..].trim();
                pending_ref = Some((first_token.to_string(), remainder.to_string()));
            }
        }
    }

    results
}

fn run_skills_cli(args: &[&str], cwd: &Path) -> Result<String, String> {
    let output = Command::new("npx")
        .args(["skills"])
        .args(args)
        .current_dir(cwd)
        .output()
        .map_err(|e| format!("Failed to run `npx skills {}`: {}", args.join(" "), e))?;

    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
    let combined = if stderr.trim().is_empty() {
        stdout.clone()
    } else {
        format!("{}\n{}", stdout, stderr)
    };

    if !output.status.success() {
        return Err(strip_ansi(&combined).trim().to_string());
    }

    Ok(combined)
}

fn copy_dir_recursive(source: &Path, destination: &Path) -> Result<(), String> {
    fs::create_dir_all(destination).map_err(|e| {
        format!(
            "Failed to create directory {}: {}",
            destination.display(),
            e
        )
    })?;

    for entry in fs::read_dir(source)
        .map_err(|e| format!("Failed to read directory {}: {}", source.display(), e))?
    {
        let entry = entry.map_err(|e| format!("Failed to read directory entry: {}", e))?;
        let source_path = entry.path();
        let destination_path = destination.join(entry.file_name());
        if source_path.is_dir() {
            copy_dir_recursive(&source_path, &destination_path)?;
        } else {
            fs::copy(&source_path, &destination_path).map_err(|e| {
                format!(
                    "Failed to copy {} -> {}: {}",
                    source_path.display(),
                    destination_path.display(),
                    e
                )
            })?;
        }
    }

    Ok(())
}

fn find_installed_skill_dir(root: &Path) -> Result<PathBuf, String> {
    let mut candidates = Vec::new();
    for entry in WalkDir::new(root).into_iter().filter_map(Result::ok) {
        if entry.file_type().is_file() && entry.file_name() == SKILL_DOC_FILENAME {
            if let Some(parent) = entry.path().parent() {
                candidates.push(parent.to_path_buf());
            }
        }
    }

    candidates.sort_by_key(|path| path.components().count());
    candidates
        .into_iter()
        .next()
        .ok_or_else(|| "The skills CLI did not produce an installable skill directory.".to_string())
}

fn resolve_store_skill(skill_id: &str) -> Result<Option<PathBuf>, String> {
    let store_dir = agentree_skills_dir()?;
    if !store_dir.exists() {
        return Ok(None);
    }

    for skill_dir in skill_directories(&store_dir)? {
        let folder_name = skill_dir
            .file_name()
            .ok_or_else(|| format!("Invalid skill path {}", skill_dir.display()))?
            .to_string_lossy()
            .into_owned();
        if folder_name == skill_id {
            return Ok(Some(skill_dir));
        }
        if let Some(metadata) = parse_source_metadata(&skill_dir) {
            if metadata.canonical_id == skill_id {
                return Ok(Some(skill_dir));
            }
        }
    }
    Ok(None)
}

fn write_skill_metadata_with_source(
    skill_dir: &Path,
    canonical_id: &str,
    source: &str,
) -> Result<(), String> {
    let metadata = SkillSourceMetadata {
        canonical_id: canonical_id.to_string(),
        source: source.to_string(),
    };
    let metadata_path = skill_dir.join(SKILL_METADATA_FILENAME);
    let payload = serde_json::to_string_pretty(&metadata)
        .map_err(|e| format!("Failed to encode skill metadata: {}", e))?;
    fs::write(&metadata_path, payload)
        .map_err(|e| format!("Failed to write {}: {}", metadata_path.display(), e))
}

fn write_skill_metadata(skill_dir: &Path, canonical_id: &str) -> Result<(), String> {
    let (source, _) = split_canonical_id(canonical_id);
    write_skill_metadata_with_source(skill_dir, canonical_id, &source)
}

fn local_skill_canonical_id(skill_dir: &Path) -> Result<String, String> {
    let canonical = skill_dir.canonicalize().map_err(|e| {
        format!(
            "Failed to resolve skill path {}: {}",
            skill_dir.display(),
            e
        )
    })?;
    Ok(format!("local:{}", canonical.to_string_lossy()))
}

fn standard_skill_roots() -> Vec<(String, PathBuf)> {
    let mut roots = Vec::new();
    let mut seen = HashSet::new();

    let mut push_root = |source: &str, root: PathBuf| {
        if seen.insert(root.clone()) {
            roots.push((source.to_string(), root));
        }
    };

    if let Some(home_dir) = dirs::home_dir() {
        push_root("codex", home_dir.join(".codex").join("skills"));
        push_root("codex", home_dir.join(".agents").join("skills"));
        push_root("claude-code", home_dir.join(".claude").join("skills"));
    }

    if let Ok(codex_home) = std::env::var("CODEX_HOME") {
        push_root("codex", PathBuf::from(codex_home).join("skills"));
    }
    if let Ok(claude_home) = std::env::var("CLAUDE_HOME") {
        push_root("claude-code", PathBuf::from(claude_home).join("skills"));
    }

    roots
}

fn summarize_discovered_skill(
    skill_dir: &Path,
    source: &str,
    installed_ids: &HashSet<String>,
) -> Result<SkillSummary, String> {
    let folder_name = skill_dir
        .file_name()
        .ok_or_else(|| format!("Invalid skill path {}", skill_dir.display()))?
        .to_string_lossy()
        .into_owned();
    let skill_doc = fs::read_to_string(skill_dir.join(SKILL_DOC_FILENAME))
        .map_err(|e| format!("Failed to read {}: {}", skill_dir.display(), e))?;
    let id = local_skill_canonical_id(skill_dir)?;

    Ok(SkillSummary {
        installed: installed_ids.contains(&id),
        id,
        name: infer_skill_name(&folder_name, &skill_doc),
        description: infer_skill_description(&skill_doc),
        source: source.to_string(),
        path: Some(skill_dir.to_string_lossy().into_owned()),
    })
}

fn list_installed_skills_inner(progress: &SkillProgress) -> Result<Vec<SkillSummary>, String> {
    let store_dir = agentree_skills_dir()?;
    fs::create_dir_all(&store_dir).map_err(|e| {
        format!(
            "Failed to create Agentree skill store {}: {}",
            store_dir.display(),
            e
        )
    })?;

    progress.stage("scan", "Scanning installed skills");
    let mut skills = Vec::new();
    for skill_dir in skill_directories(&store_dir)? {
        skills.push(summarize_local_skill(&skill_dir)?);
    }
    skills.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(skills)
}

fn list_importable_skills_inner(progress: &SkillProgress) -> Result<Vec<SkillSummary>, String> {
    let store_dir = agentree_skills_dir()?;
    fs::create_dir_all(&store_dir).map_err(|e| {
        format!(
            "Failed to create Agentree skill store {}: {}",
            store_dir.display(),
            e
        )
    })?;
    let installed = installed_skill_ids(&store_dir)?;

    progress.stage("scan", "Scanning Claude Code and Codex skill folders");
    let mut skills = Vec::new();
    let mut seen_ids = HashSet::new();
    for (source, root) in standard_skill_roots() {
        for skill_dir in skill_directories(&root)? {
            let id = local_skill_canonical_id(&skill_dir)?;
            if seen_ids.insert(id) {
                skills.push(summarize_discovered_skill(&skill_dir, &source, &installed)?);
            }
        }
    }
    skills.sort_by(|a, b| a.name.cmp(&b.name).then(a.source.cmp(&b.source)));
    Ok(skills)
}

fn search_catalog_skills_inner(
    query: &str,
    progress: &SkillProgress,
) -> Result<Vec<SkillSummary>, String> {
    let normalized = query.trim();
    if normalized.len() < 2 {
        return Ok(Vec::new());
    }

    let store_dir = agentree_skills_dir()?;
    fs::create_dir_all(&store_dir).map_err(|e| {
        format!(
            "Failed to create Agentree skill store {}: {}",
            store_dir.display(),
            e
        )
    })?;
    let installed = installed_skill_ids(&store_dir)?;

    progress.stage(
        "search",
        &format!("Searching Vercel skills registry for \"{}\"", normalized),
    );
    let output = run_skills_cli(&["find", normalized], &store_dir)?;
    Ok(parse_search_results(&output, &installed))
}

fn install_catalog_skill_inner(
    skill_id: &str,
    progress: &SkillProgress,
) -> Result<SkillSummary, String> {
    let normalized = skill_id.trim();
    if normalized.is_empty() {
        return Err("Skill id is required".to_string());
    }

    let store_dir = agentree_skills_dir()?;
    fs::create_dir_all(&store_dir).map_err(|e| {
        format!(
            "Failed to create Agentree skill store {}: {}",
            store_dir.display(),
            e
        )
    })?;

    let temp = tempdir().map_err(|e| format!("Failed to create temp directory: {}", e))?;
    progress.stage("download", "Resolving skill via Vercel registry");
    let _ = run_skills_cli(&["add", normalized, "-y", "-a", "claude-code"], temp.path())?;

    progress.stage("extract", "Copying installed skill into the Agentree store");
    let installed_dir = find_installed_skill_dir(temp.path())?;
    let folder_name = installed_dir
        .file_name()
        .ok_or_else(|| format!("Invalid installed skill path {}", installed_dir.display()))?
        .to_string_lossy()
        .into_owned();

    let destination = store_dir.join(&folder_name);
    if destination.exists() {
        remove_existing_path(&destination)?;
    }
    copy_dir_recursive(&installed_dir, &destination)?;
    write_skill_metadata(&destination, normalized)?;

    summarize_local_skill(&destination)
}

fn import_local_skill_inner(
    source_path: &str,
    progress: &SkillProgress,
) -> Result<SkillSummary, String> {
    let source_dir = PathBuf::from(source_path.trim())
        .canonicalize()
        .map_err(|e| format!("Failed to resolve skill path {}: {}", source_path, e))?;
    if !source_dir.is_dir() || !source_dir.join(SKILL_DOC_FILENAME).exists() {
        return Err(format!(
            "{} is not a skill directory with a {} file",
            source_dir.display(),
            SKILL_DOC_FILENAME
        ));
    }

    let store_dir = agentree_skills_dir()?;
    fs::create_dir_all(&store_dir).map_err(|e| {
        format!(
            "Failed to create Agentree skill store {}: {}",
            store_dir.display(),
            e
        )
    })?;

    progress.stage("import", "Copying local skill into the Agentree store");
    let folder_name = source_dir
        .file_name()
        .ok_or_else(|| format!("Invalid skill path {}", source_dir.display()))?
        .to_string_lossy()
        .into_owned();
    let canonical_id = local_skill_canonical_id(&source_dir)?;
    let source_label = standard_skill_roots()
        .into_iter()
        .find_map(|(source, root)| {
            root.canonicalize()
                .ok()
                .filter(|canonical_root| source_dir.starts_with(canonical_root))
                .map(|_| source)
        })
        .unwrap_or_else(|| "local".to_string());

    let mut destination = store_dir.join(&folder_name);
    if destination.exists() {
        let existing_matches = parse_source_metadata(&destination)
            .map(|metadata| metadata.canonical_id == canonical_id)
            .unwrap_or(false);
        if !existing_matches {
            destination = store_dir.join(format!("{}-{}", source_label, folder_name));
        }
    }

    if destination.exists() {
        remove_existing_path(&destination)?;
    }
    copy_dir_recursive(&source_dir, &destination)?;
    write_skill_metadata_with_source(&destination, &canonical_id, &source_label)?;

    summarize_local_skill(&destination)
}

fn delete_installed_skill_inner(skill_id: &str, progress: &SkillProgress) -> Result<(), String> {
    let normalized = skill_id.trim();
    if normalized.is_empty() {
        return Err("Skill id is required".to_string());
    }

    progress.stage("delete", "Removing skill from the Agentree store");
    if let Some(path) = resolve_store_skill(normalized)? {
        remove_existing_path(&path)?;
    }
    Ok(())
}

pub fn ensure_runtime_skills(agent_type: &str, cwd: &Path) -> Result<Option<PathBuf>, String> {
    let Some(runtime_dir) = runtime_skill_dir(agent_type, cwd) else {
        return Ok(None);
    };

    let store_dir = agentree_skills_dir()?;
    fs::create_dir_all(&store_dir).map_err(|e| {
        format!(
            "Failed to create Agentree skill store {}: {}",
            store_dir.display(),
            e
        )
    })?;

    let skills = skill_directories(&store_dir)?;
    if skills.is_empty() {
        return Ok(Some(store_dir));
    }

    fs::create_dir_all(&runtime_dir).map_err(|e| {
        format!(
            "Failed to create runtime skill directory {}: {}",
            runtime_dir.display(),
            e
        )
    })?;

    for skill_dir in skills {
        sync_skill_entry(&runtime_dir, &skill_dir)?;
    }

    Ok(Some(store_dir))
}

#[tauri::command]
#[specta::specta]
pub fn get_skill_store_path() -> Result<String, String> {
    let store_dir = agentree_skills_dir()?;
    fs::create_dir_all(&store_dir).map_err(|e| {
        format!(
            "Failed to create Agentree skill store {}: {}",
            store_dir.display(),
            e
        )
    })?;
    Ok(store_dir.to_string_lossy().into_owned())
}

#[tauri::command]
#[specta::specta]
pub async fn list_installed_skills(
    app: AppHandle,
    op_id: Option<String>,
) -> Result<Vec<SkillSummary>, String> {
    let progress = SkillProgress::new(app, op_id, "list-installed", None);
    let worker = progress.clone();
    let result = tokio::task::spawn_blocking(move || list_installed_skills_inner(&worker))
        .await
        .map_err(|e| format!("Failed to list installed skills: {}", e))?;
    match &result {
        Ok(skills) => progress.finish(
            "complete",
            &format!("Loaded {} installed skills", skills.len()),
        ),
        Err(error) => progress.fail("error", error),
    }
    result
}

#[tauri::command]
#[specta::specta]
pub async fn list_importable_skills(
    app: AppHandle,
    op_id: Option<String>,
) -> Result<Vec<SkillSummary>, String> {
    let progress = SkillProgress::new(app, op_id, "list-importable", None);
    let worker = progress.clone();
    let result = tokio::task::spawn_blocking(move || list_importable_skills_inner(&worker))
        .await
        .map_err(|e| format!("Failed to list importable skills: {}", e))?;
    match &result {
        Ok(skills) => progress.finish(
            "complete",
            &format!("Found {} importable skills", skills.len()),
        ),
        Err(error) => progress.fail("error", error),
    }
    result
}

#[tauri::command]
#[specta::specta]
pub async fn search_catalog_skills(
    app: AppHandle,
    query: String,
    op_id: Option<String>,
) -> Result<Vec<SkillSummary>, String> {
    let progress = SkillProgress::new(app, op_id, "search-catalog", Some(query.clone()));
    let worker = progress.clone();
    let result = tokio::task::spawn_blocking(move || search_catalog_skills_inner(&query, &worker))
        .await
        .map_err(|e| format!("Failed to search skills catalog: {}", e))?;
    match &result {
        Ok(skills) => progress.finish(
            "complete",
            &format!("Found {} matching skills", skills.len()),
        ),
        Err(error) => progress.fail("error", error),
    }
    result
}

#[tauri::command]
#[specta::specta]
pub async fn install_catalog_skill(
    app: AppHandle,
    skill_id: String,
    op_id: Option<String>,
) -> Result<SkillSummary, String> {
    let progress = SkillProgress::new(app, op_id, "install-skill", Some(skill_id.clone()));
    let worker = progress.clone();
    let result =
        tokio::task::spawn_blocking(move || install_catalog_skill_inner(&skill_id, &worker))
            .await
            .map_err(|e| format!("Failed to install skill: {}", e))?;
    match &result {
        Ok(skill) => progress.finish("complete", &format!("Installed {}", skill.name)),
        Err(error) => progress.fail("error", error),
    }
    result
}

#[tauri::command]
#[specta::specta]
pub async fn import_local_skill(
    app: AppHandle,
    source_path: String,
    op_id: Option<String>,
) -> Result<SkillSummary, String> {
    let progress = SkillProgress::new(app, op_id, "import-skill", Some(source_path.clone()));
    let worker = progress.clone();
    let result =
        tokio::task::spawn_blocking(move || import_local_skill_inner(&source_path, &worker))
            .await
            .map_err(|e| format!("Failed to import skill: {}", e))?;
    match &result {
        Ok(skill) => progress.finish("complete", &format!("Imported {}", skill.name)),
        Err(error) => progress.fail("error", error),
    }
    result
}

#[tauri::command]
#[specta::specta]
pub async fn delete_installed_skill(
    app: AppHandle,
    skill_id: String,
    op_id: Option<String>,
) -> Result<(), String> {
    let progress = SkillProgress::new(app, op_id, "delete-skill", Some(skill_id.clone()));
    let worker = progress.clone();
    let deleted_skill_id = skill_id.clone();
    let result =
        tokio::task::spawn_blocking(move || delete_installed_skill_inner(&skill_id, &worker))
            .await
            .map_err(|e| format!("Failed to delete skill: {}", e))?;
    match &result {
        Ok(()) => progress.finish("complete", &format!("Deleted {}", deleted_skill_id)),
        Err(error) => progress.fail("error", error),
    }
    result
}
