use serde::Serialize;
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

const SKILL_DOC_FILENAME: &str = "SKILL.md";

#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct ProviderSkill {
    pub id: String,
    pub name: String,
    pub description: String,
    pub provider: String,
    pub source: String,
    pub path: String,
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

fn push_root(
    roots: &mut Vec<(String, PathBuf)>,
    seen: &mut HashSet<PathBuf>,
    source: &str,
    root: PathBuf,
) {
    if seen.insert(root.clone()) {
        roots.push((source.to_string(), root));
    }
}

fn provider_skill_roots(provider: &str, repo_path: Option<&Path>) -> Vec<(String, PathBuf)> {
    let mut roots = Vec::new();
    let mut seen = HashSet::new();

    if let Some(repo_path) = repo_path {
        match provider {
            "codex" => {
                push_root(
                    &mut roots,
                    &mut seen,
                    "repo",
                    repo_path.join(".codex").join("skills"),
                );
                push_root(
                    &mut roots,
                    &mut seen,
                    "repo",
                    repo_path.join(".agents").join("skills"),
                );
            }
            "claude" => {
                push_root(
                    &mut roots,
                    &mut seen,
                    "repo",
                    repo_path.join(".claude").join("skills"),
                );
            }
            "opencode" => {
                for root in [
                    repo_path.join(".opencode").join("skills"),
                    repo_path.join(".opencode").join("skill"),
                    repo_path.join(".agents").join("skills"),
                    repo_path.join(".claude").join("skills"),
                ] {
                    push_root(&mut roots, &mut seen, "repo", root);
                }
            }
            _ => {}
        }
    }

    if let Some(home_dir) = dirs::home_dir() {
        match provider {
            "codex" => {
                push_root(
                    &mut roots,
                    &mut seen,
                    "global",
                    home_dir.join(".codex").join("skills"),
                );
                push_root(
                    &mut roots,
                    &mut seen,
                    "global",
                    home_dir.join(".agents").join("skills"),
                );
            }
            "claude" => {
                push_root(
                    &mut roots,
                    &mut seen,
                    "global",
                    home_dir.join(".claude").join("skills"),
                );
            }
            "opencode" => {
                for root in [
                    home_dir.join(".config").join("opencode").join("skills"),
                    home_dir.join(".config").join("opencode").join("skill"),
                    home_dir.join(".agents").join("skills"),
                    home_dir.join(".claude").join("skills"),
                ] {
                    push_root(&mut roots, &mut seen, "global", root);
                }
            }
            _ => {}
        }
    }

    if provider == "codex" {
        if let Ok(codex_home) = std::env::var("CODEX_HOME") {
            push_root(
                &mut roots,
                &mut seen,
                "global",
                PathBuf::from(codex_home).join("skills"),
            );
        }
    }
    if provider == "claude" {
        if let Ok(claude_home) = std::env::var("CLAUDE_HOME") {
            push_root(
                &mut roots,
                &mut seen,
                "global",
                PathBuf::from(claude_home).join("skills"),
            );
        }
    }

    roots
}

fn skill_directories(root: &Path) -> Result<Vec<PathBuf>, String> {
    let mut skills = Vec::new();
    if !root.exists() {
        return Ok(skills);
    }

    let entries = fs::read_dir(root)
        .map_err(|e| format!("Failed to read skill folder {}: {}", root.display(), e))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("Failed to read skill folder entry: {}", e))?;
        let path = entry.path();
        if path.is_dir() && path.join(SKILL_DOC_FILENAME).exists() {
            skills.push(path);
        }
    }
    skills.sort();
    Ok(skills)
}

fn summarize_skill(
    provider: &str,
    source: &str,
    skill_dir: &Path,
) -> Result<ProviderSkill, String> {
    let folder_name = skill_dir
        .file_name()
        .ok_or_else(|| format!("Invalid skill path {}", skill_dir.display()))?
        .to_string_lossy()
        .into_owned();
    let skill_doc = fs::read_to_string(skill_dir.join(SKILL_DOC_FILENAME))
        .map_err(|e| format!("Failed to read {}: {}", skill_dir.display(), e))?;
    let path = skill_dir.to_string_lossy().into_owned();

    Ok(ProviderSkill {
        id: format!("{}:{}", provider, path),
        name: infer_skill_name(&folder_name, &skill_doc),
        description: infer_skill_description(&skill_doc),
        provider: provider.to_string(),
        source: source.to_string(),
        path,
    })
}

fn normalize_provider(provider: &str) -> Option<&'static str> {
    match provider.trim().to_lowercase().as_str() {
        "codex" => Some("codex"),
        "claude" => Some("claude"),
        "opencode" => Some("opencode"),
        _ => None,
    }
}

#[specta::specta]
#[tauri::command]
pub fn list_provider_skills(
    providers: Vec<String>,
    repo_path: Option<String>,
) -> Result<Vec<ProviderSkill>, String> {
    let repo_path = repo_path
        .as_deref()
        .map(str::trim)
        .filter(|path| !path.is_empty())
        .map(PathBuf::from);
    let mut normalized_providers = Vec::new();
    let mut seen_providers = HashSet::new();
    for provider in providers {
        if let Some(provider) = normalize_provider(&provider) {
            if seen_providers.insert(provider) {
                normalized_providers.push(provider);
            }
        }
    }

    let mut skills = Vec::new();
    let mut seen_names = HashSet::new();
    for provider in normalized_providers {
        for (source, root) in provider_skill_roots(provider, repo_path.as_deref()) {
            for skill_dir in skill_directories(&root)? {
                let skill = summarize_skill(provider, &source, &skill_dir)?;
                if seen_names.insert(skill.name.to_lowercase()) {
                    skills.push(skill);
                }
            }
        }
    }

    skills.sort_by(|left, right| left.name.to_lowercase().cmp(&right.name.to_lowercase()));
    Ok(skills)
}

#[cfg(test)]
mod tests {
    use super::{provider_skill_roots, summarize_skill};
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn summarizes_skill_metadata_from_skill_doc() {
        let temp = tempdir().expect("temp dir");
        let skill_dir = temp.path().join("debug-flow");
        fs::create_dir_all(&skill_dir).expect("skill dir");
        fs::write(
            skill_dir.join("SKILL.md"),
            "---\nname: Debug Flow\ndescription: Trace issues carefully\n---\n\n# Ignored\n",
        )
        .expect("skill doc");

        let skill = summarize_skill("codex", "repo", &skill_dir).expect("summarize skill");

        assert_eq!(skill.name, "Debug Flow");
        assert_eq!(skill.description, "Trace issues carefully");
        assert_eq!(skill.provider, "codex");
        assert_eq!(skill.source, "repo");
    }

    #[test]
    fn codex_repo_roots_include_codex_and_agents_skill_folders() {
        let temp = tempdir().expect("temp dir");
        let roots = provider_skill_roots("codex", Some(temp.path()));
        let paths: Vec<_> = roots.into_iter().map(|(_, path)| path).collect();

        assert!(paths.contains(&temp.path().join(".codex").join("skills")));
        assert!(paths.contains(&temp.path().join(".agents").join("skills")));
    }

    #[test]
    fn opencode_repo_roots_include_native_and_compatible_skill_folders() {
        let temp = tempdir().expect("temp dir");
        let roots = provider_skill_roots("opencode", Some(temp.path()));
        let paths: Vec<_> = roots.into_iter().map(|(_, path)| path).collect();

        assert!(paths.contains(&temp.path().join(".opencode").join("skills")));
        assert!(paths.contains(&temp.path().join(".opencode").join("skill")));
        assert!(paths.contains(&temp.path().join(".agents").join("skills")));
        assert!(paths.contains(&temp.path().join(".claude").join("skills")));
    }
}
