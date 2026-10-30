use chrono::{DateTime, FixedOffset};
use std::collections::{HashMap, HashSet};
use std::process::{Command, Stdio};

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AcceptanceSource {
    pub sha: String,
    pub subject: String,
    pub authored_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PreviousAcceptance {
    pub source_sha: String,
    pub target_sha: String,
    pub match_kind: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AcceptanceMatch {
    pub source_sha: String,
    pub target_sha: String,
    pub match_kind: String,
}

#[derive(Debug)]
pub(crate) struct AcceptanceDetection {
    pub tip_sha: String,
    pub matches: Vec<AcceptanceMatch>,
    pub computed_patch_ids: HashMap<String, String>,
}

#[derive(Debug, Clone)]
struct TargetCommit {
    sha: String,
    authored_at: Option<String>,
    subject: String,
}

fn git_output(repo_path: &str, args: &[&str]) -> Result<String, String> {
    let output = Command::new("git")
        .args(args)
        .current_dir(repo_path)
        .output()
        .map_err(|error| format!("Failed to run git {:?}: {error}", args))?;
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(format!("git {:?} failed: {detail}", args));
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

pub(crate) fn resolve_ref_tip(repo_path: &str, git_ref: &str) -> Result<String, String> {
    git_output(
        repo_path,
        &["rev-parse", &format!("{}^{{commit}}", git_ref.trim())],
    )
    .map(|value| value.trim().to_string())
}

fn rev_list(repo_path: &str, tip_sha: &str, no_merges: bool) -> Result<Vec<String>, String> {
    let mut args = vec!["rev-list"];
    if no_merges {
        args.push("--no-merges");
    }
    args.push(tip_sha);
    Ok(git_output(repo_path, &args)?
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(ToString::to_string)
        .collect())
}

fn compute_patch_id_batch(
    repo_path: &str,
    commit_shas: &[String],
) -> Result<HashMap<String, String>, String> {
    if commit_shas.is_empty() {
        return Ok(HashMap::new());
    }

    let mut show = Command::new("git");
    show.args([
        "show",
        "--no-color",
        "--no-ext-diff",
        "--no-merges",
        "--pretty=format:commit %H",
        "-p",
    ])
    .args(commit_shas)
    .current_dir(repo_path)
    .stdout(Stdio::piped())
    .stderr(Stdio::piped());
    let mut show_child = show
        .spawn()
        .map_err(|error| format!("Failed to read commit patches: {error}"))?;
    let show_stdout = show_child
        .stdout
        .take()
        .ok_or_else(|| "Git patch stream was unavailable.".to_string())?;

    let patch_output = Command::new("git")
        .args(["patch-id", "--stable"])
        .current_dir(repo_path)
        .stdin(Stdio::from(show_stdout))
        .output()
        .map_err(|error| format!("Failed to calculate stable patch IDs: {error}"))?;
    let show_output = show_child
        .wait_with_output()
        .map_err(|error| format!("Failed to finish reading commit patches: {error}"))?;
    if !show_output.status.success() {
        return Err(format!(
            "git show failed while calculating patch IDs: {}",
            String::from_utf8_lossy(&show_output.stderr).trim()
        ));
    }
    if !patch_output.status.success() {
        return Err(format!(
            "git patch-id failed: {}",
            String::from_utf8_lossy(&patch_output.stderr).trim()
        ));
    }

    let mut result = HashMap::new();
    for line in String::from_utf8_lossy(&patch_output.stdout).lines() {
        let mut fields = line.split_whitespace();
        let Some(patch_id) = fields.next() else {
            continue;
        };
        let Some(commit_sha) = fields.next() else {
            continue;
        };
        result.insert(commit_sha.to_string(), patch_id.to_string());
    }
    Ok(result)
}

fn compute_patch_ids(
    repo_path: &str,
    commit_shas: &[String],
) -> Result<HashMap<String, String>, String> {
    let mut result = HashMap::new();
    for batch in commit_shas.chunks(256) {
        result.extend(compute_patch_id_batch(repo_path, batch)?);
    }
    Ok(result)
}

fn target_commits(repo_path: &str, tip_sha: &str) -> Result<Vec<TargetCommit>, String> {
    let output = git_output(
        repo_path,
        &["log", "--no-merges", "--format=%H%x09%aI%x09%s", tip_sha],
    )?;
    Ok(output
        .lines()
        .filter_map(|line| {
            let mut fields = line.splitn(3, '\t');
            let sha = fields.next()?.trim();
            let authored_at = fields
                .next()
                .map(str::trim)
                .filter(|value| !value.is_empty());
            let subject = fields.next()?.trim();
            if sha.is_empty() || subject.is_empty() {
                return None;
            }
            Some(TargetCommit {
                sha: sha.to_string(),
                authored_at: authored_at.map(ToString::to_string),
                subject: subject.to_string(),
            })
        })
        .collect())
}

fn changed_paths(repo_path: &str, commit_sha: &str) -> Result<HashSet<String>, String> {
    Ok(git_output(
        repo_path,
        &[
            "diff-tree",
            "--root",
            "--no-commit-id",
            "--name-only",
            "-r",
            commit_sha,
        ],
    )?
    .lines()
    .map(str::trim)
    .filter(|line| !line.is_empty())
    .map(ToString::to_string)
    .collect())
}

fn commit_body(repo_path: &str, commit_sha: &str) -> Result<String, String> {
    git_output(repo_path, &["show", "-s", "--format=%B", commit_sha])
        .map(|value| value.trim().to_string())
}

fn authored_close_enough(source: Option<&str>, target: Option<&str>) -> bool {
    let (Some(source), Some(target)) = (source, target) else {
        return false;
    };
    let Ok(source) = DateTime::<FixedOffset>::parse_from_rfc3339(source) else {
        return false;
    };
    let Ok(target) = DateTime::<FixedOffset>::parse_from_rfc3339(target) else {
        return false;
    };
    let delta = target.signed_duration_since(source).num_seconds();
    (0..=24 * 60 * 60).contains(&delta)
}

fn substantial_path_overlap(source: &HashSet<String>, target: &HashSet<String>) -> bool {
    if source.is_empty() || target.is_empty() {
        return false;
    }
    let overlap = source.intersection(target).count() as f64;
    let denominator = source.len().max(target.len()) as f64;
    overlap / denominator >= 0.6
}

fn range_diff_pairs_commits(repo_path: &str, source_sha: &str, target_sha: &str) -> bool {
    let source_range = format!("{source_sha}^!");
    let target_range = format!("{target_sha}^!");
    git_output(
        repo_path,
        &[
            "range-diff",
            "--no-color",
            "--no-dual-color",
            &source_range,
            &target_range,
        ],
    )
    .map(|output| {
        output
            .lines()
            .any(|line| line.contains(" ! 1:") || line.contains(" = 1:"))
    })
    .unwrap_or(false)
}

fn find_probable_match(
    repo_path: &str,
    source: &AcceptanceSource,
    candidates: &[TargetCommit],
) -> Result<Option<String>, String> {
    let subject_candidates = candidates
        .iter()
        .filter(|candidate| candidate.sha != source.sha && candidate.subject == source.subject)
        .collect::<Vec<_>>();
    if subject_candidates.is_empty() {
        return Ok(None);
    }

    let source_paths = changed_paths(repo_path, &source.sha)?;
    let source_body = commit_body(repo_path, &source.sha)?;
    let mut qualified = Vec::new();
    for candidate in subject_candidates {
        if !range_diff_pairs_commits(repo_path, &source.sha, &candidate.sha) {
            continue;
        }
        let candidate_paths = changed_paths(repo_path, &candidate.sha)?;
        if !substantial_path_overlap(&source_paths, &candidate_paths) {
            continue;
        }
        let candidate_body = commit_body(repo_path, &candidate.sha)?;
        let same_nonempty_body = !source_body.is_empty() && source_body == candidate_body;
        if same_nonempty_body
            || authored_close_enough(
                source.authored_at.as_deref(),
                candidate.authored_at.as_deref(),
            )
        {
            qualified.push(candidate.sha.clone());
        }
    }

    if qualified.len() == 1 {
        Ok(qualified.into_iter().next())
    } else {
        Ok(None)
    }
}

pub(crate) fn detect_commit_acceptance(
    repo_path: &str,
    git_ref: &str,
    sources: &[AcceptanceSource],
    cached_patch_ids: &HashMap<String, String>,
    previous_matches: &[PreviousAcceptance],
) -> Result<AcceptanceDetection, String> {
    let tip_sha = resolve_ref_tip(repo_path, git_ref)?;
    let reachable = rev_list(repo_path, &tip_sha, false)?;
    let reachable_set = reachable.iter().cloned().collect::<HashSet<_>>();
    let mut matches = Vec::new();
    let mut unmatched = Vec::new();

    for source in sources {
        if reachable_set.contains(&source.sha) {
            matches.push(AcceptanceMatch {
                source_sha: source.sha.clone(),
                target_sha: source.sha.clone(),
                match_kind: "exact".to_string(),
            });
        } else if let Some(previous) = previous_matches.iter().find(|previous| {
            previous.source_sha == source.sha && reachable_set.contains(&previous.target_sha)
        }) {
            matches.push(AcceptanceMatch {
                source_sha: source.sha.clone(),
                target_sha: previous.target_sha.clone(),
                match_kind: previous.match_kind.clone(),
            });
        } else {
            unmatched.push(source);
        }
    }

    if unmatched.is_empty() {
        matches.sort_by(|left, right| left.source_sha.cmp(&right.source_sha));
        return Ok(AcceptanceDetection {
            tip_sha,
            matches,
            computed_patch_ids: HashMap::new(),
        });
    }

    let target_non_merge_shas = rev_list(repo_path, &tip_sha, true)?;
    let mut missing_patch_shas = target_non_merge_shas
        .iter()
        .filter(|sha| !cached_patch_ids.contains_key(*sha))
        .cloned()
        .collect::<Vec<_>>();
    missing_patch_shas.extend(
        unmatched
            .iter()
            .filter(|source| !cached_patch_ids.contains_key(&source.sha))
            .map(|source| source.sha.clone()),
    );
    missing_patch_shas.sort();
    missing_patch_shas.dedup();
    let computed_patch_ids = compute_patch_ids(repo_path, &missing_patch_shas)?;
    let mut patch_ids = cached_patch_ids.clone();
    patch_ids.extend(computed_patch_ids.clone());

    let mut targets_by_patch = HashMap::<String, String>::new();
    for target_sha in &target_non_merge_shas {
        if let Some(patch_id) = patch_ids.get(target_sha) {
            targets_by_patch
                .entry(patch_id.clone())
                .or_insert_with(|| target_sha.clone());
        }
    }

    let mut probable_sources = Vec::new();
    for source in unmatched {
        let target_sha = patch_ids
            .get(&source.sha)
            .and_then(|patch_id| targets_by_patch.get(patch_id));
        if let Some(target_sha) = target_sha {
            matches.push(AcceptanceMatch {
                source_sha: source.sha.clone(),
                target_sha: target_sha.clone(),
                match_kind: "patch_equivalent".to_string(),
            });
        } else {
            probable_sources.push(source);
        }
    }

    if !probable_sources.is_empty() {
        let candidates = target_commits(repo_path, &tip_sha)?;
        for source in probable_sources {
            if let Some(target_sha) = find_probable_match(repo_path, source, &candidates)? {
                matches.push(AcceptanceMatch {
                    source_sha: source.sha.clone(),
                    target_sha,
                    match_kind: "probable".to_string(),
                });
            }
        }
    }

    matches.sort_by(|left, right| left.source_sha.cmp(&right.source_sha));
    Ok(AcceptanceDetection {
        tip_sha,
        matches,
        computed_patch_ids,
    })
}

#[cfg(test)]
mod tests {
    use super::{detect_commit_acceptance, AcceptanceSource, PreviousAcceptance};
    use std::collections::HashMap;
    use std::fs;
    use std::path::Path;
    use std::process::Command;

    fn git(repo: &Path, args: &[&str]) -> String {
        let output = Command::new("git")
            .args(args)
            .current_dir(repo)
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

    fn repo() -> tempfile::TempDir {
        let dir = tempfile::tempdir().expect("temp repo");
        git(dir.path(), &["init"]);
        git(dir.path(), &["config", "user.name", "Agentree Test"]);
        git(
            dir.path(),
            &["config", "user.email", "agentree@example.com"],
        );
        fs::write(dir.path().join("feature.txt"), "base\n").expect("write base");
        git(dir.path(), &["add", "feature.txt"]);
        git(dir.path(), &["commit", "-m", "base"]);
        git(dir.path(), &["branch", "-M", "main"]);
        dir
    }

    fn source(repo: &Path, contents: &str, subject: &str) -> (String, String) {
        let base = git(repo, &["rev-parse", "main"]);
        git(repo, &["checkout", "-b", "agent", &base]);
        fs::write(repo.join("feature.txt"), contents).expect("write source");
        git(repo, &["add", "feature.txt"]);
        git(repo, &["commit", "-m", subject]);
        let sha = git(repo, &["rev-parse", "HEAD"]);
        let authored_at = git(repo, &["show", "-s", "--format=%aI", &sha]);
        (sha, authored_at)
    }

    #[test]
    fn detects_clean_cherry_pick_as_accepted() {
        let dir = repo();
        let (source_sha, authored_at) = source(dir.path(), "base\nchange\n", "add feature");
        git(dir.path(), &["checkout", "main"]);
        fs::write(dir.path().join("main-only.txt"), "main diverged\n")
            .expect("write main divergence");
        git(dir.path(), &["add", "main-only.txt"]);
        git(dir.path(), &["commit", "-m", "advance main"]);
        git(dir.path(), &["cherry-pick", &source_sha]);

        let detection = detect_commit_acceptance(
            dir.path().to_string_lossy().as_ref(),
            "refs/heads/main",
            &[AcceptanceSource {
                sha: source_sha,
                subject: "add feature".to_string(),
                authored_at: Some(authored_at.clone()),
            }],
            &HashMap::new(),
            &[],
        )
        .expect("detect acceptance");

        assert_eq!(detection.matches.len(), 1);
        assert_eq!(detection.matches[0].match_kind, "patch_equivalent");

        let landed_sha = detection.matches[0].target_sha.clone();
        fs::write(dir.path().join("later.txt"), "later main change\n").expect("write later change");
        git(dir.path(), &["add", "later.txt"]);
        git(dir.path(), &["commit", "-m", "advance main again"]);
        let recorded = detect_commit_acceptance(
            dir.path().to_string_lossy().as_ref(),
            "refs/heads/main",
            &[AcceptanceSource {
                sha: detection.matches[0].source_sha.clone(),
                subject: "add feature".to_string(),
                authored_at: Some(authored_at),
            }],
            &HashMap::new(),
            &[PreviousAcceptance {
                source_sha: detection.matches[0].source_sha.clone(),
                target_sha: landed_sha.clone(),
                match_kind: "patch_equivalent".to_string(),
            }],
        )
        .expect("revalidate recorded mapping");

        assert_eq!(recorded.matches[0].target_sha, landed_sha);
    }

    #[test]
    fn detects_conflict_adjusted_unique_subject_as_probable() {
        let dir = repo();
        let (source_sha, authored_at) =
            source(dir.path(), "base\nagent change\n", "fix shared behavior");
        git(dir.path(), &["checkout", "main"]);
        fs::write(
            dir.path().join("feature.txt"),
            "base\nagent change\nconflict resolution\n",
        )
        .expect("write adjusted change");
        git(dir.path(), &["add", "feature.txt"]);
        git(dir.path(), &["commit", "-m", "fix shared behavior"]);

        let detection = detect_commit_acceptance(
            dir.path().to_string_lossy().as_ref(),
            "refs/heads/main",
            &[AcceptanceSource {
                sha: source_sha,
                subject: "fix shared behavior".to_string(),
                authored_at: Some(authored_at),
            }],
            &HashMap::new(),
            &[],
        )
        .expect("detect acceptance");

        assert_eq!(detection.matches.len(), 1);
        assert_eq!(detection.matches[0].match_kind, "probable");
    }

    #[test]
    fn refuses_ambiguous_probable_matches() {
        let dir = repo();
        let (source_sha, authored_at) =
            source(dir.path(), "base\nagent change\n", "repeatable subject");
        git(dir.path(), &["checkout", "main"]);
        fs::write(dir.path().join("feature.txt"), "base\nfirst candidate\n")
            .expect("write first candidate");
        git(dir.path(), &["add", "feature.txt"]);
        git(dir.path(), &["commit", "-m", "repeatable subject"]);
        fs::write(
            dir.path().join("feature.txt"),
            "base\nfirst candidate\nsecond candidate\n",
        )
        .expect("write second candidate");
        git(dir.path(), &["add", "feature.txt"]);
        git(dir.path(), &["commit", "-m", "repeatable subject"]);

        let detection = detect_commit_acceptance(
            dir.path().to_string_lossy().as_ref(),
            "refs/heads/main",
            &[AcceptanceSource {
                sha: source_sha,
                subject: "repeatable subject".to_string(),
                authored_at: Some(authored_at),
            }],
            &HashMap::new(),
            &[],
        )
        .expect("detect acceptance");

        assert!(detection.matches.is_empty());
    }
}
