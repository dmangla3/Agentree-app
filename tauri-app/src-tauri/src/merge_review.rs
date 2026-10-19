use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Output, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use tauri::{AppHandle, Emitter, Manager, State};

#[cfg(unix)]
use libc;

#[derive(Default)]
pub struct MergeReviewState {
    pub children: Mutex<HashMap<String, Child>>,
    pub worktrees: Mutex<HashMap<String, ReviewWorkspace>>,
}

#[derive(Debug, Clone)]
pub struct ReviewWorkspace {
    pub repo_path: String,
    pub worktree_path: String,
}

#[derive(Debug, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct MergeReviewFileInput {
    pub path: String,
    pub group: String,
}

#[derive(Debug, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct StartMergeReviewRequest {
    pub repo_path: String,
    pub target_commit: String,
    pub source_commits: Vec<String>,
    pub files: Vec<MergeReviewFileInput>,
    pub source_labels: Option<HashMap<String, String>>,
    pub agent_type: String,
    pub agent_name: Option<String>,
    pub cli_args: Option<String>,
    pub prompt_flag: Option<String>,
    pub selected_model_id: Option<String>,
}

#[derive(Debug, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct StartMergeReviewResponse {
    pub run_id: String,
}

#[derive(Debug, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
struct MergeReviewSourceContext {
    source_commit: String,
    source_label: String,
    base_commit: String,
    target_diff: String,
    source_diff: String,
    target_content: Option<String>,
    source_content: Option<String>,
    base_content: Option<String>,
}

#[derive(Debug, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
struct MergeReviewFileContext {
    path: String,
    group: String,
    sources: Vec<MergeReviewSourceContext>,
}

#[derive(Debug, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
struct MergeReviewPayload {
    target_commit: String,
    source_commits: Vec<String>,
    files: Vec<MergeReviewFileContext>,
}

#[derive(Debug, Deserialize, Serialize, Clone, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct MergeReviewIssueOptionInput {
    pub id: String,
    pub label: String,
    pub kind: String,
    pub source_commit: Option<String>,
    pub source_label: Option<String>,
    pub description: Option<String>,
}

#[derive(Debug, Deserialize, Serialize, Clone, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct MergeReviewIssueInput {
    pub id: String,
    pub title: String,
    pub summary: String,
    pub risk_level: String,
    pub rationale: String,
    pub affected_files: Vec<String>,
    pub options: Vec<MergeReviewIssueOptionInput>,
}

#[derive(Debug, Deserialize, Serialize, Clone, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct MergeReviewIssueSelectionInput {
    pub issue_id: String,
    pub option_id: String,
}

#[derive(Debug, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SynthesizeMergeResolutionsRequest {
    pub run_id: Option<String>,
    pub repo_path: String,
    pub target_commit: String,
    pub source_commits: Vec<String>,
    pub files: Vec<MergeReviewFileInput>,
    pub source_labels: Option<HashMap<String, String>>,
    pub issues: Vec<MergeReviewIssueInput>,
    pub selections: Vec<MergeReviewIssueSelectionInput>,
    pub agent_type: String,
    pub agent_name: Option<String>,
    pub cli_args: Option<String>,
    pub prompt_flag: Option<String>,
    pub selected_model_id: Option<String>,
}

#[derive(Debug, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
struct MergeResolutionPayload {
    target_commit: String,
    source_commits: Vec<String>,
    files: Vec<MergeReviewFileContext>,
    issues: Vec<MergeReviewIssueInput>,
    selections: Vec<MergeReviewIssueSelectionInput>,
}

#[derive(Debug, Deserialize, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SynthesizeMergeResolutionsResponse {
    pub summary_text: String,
    pub resolutions: Vec<crate::types::ConflictResolution>,
}

fn run_git_with_status(repo_path: &str, args: &[&str]) -> Result<Output, String> {
    Command::new("git")
        .args(args)
        .current_dir(repo_path)
        .output()
        .map_err(|e| format!("git {:?} failed: {}", args, e))
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

fn review_root(repo_path: &str) -> Result<PathBuf, String> {
    let git_dir = resolve_git_dir(repo_path)?;
    let root = git_dir.join("agentree").join("merge-reviews");
    ensure_directory(&root)?;
    Ok(root)
}

fn truncate_text(value: String, limit: usize) -> String {
    if value.len() <= limit {
        return value;
    }
    let truncated: String = value.chars().take(limit).collect();
    format!("{}\n...[truncated]", truncated)
}

fn show_file_at_commit(
    repo_path: &str,
    commit: &str,
    file_path: &str,
    limit: usize,
) -> Option<String> {
    let output =
        run_git_with_status(repo_path, &["show", &format!("{commit}:{file_path}")]).ok()?;
    if !output.status.success() {
        return None;
    }
    if output.stdout.iter().any(|byte| *byte == 0) {
        return None;
    }
    Some(truncate_text(
        String::from_utf8_lossy(&output.stdout).to_string(),
        limit,
    ))
}

fn diff_file(
    repo_path: &str,
    from_commit: &str,
    to_commit: &str,
    file_path: &str,
    limit: usize,
) -> String {
    let diff = run_git(
        repo_path,
        &[
            "diff",
            "--unified=3",
            from_commit,
            to_commit,
            "--",
            file_path,
        ],
    )
    .unwrap_or_default();
    truncate_text(diff, limit)
}

fn emit_review_event<T: Serialize>(app: &AppHandle, payload: &T) {
    let _ = app.emit("integration:merge-review-event", payload);
}

fn append_merge_review_backend_log(app: &AppHandle, run_id: &str, channel: &str, message: &str) {
    let single_line = message.replace('\n', "\\n");
    let _ = crate::logging::append_backend_line(
        app,
        &format!("[merge-review][{run_id}][{channel}] {single_line}"),
    );
}

fn persist_merge_review_raw_event(
    app: &AppHandle,
    run_id: &str,
    event_type: &str,
    data: &str,
    log_channel: &str,
) {
    let _ = crate::db::log_event(app, run_id, event_type, data);
    append_merge_review_backend_log(app, run_id, log_channel, data);
}

fn persist_merge_review_event_value(app: &AppHandle, run_id: &str, value: &serde_json::Value) {
    let event_type = value
        .get("type")
        .and_then(|entry| entry.as_str())
        .map(|kind| format!("merge_review:{kind}"))
        .unwrap_or_else(|| "merge_review:event".to_string());

    if let Ok(serialized) = serde_json::to_string(value) {
        persist_merge_review_raw_event(app, run_id, &event_type, &serialized, "event");
    }
}

fn update_merge_review_session_status(
    app: &AppHandle,
    run_id: &str,
    status: &str,
    repo_path: Option<&str>,
    worktree_path: Option<&str>,
) {
    let telemetry = app.state::<crate::db::TelemetryDb>();
    if let Err(err) = telemetry.update_session_status(run_id, status, repo_path, worktree_path) {
        crate::app_log!(
            "[merge-review][{}] session_status_update_failed status={} err={}",
            run_id,
            status,
            err
        );
    }
}

fn initialize_merge_review_session(
    app: &AppHandle,
    run_id: &str,
    workspace: &ReviewWorkspace,
    mode: &str,
) {
    let telemetry = app.state::<crate::db::TelemetryDb>();
    if let Err(err) = telemetry.ensure_session(
        run_id,
        Some(&workspace.repo_path),
        Some(&workspace.worktree_path),
    ) {
        crate::app_log!(
            "[merge-review][{}] ensure_session_failed mode={} err={}",
            run_id,
            mode,
            err
        );
    }
    let _ = telemetry.kv_set(run_id, "merge_review.mode", mode);
    append_merge_review_backend_log(
        app,
        run_id,
        "lifecycle",
        &format!(
            "started mode={mode} repo={} worktree={}",
            workspace.repo_path, workspace.worktree_path
        ),
    );
}

fn cleanup_review_workspace(run_id: &str, workspace: &ReviewWorkspace) {
    if let Ok(Some(sandbox_path)) =
        crate::command_guards::cleanup_agent_sandbox(run_id, Path::new(&workspace.worktree_path))
    {
        crate::app_log!(
            "[merge-review][{}][lifecycle] sandbox_removed path={}",
            run_id,
            sandbox_path.display()
        );
    }
    let _ = run_git(
        &workspace.repo_path,
        &["worktree", "remove", &workspace.worktree_path, "--force"],
    );
    let _ = fs::remove_dir_all(&workspace.worktree_path);
}

fn build_file_contexts(
    repo_path: &str,
    target_commit: &str,
    source_commits: &[String],
    source_labels: Option<&HashMap<String, String>>,
    files: &[MergeReviewFileInput],
) -> Result<Vec<MergeReviewFileContext>, String> {
    files
        .iter()
        .map(|file| {
            let sources = source_commits
                .iter()
                .map(|source_commit| {
                    let base_commit =
                        run_git(repo_path, &["merge-base", target_commit, source_commit])?
                            .trim()
                            .to_string();

                    Ok(MergeReviewSourceContext {
                        source_commit: source_commit.clone(),
                        source_label: source_labels
                            .and_then(|labels| labels.get(source_commit))
                            .cloned()
                            .unwrap_or_else(|| source_commit.chars().take(8).collect()),
                        base_commit: base_commit.clone(),
                        target_diff: diff_file(
                            repo_path,
                            &base_commit,
                            target_commit,
                            &file.path,
                            12_000,
                        ),
                        source_diff: diff_file(
                            repo_path,
                            &base_commit,
                            source_commit,
                            &file.path,
                            12_000,
                        ),
                        target_content: show_file_at_commit(
                            repo_path,
                            target_commit,
                            &file.path,
                            16_000,
                        ),
                        source_content: show_file_at_commit(
                            repo_path,
                            source_commit,
                            &file.path,
                            16_000,
                        ),
                        base_content: show_file_at_commit(
                            repo_path,
                            &base_commit,
                            &file.path,
                            16_000,
                        ),
                    })
                })
                .collect::<Result<Vec<_>, String>>()?;

            Ok(MergeReviewFileContext {
                path: file.path.clone(),
                group: file.group.clone(),
                sources,
            })
        })
        .collect::<Result<Vec<_>, String>>()
}

fn build_payload(request: &StartMergeReviewRequest) -> Result<MergeReviewPayload, String> {
    Ok(MergeReviewPayload {
        target_commit: request.target_commit.clone(),
        source_commits: request.source_commits.clone(),
        files: build_file_contexts(
            &request.repo_path,
            &request.target_commit,
            &request.source_commits,
            request.source_labels.as_ref(),
            &request.files,
        )?,
    })
}

fn build_resolution_payload(
    request: &SynthesizeMergeResolutionsRequest,
) -> Result<MergeResolutionPayload, String> {
    Ok(MergeResolutionPayload {
        target_commit: request.target_commit.clone(),
        source_commits: request.source_commits.clone(),
        files: build_file_contexts(
            &request.repo_path,
            &request.target_commit,
            &request.source_commits,
            request.source_labels.as_ref(),
            &request.files,
        )?,
        issues: request.issues.clone(),
        selections: request.selections.clone(),
    })
}

fn create_review_workspace(
    repo_path: &str,
    target_commit: &str,
) -> Result<(String, ReviewWorkspace), String> {
    let run_id = uuid::Uuid::new_v4().to_string();
    let worktree_path = review_root(repo_path)?.join(&run_id);
    let worktree_string = worktree_path.to_string_lossy().to_string();
    if worktree_path.exists() {
        let _ = run_git(
            repo_path,
            &["worktree", "remove", &worktree_string, "--force"],
        );
        let _ = fs::remove_dir_all(&worktree_path);
    }

    run_git(
        repo_path,
        &[
            "worktree",
            "add",
            "--detach",
            &worktree_string,
            target_commit,
        ],
    )?;

    Ok((
        run_id,
        ReviewWorkspace {
            repo_path: repo_path.to_string(),
            worktree_path: worktree_string,
        },
    ))
}

fn merge_review_script_path(app: &AppHandle) -> Result<PathBuf, String> {
    crate::runtime_scripts::runtime_script_path(app, "merge-review-runner.cjs")
}

fn add_codex_adapter_command_to_config(
    app: &AppHandle,
    config: &mut serde_json::Value,
) -> Result<(), String> {
    let command = crate::runtime_scripts::codex_adapter_command(app)?;
    let Some(object) = config.as_object_mut() else {
        return Err("Merge review runner config must be a JSON object.".to_string());
    };
    object.insert(
        "codexAdapterProgram".to_string(),
        serde_json::Value::String(command.program),
    );
    object.insert(
        "codexAdapterArgsPrefix".to_string(),
        serde_json::Value::Array(
            command
                .args_prefix
                .into_iter()
                .map(serde_json::Value::String)
                .collect(),
        ),
    );
    Ok(())
}

fn run_sync_runner_with_events<T: for<'de> Deserialize<'de>>(
    app: &AppHandle,
    run_id: &str,
    worktree_path: &str,
    mut config: serde_json::Value,
    worktree_config: &crate::worktree_config::AgentWorktreeConfig,
) -> Result<T, String> {
    add_codex_adapter_command_to_config(app, &mut config)?;
    let mut command = Command::new(crate::managed_runtime::node_program(app)?);
    command
        .arg(merge_review_script_path(app)?)
        .arg(config.to_string())
        .current_dir(worktree_path)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    crate::command_guards::apply_agent_command_env_with_config(
        &mut command,
        app,
        run_id,
        Path::new(worktree_path),
        worktree_config,
    )?;
    let mut child = command
        .spawn()
        .map_err(|e| format!("Failed to spawn merge review runner: {}", e))?;

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let raw_result = Arc::new(Mutex::new(None::<serde_json::Value>));
    let runner_error = Arc::new(Mutex::new(None::<String>));

    let stdout_handle = stdout.map(|stdout| {
        let app = app.clone();
        let run_id = run_id.to_string();
        let raw_result = Arc::clone(&raw_result);
        let runner_error = Arc::clone(&runner_error);
        thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines().map_while(Result::ok) {
                match serde_json::from_str::<serde_json::Value>(&line) {
                    Ok(mut value) => {
                        if value.get("runId").is_none() {
                            value["runId"] = serde_json::Value::String(run_id.clone());
                        }
                        persist_merge_review_event_value(&app, &run_id, &value);
                        match value.get("type").and_then(|v| v.as_str()) {
                            Some("result") => {
                                if let Some(result) = value.get("result") {
                                    if let Ok(mut slot) = raw_result.lock() {
                                        *slot = Some(result.clone());
                                    }
                                }
                            }
                            Some("error") => {
                                if let Some(message) = value.get("error").and_then(|v| v.as_str()) {
                                    if let Ok(mut slot) = runner_error.lock() {
                                        *slot = Some(message.to_string());
                                    }
                                }
                            }
                            Some("status")
                                if value.get("status").and_then(|v| v.as_str())
                                    == Some("failed") =>
                            {
                                if let Some(message) = value.get("message").and_then(|v| v.as_str())
                                {
                                    if let Ok(mut slot) = runner_error.lock() {
                                        *slot = Some(message.to_string());
                                    }
                                }
                            }
                            _ => {}
                        }
                        emit_review_event(&app, &value);
                    }
                    Err(_) => {
                        persist_merge_review_raw_event(
                            &app,
                            &run_id,
                            "merge_review:stdout",
                            &line,
                            "stdout",
                        );
                        let payload = serde_json::json!({
                            "runId": run_id,
                            "type": "timeline",
                            "event": {
                                "timestamp": chrono_like_now(),
                                "level": "info",
                                "message": line,
                            }
                        });
                        emit_review_event(&app, &payload);
                    }
                }
            }
        })
    });

    let stderr_handle = stderr.map(|stderr| {
        let app = app.clone();
        let run_id = run_id.to_string();
        let runner_error = Arc::clone(&runner_error);
        thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines().map_while(Result::ok) {
                if let Ok(mut slot) = runner_error.lock() {
                    *slot = Some(line.clone());
                }
                persist_merge_review_raw_event(
                    &app,
                    &run_id,
                    "merge_review:stderr",
                    &line,
                    "stderr",
                );
                let payload = serde_json::json!({
                    "runId": run_id,
                    "type": "timeline",
                    "event": {
                        "timestamp": chrono_like_now(),
                        "level": "warning",
                        "message": line,
                    }
                });
                emit_review_event(&app, &payload);
            }
        })
    });

    let status = child
        .wait()
        .map_err(|e| format!("Failed waiting for merge runner: {}", e))?;

    if let Some(handle) = stdout_handle {
        let _ = handle.join();
    }
    if let Some(handle) = stderr_handle {
        let _ = handle.join();
    }

    let stderr_message = runner_error.lock().ok().and_then(|slot| slot.clone());
    let raw_result = raw_result.lock().ok().and_then(|slot| slot.clone());

    if !status.success() {
        return Err(stderr_message.unwrap_or_else(|| {
            format!(
                "Merge runner exited with code {}",
                status.code().unwrap_or(-1)
            )
        }));
    }

    let raw_result = raw_result.ok_or_else(|| {
        stderr_message
            .clone()
            .unwrap_or_else(|| "Merge runner did not return a result".to_string())
    })?;

    update_merge_review_session_status(app, run_id, "completed", None, Some(worktree_path));
    append_merge_review_backend_log(app, run_id, "lifecycle", "completed");
    serde_json::from_value(raw_result).map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn start_merge_review(
    app: AppHandle,
    request: StartMergeReviewRequest,
) -> Result<StartMergeReviewResponse, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<MergeReviewState>();
        start_merge_review_blocking(&app, state.inner(), request)
    })
    .await
    .map_err(|error| format!("Merge review task failed: {error}"))?
}

fn start_merge_review_blocking(
    app: &AppHandle,
    state: &MergeReviewState,
    request: StartMergeReviewRequest,
) -> Result<StartMergeReviewResponse, String> {
    if request.source_commits.is_empty() {
        return Err("No source commits provided".to_string());
    }
    if request.files.is_empty() {
        return Err("No files to review".to_string());
    }

    let (run_id, workspace) = create_review_workspace(&request.repo_path, &request.target_commit)?;
    let worktree_string = workspace.worktree_path.clone();
    initialize_merge_review_session(app, &run_id, &workspace, "review");

    let payload = build_payload(&request)?;
    let worktree_config = crate::worktree_config::load_agent_worktree_config(&request.repo_path)?;
    let agentree_dir = Path::new(&worktree_string).join(".agentree");
    ensure_directory(&agentree_dir)?;
    let payload_file = agentree_dir.join("merge-review-input.json");
    fs::write(
        &payload_file,
        serde_json::to_vec_pretty(&payload).map_err(|e| e.to_string())?,
    )
    .map_err(|e| format!("Failed to write review payload: {}", e))?;

    let mut config = serde_json::json!({
        "mode": "review",
        "agentType": request.agent_type,
        "agentName": request.agent_name,
        "cliArgs": request.cli_args,
        "promptFlag": request.prompt_flag,
        "selectedModelId": request.selected_model_id,
        "payloadFile": payload_file.to_string_lossy().to_string(),
        "worktreePath": worktree_string,
    });
    add_codex_adapter_command_to_config(app, &mut config)?;

    let mut command = Command::new(crate::managed_runtime::node_program(app)?);
    command
        .arg(merge_review_script_path(app)?)
        .arg(config.to_string())
        .current_dir(&workspace.worktree_path)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    crate::command_guards::apply_agent_command_env_with_config(
        &mut command,
        app,
        &run_id,
        Path::new(&workspace.worktree_path),
        &worktree_config,
    )?;
    let mut child = command
        .spawn()
        .map_err(|e| format!("Failed to spawn merge review runner: {}", e))?;

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    state
        .worktrees
        .lock()
        .map_err(|e| e.to_string())?
        .insert(run_id.clone(), workspace.clone());
    state
        .children
        .lock()
        .map_err(|e| e.to_string())?
        .insert(run_id.clone(), child);

    let app_for_stdout = app.clone();
    let run_id_for_stdout = run_id.clone();
    if let Some(stdout) = stdout {
        thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines().map_while(Result::ok) {
                match serde_json::from_str::<serde_json::Value>(&line) {
                    Ok(mut value) => {
                        if value.get("runId").is_none() {
                            value["runId"] = serde_json::Value::String(run_id_for_stdout.clone());
                        }
                        persist_merge_review_event_value(
                            &app_for_stdout,
                            &run_id_for_stdout,
                            &value,
                        );
                        emit_review_event(&app_for_stdout, &value);
                    }
                    Err(_) => {
                        persist_merge_review_raw_event(
                            &app_for_stdout,
                            &run_id_for_stdout,
                            "merge_review:stdout",
                            &line,
                            "stdout",
                        );
                        let payload = serde_json::json!({
                            "runId": run_id_for_stdout,
                            "type": "timeline",
                            "event": {
                                "timestamp": chrono_like_now(),
                                "level": "info",
                                "message": line,
                            }
                        });
                        emit_review_event(&app_for_stdout, &payload);
                    }
                }
            }
        });
    }

    let app_for_stderr = app.clone();
    let run_id_for_stderr = run_id.clone();
    if let Some(stderr) = stderr {
        thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines().map_while(Result::ok) {
                persist_merge_review_raw_event(
                    &app_for_stderr,
                    &run_id_for_stderr,
                    "merge_review:stderr",
                    &line,
                    "stderr",
                );
                let payload = serde_json::json!({
                    "runId": run_id_for_stderr,
                    "type": "timeline",
                    "event": {
                        "timestamp": chrono_like_now(),
                        "level": "warning",
                        "message": line,
                    }
                });
                emit_review_event(&app_for_stderr, &payload);
            }
        });
    }

    let app_for_wait = app.clone();
    let run_id_for_wait = run_id.clone();
    thread::spawn(move || loop {
        let status = {
            let app_state = app_for_wait.state::<MergeReviewState>();
            let mut children = match app_state.children.lock() {
                Ok(guard) => guard,
                Err(_) => return,
            };
            let Some(child) = children.get_mut(&run_id_for_wait) else {
                return;
            };
            match child.try_wait() {
                Ok(Some(status)) => {
                    children.remove(&run_id_for_wait);
                    Some(status)
                }
                Ok(None) => None,
                Err(_) => {
                    children.remove(&run_id_for_wait);
                    None
                }
            }
        };

        if let Some(status) = status {
            let workspace = {
                let app_state = app_for_wait.state::<MergeReviewState>();
                app_state
                    .worktrees
                    .lock()
                    .ok()
                    .and_then(|mut map| map.remove(&run_id_for_wait))
            };
            if let Some(workspace) = workspace.as_ref() {
                let terminal_status = if status.success() {
                    "completed"
                } else {
                    "failed"
                };
                update_merge_review_session_status(
                    &app_for_wait,
                    &run_id_for_wait,
                    terminal_status,
                    Some(&workspace.repo_path),
                    Some(&workspace.worktree_path),
                );
                append_merge_review_backend_log(
                    &app_for_wait,
                    &run_id_for_wait,
                    "lifecycle",
                    &format!(
                        "process_exit status={terminal_status} code={}",
                        status.code().unwrap_or(-1)
                    ),
                );
                cleanup_review_workspace(&run_id_for_wait, workspace);
            }

            if !status.success() {
                let payload = serde_json::json!({
                    "runId": run_id_for_wait,
                    "type": "status",
                    "status": "failed",
                    "message": format!("Merge review exited with code {}", status.code().unwrap_or(-1)),
                });
                emit_review_event(&app_for_wait, &payload);
            }
            return;
        }

        thread::sleep(std::time::Duration::from_millis(200));
    });

    Ok(StartMergeReviewResponse { run_id })
}

#[tauri::command]
#[specta::specta]
pub async fn synthesize_merge_resolutions(
    app: AppHandle,
    request: SynthesizeMergeResolutionsRequest,
) -> Result<SynthesizeMergeResolutionsResponse, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if request.source_commits.is_empty() {
            return Err("No source commits provided".to_string());
        }
        if request.files.is_empty() {
            return Err("No files to synthesize".to_string());
        }

        let run_id = request
            .run_id
            .clone()
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        let (_workspace_run_id, workspace) =
            create_review_workspace(&request.repo_path, &request.target_commit)?;
        initialize_merge_review_session(&app, &run_id, &workspace, "synthesize");
        let result = (|| -> Result<SynthesizeMergeResolutionsResponse, String> {
            let payload = build_resolution_payload(&request)?;
            let agentree_dir = Path::new(&workspace.worktree_path).join(".agentree");
            ensure_directory(&agentree_dir)?;
            let payload_file = agentree_dir.join("merge-resolution-input.json");
            fs::write(
                &payload_file,
                serde_json::to_vec_pretty(&payload).map_err(|e| e.to_string())?,
            )
            .map_err(|e| format!("Failed to write synthesis payload: {}", e))?;

            let config = serde_json::json!({
                "mode": "synthesize",
                "agentType": request.agent_type,
                "agentName": request.agent_name,
                "cliArgs": request.cli_args,
                "promptFlag": request.prompt_flag,
                "selectedModelId": request.selected_model_id,
                "payloadFile": payload_file.to_string_lossy().to_string(),
                "worktreePath": workspace.worktree_path.clone(),
            });

            let worktree_config =
                crate::worktree_config::load_agent_worktree_config(&request.repo_path)?;
            run_sync_runner_with_events(
                &app,
                &run_id,
                &workspace.worktree_path,
                config,
                &worktree_config,
            )
        })();

        cleanup_review_workspace(&run_id, &workspace);
        result
    })
    .await
    .map_err(|e| format!("Merge synthesis task failed: {}", e))?
}

#[tauri::command]
#[specta::specta]
pub fn stop_merge_review(
    app: AppHandle,
    state: State<MergeReviewState>,
    run_id: String,
) -> Result<(), String> {
    let mut children = state.children.lock().map_err(|e| e.to_string())?;
    let Some(child) = children.get_mut(&run_id) else {
        return Err(format!("No merge review run found for {}", run_id));
    };

    #[cfg(unix)]
    unsafe {
        libc::kill(child.id() as i32, libc::SIGTERM);
    }

    let _ = child.kill();
    let _ = child.wait();
    children.remove(&run_id);
    drop(children);

    if let Some(workspace) = state
        .worktrees
        .lock()
        .map_err(|e| e.to_string())?
        .remove(&run_id)
    {
        update_merge_review_session_status(
            &app,
            &run_id,
            "cancelled",
            Some(&workspace.repo_path),
            Some(&workspace.worktree_path),
        );
        append_merge_review_backend_log(&app, &run_id, "lifecycle", "cancelled");
        cleanup_review_workspace(&run_id, &workspace);
    } else {
        update_merge_review_session_status(&app, &run_id, "cancelled", None, None);
        append_merge_review_backend_log(&app, &run_id, "lifecycle", "cancelled");
    }

    let payload = serde_json::json!({
        "runId": run_id,
        "type": "status",
        "status": "cancelled",
        "message": "Merge review cancelled",
    });
    emit_review_event(&app, &payload);

    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn is_merge_review_running(
    state: State<MergeReviewState>,
    run_id: String,
) -> Result<bool, String> {
    Ok(state
        .children
        .lock()
        .map_err(|e| e.to_string())?
        .contains_key(&run_id))
}

fn chrono_like_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}
