use crate::skills;
#[cfg(unix)]
use libc;
use serde::{Deserialize, Serialize};
use serde_json::{Map as JsonMap, Value as JsonValue};
use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, State};

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentRunContext {
    pub run_id: String,
    #[serde(default)]
    #[specta(type = specta_typescript::Unknown)]
    pub execution_data: JsonValue,
    #[serde(default)]
    pub git_branch_name: Option<String>,
    #[serde(default)]
    pub repo_path: Option<String>,
    #[serde(default)]
    pub parent_commit: Option<String>,
    #[serde(default)]
    pub author_name: Option<String>,
    #[serde(default)]
    pub prompt_fallback: Option<String>,
}

#[derive(Debug, Clone, Default)]
struct LatencyTraceState {
    trace_id: Option<String>,
    marks: JsonMap<String, JsonValue>,
}

#[derive(Debug, Clone)]
struct AgentRunSnapshot {
    node_id: String,
    run_id: String,
    status: String,
    final_content: String,
    execution_data: JsonValue,
    prompt_tokens: Option<i64>,
    completion_tokens: Option<i64>,
    total_tokens: Option<i64>,
    output_commit_sha: Option<String>,
    git_branch_name: Option<String>,
    repo_path: Option<String>,
    parent_commit: Option<String>,
    author_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
struct FinalizeAckPayload {
    run_id: String,
    status: String,
    persisted: bool,
    output_commit_sha: Option<String>,
    base_commit_sha: Option<String>,
    commit_created: bool,
}

enum FinalizeRunSnapshotOutcome {
    QueuedForRetry {
        finalize_ack: FinalizeAckPayload,
        upload_error: String,
    },
}

#[derive(Debug, Clone, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct StartAgentRunIntent {
    pub run_id: String,
    pub assistant_node_id: String,
    pub workspace_id: Option<String>,
    pub repo_path: String,
    pub parent_commit: String,
    pub agent_type: String,
    pub args: Vec<String>,
    pub auth_token: String,
    pub trace_id: Option<String>,
    pub run_context: AgentRunContext,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct StartAgentRunResponse {
    pub run_id: String,
    pub assistant_node_id: String,
    pub worktree_path: String,
    pub branch_name: String,
    pub pid: Option<u32>,
    pub initial_status: String,
}

#[derive(Debug, Clone)]
pub(crate) struct AgentRunState {
    context: AgentRunContext,
    content: String,
    timeline: Vec<JsonValue>,
    usage: Option<JsonValue>,
    meta: JsonMap<String, JsonValue>,
    latency_trace: LatencyTraceState,
    last_stream_seq: Option<u64>,
    terminal_status: Option<String>,
    stop_reason: Option<String>,
    provider_thread_id: Option<String>,
    provider_turn_id: Option<String>,
    final_content_override: Option<String>,
    cancel_requested: bool,
    finalized: bool,
}

impl AgentRunState {
    fn new(context: AgentRunContext) -> Self {
        Self {
            context,
            content: String::new(),
            timeline: Vec::new(),
            usage: None,
            meta: JsonMap::new(),
            latency_trace: LatencyTraceState::default(),
            last_stream_seq: None,
            terminal_status: None,
            stop_reason: None,
            provider_thread_id: None,
            provider_turn_id: None,
            final_content_override: None,
            cancel_requested: false,
            finalized: false,
        }
    }
}

pub struct AgentState {
    pub children: Mutex<HashMap<u32, Child>>,
    pub sessions: Mutex<HashMap<String, u32>>,
    pub session_tokens: Mutex<HashMap<String, String>>,
    pub run_states: Mutex<HashMap<String, Arc<Mutex<AgentRunState>>>>,
}

// AgentEvent struct removed - events are now constructed inline using serde_json::json!

fn resolve_codex_home() -> Option<String> {
    if let Ok(raw) = std::env::var("CODEX_HOME") {
        let trimmed = raw.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    }

    dirs::home_dir().map(|home| home.join(".codex").to_string_lossy().into_owned())
}

fn record_local_trace_event(
    app_handle: &AppHandle,
    session_id: &str,
    trace_id: &str,
    name: &str,
    source: &str,
) {
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0);
    let event = serde_json::json!({
        "type": "trace",
        "trace_id": trace_id,
        "name": name,
        "source": source,
        "ts": ts,
    });
    let run_state = {
        let app_state = app_handle.state::<AgentState>();
        let run_states = app_state.run_states.lock().unwrap();
        run_states.get(session_id).cloned()
    };
    if let Some(run_state) = run_state {
        let mut run_state = run_state.lock().unwrap();
        update_run_state_from_event(&mut run_state, &event);
    }
}

fn stream_debug_enabled() -> bool {
    matches!(
        std::env::var("AGENTREE_STREAM_DEBUG").as_deref(),
        Ok("1") | Ok("true") | Ok("yes")
    )
}

fn stream_debug(enabled: bool, message: &str) {
    if enabled {
        crate::app_log!("[RCSTRM] {}", message);
    }
}

fn unix_timestamp_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

fn string_from_execution_meta(execution_data: &JsonValue, key: &str) -> Option<String> {
    execution_data
        .get("meta")
        .and_then(|value| value.get(key))
        .and_then(|value| value.as_str())
        .filter(|value| !value.trim().is_empty())
        .map(|value| value.to_string())
}

fn workspace_id_from_execution_data(execution_data: &JsonValue) -> Option<String> {
    execution_data
        .get("workspace_id")
        .or_else(|| execution_data.get("workspaceId"))
        .and_then(|value| value.as_str())
        .filter(|value| !value.trim().is_empty())
        .map(|value| value.to_string())
}

fn parent_id_from_execution_data(execution_data: &JsonValue) -> Option<String> {
    execution_data
        .get("parentId")
        .or_else(|| execution_data.get("parent_id"))
        .or_else(|| {
            execution_data
                .get("meta")
                .and_then(|value| value.get("context_parent_node_id"))
        })
        .and_then(|value| value.as_str())
        .filter(|value| !value.trim().is_empty())
        .map(|value| value.to_string())
}

fn llm_model_from_execution_data(execution_data: &JsonValue) -> Option<String> {
    string_from_execution_meta(execution_data, "llmModel")
        .or_else(|| string_from_execution_meta(execution_data, "provider_model"))
        .or_else(|| string_from_execution_meta(execution_data, "model"))
}

fn llm_provider_from_execution_data(execution_data: &JsonValue) -> Option<String> {
    string_from_execution_meta(execution_data, "provider_selected_provider")
        .or_else(|| string_from_execution_meta(execution_data, "provider"))
        .or_else(|| string_from_execution_meta(execution_data, "llmProvider"))
}

fn run_ledger_user_node_id_from_context(context: &AgentRunContext) -> Option<String> {
    parent_id_from_execution_data(&context.execution_data)
}

fn base_selected_from_node_id_from_execution_data(execution_data: &JsonValue) -> Option<String> {
    execution_data
        .get("base_selected_from_node_id")
        .or_else(|| execution_data.get("baseSelectedFromNodeId"))
        .or_else(|| {
            execution_data
                .get("meta")
                .and_then(|value| value.get("base_selected_from_node_id"))
        })
        .or_else(|| {
            execution_data
                .get("meta")
                .and_then(|value| value.get("baseSelectedFromNodeId"))
        })
        .and_then(|value| value.as_str())
        .filter(|value| !value.trim().is_empty())
        .map(|value| value.to_string())
}

fn upsert_run_ledger_for_context(
    app_handle: &AppHandle,
    session_id: &str,
    agent_type: Option<&str>,
    status: &str,
    phase: &str,
    pid: Option<i64>,
    context: &AgentRunContext,
) {
    let telemetry = app_handle.state::<crate::db::TelemetryDb>();
    let worktree_path = string_from_execution_meta(&context.execution_data, "git_worktree_path");
    let workspace_id = workspace_id_from_execution_data(&context.execution_data);
    let run = crate::db::AgentRunLedgerUpsert {
        run_id: context.run_id.clone(),
        user_node_id: run_ledger_user_node_id_from_context(context),
        assistant_node_id: session_id.to_string(),
        workspace_id,
        repo_path: context.repo_path.clone(),
        worktree_path,
        branch_name: context.git_branch_name.clone(),
        parent_commit: context.parent_commit.clone(),
        pid,
        agent_type: agent_type.map(|value| value.to_string()),
        status: status.to_string(),
        phase: phase.to_string(),
    };
    if let Err(err) = telemetry.upsert_agent_run_ledger(&run) {
        crate::app_log!(
            "[AGENT_WORKTREE] event=ledger.upsert_failed node_id={} run_id={} err={}",
            session_id,
            context.run_id,
            err
        );
    }
}

fn emit_agent_event(app_handle: &AppHandle, session_id: &str, event: &serde_json::Value) {
    let mut event = event.clone();
    if let Ok(Some(ledger)) = app_handle
        .state::<crate::db::TelemetryDb>()
        .get_agent_run_ledger_by_assistant(session_id)
    {
        let event_type = event
            .get("type")
            .and_then(|value| value.as_str())
            .unwrap_or("event")
            .to_string();
        let status = event.get("status").and_then(|value| value.as_str());
        let phase = event.get("phase").and_then(|value| value.as_str());
        let payload = event.to_string();
        if let Ok(seq) = app_handle
            .state::<crate::db::TelemetryDb>()
            .append_agent_run_event(
                &ledger.run_id,
                session_id,
                &event_type,
                status,
                phase,
                &payload,
            )
        {
            if let Some(object) = event.as_object_mut() {
                object.insert("run_id".to_string(), serde_json::json!(ledger.run_id));
                object.insert("nodeId".to_string(), serde_json::json!(session_id));
                object.insert("seq".to_string(), serde_json::json!(seq));
                object.insert(
                    "timestamp".to_string(),
                    serde_json::json!(unix_timestamp_millis()),
                );
                if !object.contains_key("phase") {
                    object.insert("phase".to_string(), serde_json::json!(ledger.phase));
                }
                if !object.contains_key("status") {
                    object.insert("status".to_string(), serde_json::json!(ledger.status));
                }
            }
        }
    }
    let payload = serde_json::json!({
        "nodeId": session_id,
        "event": event,
    });
    let _ = app_handle.emit("agent:event", payload);
}

fn emit_finalize_ack(app_handle: &AppHandle, session_id: &str, payload: &FinalizeAckPayload) {
    let event = serde_json::json!({
        "type": "finalize_ack",
        "run_id": payload.run_id,
        "status": payload.status,
        "persisted": payload.persisted,
        "output_commit_sha": payload.output_commit_sha,
        "base_commit_sha": payload.base_commit_sha,
        "commit_created": payload.commit_created,
    });
    emit_agent_event(app_handle, session_id, &event);
}

fn emit_finalize_progress(app_handle: &AppHandle, session_id: &str, phase: &str, message: &str) {
    let event = serde_json::json!({
        "type": "finalize_progress",
        "phase": phase,
        "message": message,
    });
    emit_agent_event(app_handle, session_id, &event);
}

fn cleanup_terminal_status_allows_cleanup(status: &str) -> bool {
    matches!(
        status,
        "completed"
            | "failed"
            | "cancelled"
            | "error"
            | "failed_setup"
            | "failed_spawn"
            | "failed_runtime"
    )
}

fn cleanup_requires_server_final_persisted(status: &str) -> bool {
    status == "completed"
}

fn cleanup_agent_run_worktree_internal(
    app_handle: &AppHandle,
    node_id: &str,
    repo_path: &str,
) -> Result<(), String> {
    let telemetry = app_handle.state::<crate::db::TelemetryDb>();
    telemetry.increment_agent_run_cleanup_attempt(node_id)?;
    let Some(ledger) = telemetry.get_agent_run_ledger_by_assistant(node_id)? else {
        return Err(format!("No native run ledger found for {}", node_id));
    };
    if ledger.repo_path.as_deref() != Some(repo_path) {
        telemetry.mark_agent_run_needs_user_action(
            node_id,
            "Cleanup repo path did not match the native run ledger.",
        )?;
        return Err("Cleanup repo path did not match native run ledger.".to_string());
    }
    let terminal_status = ledger
        .terminal_status
        .as_deref()
        .unwrap_or(ledger.status.as_str());
    let is_terminal = cleanup_terminal_status_allows_cleanup(terminal_status);
    if !is_terminal && !ledger.server_final_persisted {
        telemetry.mark_agent_run_needs_user_action(
            node_id,
            "Cleanup requested before terminal classification.",
        )?;
        return Err("Cleanup requested before terminal classification.".to_string());
    }
    let has_retryable_terminal_sync = !ledger.server_final_persisted
        && cleanup_requires_server_final_persisted(terminal_status)
        && telemetry.has_retryable_terminal_node_sync(node_id)?;
    if !ledger.server_final_persisted
        && cleanup_requires_server_final_persisted(terminal_status)
        && !has_retryable_terminal_sync
    {
        telemetry.mark_agent_run_needs_user_action(
            node_id,
            "Cleanup blocked because completed run is not durably finalized on the server.",
        )?;
        return Err("Cleanup blocked before durable server finalization.".to_string());
    }
    let active_pid = {
        let app_state = app_handle.state::<AgentState>();
        let pid = app_state
            .sessions
            .lock()
            .map_err(|e| e.to_string())?
            .get(node_id)
            .copied();
        pid
    };
    if let Some(active_pid) = active_pid {
        let app_state = app_handle.state::<AgentState>();
        let mut children = app_state.children.lock().map_err(|e| e.to_string())?;
        let still_running = children
            .get_mut(&active_pid)
            .map(|child| matches!(child.try_wait(), Ok(None)))
            .unwrap_or(false);
        if still_running {
            telemetry.mark_agent_run_needs_user_action(
                node_id,
                "Cleanup blocked because the native agent process is still running.",
            )?;
            return Err("Cleanup blocked while native process is still running.".to_string());
        }
    }
    let Some(worktree_path) = ledger.worktree_path.clone() else {
        telemetry.mark_agent_run_needs_user_action(
            node_id,
            "Cleanup blocked because the native ledger has no worktree path.",
        )?;
        return Err("Cleanup blocked without ledger worktree path.".to_string());
    };
    let Some(branch_name) = ledger.branch_name.clone() else {
        telemetry.mark_agent_run_needs_user_action(
            node_id,
            "Cleanup blocked because the native ledger has no branch name.",
        )?;
        return Err("Cleanup blocked without ledger branch name.".to_string());
    };
    let expected_worktree_path = crate::git_workspace::preview_agent_worktree(
        repo_path.to_string(),
        node_id.to_string(),
        ledger.parent_commit.clone().unwrap_or_default(),
    );
    let expected_worktree_path =
        tauri::async_runtime::block_on(expected_worktree_path)?.worktree_path;
    if worktree_path != expected_worktree_path {
        telemetry.mark_agent_run_needs_user_action(
            node_id,
            "Cleanup worktree path did not match the native run ledger.",
        )?;
        return Err("Cleanup worktree path did not match native run ledger.".to_string());
    }
    if branch_name != format!("agentree/{}", node_id) {
        telemetry.mark_agent_run_needs_user_action(
            node_id,
            "Cleanup branch name did not match the native run ledger.",
        )?;
        return Err("Cleanup branch name did not match native run ledger.".to_string());
    }
    if ledger.cleanup_completed {
        return Ok(());
    }
    telemetry.update_agent_run_phase(node_id, terminal_status, "cleaning", None)?;
    tauri::async_runtime::block_on(crate::git_workspace::cleanup_worktree_owned(
        repo_path.to_string(),
        node_id.to_string(),
        worktree_path,
        branch_name,
    ))?;
    telemetry.mark_agent_run_cleanup_completed(node_id)?;
    Ok(())
}

fn cleanup_worktree_after_finalize(
    app_handle: &AppHandle,
    node_id: &str,
    repo_path: Option<String>,
    log_label: &str,
) {
    if let Some(repo_path) = repo_path {
        crate::app_log!(
            "[AGENT_WORKTREE] event=native_cleanup.request node_id={} repo={} detail={}",
            node_id,
            repo_path,
            log_label
        );
        if let Err(err) = cleanup_agent_run_worktree_internal(app_handle, node_id, &repo_path) {
            crate::app_log!("[RCSTRM] {} session_id={} err={}", log_label, node_id, err);
        }
    }
}

fn update_local_session_status(
    app_handle: &AppHandle,
    session_id: &str,
    status: &str,
    repo_path: Option<&str>,
) {
    let telemetry = app_handle.state::<crate::db::TelemetryDb>();
    if let Err(err) = telemetry.update_session_status(session_id, status, repo_path, None) {
        crate::app_log!(
            "[RCSTRM] local_session_status_update_failed session_id={} status={} err={}",
            session_id,
            status,
            err
        );
    }
}

fn finalize_run_state_if_ready(
    app_handle: &AppHandle,
    session_id: &str,
    auth_token: &str,
) -> Option<String> {
    let run_state = {
        let app_state = app_handle.state::<AgentState>();
        let run_states = app_state.run_states.lock().unwrap();
        run_states.get(session_id).cloned()
    }?;

    let mut run_state = run_state.lock().unwrap();
    crate::app_log!(
        "[AGENT_WORKTREE] event=finalize_state.enter node_id={} terminal_status={:?} cancel_requested={} already_finalized={} repo={:?} parent_commit={:?}",
        session_id,
        run_state.terminal_status,
        run_state.cancel_requested,
        run_state.finalized,
        run_state.context.repo_path,
        run_state.context.parent_commit
    );
    if run_state.terminal_status.is_none() {
        run_state.terminal_status = Some(if run_state.cancel_requested {
            "cancelled".to_string()
        } else {
            "failed".to_string()
        });
    }
    let terminal_status = run_state.terminal_status.clone();
    let mut snapshot = build_finalize_snapshot(&mut run_state, session_id);
    crate::app_log!(
        "[AGENT_WORKTREE] event=finalize_state.snapshot node_id={} built={} terminal_status={:?}",
        session_id,
        snapshot.is_some(),
        terminal_status
    );
    drop(run_state);

    if let Some(ref mut snapshot) = snapshot {
        let telemetry = app_handle.state::<crate::db::TelemetryDb>();
        let _ = telemetry.increment_agent_run_finalize_attempt(session_id);
        let _ =
            telemetry.update_agent_run_phase(session_id, "finalizing", "finalizing_stream", None);
        match finalize_run_snapshot(app_handle, snapshot, auth_token) {
            Ok(FinalizeRunSnapshotOutcome::QueuedForRetry {
                finalize_ack,
                upload_error,
            }) => {
                let _ = telemetry.mark_agent_run_finalized(
                    session_id,
                    &finalize_ack.status,
                    false,
                    finalize_ack.output_commit_sha.as_deref(),
                );
                cleanup_worktree_after_finalize(
                    app_handle,
                    session_id,
                    snapshot.repo_path.clone(),
                    "cleanup_after_local_finalize_queued_sync",
                );
                emit_finalize_ack(app_handle, session_id, &finalize_ack);
                crate::app_log!(
                    "[RCSTRM] finalize_upload_queued_for_retry session_id={} err={}",
                    session_id,
                    upload_error
                );
            }
            Err(err) => {
                let _ = telemetry.update_agent_run_phase(
                    session_id,
                    "failed_finalization",
                    "failed_finalization",
                    Some(&err),
                );
                let _ = telemetry.mark_agent_run_needs_user_action(
                    session_id,
                    "Native finalization failed before durable server finalization; cleanup is blocked.",
                );
                crate::app_log!(
                    "[RCSTRM] finalize_failed session_id={} err={}",
                    session_id,
                    err
                );
            }
        }
        update_local_session_status(
            app_handle,
            session_id,
            &snapshot.status,
            snapshot.repo_path.as_deref(),
        );
        return Some(snapshot.status.clone());
    }

    if let Some(ref status) = terminal_status {
        update_local_session_status(app_handle, session_id, status, None);
    }

    terminal_status
}

fn merge_json_value(base: &mut JsonValue, patch: &JsonValue) {
    match (base, patch) {
        (JsonValue::Object(base_obj), JsonValue::Object(patch_obj)) => {
            for (key, value) in patch_obj {
                match base_obj.get_mut(key) {
                    Some(existing) => merge_json_value(existing, value),
                    None => {
                        base_obj.insert(key.clone(), value.clone());
                    }
                }
            }
        }
        (base_slot, patch_value) => {
            *base_slot = patch_value.clone();
        }
    }
}

fn merge_json_maps(base: &mut JsonMap<String, JsonValue>, patch: &JsonMap<String, JsonValue>) {
    for (key, value) in patch {
        match base.get_mut(key) {
            Some(existing) => merge_json_value(existing, value),
            None => {
                base.insert(key.clone(), value.clone());
            }
        }
    }
}

fn merge_text_output(current: &str, incoming: &str) -> String {
    if incoming.is_empty() {
        return current.to_string();
    }
    if current.is_empty() {
        return incoming.to_string();
    }
    if incoming.starts_with(current) {
        return incoming.to_string();
    }
    if current.starts_with(incoming) || current.ends_with(incoming) {
        return current.to_string();
    }
    format!("{}{}", current, incoming)
}

fn derive_incremental_text(previous: &str, next: &str) -> String {
    if next.is_empty() {
        return String::new();
    }
    if previous.is_empty() {
        return next.to_string();
    }
    if previous == next || previous.starts_with(next) {
        return String::new();
    }
    if next.starts_with(previous) {
        return next[previous.len()..].to_string();
    }
    let max_overlap = previous.len().min(next.len());
    for overlap in (1..=max_overlap).rev() {
        if previous.ends_with(&next[..overlap]) {
            return next[overlap..].to_string();
        }
    }
    if previous.contains(next) {
        String::new()
    } else {
        next.to_string()
    }
}

fn append_message_timeline_segment(run_state: &mut AgentRunState, text: &str, timestamp: i64) {
    if text.is_empty() {
        return;
    }
    if let Some(last_event) = run_state.timeline.last_mut() {
        if last_event.get("type").and_then(|value| value.as_str()) == Some("message") {
            let existing = last_event
                .get("content")
                .and_then(|value| value.as_str())
                .unwrap_or_default()
                .to_string();
            if let Some(object) = last_event.as_object_mut() {
                object.insert(
                    "content".to_string(),
                    JsonValue::String(merge_text_output(&existing, text)),
                );
            }
            return;
        }
    }
    run_state.timeline.push(serde_json::json!({
        "type": "message",
        "timestamp": timestamp,
        "content": text,
    }));
}

fn replace_message_timeline_with_final_content(
    run_state: &mut AgentRunState,
    final_content: &str,
    timestamp: i64,
) {
    run_state
        .timeline
        .retain(|event| event.get("type").and_then(|value| value.as_str()) != Some("message"));
    append_message_timeline_segment(run_state, final_content, timestamp);
}

fn timeline_tool_use_id(event: &JsonValue) -> Option<&str> {
    event
        .get("toolUseId")
        .or_else(|| event.get("tool_use_id"))
        .or_else(|| event.get("id"))
        .and_then(|value| value.as_str())
}

fn append_tool_output_delta(run_state: &mut AgentRunState, tool_use_id: &str, delta: &str) {
    if delta.is_empty() {
        return;
    }
    for event in run_state.timeline.iter_mut().rev() {
        if event.get("type").and_then(|value| value.as_str()) != Some("tool_use") {
            continue;
        }
        if timeline_tool_use_id(event) != Some(tool_use_id) {
            continue;
        }
        let existing = event
            .get("toolOutput")
            .and_then(|value| value.as_str())
            .unwrap_or_default()
            .to_string();
        if let Some(object) = event.as_object_mut() {
            object.insert(
                "toolOutput".to_string(),
                JsonValue::String(merge_text_output(&existing, delta)),
            );
        }
        return;
    }
}

fn normalize_timeline_event(event: &JsonValue) -> Option<JsonValue> {
    let event_type = event.get("type")?.as_str()?;
    let timestamp = event
        .get("timestamp")
        .and_then(|value| value.as_i64())
        .unwrap_or_else(|| {
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|duration| duration.as_millis() as i64)
                .unwrap_or(0)
        });

    match event_type {
        "thinking" => Some(serde_json::json!({
            "type": "thinking",
            "timestamp": timestamp,
            "content": event.get("thinking").cloned()
                .or_else(|| event.get("content").cloned())
                .unwrap_or(JsonValue::Null),
        })),
        "tool_use" => Some(serde_json::json!({
            "type": "tool_use",
            "timestamp": timestamp,
            "toolName": event.get("toolName").cloned()
                .or_else(|| event.get("name").cloned())
                .or_else(|| event.get("tool_name").cloned())
                .unwrap_or(JsonValue::Null),
            "toolInput": event.get("toolInput").cloned()
                .or_else(|| event.get("tool_input").cloned())
                .or_else(|| event.get("input").cloned())
                .unwrap_or(JsonValue::Null),
            "toolUseId": event.get("toolUseId").cloned()
                .or_else(|| event.get("tool_use_id").cloned())
                .or_else(|| event.get("id").cloned())
                .unwrap_or(JsonValue::Null),
            "commandActions": event.get("commandActions").cloned()
                .or_else(|| event.get("command_actions").cloned())
                .or_else(|| event.get("provider_item").and_then(|item| item.get("commandActions")).cloned())
                .unwrap_or(JsonValue::Null),
            "providerItem": event.get("providerItem").cloned()
                .or_else(|| event.get("provider_item").cloned())
                .unwrap_or(JsonValue::Null),
            "provider_item_id": event.get("provider_item_id").cloned()
                .or_else(|| event.get("id").cloned())
                .unwrap_or(JsonValue::Null),
        })),
        "tool_result" => Some(serde_json::json!({
            "type": "tool_result",
            "timestamp": timestamp,
            "toolName": event.get("toolName").cloned()
                .or_else(|| event.get("tool_name").cloned())
                .or_else(|| event.get("name").cloned())
                .unwrap_or(JsonValue::Null),
            "toolOutput": event.get("toolOutput").cloned()
                .or_else(|| event.get("tool_output").cloned())
                .or_else(|| event.get("content").cloned())
                .or_else(|| event.get("output").cloned())
                .unwrap_or(JsonValue::Null),
            "isError": event.get("isError").cloned()
                .or_else(|| event.get("is_error").cloned())
                .unwrap_or(JsonValue::Bool(false)),
            "toolUseId": event.get("toolUseId").cloned()
                .or_else(|| event.get("tool_use_id").cloned())
                .or_else(|| event.get("id").cloned())
                .unwrap_or(JsonValue::Null),
        })),
        "error" => Some(serde_json::json!({
            "type": "error",
            "timestamp": timestamp,
            "content": event.get("content").cloned()
                .or_else(|| event.get("data").cloned())
                .unwrap_or(JsonValue::Null),
        })),
        "stderr" => Some(serde_json::json!({
            "type": "error",
            "timestamp": timestamp,
            "content": event.get("data").cloned()
                .or_else(|| event.get("content").cloned())
                .unwrap_or(JsonValue::Null),
        })),
        _ => None,
    }
}

fn update_latency_trace(state: &mut AgentRunState, event: &JsonValue) {
    let Some(name) = event.get("name").and_then(|value| value.as_str()) else {
        return;
    };
    let mut mark = JsonMap::new();
    if let Some(ts) = event.get("ts").cloned() {
        mark.insert("ts".to_string(), ts);
    }
    if let Some(source) = event.get("source").cloned() {
        mark.insert("source".to_string(), source);
    }
    if let Some(detail) = event.get("detail").cloned() {
        mark.insert("detail".to_string(), detail);
    }
    if let Some(trace_id) = event.get("trace_id").and_then(|value| value.as_str()) {
        state.latency_trace.trace_id = Some(trace_id.to_string());
    }
    state
        .latency_trace
        .marks
        .insert(name.to_string(), JsonValue::Object(mark));
}

fn build_latency_trace_value(trace: &LatencyTraceState) -> Option<JsonValue> {
    if trace.trace_id.is_none() && trace.marks.is_empty() {
        return None;
    }
    let mut summary = JsonMap::new();
    let get_ts = |name: &str| -> Option<i64> {
        trace
            .marks
            .get(name)
            .and_then(|value| value.get("ts"))
            .and_then(|value| value.as_i64())
    };
    if let (Some(start), Some(end)) = (
        get_ts("send_clicked"),
        get_ts("first_visible_text_rendered"),
    ) {
        if end >= start {
            summary.insert(
                "first_visible_text_rendered".to_string(),
                JsonValue::from(end - start),
            );
        }
    }
    Some(serde_json::json!({
        "trace_id": trace.trace_id,
        "marks": trace.marks,
        "summary_ms": JsonValue::Object(summary),
        "updated_at_ts": SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_millis() as i64)
            .unwrap_or(0),
    }))
}

fn update_run_state_from_event(run_state: &mut AgentRunState, event: &JsonValue) {
    if let Some(stream_seq) = event.get("stream_seq").and_then(|value| value.as_u64()) {
        run_state.last_stream_seq = Some(stream_seq);
    }

    let Some(event_type) = event.get("type").and_then(|value| value.as_str()) else {
        return;
    };
    let timestamp = event
        .get("timestamp")
        .and_then(|value| value.as_i64())
        .unwrap_or_else(|| {
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|duration| duration.as_millis() as i64)
                .unwrap_or(0)
        });

    match event_type {
        "message_delta" => {
            if let Some(delta) = event.get("delta").and_then(|value| value.as_str()) {
                run_state.content.push_str(delta);
                append_message_timeline_segment(run_state, delta, timestamp);
            }
        }
        "message_completed" | "message" => {
            if let Some(content) = event.get("content").and_then(|value| value.as_str()) {
                let merged = merge_text_output(&run_state.content, content);
                let appended = derive_incremental_text(&run_state.content, &merged);
                run_state.content = merged;
                append_message_timeline_segment(run_state, &appended, timestamp);
            }
        }
        "usage" => {
            if let Some(usage) = event.get("usage") {
                run_state.usage = Some(usage.clone());
            }
        }
        "provider_meta" => {
            if let Some(meta) = event.get("meta").and_then(|value| value.as_object()) {
                merge_json_maps(&mut run_state.meta, meta);
            }
        }
        "tool_output_delta" => {
            if let (Some(tool_use_id), Some(delta)) = (
                event
                    .get("toolUseId")
                    .or_else(|| event.get("tool_use_id"))
                    .or_else(|| event.get("id"))
                    .and_then(|value| value.as_str()),
                event.get("delta").and_then(|value| value.as_str()),
            ) {
                append_tool_output_delta(run_state, tool_use_id, delta);
            }
        }
        "session" => {
            if let Some(session_id) = event.get("session_id").cloned() {
                run_state
                    .meta
                    .insert("agent_session_id".to_string(), session_id);
            }
            if let Some(provider) = event.get("provider").cloned() {
                run_state
                    .meta
                    .insert("agent_session_provider".to_string(), provider);
            }
        }
        "trace" => update_latency_trace(run_state, event),
        "stop" | "provider_stop" => {
            if let Some(status) = event
                .get("provider_status")
                .or_else(|| event.get("status"))
                .and_then(|value| value.as_str())
            {
                run_state.terminal_status = Some(status.to_string());
            }
            if let Some(stop_reason) = event
                .get("provider_stop_reason")
                .or_else(|| event.get("stop_reason"))
                .and_then(|value| value.as_str())
            {
                run_state.stop_reason = Some(stop_reason.to_string());
            }
            if let Some(provider_thread_id) = event
                .get("provider_thread_id")
                .and_then(|value| value.as_str())
            {
                run_state.provider_thread_id = Some(provider_thread_id.to_string());
            }
            if let Some(provider_turn_id) = event
                .get("provider_turn_id")
                .and_then(|value| value.as_str())
            {
                run_state.provider_turn_id = Some(provider_turn_id.to_string());
            }
            if let Some(usage) = event.get("usage") {
                run_state.usage = Some(usage.clone());
            }
            if let Some(final_content) = event.get("final_content").and_then(|value| value.as_str())
            {
                run_state.content = final_content.to_string();
                run_state.final_content_override = Some(final_content.to_string());
                replace_message_timeline_with_final_content(run_state, final_content, timestamp);
            }
        }
        _ => {}
    }

    if let Some(timeline_event) = normalize_timeline_event(event) {
        run_state.timeline.push(timeline_event);
    }
}

fn usage_token_fields(usage: Option<&JsonValue>) -> (Option<i64>, Option<i64>, Option<i64>) {
    let Some(usage) = usage else {
        return (None, None, None);
    };
    let prompt = usage
        .get("input_tokens")
        .or_else(|| usage.get("prompt_tokens"))
        .and_then(|value| value.as_i64());
    let completion = usage
        .get("output_tokens")
        .or_else(|| usage.get("completion_tokens"))
        .and_then(|value| value.as_i64());
    let total = usage
        .get("total_tokens")
        .and_then(|value| value.as_i64())
        .or_else(|| match (prompt, completion) {
            (Some(prompt), Some(completion)) => Some(prompt + completion),
            _ => None,
        });
    (prompt, completion, total)
}

fn build_finalize_snapshot(
    run_state: &mut AgentRunState,
    session_id: &str,
) -> Option<AgentRunSnapshot> {
    if run_state.finalized {
        return None;
    }
    run_state.finalized = true;

    let status = run_state.terminal_status.clone().unwrap_or_else(|| {
        if run_state.cancel_requested {
            "cancelled".to_string()
        } else {
            "failed".to_string()
        }
    });
    let final_content = run_state
        .final_content_override
        .clone()
        .unwrap_or_else(|| run_state.content.clone());

    let mut execution_data = if run_state.context.execution_data.is_object() {
        run_state.context.execution_data.clone()
    } else {
        JsonValue::Object(JsonMap::new())
    };
    let execution_object = execution_data
        .as_object_mut()
        .expect("execution_data must be object");

    let mut meta_value = execution_object
        .remove("meta")
        .unwrap_or_else(|| JsonValue::Object(JsonMap::new()));
    if !meta_value.is_object() {
        meta_value = JsonValue::Object(JsonMap::new());
    }
    let meta_object = meta_value.as_object_mut().expect("meta must be object");
    merge_json_maps(meta_object, &run_state.meta);
    if let Some(provider_thread_id) = &run_state.provider_thread_id {
        meta_object.insert(
            "provider_thread_id".to_string(),
            JsonValue::String(provider_thread_id.clone()),
        );
    }
    if let Some(provider_turn_id) = &run_state.provider_turn_id {
        meta_object.insert(
            "provider_turn_id".to_string(),
            JsonValue::String(provider_turn_id.clone()),
        );
    }
    execution_object.insert("meta".to_string(), meta_value);

    if let Some(usage) = &run_state.usage {
        execution_object.insert("usage".to_string(), usage.clone());
    }
    execution_object.insert(
        "timeline".to_string(),
        JsonValue::Array(run_state.timeline.clone()),
    );
    execution_object.insert(
        "current_run_id".to_string(),
        JsonValue::String(run_state.context.run_id.clone()),
    );
    execution_object.insert(
        "last_terminal_status".to_string(),
        JsonValue::String(status.clone()),
    );
    if let Some(stop_reason) = &run_state.stop_reason {
        execution_object.insert(
            "stop_reason".to_string(),
            JsonValue::String(stop_reason.clone()),
        );
    }
    if let Some(last_stream_seq) = run_state.last_stream_seq {
        execution_object.insert(
            "last_stream_seq".to_string(),
            JsonValue::from(last_stream_seq),
        );
    }
    if let Some(latency_trace) = build_latency_trace_value(&run_state.latency_trace) {
        execution_object.insert("latency_trace".to_string(), latency_trace);
    }

    let (prompt_tokens, completion_tokens, total_tokens) =
        usage_token_fields(run_state.usage.as_ref());

    Some(AgentRunSnapshot {
        node_id: session_id.to_string(),
        run_id: run_state.context.run_id.clone(),
        status,
        final_content,
        execution_data,
        prompt_tokens,
        completion_tokens,
        total_tokens,
        output_commit_sha: None,
        git_branch_name: run_state.context.git_branch_name.clone(),
        repo_path: run_state.context.repo_path.clone(),
        parent_commit: run_state.context.parent_commit.clone(),
        author_name: run_state.context.author_name.clone(),
    })
}

fn post_json_with_retry(
    client: &reqwest::blocking::Client,
    auth_token: &str,
    url: &str,
    body: &JsonValue,
    attempts: usize,
    label: &str,
) -> Result<JsonValue, String> {
    let mut last_error = None;
    for attempt in 0..attempts {
        match client
            .post(url)
            .header("Authorization", format!("Bearer {}", auth_token))
            .json(body)
            .send()
        {
            Ok(response) if response.status().is_success() => {
                return match response.json::<JsonValue>() {
                    Ok(body) => Ok(body),
                    Err(_) => Ok(JsonValue::Null),
                };
            }
            Ok(response) => {
                last_error = Some(format!(
                    "{} failed with status {}",
                    label,
                    response.status()
                ));
            }
            Err(err) => {
                last_error = Some(format!("{} transport error: {}", label, err));
            }
        }
        if attempt + 1 < attempts {
            let backoff_ms = 250u64.saturating_mul(1u64 << attempt.min(5));
            thread::sleep(Duration::from_millis(backoff_ms));
        }
    }
    Err(last_error.unwrap_or_else(|| format!("{} failed", label)))
}

fn persist_local_node_snapshot(
    app_handle: &AppHandle,
    snapshot: &AgentRunSnapshot,
) -> Result<(), String> {
    let workspace_id =
        workspace_id_from_execution_data(&snapshot.execution_data).ok_or_else(|| {
            "Cannot persist local authoritative node without workspace id.".to_string()
        })?;
    let payload = local_node_payload_for_snapshot(snapshot, &workspace_id);
    let serialized = serde_json::to_string(&payload).map_err(|e| e.to_string())?;
    app_handle
        .state::<crate::db::TelemetryDb>()
        .upsert_local_node(&snapshot.node_id, &workspace_id, &serialized)
}

fn local_node_payload_for_snapshot(snapshot: &AgentRunSnapshot, workspace_id: &str) -> JsonValue {
    serde_json::json!({
        "id": snapshot.node_id,
        "role": "assistant",
        "workspaceId": workspace_id,
        "parentId": parent_id_from_execution_data(&snapshot.execution_data),
        "content": snapshot.final_content,
        "aiLabel": ai_label_from_execution_data(&snapshot.execution_data),
        "llmModel": llm_model_from_execution_data(&snapshot.execution_data),
        "llmProvider": llm_provider_from_execution_data(&snapshot.execution_data),
        "status": snapshot.status,
        "execution_data": snapshot.execution_data,
        "promptTokens": snapshot.prompt_tokens,
        "completionTokens": snapshot.completion_tokens,
        "totalTokens": snapshot.total_tokens,
        "base_commit_sha": snapshot.parent_commit,
        "output_commit_sha": snapshot.output_commit_sha,
        "base_selected_from_node_id": base_selected_from_node_id_from_execution_data(&snapshot.execution_data),
        "git_branch_name": snapshot.git_branch_name,
        "updatedAt": chrono_like_now(),
    })
}

fn store_finalize_ack(
    telemetry: &crate::db::TelemetryDb,
    session_id: &str,
    finalize_ack: &FinalizeAckPayload,
) {
    match serde_json::to_string(finalize_ack) {
        Ok(finalize_ack_json) => {
            if let Err(err) = telemetry.kv_set(session_id, "finalize_ack", &finalize_ack_json) {
                crate::app_log!(
                    "[RCSTRM] finalize_ack_kv_write_failed session_id={} err={}",
                    session_id,
                    err
                );
            }
        }
        Err(err) => {
            crate::app_log!(
                "[RCSTRM] finalize_ack_serialize_failed session_id={} err={}",
                session_id,
                err
            );
        }
    }
}

fn normalize_commit_message_subject(value: &str) -> Option<String> {
    let normalized = value
        .replace(['\n', '\r', '\t'], " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .trim()
        .trim_matches(|ch| ch == '"' || ch == '\'' || ch == '`' || ch == '-' || ch == '.')
        .to_string();
    if normalized.is_empty() {
        return None;
    }
    Some(
        normalized
            .chars()
            .take(72)
            .collect::<String>()
            .trim()
            .to_string(),
    )
}

fn normalize_ai_label(value: &str) -> Option<String> {
    let without_code_fences = strip_markdown_code(value);
    let normalized = without_code_fences
        .replace(['\n', '\r', '\t'], " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .trim()
        .trim_matches(|ch| ch == '"' || ch == '\'' || ch == '`' || ch == '-' || ch == '.')
        .to_string();
    if normalized.is_empty() {
        return None;
    }
    Some(
        normalized
            .chars()
            .take(80)
            .collect::<String>()
            .trim()
            .to_string(),
    )
}

fn strip_markdown_code(value: &str) -> String {
    let mut output = String::with_capacity(value.len());
    let mut in_fence = false;
    for line in value.lines() {
        if line.trim_start().starts_with("```") {
            in_fence = !in_fence;
            output.push(' ');
            continue;
        }
        if !in_fence {
            output.push_str(line);
            output.push(' ');
        }
    }
    output
}

fn normalize_commit_message_fallback(value: Option<&str>) -> Option<String> {
    let raw = value?;
    let cleaned = raw
        .replace(['\n', '\r', '\t'], " ")
        .replace(['?', '!', '.'], "")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    let mut candidate = cleaned
        .trim()
        .trim_matches(|ch| ch == '"' || ch == '\'' || ch == '`' || ch == '-' || ch == '.')
        .to_string();
    for prefix in [
        "can you ",
        "could you ",
        "please ",
        "pls ",
        "i think ",
        "seems like ",
        "isn't ",
        "is not ",
        "isnt ",
    ] {
        if candidate.to_lowercase().starts_with(prefix) {
            candidate = candidate[prefix.len()..].trim().to_string();
            break;
        }
    }
    let split_index = candidate
        .find(" and ")
        .or_else(|| candidate.find(" but "))
        .or_else(|| candidate.find(" so "))
        .or_else(|| candidate.find(" because "))
        .unwrap_or(candidate.len());
    candidate.truncate(split_index);
    let result = candidate
        .chars()
        .take(72)
        .collect::<String>()
        .trim()
        .to_string();
    if result.is_empty() {
        None
    } else {
        Some(result)
    }
}

fn commit_subject_from_execution_data(execution_data: &JsonValue) -> Option<String> {
    execution_data
        .get("meta")
        .and_then(|value| value.as_object())
        .and_then(|meta| {
            meta.get("commit_subject")
                .or_else(|| meta.get("agent_commit_subject"))
                .or_else(|| meta.get("runtime_commit_subject"))
        })
        .and_then(|value| value.as_str())
        .and_then(normalize_commit_message_subject)
}

fn ai_label_from_execution_data(execution_data: &JsonValue) -> Option<String> {
    execution_data
        .get("meta")
        .and_then(|value| value.as_object())
        .and_then(|meta| {
            meta.get("ai_label")
                .or_else(|| meta.get("aiLabel"))
                .or_else(|| meta.get("agent_ai_label"))
                .or_else(|| meta.get("runtime_ai_label"))
        })
        .and_then(|value| value.as_str())
        .and_then(normalize_ai_label)
}

fn commit_message_for_snapshot(snapshot: &AgentRunSnapshot) -> String {
    commit_subject_from_execution_data(&snapshot.execution_data)
        .or_else(|| normalize_commit_message_fallback(Some(snapshot.final_content.as_str())))
        .unwrap_or_else(|| {
            format!(
                "Update {}",
                &snapshot.node_id[..snapshot.node_id.len().min(8)]
            )
        })
}

fn is_merge_using_ai_execution_data(execution_data: &JsonValue) -> bool {
    execution_data
        .get("meta")
        .and_then(|value| value.as_object())
        .and_then(|meta| meta.get("workflow"))
        .and_then(|value| value.as_str())
        == Some("merge_using_ai")
}

fn merge_source_commits_from_execution_data(execution_data: &JsonValue) -> Vec<String> {
    execution_data
        .get("meta")
        .and_then(|value| value.as_object())
        .and_then(|meta| meta.get("merge_source_commits"))
        .and_then(|value| value.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str())
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToString::to_string)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default()
}

fn merge_target_branch_from_execution_data(execution_data: &JsonValue) -> Option<String> {
    execution_data
        .get("meta")
        .and_then(|value| value.as_object())
        .and_then(|meta| meta.get("merge_target_branch"))
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
}

fn record_output_commit_for_snapshot(
    app_handle: &AppHandle,
    snapshot: &mut AgentRunSnapshot,
    repo_path: &str,
    parent_commit: &str,
    commit: crate::git_workspace::GitCommitMetadata,
    meta_commit_message: Option<String>,
    source_kind: &str,
) -> Result<(), String> {
    let commit_sha = commit.sha.clone();
    let commit_subject = if commit.subject.trim().is_empty() {
        meta_commit_message
            .clone()
            .unwrap_or_else(|| "Agent changes".to_string())
    } else {
        commit.subject.clone()
    };
    let commit_message = meta_commit_message.unwrap_or_else(|| commit_subject.clone());
    let diff = tauri::async_runtime::block_on(crate::git_workspace::diff_commits(
        repo_path.to_string(),
        parent_commit.to_string(),
        commit_sha.clone(),
        false,
    ))?;
    let changed_files = diff
        .files
        .into_iter()
        .map(|file| JsonValue::String(file.path))
        .collect::<Vec<_>>();
    let files_changed_count = changed_files.len() as i64;

    if let Some(execution_object) = snapshot.execution_data.as_object_mut() {
        execution_object.insert("files_changed".to_string(), JsonValue::Array(changed_files));
        execution_object.insert(
            "files_changed_count".to_string(),
            JsonValue::from(files_changed_count),
        );
        let meta = execution_object
            .entry("meta".to_string())
            .or_insert_with(|| JsonValue::Object(JsonMap::new()));
        if let Some(meta_object) = meta.as_object_mut() {
            meta_object.insert("commit_created".to_string(), JsonValue::Bool(true));
            meta_object.insert(
                "commit_message".to_string(),
                JsonValue::String(commit_message.clone()),
            );
        }
    }

    snapshot.output_commit_sha = Some(commit_sha.clone());
    let _ = app_handle
        .state::<crate::db::TelemetryDb>()
        .record_agent_run_output_commit(&snapshot.node_id, &commit_sha);
    if let Some(workspace_id) = workspace_id_from_execution_data(&snapshot.execution_data) {
        let fallback_timestamp = chrono_like_now();
        let parents = if commit.parents.is_empty() {
            vec![parent_commit.to_string()]
        } else {
            commit.parents.clone()
        };
        let _ = app_handle
            .state::<crate::db::TelemetryDb>()
            .import_local_commits_with_parent_closure(
                &workspace_id,
                vec![crate::db::LocalCommitImport {
                    sha: commit_sha,
                    parents,
                    subject: Some(commit_subject),
                    author_name: commit
                        .author_name
                        .clone()
                        .or_else(|| snapshot.author_name.clone()),
                    author_email: commit.author_email.clone(),
                    authored_at: commit
                        .authored_at
                        .clone()
                        .or_else(|| Some(fallback_timestamp.clone())),
                    committed_at: commit.authored_at.clone().or(Some(fallback_timestamp)),
                    source_kind: Some(source_kind.to_string()),
                    produced_by_node_id: Some(snapshot.node_id.clone()),
                    files_changed_count: commit
                        .files_changed_count
                        .map(|value| value as i64)
                        .or(Some(files_changed_count)),
                    total_additions: commit.total_additions.map(|value| value as i64),
                    total_deletions: commit.total_deletions.map(|value| value as i64),
                }],
                Some(source_kind),
                Some(repo_path),
            );
    }

    Ok(())
}

fn finalize_run_snapshot(
    app_handle: &AppHandle,
    snapshot: &mut AgentRunSnapshot,
    _auth_token: &str,
) -> Result<FinalizeRunSnapshotOutcome, String> {
    let mut commit_created = false;
    crate::app_log!(
        "[AGENT_WORKTREE] event=finalize_snapshot.start node_id={} status={} repo={:?} parent_commit={:?} branch={:?}",
        snapshot.node_id,
        snapshot.status,
        snapshot.repo_path,
        snapshot.parent_commit,
        snapshot.git_branch_name
    );

    if snapshot.status == "completed" {
        if let (Some(repo_path), Some(parent_commit)) =
            (snapshot.repo_path.clone(), snapshot.parent_commit.clone())
        {
            let _ = app_handle
                .state::<crate::db::TelemetryDb>()
                .update_agent_run_phase(&snapshot.node_id, "finalizing", "finalizing_git", None);
            crate::app_log!(
                "[AGENT_WORKTREE] event=finalize_snapshot.git_checks node_id={} repo={} parent_commit={}",
                snapshot.node_id,
                repo_path,
                parent_commit
            );
            emit_finalize_progress(
                app_handle,
                &snapshot.node_id,
                "checking_changes",
                "Checking for generated changes...",
            );
            if let Some(execution_object) = snapshot.execution_data.as_object_mut() {
                let meta = execution_object
                    .entry("meta".to_string())
                    .or_insert_with(|| JsonValue::Object(JsonMap::new()));
                if let Some(meta_object) = meta.as_object_mut() {
                    meta_object.insert("commit_created".to_string(), JsonValue::Bool(false));
                }
            }

            if is_merge_using_ai_execution_data(&snapshot.execution_data) {
                emit_finalize_progress(
                    app_handle,
                    &snapshot.node_id,
                    "commit_message",
                    "Preparing AI merge commit...",
                );
                let commit_message = commit_message_for_snapshot(snapshot);
                let source_commits =
                    merge_source_commits_from_execution_data(&snapshot.execution_data);
                let target_branch =
                    merge_target_branch_from_execution_data(&snapshot.execution_data);
                emit_finalize_progress(
                    app_handle,
                    &snapshot.node_id,
                    "git_commit",
                    "Creating merge commit...",
                );
                let (commit_metadata, target_branch_updated) =
                    crate::git_workspace::finalize_agent_merge_worktree(
                        &repo_path,
                        &snapshot.node_id,
                        &parent_commit,
                        &source_commits,
                        &commit_message,
                        snapshot.author_name.as_deref(),
                        target_branch.as_deref(),
                    )?;
                if let Some(execution_object) = snapshot.execution_data.as_object_mut() {
                    let meta = execution_object
                        .entry("meta".to_string())
                        .or_insert_with(|| JsonValue::Object(JsonMap::new()));
                    if let Some(meta_object) = meta.as_object_mut() {
                        meta_object.insert("commit_created".to_string(), JsonValue::Bool(true));
                        meta_object.insert(
                            "merge_target_branch_updated".to_string(),
                            JsonValue::Bool(target_branch_updated),
                        );
                    }
                }
                record_output_commit_for_snapshot(
                    app_handle,
                    snapshot,
                    &repo_path,
                    &parent_commit,
                    commit_metadata,
                    Some(commit_message),
                    "merge",
                )?;
                commit_created = true;
            } else {
                let has_changes = tauri::async_runtime::block_on(
                    crate::git_workspace::agent_worktree_has_changes(
                        repo_path.clone(),
                        snapshot.node_id.clone(),
                    ),
                )?;

                if has_changes {
                    emit_finalize_progress(
                        app_handle,
                        &snapshot.node_id,
                        "commit_message",
                        "Preparing commit message...",
                    );
                    let commit_message = commit_message_for_snapshot(snapshot);
                    emit_finalize_progress(
                        app_handle,
                        &snapshot.node_id,
                        "git_commit",
                        "Creating git commit...",
                    );
                    let finalize_result = tauri::async_runtime::block_on(
                        crate::git_workspace::finalize_agent_worktree(
                            repo_path.clone(),
                            snapshot.node_id.clone(),
                            commit_message.clone(),
                            snapshot.author_name.clone(),
                        ),
                    )?;
                    let commit_sha = finalize_result.commit_sha.ok_or_else(|| {
                        "Commit SHA missing after finalize_agent_worktree".to_string()
                    })?;
                    let commit_metadata =
                        crate::git_workspace::read_commit_metadata_sync(&repo_path, &commit_sha)?;
                    record_output_commit_for_snapshot(
                        app_handle,
                        snapshot,
                        &repo_path,
                        &parent_commit,
                        commit_metadata,
                        Some(commit_message),
                        "agent",
                    )?;
                    commit_created = true;
                } else if let Some(commit_metadata) =
                    crate::git_workspace::agent_worktree_head_commit_if_advanced(
                        &repo_path,
                        &snapshot.node_id,
                        &parent_commit,
                    )?
                {
                    crate::app_log!(
                        "[AGENT_WORKTREE] event=finalize_snapshot.head_advanced node_id={} repo={} parent_commit={} output_commit={}",
                        snapshot.node_id,
                        repo_path,
                        parent_commit,
                        commit_metadata.sha
                    );
                    emit_finalize_progress(
                        app_handle,
                        &snapshot.node_id,
                        "git_commit",
                        "Recording generated commit...",
                    );
                    record_output_commit_for_snapshot(
                        app_handle,
                        snapshot,
                        &repo_path,
                        &parent_commit,
                        commit_metadata,
                        None,
                        "agent",
                    )?;
                    commit_created = true;
                } else if let Some(execution_object) = snapshot.execution_data.as_object_mut() {
                    execution_object
                        .insert("files_changed".to_string(), JsonValue::Array(Vec::new()));
                    execution_object.insert("files_changed_count".to_string(), JsonValue::from(0));
                }
            }

            snapshot.git_branch_name = None;
        }
    }

    let payload = serde_json::json!({
        "nodeId": snapshot.node_id,
        "runId": snapshot.run_id,
        "status": snapshot.status,
        "finalContent": snapshot.final_content,
        "aiLabel": ai_label_from_execution_data(&snapshot.execution_data),
        "executionData": snapshot.execution_data,
        "promptTokens": snapshot.prompt_tokens,
        "completionTokens": snapshot.completion_tokens,
        "totalTokens": snapshot.total_tokens,
        "outputCommitSha": snapshot.output_commit_sha,
        "gitBranchName": snapshot.git_branch_name,
    });
    persist_local_node_snapshot(app_handle, snapshot)?;
    let _ = app_handle
        .state::<crate::db::TelemetryDb>()
        .update_agent_run_phase(&snapshot.node_id, "finalizing", "persisting_final", None);
    emit_finalize_progress(
        app_handle,
        &snapshot.node_id,
        "persisting",
        "Saving generated commit...",
    );
    let telemetry = app_handle.state::<crate::db::TelemetryDb>();
    let workspace_id = workspace_id_from_execution_data(&snapshot.execution_data)
        .ok_or_else(|| "Missing workspace_id in terminal snapshot execution data.".to_string())?;
    let assistant_payload = telemetry
        .get_local_node_payload(&snapshot.node_id)?
        .ok_or_else(|| format!("Missing local assistant payload for {}", snapshot.node_id))?;
    let user_node_id = telemetry
        .get_local_node_parent_id(&snapshot.node_id)?
        .ok_or_else(|| format!("Missing local parent user node for {}", snapshot.node_id))?;
    let user_payload = telemetry
        .get_local_node_payload(&user_node_id)?
        .ok_or_else(|| format!("Missing local user payload for {}", user_node_id))?;
    let sync_payload = serde_json::json!({
        "workspaceId": workspace_id,
        "userMessage": serde_json::from_str::<JsonValue>(&user_payload).unwrap_or(JsonValue::Null),
        "assistantMessage": serde_json::from_str::<JsonValue>(&assistant_payload).unwrap_or(JsonValue::Null),
        "finalize": payload,
    });
    let payload_json = serde_json::to_string(&sync_payload).unwrap_or_else(|_| "{}".to_string());
    telemetry
        .enqueue_local_sync_event(
            Some(workspace_id.as_str()),
            "node",
            &snapshot.node_id,
            "node.update_terminal",
            &payload_json,
            Some(&snapshot.run_id),
        )
        .map_err(|queue_err| {
            format!("failed to enqueue local terminal sync retry: {}", queue_err)
        })?;
    let finalize_ack = FinalizeAckPayload {
        run_id: snapshot.run_id.clone(),
        status: snapshot.status.clone(),
        persisted: false,
        output_commit_sha: snapshot.output_commit_sha.clone(),
        base_commit_sha: snapshot.parent_commit.clone(),
        commit_created,
    };

    store_finalize_ack(&telemetry, &snapshot.node_id, &finalize_ack);

    Ok(FinalizeRunSnapshotOutcome::QueuedForRetry {
        finalize_ack,
        upload_error: "queued for background sync".to_string(),
    })
}

fn spawn_agent_internal(
    app: AppHandle,
    state: &AgentState,
    agent_type: String,
    cwd: String,
    args: Vec<String>,
    session_id: String,
    auth_token: String,
    trace_id: Option<String>,
    run_context: Option<AgentRunContext>,
) -> Result<u32, String> {
    crate::app_log!(
        "[AGENT_WORKTREE] event=spawn.start node_id={} agent_type={} cwd={} has_run_context={}",
        session_id,
        agent_type,
        cwd,
        run_context.is_some()
    );
    let skill_store = skills::ensure_runtime_skills(&agent_type, Path::new(&cwd))?;
    let mut args = args;
    if agent_type.as_str() == "codex" {
        args.insert(
            0,
            crate::runtime_scripts::runtime_script_path(&app, "codex-app-server-adapter.py")?
                .to_string_lossy()
                .into_owned(),
        );
    }
    if agent_type.as_str() == "claude" {
        args.insert(
            0,
            crate::runtime_scripts::runtime_script_path(&app, "claude-agent-sdk-adapter.mjs")?
                .to_string_lossy()
                .into_owned(),
        );
    }
    if agent_type.as_str() == "bash" {
        args.insert(
            0,
            crate::runtime_scripts::runtime_script_path(&app, "bash-adapter.cjs")?
                .to_string_lossy()
                .into_owned(),
        );
    }
    if agent_type.as_str() == "claude" {
        let mut cleaned: Vec<String> = Vec::new();
        let mut skip_next = false;
        for arg in args.into_iter() {
            if skip_next {
                skip_next = false;
                continue;
            }
            if arg == "--output-format" {
                skip_next = true;
                continue;
            }
            if arg == "-p"
                || arg == "--print"
                || arg == "--verbose"
                || arg == "--no-session-persistence"
            {
                continue;
            }
            cleaned.push(arg);
        }
        args = cleaned;
    }

    let program = match agent_type.as_str() {
        "claude" => "node".to_string(),
        "codex" => crate::runtime_scripts::runtime_python_command(&app),
        "bash" => "node".to_string(),
        "echo" => "echo".to_string(),
        _ => return Err(format!("Unknown agent type: {}", agent_type)),
    };

    let stream_debug_on = stream_debug_enabled();
    stream_debug(
        stream_debug_on,
        &format!(
            "spawn agent_type={} session_id={} cwd={} program={}",
            agent_type, session_id, cwd, program
        ),
    );

    let mcp_bind = std::env::var("AGENTREE_MCP_BIND").unwrap_or_else(|_| "127.0.0.1".to_string());
    let mcp_port = std::env::var("AGENTREE_MCP_PORT")
        .or_else(|_| std::env::var("MCP_PORT"))
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(61337);
    let mcp_url = format!("http://{}:{}/mcp", mcp_bind, mcp_port);
    let mut command = Command::new(&program);
    command
        .args(args)
        .current_dir(&cwd)
        .env("AGENTREE_MCP_URL", &mcp_url)
        .env("MCP_SERVER_URL", &mcp_url)
        .env("AGENTREE_TRACE_ID", trace_id.clone().unwrap_or_default())
        .env(
            "AGENTREE_SKILLS_DIR",
            skill_store
                .as_ref()
                .map(|path| path.to_string_lossy().into_owned())
                .unwrap_or_default(),
        )
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    crate::command_guards::apply_agent_command_env(
        &mut command,
        &app,
        &session_id,
        Path::new(&cwd),
    )?;

    if agent_type.as_str() == "codex" {
        if let Some(codex_home) = resolve_codex_home() {
            command.env("CODEX_HOME", codex_home);
        }
    }

    if let Some(run_context) = run_context.as_ref() {
        upsert_run_ledger_for_context(
            &app,
            &session_id,
            Some(agent_type.as_str()),
            "spawning",
            "spawning",
            None,
            run_context,
        );
    }

    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(err) => {
            if run_context.is_some() {
                let telemetry = app.state::<crate::db::TelemetryDb>();
                let _ = telemetry.update_agent_run_phase(
                    &session_id,
                    "failed_spawn",
                    "failed_spawn",
                    Some(&err.to_string()),
                );
            }
            crate::app_log!(
                "[AGENT_WORKTREE] event=spawn.command_error node_id={} agent_type={} cwd={} err={}",
                session_id,
                agent_type,
                cwd,
                err
            );
            return Err(err.to_string());
        }
    };

    let child_id = child.id();
    if let Some(run_context) = run_context.as_ref() {
        upsert_run_ledger_for_context(
            &app,
            &session_id,
            Some(agent_type.as_str()),
            "running",
            "running",
            Some(child_id as i64),
            run_context,
        );
    }
    crate::app_log!(
        "[AGENT_WORKTREE] event=spawn.child_started node_id={} pid={} agent_type={} cwd={}",
        session_id,
        child_id,
        agent_type,
        cwd
    );
    let verbose_agent_logs = matches!(
        std::env::var("AGENTREE_AGENT_VERBOSE_LOGS").as_deref(),
        Ok("1") | Ok("true") | Ok("yes")
    );
    let stream_seq = Arc::new(AtomicU64::new(0));
    let app_handle = app.clone();
    stream_debug(
        stream_debug_on,
        &format!("spawned pid={} session_id={}", child_id, session_id),
    );
    let stdout_done = Arc::new(AtomicBool::new(false));
    let stderr_done = Arc::new(AtomicBool::new(false));

    // Stream stdout
    if let Some(stdout) = child.stdout.take() {
        let app_handle = app_handle.clone();
        let session_id = session_id.clone();
        let auth_token = auth_token.clone();
        let trace_id = trace_id.clone();
        let stdout_done = Arc::clone(&stdout_done);
        let stream_seq = Arc::clone(&stream_seq);
        let verbose_agent_logs = verbose_agent_logs;
        let stream_debug_on = stream_debug_on;
        thread::spawn(move || {
            stream_debug(
                stream_debug_on,
                &format!("stdout_thread_started pid={}", child_id),
            );
            let reader = BufReader::new(stdout);
            let mut first_stdout_sent = false;

            for line in reader.lines() {
                if let Ok(line) = line {
                    if verbose_agent_logs {
                        crate::app_log!("[RCSTRM] stdout_line pid={} line={}", child_id, line);
                    }
                    // Log to Local SQLite (Telemetry)
                    let _ = crate::db::log_event(&app_handle, &session_id, "stdout", &line);
                    if !first_stdout_sent {
                        if let Some(trace_id) = trace_id.as_deref() {
                            record_local_trace_event(
                                &app_handle,
                                &session_id,
                                trace_id,
                                "tauri_first_stdout_line",
                                "tauri",
                            );
                        }
                        first_stdout_sent = true;
                    }

                    let structured_event = serde_json::from_str::<serde_json::Value>(&line)
                        .ok()
                        .filter(|value| {
                            value.get("type").and_then(|entry| entry.as_str()).is_some()
                        });

                    let mut event = structured_event.unwrap_or_else(|| {
                        serde_json::json!({
                            "agent_id": child_id,
                            "type": "stdout",
                            "data": line
                        })
                    });
                    if let Some(object) = event.as_object_mut() {
                        let seq = stream_seq.fetch_add(1, Ordering::SeqCst) + 1;
                        object.insert("stream_seq".to_string(), serde_json::json!(seq));
                        object.insert(
                            "stream_source".to_string(),
                            serde_json::json!("tauri_stdout"),
                        );
                    }
                    {
                        let app_state = app_handle.state::<AgentState>();
                        let run_state = {
                            let run_states = app_state.run_states.lock().unwrap();
                            run_states.get(&session_id).cloned()
                        };
                        if let Some(run_state) = run_state {
                            let mut run_state = run_state.lock().unwrap();
                            update_run_state_from_event(&mut run_state, &event);
                        }
                    }
                    emit_agent_event(&app_handle, &session_id, &event);

                    let event_type = event
                        .get("type")
                        .and_then(|entry| entry.as_str())
                        .unwrap_or("")
                        .to_string();
                    if event_type == "stop" || event_type == "provider_stop" {
                        let _ = finalize_run_state_if_ready(&app_handle, &session_id, &auth_token);
                        stream_debug(
                            stream_debug_on,
                            &format!("terminal_stop_forwarded session_id={}", session_id),
                        );
                        continue;
                    }
                }
            }
            stdout_done.store(true, Ordering::SeqCst);
        });
    } else {
        stdout_done.store(true, Ordering::SeqCst);
    }

    // Stream stderr
    if let Some(stderr) = child.stderr.take() {
        let app_handle = app_handle.clone();
        let session_id = session_id.clone();
        let stderr_done = Arc::clone(&stderr_done);
        let stream_seq = Arc::clone(&stream_seq);
        let verbose_agent_logs = verbose_agent_logs;
        let stream_debug_on = stream_debug_on;
        thread::spawn(move || {
            stream_debug(
                stream_debug_on,
                &format!("stderr_thread_started pid={}", child_id),
            );
            let reader = BufReader::new(stderr);
            for line in reader.lines() {
                if let Ok(line) = line {
                    if verbose_agent_logs {
                        crate::app_log!("[RCSTRM] stderr_line pid={} line={}", child_id, line);
                    }
                    // Log to Local SQLite
                    let _ = crate::db::log_event(&app_handle, &session_id, "stderr", &line);

                    let payload = serde_json::json!({
                        "agent_id": child_id,
                        "type": "stderr",
                        "data": line,
                        "stream_seq": stream_seq.fetch_add(1, Ordering::SeqCst) + 1,
                        "stream_source": "tauri_stderr"
                    });
                    {
                        let app_state = app_handle.state::<AgentState>();
                        let run_state = {
                            let run_states = app_state.run_states.lock().unwrap();
                            run_states.get(&session_id).cloned()
                        };
                        if let Some(run_state) = run_state {
                            let mut run_state = run_state.lock().unwrap();
                            update_run_state_from_event(&mut run_state, &payload);
                        }
                    }
                    emit_agent_event(&app_handle, &session_id, &payload);
                }
            }
            stderr_done.store(true, Ordering::SeqCst);
        });
    } else {
        stderr_done.store(true, Ordering::SeqCst);
    }

    // Store child process and token
    state.children.lock().unwrap().insert(child_id, child);
    state
        .sessions
        .lock()
        .unwrap()
        .insert(session_id.clone(), child_id);
    state
        .session_tokens
        .lock()
        .unwrap()
        .insert(session_id.clone(), auth_token.clone());
    crate::app_log!(
        "[AGENT_WORKTREE] event=spawn.session_registered node_id={} pid={} has_run_context={}",
        session_id,
        child_id,
        run_context.is_some()
    );
    if let Some(run_context) = run_context.clone() {
        state.run_states.lock().unwrap().insert(
            session_id.clone(),
            Arc::new(Mutex::new(AgentRunState::new(run_context.clone()))),
        );
        crate::app_log!(
            "[AGENT_WORKTREE] event=spawn.run_state_registered node_id={} pid={} repo={:?} parent_commit={:?}",
            session_id,
            child_id,
            run_context.repo_path,
            run_context.parent_commit
        );
        update_local_session_status(
            &app,
            &session_id,
            "running",
            run_context.repo_path.as_deref(),
        );
        if let Some(trace_id) = trace_id.as_deref() {
            record_local_trace_event(&app, &session_id, trace_id, "tauri_child_spawned", "tauri");
        }
        crate::app_log!(
            "[AGENT_WORKTREE] event=spawn.persist_start_skipped_local_first node_id={} pid={}",
            session_id,
            child_id
        );
    }

    // Dedicated wait thread to emit exit event even if stdout/stderr stalls
    let app_handle = app.clone();
    let session_id_for_wait = session_id.clone();
    let auth_token_for_wait = auth_token.clone();
    let stdout_done_for_wait = Arc::clone(&stdout_done);
    let stderr_done_for_wait = Arc::clone(&stderr_done);
    thread::spawn(move || {
        loop {
            let mut exited = None;
            {
                let app_state = app_handle.state::<AgentState>();
                let mut children = app_state.children.lock().unwrap();
                if let Some(child) = children.get_mut(&child_id) {
                    match child.try_wait() {
                        Ok(Some(status)) => exited = Some(status),
                        Ok(None) => {}
                        Err(err) => {
                            crate::app_log!(
                                "[RCSTRM] child_poll_failed pid={} err={}",
                                child_id,
                                err
                            );
                        }
                    }
                } else {
                    return;
                }
            }

            if let Some(status) = exited {
                let exit_code = status
                    .code()
                    .map(|c| c.to_string())
                    .unwrap_or_else(|| "unknown".to_string());
                stream_debug(
                    stream_debug_on,
                    &format!("child_exit_detected pid={} status={}", child_id, exit_code),
                );

                // Wait briefly for stdout/stderr relay threads to flush final buffered lines
                // before emitting the terminal exit event. Without this, the UI can observe
                // "completed" before the final assistant message chunks arrive.
                for _ in 0..40 {
                    if stdout_done_for_wait.load(Ordering::SeqCst)
                        && stderr_done_for_wait.load(Ordering::SeqCst)
                    {
                        break;
                    }
                    thread::sleep(std::time::Duration::from_millis(50));
                }

                let terminal_status = {
                    finalize_run_state_if_ready(
                        &app_handle,
                        &session_id_for_wait,
                        &auth_token_for_wait,
                    )
                };

                {
                    let app_state = app_handle.state::<AgentState>();
                    let mut children = app_state.children.lock().unwrap();
                    children.remove(&child_id);
                    let mut sessions = app_state.sessions.lock().unwrap();
                    sessions.remove(&session_id_for_wait);
                    let mut tokens = app_state.session_tokens.lock().unwrap();
                    tokens.remove(&session_id_for_wait);
                    let mut run_states = app_state.run_states.lock().unwrap();
                    run_states.remove(&session_id_for_wait);
                }

                let payload = serde_json::json!({
                    "agent_id": child_id,
                    "type": "exit",
                    "data": format!("Process finished with code {}", exit_code),
                    "status": terminal_status,
                    "stream_seq": stream_seq.fetch_add(1, Ordering::SeqCst) + 1,
                    "stream_source": "tauri_exit"
                });
                emit_agent_event(&app_handle, &session_id_for_wait, &payload);
                return;
            }

            thread::sleep(std::time::Duration::from_millis(250));
        }
    });

    Ok(child_id)
}

#[tauri::command]
#[specta::specta]
pub async fn start_agent_run(
    app: AppHandle,
    _state: State<'_, AgentState>,
    intent: StartAgentRunIntent,
) -> Result<StartAgentRunResponse, String> {
    let telemetry = app.state::<crate::db::TelemetryDb>();
    let preview = crate::git_workspace::preview_agent_worktree(
        intent.repo_path.clone(),
        intent.assistant_node_id.clone(),
        intent.parent_commit.clone(),
    )
    .await?;
    let initial_run = crate::db::AgentRunLedgerUpsert {
        run_id: intent.run_id.clone(),
        user_node_id: run_ledger_user_node_id_from_context(&intent.run_context),
        assistant_node_id: intent.assistant_node_id.clone(),
        workspace_id: intent.workspace_id.clone(),
        repo_path: Some(intent.repo_path.clone()),
        worktree_path: Some(preview.worktree_path.clone()),
        branch_name: Some(preview.branch_name.clone()),
        parent_commit: Some(intent.parent_commit.clone()),
        pid: None,
        agent_type: Some(intent.agent_type.clone()),
        status: "accepted".to_string(),
        phase: "accepted".to_string(),
    };
    telemetry.upsert_agent_run_ledger(&initial_run)?;
    telemetry.append_agent_run_event(
        &intent.run_id,
        &intent.assistant_node_id,
        "agent:lifecycle",
        Some("accepted"),
        Some("accepted"),
        &serde_json::json!({
            "type": "agent:lifecycle",
            "status": "accepted",
            "phase": "accepted",
            "run_id": intent.run_id.clone(),
            "nodeId": intent.assistant_node_id.clone(),
        })
        .to_string(),
    )?;

    let app_for_run = app.clone();
    let run_id_for_response = intent.run_id.clone();
    let assistant_id_for_response = intent.assistant_node_id.clone();
    thread::spawn(move || {
        if let Err(err) = run_agent_lifecycle_background(app_for_run.clone(), intent) {
            crate::app_log!(
                "[AGENT_WORKTREE] event=start_agent_run.background_error err={}",
                err
            );
        }
    });

    Ok(StartAgentRunResponse {
        run_id: run_id_for_response,
        assistant_node_id: assistant_id_for_response,
        worktree_path: preview.worktree_path,
        branch_name: preview.branch_name,
        pid: None,
        initial_status: "accepted".to_string(),
    })
}

fn run_agent_lifecycle_background(
    app: AppHandle,
    intent: StartAgentRunIntent,
) -> Result<(), String> {
    let telemetry = app.state::<crate::db::TelemetryDb>();
    let worktree =
        match tauri::async_runtime::block_on(crate::git_workspace::create_agent_worktree(
            app.clone(),
            intent.repo_path.clone(),
            intent.assistant_node_id.clone(),
            intent.parent_commit.clone(),
            Some(intent.run_id.clone()),
            intent.workspace_id.clone(),
            Some(intent.agent_type.clone()),
        )) {
            Ok(worktree) => worktree,
            Err(err) => {
                let _ = telemetry.update_agent_run_phase(
                    &intent.assistant_node_id,
                    "failed_setup",
                    "failed_setup",
                    Some(&err),
                );
                let _ = finalize_setup_failure(&app, &intent, "failed_setup", &err);
                return Err(err);
            }
        };

    let mut run_context = intent.run_context.clone();
    run_context.run_id = intent.run_id.clone();
    run_context.repo_path = Some(intent.repo_path.clone());
    run_context.parent_commit = Some(intent.parent_commit.clone());
    run_context.git_branch_name = Some(worktree.branch_name.clone());
    if let Some(object) = run_context.execution_data.as_object_mut() {
        object.insert(
            "workspace_id".to_string(),
            serde_json::json!(intent.workspace_id),
        );
        let meta = object
            .entry("meta".to_string())
            .or_insert_with(|| JsonValue::Object(JsonMap::new()));
        if let Some(meta_object) = meta.as_object_mut() {
            meta_object.insert(
                "git_worktree_path".to_string(),
                serde_json::json!(worktree.worktree_path.clone()),
            );
            meta_object.insert(
                "git_branch_name".to_string(),
                serde_json::json!(worktree.branch_name.clone()),
            );
            meta_object.insert(
                "base_commit_sha".to_string(),
                serde_json::json!(intent.parent_commit.clone()),
            );
        }
    }

    let agent_state = app.state::<AgentState>();
    match spawn_agent_internal(
        app.clone(),
        &agent_state,
        intent.agent_type.clone(),
        worktree.worktree_path.clone(),
        intent.args.clone(),
        intent.assistant_node_id.clone(),
        intent.auth_token.clone(),
        intent.trace_id.clone(),
        Some(run_context),
    ) {
        Ok(_) => Ok(()),
        Err(err) => {
            let _ = telemetry.update_agent_run_phase(
                &intent.assistant_node_id,
                "failed_spawn",
                "failed_spawn",
                Some(&err),
            );
            let _ = finalize_setup_failure(&app, &intent, "failed_spawn", &err);
            cleanup_worktree_after_finalize(
                &app,
                &intent.assistant_node_id,
                Some(intent.repo_path.clone()),
                "cleanup_after_spawn_failure",
            );
            Err(err)
        }
    }
}

fn finalize_setup_failure(
    app: &AppHandle,
    intent: &StartAgentRunIntent,
    status: &str,
    failure_reason: &str,
) -> Result<(), String> {
    let mut execution_data = intent.run_context.execution_data.clone();
    if let Some(object) = execution_data.as_object_mut() {
        object.insert("ended_at".to_string(), serde_json::json!(chrono_like_now()));
        object.insert("setup_error".to_string(), serde_json::json!(failure_reason));
        object.insert(
            "last_terminal_status".to_string(),
            serde_json::json!(status),
        );
    }
    let payload = serde_json::json!({
        "nodeId": intent.assistant_node_id,
        "runId": intent.run_id,
        "status": status,
        "finalContent": "",
        "executionData": execution_data,
        "outputCommitSha": JsonValue::Null,
        "gitBranchName": JsonValue::Null,
    });
    let client = reqwest::blocking::Client::new();
    post_json_with_retry(
        &client,
        &intent.auth_token,
        &format!("{}/stream/finalize", crate::config::server_base_url()),
        &payload,
        4,
        "setup_finalize",
    )?;
    app.state::<crate::db::TelemetryDb>()
        .mark_agent_run_finalized(&intent.assistant_node_id, status, true, None)?;
    Ok(())
}

fn chrono_like_now() -> String {
    format!("{}", unix_timestamp_millis())
}

#[tauri::command]
#[specta::specta]
pub fn stop_agent(
    _app: AppHandle,
    state: State<AgentState>,
    session_id: String,
) -> Result<(), String> {
    let pid = {
        let sessions = state.sessions.lock().map_err(|e| e.to_string())?;
        sessions.get(&session_id).copied()
    };

    let Some(pid) = pid else {
        return Err(format!("No agent session found for {}", session_id));
    };

    if let Some(run_state) = state
        .run_states
        .lock()
        .map_err(|e| e.to_string())?
        .get(&session_id)
        .cloned()
    {
        let mut run_state = run_state.lock().map_err(|e| e.to_string())?;
        run_state.cancel_requested = true;
        if run_state.terminal_status.is_none() {
            run_state.terminal_status = Some("cancelled".to_string());
        }
    }

    let mut children = state.children.lock().map_err(|e| e.to_string())?;
    if let Some(child) = children.get_mut(&pid) {
        let mut terminated = false;
        #[cfg(unix)]
        {
            let pid_i32 = pid as i32;
            unsafe {
                libc::kill(pid_i32, libc::SIGTERM);
            }
            for _ in 0..20 {
                if let Ok(Some(_)) = child.try_wait() {
                    terminated = true;
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(150));
            }
        }
        if !terminated {
            if let Err(err) = child.kill() {
                let _ = child.wait();
                return Err(err.to_string());
            }
            let _ = child.wait();
        }
        drop(children);
        for _ in 0..80 {
            let active = state
                .sessions
                .lock()
                .map_err(|e| e.to_string())?
                .contains_key(&session_id);
            if !active {
                return Ok(());
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        Err(format!(
            "Timed out waiting for agent {} to stop cleanly",
            session_id
        ))
    } else {
        Err(format!("No running process found for pid {}", pid))
    }
}

#[tauri::command]
#[specta::specta]
pub fn get_agent_run_state(
    app: AppHandle,
    state: State<AgentState>,
    assistant_node_id: String,
) -> Result<crate::db::AgentRunStateResponse, String> {
    let pid = {
        let sessions = state.sessions.lock().map_err(|e| e.to_string())?;
        sessions
            .get(&assistant_node_id)
            .copied()
            .map(|value| value as i64)
    };
    let ledger = app
        .state::<crate::db::TelemetryDb>()
        .get_agent_run_ledger_by_assistant(&assistant_node_id)?;
    Ok(crate::db::AgentRunStateResponse {
        ledger,
        running: pid.is_some(),
        pid,
    })
}

#[cfg(test)]
mod tests {
    use super::{
        ai_label_from_execution_data, cleanup_requires_server_final_persisted,
        cleanup_terminal_status_allows_cleanup, commit_message_for_snapshot,
        commit_subject_from_execution_data, local_node_payload_for_snapshot,
        run_ledger_user_node_id_from_context, update_run_state_from_event, AgentRunContext,
        AgentRunSnapshot, AgentRunState,
    };
    use serde_json::json;

    fn test_run_state() -> AgentRunState {
        AgentRunState::new(AgentRunContext {
            run_id: "run-1".to_string(),
            execution_data: json!({}),
            git_branch_name: None,
            repo_path: None,
            parent_commit: None,
            author_name: None,
            prompt_fallback: None,
        })
    }

    fn test_snapshot(execution_data: serde_json::Value, final_content: &str) -> AgentRunSnapshot {
        AgentRunSnapshot {
            node_id: "assistant-1234567890".to_string(),
            run_id: "run-1".to_string(),
            status: "completed".to_string(),
            final_content: final_content.to_string(),
            execution_data,
            prompt_tokens: None,
            completion_tokens: None,
            total_tokens: None,
            output_commit_sha: None,
            git_branch_name: None,
            repo_path: None,
            parent_commit: None,
            author_name: None,
        }
    }

    #[test]
    fn cleanup_blocks_non_terminal_statuses() {
        assert!(!cleanup_terminal_status_allows_cleanup("running"));
        assert!(!cleanup_terminal_status_allows_cleanup(
            "preparing_worktree"
        ));
        assert!(cleanup_terminal_status_allows_cleanup("completed"));
        assert!(cleanup_terminal_status_allows_cleanup("failed_setup"));
    }

    #[test]
    fn cleanup_requires_durable_server_finalization_for_completed_runs_only() {
        assert!(cleanup_requires_server_final_persisted("completed"));
        assert!(!cleanup_requires_server_final_persisted("failed"));
        assert!(!cleanup_requires_server_final_persisted("cancelled"));
        assert!(!cleanup_requires_server_final_persisted("failed_spawn"));
    }

    #[test]
    fn local_node_snapshot_payload_persists_selected_model_metadata() {
        let snapshot = test_snapshot(
            json!({
                "workspace_id": "workspace-1",
                "parentId": "user-1",
                "meta": {
                    "llmModel": "openai/gpt-5.5-high",
                    "provider_model": "openai/gpt-5.5-high",
                    "provider_selected_provider": "codex"
                }
            }),
            "final answer",
        );

        let payload = local_node_payload_for_snapshot(&snapshot, "workspace-1");

        assert_eq!(payload["llmModel"], "openai/gpt-5.5-high");
        assert_eq!(payload["llmProvider"], "codex");
        assert_eq!(
            payload["execution_data"]["meta"]["provider_model"],
            "openai/gpt-5.5-high"
        );
    }

    #[test]
    fn run_ledger_user_node_id_comes_from_assistant_parent_id() {
        let context = AgentRunContext {
            run_id: "run-1".to_string(),
            execution_data: json!({
                "parentId": "user-1",
                "meta": {
                    "context_parent_node_id": "assistant-before-user"
                }
            }),
            git_branch_name: None,
            repo_path: None,
            parent_commit: None,
            author_name: None,
            prompt_fallback: None,
        };

        assert_eq!(
            run_ledger_user_node_id_from_context(&context).as_deref(),
            Some("user-1")
        );
    }

    #[test]
    fn commit_subject_comes_from_runtime_metadata() {
        let execution_data = json!({
            "meta": {
                "commit_subject": "  `Add structured commit subjects.`  "
            }
        });

        assert_eq!(
            commit_subject_from_execution_data(&execution_data).as_deref(),
            Some("Add structured commit subjects")
        );
        assert_eq!(
            commit_message_for_snapshot(&test_snapshot(execution_data, "Implemented the feature."))
                .as_str(),
            "Add structured commit subjects"
        );
    }

    #[test]
    fn commit_message_falls_back_to_final_content_not_user_prompt() {
        let message = commit_message_for_snapshot(&test_snapshot(
            json!({ "meta": {} }),
            "Implemented local commit subject handling and verified adapters.",
        ));

        assert_eq!(
            message.as_str(),
            "Implemented local commit subject handling"
        );
    }

    #[test]
    fn ai_label_comes_from_runtime_metadata() {
        let execution_data = json!({
            "meta": {
                "ai_label": "  `Structured Label Generation.`  "
            }
        });

        assert_eq!(
            ai_label_from_execution_data(&execution_data).as_deref(),
            Some("Structured Label Generation")
        );
    }

    #[test]
    fn message_deltas_preserve_newlines_in_content_and_timeline() {
        let mut state = test_run_state();
        update_run_state_from_event(
            &mut state,
            &json!({"type": "message_delta", "delta": "first\n", "timestamp": 1}),
        );
        update_run_state_from_event(
            &mut state,
            &json!({"type": "message_delta", "delta": "\nsecond", "timestamp": 2}),
        );

        assert_eq!(state.content, "first\n\nsecond");
        assert_eq!(state.timeline.len(), 1);
        assert_eq!(state.timeline[0]["content"], "first\n\nsecond");
    }

    #[test]
    fn provider_final_content_replaces_interim_message_snapshots_in_timeline() {
        let mut state = test_run_state();
        update_run_state_from_event(
            &mut state,
            &json!({"type": "message_completed", "content": "Working on the fix.", "timestamp": 1}),
        );
        update_run_state_from_event(
            &mut state,
            &json!({"type": "message_completed", "content": "Working on the fix. Checking tests.", "timestamp": 2}),
        );
        update_run_state_from_event(
            &mut state,
            &json!({"type": "provider_stop", "provider_status": "completed", "final_content": "Implemented.\n\nVerification passed.", "timestamp": 3}),
        );

        let message_events: Vec<_> = state
            .timeline
            .iter()
            .filter(|event| event["type"] == "message")
            .collect();
        assert_eq!(state.content, "Implemented.\n\nVerification passed.");
        assert_eq!(message_events.len(), 1);
        assert_eq!(
            message_events[0]["content"],
            "Implemented.\n\nVerification passed."
        );
    }

    #[test]
    fn tool_output_deltas_append_to_existing_tool_use_without_extra_rows() {
        let mut state = test_run_state();
        update_run_state_from_event(
            &mut state,
            &json!({
                "type": "tool_use",
                "id": "tool-1",
                "name": "commandExecution",
                "input": {"command": "printf 'a\\nb\\n'"},
                "timestamp": 1
            }),
        );
        update_run_state_from_event(
            &mut state,
            &json!({"type": "tool_output_delta", "toolUseId": "tool-1", "delta": "a\n", "timestamp": 2}),
        );
        update_run_state_from_event(
            &mut state,
            &json!({"type": "tool_output_delta", "toolUseId": "tool-1", "delta": "b\n", "timestamp": 3}),
        );

        assert_eq!(state.timeline.len(), 1);
        assert_eq!(state.timeline[0]["toolOutput"], "a\nb\n");
    }
}
