use ignore::gitignore::{Gitignore, GitignoreBuilder};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::path::{Component, Path};

pub const CONFIG_RELATIVE_PATH: &str = ".agentree/config.json";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[derive(specta::Type)]
pub struct AgentWorktreeConfig {
    pub dependency_link_dirs: Vec<String>,
    pub copy_env_files: bool,
    pub env_file_patterns: Vec<String>,
    pub commit_exclude_patterns: Vec<String>,
    pub runtime_scaffolding_dirs: Vec<String>,
    pub block_dependency_mutation_commands: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
#[derive(specta::Type)]
pub struct AgentWorktreeConfigStatus {
    pub config: AgentWorktreeConfig,
    pub config_path: String,
    pub source: String,
}

impl Default for AgentWorktreeConfig {
    fn default() -> Self {
        Self {
            dependency_link_dirs: vec![
                "node_modules".to_string(),
                ".venv".to_string(),
                "venv".to_string(),
                "vendor".to_string(),
                ".gradle".to_string(),
                "target".to_string(),
            ],
            copy_env_files: true,
            env_file_patterns: vec![".env*".to_string()],
            commit_exclude_patterns: Vec::new(),
            runtime_scaffolding_dirs: vec![
                ".agents/skills".to_string(),
                ".claude/skills".to_string(),
            ],
            block_dependency_mutation_commands: true,
        }
    }
}

#[derive(Debug, Deserialize)]
struct AgentreeConfigFile {
    worktree: Option<PartialAgentWorktreeConfig>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PartialAgentWorktreeConfig {
    dependency_link_dirs: Option<Vec<String>>,
    copy_env_files: Option<bool>,
    env_file_patterns: Option<Vec<String>>,
    commit_exclude_patterns: Option<Vec<String>>,
    runtime_scaffolding_dirs: Option<Vec<String>>,
    block_dependency_mutation_commands: Option<bool>,
}

pub fn load_agent_worktree_config(repo_path: &str) -> Result<AgentWorktreeConfig, String> {
    let config_path = Path::new(repo_path).join(CONFIG_RELATIVE_PATH);
    if !config_path.exists() {
        return Ok(AgentWorktreeConfig::default());
    }

    let raw = std::fs::read_to_string(&config_path)
        .map_err(|e| format!("Failed to read {}: {}", config_path.display(), e))?;
    let parsed: AgentreeConfigFile = serde_json::from_str(&raw)
        .map_err(|e| format!("Failed to parse {}: {}", config_path.display(), e))?;
    let Some(partial) = parsed.worktree else {
        return Ok(AgentWorktreeConfig::default());
    };

    let defaults = AgentWorktreeConfig::default();
    let config = validate_agent_worktree_config(AgentWorktreeConfig {
        dependency_link_dirs: validate_relative_paths(
            partial
                .dependency_link_dirs
                .unwrap_or(defaults.dependency_link_dirs),
            "worktree.dependencyLinkDirs",
            false,
        )?,
        copy_env_files: partial.copy_env_files.unwrap_or(defaults.copy_env_files),
        env_file_patterns: validate_relative_paths(
            partial
                .env_file_patterns
                .unwrap_or(defaults.env_file_patterns),
            "worktree.envFilePatterns",
            true,
        )?,
        commit_exclude_patterns: validate_relative_paths(
            partial
                .commit_exclude_patterns
                .unwrap_or(defaults.commit_exclude_patterns),
            "worktree.commitExcludePatterns",
            true,
        )?,
        runtime_scaffolding_dirs: validate_relative_paths(
            partial
                .runtime_scaffolding_dirs
                .unwrap_or(defaults.runtime_scaffolding_dirs),
            "worktree.runtimeScaffoldingDirs",
            false,
        )?,
        block_dependency_mutation_commands: partial
            .block_dependency_mutation_commands
            .unwrap_or(defaults.block_dependency_mutation_commands),
    })?;

    Ok(config)
}

pub fn validate_agent_worktree_config(
    config: AgentWorktreeConfig,
) -> Result<AgentWorktreeConfig, String> {
    Ok(AgentWorktreeConfig {
        dependency_link_dirs: validate_relative_paths(
            config.dependency_link_dirs,
            "worktree.dependencyLinkDirs",
            false,
        )?,
        copy_env_files: config.copy_env_files,
        env_file_patterns: validate_relative_paths(
            config.env_file_patterns,
            "worktree.envFilePatterns",
            true,
        )?,
        commit_exclude_patterns: validate_relative_paths(
            config.commit_exclude_patterns,
            "worktree.commitExcludePatterns",
            true,
        )?,
        runtime_scaffolding_dirs: validate_relative_paths(
            config.runtime_scaffolding_dirs,
            "worktree.runtimeScaffoldingDirs",
            false,
        )?,
        block_dependency_mutation_commands: config.block_dependency_mutation_commands,
    })
}

#[tauri::command]
#[specta::specta]
pub fn get_agent_worktree_config(repo_path: String) -> Result<AgentWorktreeConfigStatus, String> {
    let config_path = Path::new(&repo_path).join(CONFIG_RELATIVE_PATH);
    let source = if config_path.exists() {
        "project"
    } else {
        "default"
    };
    Ok(AgentWorktreeConfigStatus {
        config: load_agent_worktree_config(&repo_path)?,
        config_path: config_path.to_string_lossy().into_owned(),
        source: source.to_string(),
    })
}

#[tauri::command]
#[specta::specta]
pub fn save_agent_worktree_config(
    repo_path: String,
    config: AgentWorktreeConfig,
) -> Result<AgentWorktreeConfigStatus, String> {
    let validated_config = validate_agent_worktree_config(config)?;
    let config_path = Path::new(&repo_path).join(CONFIG_RELATIVE_PATH);
    let mut root = match std::fs::read_to_string(&config_path) {
        Ok(raw) if raw.trim().is_empty() => Map::new(),
        Ok(raw) => match serde_json::from_str::<Value>(&raw)
            .map_err(|e| format!("Failed to parse {}: {}", config_path.display(), e))?
        {
            Value::Object(map) => map,
            _ => {
                return Err(format!(
                    "{} must contain a JSON object",
                    config_path.display()
                ));
            }
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Map::new(),
        Err(error) => {
            return Err(format!(
                "Failed to read {}: {}",
                config_path.display(),
                error
            ));
        }
    };

    root.insert(
        "worktree".to_string(),
        serde_json::to_value(&validated_config)
            .map_err(|e| format!("Failed to serialize worktree config: {}", e))?,
    );

    if let Some(parent) = config_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create {}: {}", parent.display(), e))?;
    }
    let rendered = serde_json::to_string_pretty(&Value::Object(root))
        .map_err(|e| format!("Failed to render {}: {}", config_path.display(), e))?;
    std::fs::write(&config_path, format!("{}\n", rendered))
        .map_err(|e| format!("Failed to write {}: {}", config_path.display(), e))?;

    get_agent_worktree_config(repo_path)
}

pub fn compile_gitignore_patterns(
    root: &Path,
    patterns: &[String],
    field_name: &str,
) -> Result<Gitignore, String> {
    let mut builder = GitignoreBuilder::new(root);
    for pattern in patterns {
        builder
            .add_line(None, pattern)
            .map_err(|e| format!("Invalid {} pattern {:?}: {}", field_name, pattern, e))?;
    }
    builder
        .build()
        .map_err(|e| format!("Invalid {} patterns: {}", field_name, e))
}

pub fn path_matches_patterns(matcher: &Gitignore, path: &Path, is_dir: bool) -> bool {
    matcher
        .matched_path_or_any_parents(path, is_dir)
        .is_ignore()
}

pub fn config_summary(config: &AgentWorktreeConfig) -> String {
    format!(
        "dependency_link_dirs={} copy_env_files={} env_file_patterns={} commit_exclude_patterns={} runtime_scaffolding_dirs={} block_dependency_mutation_commands={}",
        config.dependency_link_dirs.join(","),
        config.copy_env_files,
        config.env_file_patterns.join(","),
        config.commit_exclude_patterns.join(","),
        config.runtime_scaffolding_dirs.join(","),
        config.block_dependency_mutation_commands,
    )
}

fn validate_relative_paths(
    values: Vec<String>,
    field_name: &str,
    allow_patterns: bool,
) -> Result<Vec<String>, String> {
    let mut normalized = Vec::new();
    for value in values {
        let value = value.trim().replace('\\', "/");
        if value.is_empty() {
            return Err(format!("{} cannot contain empty entries", field_name));
        }
        if value.contains('\0') {
            return Err(format!("{} contains a NUL byte: {:?}", field_name, value));
        }
        if value.starts_with('/') {
            return Err(format!("{} must be repo-relative: {:?}", field_name, value));
        }
        if value.starts_with('!') {
            return Err(format!(
                "{} does not support negated patterns: {:?}",
                field_name, value
            ));
        }
        if !allow_patterns && contains_glob_meta(&value) {
            return Err(format!(
                "{} entries must be literal relative directories: {:?}",
                field_name, value
            ));
        }

        let path_for_validation = value.trim_end_matches('/');
        for component in Path::new(path_for_validation).components() {
            match component {
                Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                    return Err(format!(
                        "{} must stay inside the repo: {:?}",
                        field_name, value
                    ));
                }
                Component::Normal(segment) if segment == ".git" => {
                    return Err(format!("{} cannot reference .git: {:?}", field_name, value));
                }
                _ => {}
            }
        }

        normalized.push(path_for_validation.to_string());
    }
    Ok(normalized)
}

fn contains_glob_meta(value: &str) -> bool {
    value
        .chars()
        .any(|character| matches!(character, '*' | '?' | '[' | ']'))
}

#[cfg(test)]
mod tests {
    use super::{
        load_agent_worktree_config, save_agent_worktree_config, AgentWorktreeConfig,
        CONFIG_RELATIVE_PATH,
    };
    use std::fs;

    #[test]
    fn missing_config_uses_defaults() {
        let repo = tempfile::tempdir().expect("repo");

        assert_eq!(
            load_agent_worktree_config(repo.path().to_str().unwrap()).expect("load config"),
            AgentWorktreeConfig::default()
        );
    }

    #[test]
    fn repo_config_overrides_worktree_policy_fields() {
        let repo = tempfile::tempdir().expect("repo");
        let config_path = repo.path().join(CONFIG_RELATIVE_PATH);
        fs::create_dir_all(config_path.parent().unwrap()).expect("create config dir");
        fs::write(
            &config_path,
            r#"{
              "worktree": {
                "dependencyLinkDirs": ["web/.yarn/cache", "node_modules"],
                "copyEnvFiles": false,
                "envFilePatterns": [".env.agent"],
                "commitExcludePatterns": ["dist/**"],
                "runtimeScaffoldingDirs": [".agents/skills"],
                "blockDependencyMutationCommands": false
              }
            }"#,
        )
        .expect("write config");

        let config =
            load_agent_worktree_config(repo.path().to_str().unwrap()).expect("load config");

        assert_eq!(
            config.dependency_link_dirs,
            vec!["web/.yarn/cache".to_string(), "node_modules".to_string()]
        );
        assert!(!config.copy_env_files);
        assert_eq!(config.env_file_patterns, vec![".env.agent".to_string()]);
        assert_eq!(config.commit_exclude_patterns, vec!["dist/**".to_string()]);
        assert_eq!(
            config.runtime_scaffolding_dirs,
            vec![".agents/skills".to_string()]
        );
        assert!(!config.block_dependency_mutation_commands);
    }

    #[test]
    fn repo_config_rejects_unsafe_paths() {
        let repo = tempfile::tempdir().expect("repo");
        let config_path = repo.path().join(CONFIG_RELATIVE_PATH);
        fs::create_dir_all(config_path.parent().unwrap()).expect("create config dir");
        fs::write(
            &config_path,
            r#"{"worktree":{"dependencyLinkDirs":["../outside"]}}"#,
        )
        .expect("write config");

        let error = load_agent_worktree_config(repo.path().to_str().unwrap())
            .expect_err("unsafe config should fail");

        assert!(error.contains("must stay inside the repo"));
    }

    #[test]
    fn save_config_writes_project_policy_and_preserves_other_keys() {
        let repo = tempfile::tempdir().expect("repo");
        let config_path = repo.path().join(CONFIG_RELATIVE_PATH);
        fs::create_dir_all(config_path.parent().unwrap()).expect("create config dir");
        fs::write(&config_path, r#"{"theme":"dark"}"#).expect("write config");

        let config = AgentWorktreeConfig {
            dependency_link_dirs: vec!["web/.yarn/cache".to_string()],
            copy_env_files: false,
            env_file_patterns: vec![".env.agent".to_string()],
            commit_exclude_patterns: vec!["dist/**".to_string()],
            runtime_scaffolding_dirs: vec![".agents/skills".to_string()],
            block_dependency_mutation_commands: false,
        };

        let status =
            save_agent_worktree_config(repo.path().to_string_lossy().into_owned(), config.clone())
                .expect("save config");

        assert_eq!(status.source, "project");
        assert_eq!(status.config, config);

        let raw = fs::read_to_string(config_path).expect("read config");
        let parsed: serde_json::Value = serde_json::from_str(&raw).expect("parse config");
        assert_eq!(parsed["theme"], "dark");
        assert_eq!(
            parsed["worktree"]["dependencyLinkDirs"][0],
            "web/.yarn/cache"
        );
    }
}
