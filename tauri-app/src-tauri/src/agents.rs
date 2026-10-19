#[cfg(unix)]
use libc;
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use serde_json::{Map as JsonMap, Value as JsonValue};
use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader, Write};
#[cfg(unix)]
use std::os::unix::process::CommandExt;
use std::path::Path;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, State};

const AGENT_RUN_WATCHDOG_IDLE_TIMEOUT_MS: i64 = 10 * 60 * 1000;
const AGENT_RUN_WATCHDOG_POLL_INTERVAL_MS: u64 = 30 * 1000;
const AGENT_RUN_ACTIVITY_PERSIST_INTERVAL_MS: i64 = 60 * 1000;

static AGENT_RUN_ACTIVITY_PERSISTED_AT: Lazy<Mutex<HashMap<String, i64>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

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
    #[serde(default)]
    pub auth_user_id: Option<String>,
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
    auth_user_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct AgentRunWatchdogDecision {
    timed_out: bool,
    idle_ms: i64,
    reason: Option<String>,
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
        finalization_durable: bool,
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
    pub current_user_id: String,
    pub trace_id: Option<String>,
    pub run_context: AgentRunContext,
    #[serde(rename = "loginProfileId", default)]
    pub login_profile_id: Option<String>,
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
    failure_reason: Option<String>,
    provider_thread_id: Option<String>,
    provider_turn_id: Option<String>,
    active_message_item_id: Option<String>,
    final_content_override: Option<String>,
    cancel_requested: bool,
    finalized: bool,
    last_activity_at_ms: i64,
    last_activity_label: String,
    watchdog_timeout_requested: bool,
}

impl AgentRunState {
    fn new(context: AgentRunContext) -> Self {
        let now_ms = unix_timestamp_millis();
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
            failure_reason: None,
            provider_thread_id: None,
            provider_turn_id: None,
            active_message_item_id: None,
            final_content_override: None,
            cancel_requested: false,
            finalized: false,
            last_activity_at_ms: now_ms,
            last_activity_label: "run_state_created".to_string(),
            watchdog_timeout_requested: false,
        }
    }
}

pub struct AgentState {
    pub children: Mutex<HashMap<u32, Child>>,
    pub sessions: Mutex<HashMap<String, u32>>,
    pub stdins: Mutex<HashMap<String, Arc<Mutex<ChildStdin>>>>,
    pub session_tokens: Mutex<HashMap<String, String>>,
    pub run_states: Mutex<HashMap<String, Arc<Mutex<AgentRunState>>>>,
}

// AgentEvent struct removed - events are now constructed inline using serde_json::json!

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

fn unix_millis_to_rfc3339(ms: i64) -> String {
    chrono::DateTime::<chrono::Utc>::from_timestamp_millis(ms)
        .unwrap_or_else(chrono::Utc::now)
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn is_terminal_runtime_status(status: &str) -> bool {
    matches!(
        status,
        "completed"
            | "failed"
            | "cancelled"
            | "error"
            | "failed_setup"
            | "failed_spawn"
            | "failed_finalization"
            | "failed_runtime"
    )
}

fn terminal_status_for_runtime_activity<'a>(
    event_type: &str,
    status: Option<&'a str>,
) -> Option<&'a str> {
    let status = status.filter(|value| is_terminal_runtime_status(value))?;
    match event_type {
        "agent:lifecycle" | "finalize_ack" | "provider_stop" | "stop" => Some(status),
        _ => None,
    }
}

fn maybe_persist_agent_run_activity(
    app_handle: &AppHandle,
    session_id: &str,
    event_type: &str,
    event_timestamp_ms: i64,
    status: Option<&str>,
) {
    let terminal_status = terminal_status_for_runtime_activity(event_type, status);
    let should_persist = terminal_status.is_some() || event_type == "finalize_ack" || {
        let mut persisted_at = AGENT_RUN_ACTIVITY_PERSISTED_AT.lock().unwrap();
        let last = persisted_at.get(session_id).copied().unwrap_or(0);
        if event_timestamp_ms.saturating_sub(last) < AGENT_RUN_ACTIVITY_PERSIST_INTERVAL_MS {
            false
        } else {
            persisted_at.insert(session_id.to_string(), event_timestamp_ms);
            true
        }
    };
    if !should_persist {
        return;
    }
    if terminal_status.is_some() {
        AGENT_RUN_ACTIVITY_PERSISTED_AT
            .lock()
            .unwrap()
            .remove(session_id);
    }

    let last_event_at = unix_millis_to_rfc3339(event_timestamp_ms);
    if let Err(err) = app_handle
        .state::<crate::db::TelemetryDb>()
        .update_local_node_runtime_activity(session_id, &last_event_at, event_type, terminal_status)
    {
        crate::app_log!(
            "[RCSTRM] activity_persist_failed session_id={} event_type={} err={}",
            session_id,
            event_type,
            err
        );
    }
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

fn agent_id_from_execution_data(execution_data: &JsonValue) -> Option<String> {
    execution_data
        .get("agent_id")
        .or_else(|| execution_data.get("agentId"))
        .and_then(|value| value.as_str())
        .filter(|value| !value.trim().is_empty())
        .map(|value| value.to_string())
        .or_else(|| string_from_execution_meta(execution_data, "agent_id"))
        .or_else(|| string_from_execution_meta(execution_data, "agentId"))
        .or_else(|| string_from_execution_meta(execution_data, "selected_agent_id"))
        .or_else(|| string_from_execution_meta(execution_data, "selectedAgentId"))
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
        login_profile_id: string_from_execution_meta(&context.execution_data, "login_profile_id"),
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

pub(crate) fn emit_agent_event(
    app_handle: &AppHandle,
    session_id: &str,
    event: &serde_json::Value,
) {
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
        let status = event
            .get("status")
            .and_then(|value| value.as_str())
            .map(str::to_string);
        let runtime_status = event
            .get("provider_status")
            .and_then(|value| value.as_str())
            .or(status.as_deref())
            .map(str::to_string);
        let phase = event
            .get("phase")
            .and_then(|value| value.as_str())
            .map(str::to_string);
        let payload = event.to_string();
        if let Ok(seq) = app_handle
            .state::<crate::db::TelemetryDb>()
            .append_agent_run_event(
                &ledger.run_id,
                session_id,
                &event_type,
                status.as_deref(),
                phase.as_deref(),
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
        let event_timestamp_ms = event
            .get("timestamp")
            .and_then(|value| value.as_i64())
            .unwrap_or_else(unix_timestamp_millis);
        maybe_persist_agent_run_activity(
            app_handle,
            session_id,
            &event_type,
            event_timestamp_ms,
            runtime_status.as_deref(),
        );
    }
    let payload = serde_json::json!({
        "nodeId": session_id,
        "event": event,
    });
    let _ = app_handle.emit("agent:event", payload);
}

pub(crate) fn apply_and_emit_agent_event(
    app_handle: &AppHandle,
    session_id: &str,
    event: &serde_json::Value,
) {
    let run_state = {
        let app_state = app_handle.state::<AgentState>();
        let run_states = app_state.run_states.lock().unwrap();
        run_states.get(session_id).cloned()
    };
    if let Some(run_state) = run_state {
        let mut run_state = run_state.lock().unwrap();
        update_run_state_from_event(&mut run_state, event);
    }
    emit_agent_event(app_handle, session_id, event);
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
    is_terminal_runtime_status(status)
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
    let requires_server_finalization = cleanup_requires_server_final_persisted(terminal_status)
        && telemetry.workspace_cloud_backup_enabled(ledger.workspace_id.as_deref())?;
    let has_retryable_terminal_sync = !ledger.server_final_persisted
        && requires_server_finalization
        && telemetry.has_retryable_terminal_node_sync(node_id)?;
    if !ledger.server_final_persisted
        && requires_server_finalization
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
    if !crate::git_workspace::is_agent_worktree_path_for_node(repo_path, node_id, &worktree_path)? {
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
    if let Some(sandbox_path) =
        crate::command_guards::cleanup_agent_sandbox(node_id, Path::new(&worktree_path))?
    {
        crate::app_log!(
            "[AGENT_WORKTREE] event=cleanup.sandbox_removed node_id={} path={}",
            node_id,
            sandbox_path.display()
        );
    }
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
    let run_state_handle = {
        let app_state = app_handle.state::<AgentState>();
        let run_states = app_state.run_states.lock().unwrap();
        run_states.get(session_id).cloned()
    }?;

    let mut run_state = run_state_handle.lock().unwrap();
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
                finalization_durable,
            }) => {
                let _ = telemetry.mark_agent_run_finalized(
                    session_id,
                    &finalize_ack.status,
                    finalization_durable,
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
                if let Ok(mut run_state) = run_state_handle.lock() {
                    run_state.finalized = false;
                }
                if let Err(persist_err) = persist_local_node_snapshot(app_handle, snapshot) {
                    crate::app_log!(
                        "[RCSTRM] finalize_failed_snapshot_persist_failed session_id={} err={}",
                        session_id,
                        persist_err
                    );
                }
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

fn terminate_agent_child(
    state: &AgentState,
    session_id: &str,
    pid: u32,
    wait_for_session_removal: bool,
) -> Result<(), String> {
    let mut children = state.children.lock().map_err(|e| e.to_string())?;
    if let Some(child) = children.get_mut(&pid) {
        let mut terminated = false;
        #[cfg(unix)]
        {
            let pid_i32 = pid as i32;
            unsafe {
                if libc::kill(-pid_i32, libc::SIGTERM) != 0 {
                    libc::kill(pid_i32, libc::SIGTERM);
                }
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
        if wait_for_session_removal {
            for _ in 0..80 {
                let active = state
                    .sessions
                    .lock()
                    .map_err(|e| e.to_string())?
                    .contains_key(session_id);
                if !active {
                    return Ok(());
                }
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
            return Err(format!(
                "Timed out waiting for agent {} to stop cleanly",
                session_id
            ));
        }
        Ok(())
    } else {
        Err(format!("No running process found for pid {}", pid))
    }
}

pub fn start_agent_run_watchdog(app_handle: AppHandle) {
    thread::spawn(move || loop {
        thread::sleep(Duration::from_millis(AGENT_RUN_WATCHDOG_POLL_INTERVAL_MS));
        let now_ms = unix_timestamp_millis();
        {
            match recover_terminal_agent_runs_from_journal(&app_handle) {
                Ok(count) if count > 0 => {
                    crate::app_log!(
                        "[AGENT_WATCHDOG] event=terminal_journal_replay.recovered count={}",
                        count
                    );
                }
                Err(err) => {
                    crate::app_log!(
                        "[AGENT_WATCHDOG] event=terminal_journal_replay.failed err={}",
                        err
                    );
                }
                _ => {}
            }
            let telemetry = app_handle.state::<crate::db::TelemetryDb>();
            match telemetry.reconcile_stale_prelaunch_local_nodes(60, "watchdog") {
                Ok(count) if count > 0 => {
                    crate::app_log!(
                        "[AGENT_WATCHDOG] event=prelaunch_local_failed_setup count={}",
                        count
                    );
                }
                Err(err) => {
                    crate::app_log!(
                        "[AGENT_WATCHDOG] event=prelaunch_local_reconcile_failed err={}",
                        err
                    );
                }
                _ => {}
            }
        }
        let sessions = {
            let state = app_handle.state::<AgentState>();
            let sessions = match state.sessions.lock() {
                Ok(sessions) => sessions.clone(),
                Err(err) => {
                    crate::app_log!("[AGENT_WATCHDOG] event=sessions_lock_failed err={}", err);
                    continue;
                }
            };
            sessions
        };

        for (session_id, pid) in sessions {
            let decision = {
                let state = app_handle.state::<AgentState>();
                let run_state = match state.run_states.lock() {
                    Ok(run_states) => run_states.get(&session_id).cloned(),
                    Err(err) => {
                        crate::app_log!(
                            "[AGENT_WATCHDOG] event=run_states_lock_failed node_id={} err={}",
                            session_id,
                            err
                        );
                        None
                    }
                };
                let Some(run_state) = run_state else {
                    continue;
                };
                let mut run_state = match run_state.lock() {
                    Ok(run_state) => run_state,
                    Err(err) => {
                        crate::app_log!(
                            "[AGENT_WATCHDOG] event=run_state_lock_failed node_id={} err={}",
                            session_id,
                            err
                        );
                        continue;
                    }
                };
                let decision = decide_agent_run_watchdog_timeout(
                    run_state.last_activity_at_ms,
                    now_ms,
                    AGENT_RUN_WATCHDOG_IDLE_TIMEOUT_MS,
                    run_state.terminal_status.as_deref(),
                    run_state.finalized,
                    run_state.watchdog_timeout_requested,
                    &run_state.last_activity_label,
                );
                if decision.timed_out {
                    run_state.watchdog_timeout_requested = true;
                    run_state.terminal_status = Some("failed_runtime".to_string());
                    if let Some(reason) = decision.reason.as_deref().and_then(clean_failure_reason)
                    {
                        run_state.failure_reason = Some(reason.clone());
                        run_state.stop_reason = Some(reason);
                    }
                    run_state
                        .meta
                        .insert("native_watchdog_timeout".to_string(), JsonValue::Bool(true));
                    run_state.meta.insert(
                        "native_watchdog_idle_ms".to_string(),
                        JsonValue::from(decision.idle_ms),
                    );
                }
                decision
            };

            if !decision.timed_out {
                continue;
            }
            let reason = decision.reason.unwrap_or_else(|| {
                "Agent run timed out after producing no runtime events.".to_string()
            });
            crate::app_log!(
                "[AGENT_WATCHDOG] event=timeout node_id={} pid={} idle_ms={} reason={}",
                session_id,
                pid,
                decision.idle_ms,
                reason
            );
            let payload = serde_json::json!({
                "type": "watchdog:timeout",
                "status": "failed_runtime",
                "phase": "timed_out",
                "pid": pid,
                "idle_ms": decision.idle_ms,
                "reason": reason,
                "timestamp": now_ms,
                "stream_source": "tauri_watchdog",
            });
            emit_agent_event(&app_handle, &session_id, &payload);
            let telemetry = app_handle.state::<crate::db::TelemetryDb>();
            let _ = telemetry.update_agent_run_phase(
                &session_id,
                "failed_runtime",
                "timed_out",
                payload.get("reason").and_then(|value| value.as_str()),
            );
            let state = app_handle.state::<AgentState>();
            if let Err(err) = terminate_agent_child(&*state, &session_id, pid, false) {
                crate::app_log!(
                    "[AGENT_WATCHDOG] event=terminate_failed node_id={} pid={} err={}",
                    session_id,
                    pid,
                    err
                );
            }
        }
    });
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

fn arg_value<'a>(args: &'a [String], flag: &str) -> Option<&'a str> {
    args.windows(2)
        .find(|window| window.first().map(String::as_str) == Some(flag))
        .and_then(|window| window.get(1))
        .map(String::as_str)
}

pub(crate) fn codex_chatgpt_session_supports_model(model: Option<&str>) -> bool {
    matches!(
        model,
        None | Some("gpt-5.6-sol") | Some("gpt-5.6-terra") | Some("gpt-5.6-luna") | Some("gpt-5.5")
    )
}

fn append_message_timeline_segment_for_item(
    run_state: &mut AgentRunState,
    text: &str,
    timestamp: i64,
    provider_item_id: Option<&str>,
) {
    if text.is_empty() {
        return;
    }
    if let Some(last_event) = run_state.timeline.last_mut() {
        if last_event.get("type").and_then(|value| value.as_str()) == Some("message") {
            let prior_provider_item_id = last_event
                .get("provider_item_id")
                .and_then(|value| value.as_str());
            let prior_provider_item_missing = prior_provider_item_id.is_none();
            if (prior_provider_item_id.is_some()
                && provider_item_id.is_some()
                && prior_provider_item_id != provider_item_id)
                || (prior_provider_item_id.is_none() && provider_item_id.is_some())
            {
                run_state.timeline.push(serde_json::json!({
                    "type": "message",
                    "timestamp": timestamp,
                    "content": text,
                    "provider_item_id": provider_item_id,
                }));
                return;
            }
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
                if prior_provider_item_missing {
                    if let Some(provider_item_id) = provider_item_id {
                        object.insert(
                            "provider_item_id".to_string(),
                            JsonValue::String(provider_item_id.to_string()),
                        );
                    }
                }
            }
            return;
        }
    }
    run_state.timeline.push(serde_json::json!({
        "type": "message",
        "timestamp": timestamp,
        "content": text,
        "provider_item_id": provider_item_id,
    }));
}

fn replace_message_timeline_with_final_content(
    run_state: &mut AgentRunState,
    final_content: &str,
    timestamp: i64,
    provider_item_id: Option<&str>,
) {
    if provider_item_id.is_none() {
        run_state
            .timeline
            .retain(|event| event.get("type").and_then(|value| value.as_str()) != Some("message"));
        append_message_timeline_segment_for_item(run_state, final_content, timestamp, None);
        return;
    }
    let target_index = if let Some(provider_item_id) = provider_item_id {
        run_state.timeline.iter().rposition(|event| {
            event.get("type").and_then(|value| value.as_str()) == Some("message")
                && event
                    .get("provider_item_id")
                    .and_then(|value| value.as_str())
                    == Some(provider_item_id)
        })
    } else {
        run_state.timeline.iter().rposition(|event| {
            event.get("type").and_then(|value| value.as_str()) == Some("message")
        })
    };
    let Some(index) = target_index else {
        append_message_timeline_segment_for_item(
            run_state,
            final_content,
            timestamp,
            provider_item_id,
        );
        return;
    };
    if final_content.is_empty() {
        run_state.timeline.remove(index);
        return;
    }
    if let Some(object) = run_state.timeline[index].as_object_mut() {
        object.insert("timestamp".to_string(), JsonValue::from(timestamp));
        object.insert(
            "content".to_string(),
            JsonValue::String(final_content.to_string()),
        );
        if let Some(provider_item_id) = provider_item_id {
            object.insert(
                "provider_item_id".to_string(),
                JsonValue::String(provider_item_id.to_string()),
            );
        }
    }
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
            "isDelta": event.get("isDelta").cloned()
                .or_else(|| event.get("is_delta").cloned())
                .unwrap_or(JsonValue::Bool(false)),
        })),
        "user_steer_requested" => Some(serde_json::json!({
            "type": "user_steer_requested",
            "timestamp": timestamp,
            "content": event.get("content").cloned().unwrap_or(JsonValue::Null),
            "idempotency_key": event.get("idempotency_key").cloned().unwrap_or(JsonValue::Null),
        })),
        "artifact_registered" => {
            let artifact = event.get("artifact")?;
            if !artifact.is_object() {
                return None;
            }
            Some(serde_json::json!({
                "type": "tool_result",
                "timestamp": timestamp,
                "toolName": "show_output",
                "toolOutput": artifact.get("title").cloned()
                    .or_else(|| artifact.get("filename").cloned())
                    .or_else(|| artifact.get("kind").cloned())
                    .unwrap_or(JsonValue::String("output preview".to_string())),
                "isError": false,
                "toolUseId": artifact.get("id").cloned().unwrap_or(JsonValue::Null),
            }))
        }
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

fn clean_failure_reason(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(trimmed.chars().take(500).collect())
}

fn should_persist_failure_reason(status: &str) -> bool {
    matches!(
        status,
        "failed"
            | "error"
            | "failed_setup"
            | "failed_spawn"
            | "failed_finalization"
            | "failed_runtime"
    )
}

fn decide_agent_run_watchdog_timeout(
    last_activity_at_ms: i64,
    now_ms: i64,
    timeout_ms: i64,
    terminal_status: Option<&str>,
    finalized: bool,
    timeout_requested: bool,
    last_activity_label: &str,
) -> AgentRunWatchdogDecision {
    let idle_ms = now_ms.saturating_sub(last_activity_at_ms);
    if terminal_status.is_some() || finalized || timeout_requested || idle_ms < timeout_ms {
        return AgentRunWatchdogDecision {
            timed_out: false,
            idle_ms,
            reason: None,
        };
    }
    AgentRunWatchdogDecision {
        timed_out: true,
        idle_ms,
        reason: Some(format!(
            "Agent run produced no runtime events for {} seconds; last activity was {}.",
            idle_ms / 1000,
            last_activity_label
        )),
    }
}

fn update_run_state_from_event(run_state: &mut AgentRunState, event: &JsonValue) {
    if let Some(stream_seq) = event.get("stream_seq").and_then(|value| value.as_u64()) {
        run_state.last_stream_seq = Some(stream_seq);
    }

    let Some(event_type) = event.get("type").and_then(|value| value.as_str()) else {
        return;
    };
    run_state.last_activity_at_ms = unix_timestamp_millis();
    run_state.last_activity_label = event_type.to_string();
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
                let provider_item_id = event
                    .get("provider_item_id")
                    .and_then(|value| value.as_str());
                if let Some(provider_item_id) = provider_item_id {
                    run_state.active_message_item_id = Some(provider_item_id.to_string());
                }
                append_message_timeline_segment_for_item(
                    run_state,
                    delta,
                    timestamp,
                    provider_item_id,
                );
            }
        }
        "message_completed" | "message" => {
            if let Some(content) = event.get("content").and_then(|value| value.as_str()) {
                let merged = merge_text_output(&run_state.content, content);
                let appended = derive_incremental_text(&run_state.content, &merged);
                run_state.content = merged;
                let provider_item_id = event
                    .get("provider_item_id")
                    .and_then(|value| value.as_str());
                if let Some(provider_item_id) = provider_item_id {
                    run_state.active_message_item_id = Some(provider_item_id.to_string());
                }
                append_message_timeline_segment_for_item(
                    run_state,
                    &appended,
                    timestamp,
                    provider_item_id,
                );
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
        "error" | "stderr" => {
            if let Some(reason) = event
                .get("data")
                .or_else(|| event.get("content"))
                .and_then(|value| value.as_str())
                .and_then(clean_failure_reason)
            {
                run_state.failure_reason = Some(reason);
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
        "artifact_registered" => {
            if let Some(artifact) = event.get("artifact").cloned().filter(JsonValue::is_object) {
                crate::artifacts::upsert_artifact_in_execution_data(
                    &mut run_state.context.execution_data,
                    artifact,
                );
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
                let provider_item_id = event
                    .get("provider_item_id")
                    .and_then(|value| value.as_str())
                    .map(str::to_string)
                    .or_else(|| run_state.active_message_item_id.clone());
                replace_message_timeline_with_final_content(
                    run_state,
                    final_content,
                    timestamp,
                    provider_item_id.as_deref(),
                );
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
    if should_persist_failure_reason(&status) {
        if let Some(failure_reason) = run_state
            .failure_reason
            .as_deref()
            .or(run_state.stop_reason.as_deref())
            .and_then(clean_failure_reason)
        {
            execution_object.insert(
                "failure_reason".to_string(),
                JsonValue::String(failure_reason),
            );
        }
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
        auth_user_id: run_state.context.auth_user_id.clone(),
    })
}

fn execution_data_from_local_payload(payload: Option<String>) -> JsonValue {
    let Some(payload) = payload else {
        return JsonValue::Object(JsonMap::new());
    };
    let Ok(payload) = serde_json::from_str::<JsonValue>(&payload) else {
        return JsonValue::Object(JsonMap::new());
    };
    payload
        .get("execution_data")
        .cloned()
        .filter(JsonValue::is_object)
        .unwrap_or_else(|| JsonValue::Object(JsonMap::new()))
}

fn ensure_context_recovery_fields(
    execution_data: &mut JsonValue,
    workspace_id: Option<&str>,
    parent_id: Option<&str>,
) {
    if !execution_data.is_object() {
        *execution_data = JsonValue::Object(JsonMap::new());
    }
    let has_workspace_id = workspace_id_from_execution_data(execution_data).is_some();
    let has_parent_id = parent_id_from_execution_data(execution_data).is_some();
    let object = execution_data
        .as_object_mut()
        .expect("execution_data must be object");
    if !has_workspace_id {
        if let Some(workspace_id) = workspace_id.filter(|value| !value.trim().is_empty()) {
            object.insert(
                "workspace_id".to_string(),
                JsonValue::String(workspace_id.to_string()),
            );
        }
    }
    if !has_parent_id {
        if let Some(parent_id) = parent_id.filter(|value| !value.trim().is_empty()) {
            object.insert(
                "parentId".to_string(),
                JsonValue::String(parent_id.to_string()),
            );
        }
    }
}

fn snapshot_from_replayed_journal(
    ledger: &crate::db::AgentRunLedgerRow,
    events: &[crate::db::AgentRunJournalEvent],
    execution_data: JsonValue,
    prompt_fallback: Option<String>,
) -> Option<AgentRunSnapshot> {
    let mut run_state = AgentRunState::new(AgentRunContext {
        run_id: ledger.run_id.clone(),
        execution_data,
        git_branch_name: ledger.branch_name.clone(),
        repo_path: ledger.repo_path.clone(),
        parent_commit: ledger.parent_commit.clone(),
        author_name: None,
        prompt_fallback,
        auth_user_id: None,
    });
    for event in events {
        if let Ok(payload) = serde_json::from_str::<JsonValue>(&event.payload) {
            update_run_state_from_event(&mut run_state, &payload);
        }
    }
    run_state.terminal_status.as_ref()?;
    build_finalize_snapshot(&mut run_state, &ledger.assistant_node_id)
}

pub fn recover_terminal_agent_runs_from_journal(app_handle: &AppHandle) -> Result<usize, String> {
    let telemetry = app_handle.state::<crate::db::TelemetryDb>();
    let candidates = telemetry.list_terminal_journal_recovery_candidates()?;
    let mut recovered = 0usize;

    for ledger in candidates {
        let agent_state = app_handle.state::<AgentState>();
        let sessions = agent_state.sessions.lock();
        if sessions
            .as_ref()
            .map(|sessions| sessions.contains_key(&ledger.assistant_node_id))
            .unwrap_or(false)
        {
            continue;
        }
        drop(sessions);

        let mut execution_data = execution_data_from_local_payload(
            telemetry.get_local_node_payload(&ledger.assistant_node_id)?,
        );
        ensure_context_recovery_fields(
            &mut execution_data,
            ledger.workspace_id.as_deref(),
            ledger.user_node_id.as_deref(),
        );
        let prompt_fallback = ledger.user_node_id.as_deref().and_then(|user_node_id| {
            telemetry
                .get_local_node_payload(user_node_id)
                .ok()
                .flatten()
                .and_then(|payload| serde_json::from_str::<JsonValue>(&payload).ok())
                .and_then(|payload| {
                    payload
                        .get("content")
                        .and_then(|value| value.as_str())
                        .filter(|value| !value.trim().is_empty())
                        .map(|value| value.to_string())
                })
        });
        let events = telemetry.list_agent_run_events_after(&ledger.run_id, 0)?;
        let Some(mut snapshot) =
            snapshot_from_replayed_journal(&ledger, &events, execution_data, prompt_fallback)
        else {
            continue;
        };

        crate::app_log!(
            "[AGENT_RECOVERY] event=terminal_journal_replay.start node_id={} run_id={} status={}",
            ledger.assistant_node_id,
            ledger.run_id,
            snapshot.status
        );
        let _ = telemetry.increment_agent_run_finalize_attempt(&ledger.assistant_node_id);
        let _ = telemetry.update_agent_run_phase(
            &ledger.assistant_node_id,
            "finalizing",
            "finalizing_recovered_terminal_journal",
            None,
        );
        match finalize_run_snapshot(app_handle, &mut snapshot, "") {
            Ok(FinalizeRunSnapshotOutcome::QueuedForRetry {
                finalize_ack,
                upload_error,
                finalization_durable,
            }) => {
                telemetry.mark_agent_run_finalized(
                    &ledger.assistant_node_id,
                    &finalize_ack.status,
                    finalization_durable,
                    finalize_ack.output_commit_sha.as_deref(),
                )?;
                cleanup_worktree_after_finalize(
                    app_handle,
                    &ledger.assistant_node_id,
                    snapshot.repo_path.clone(),
                    "cleanup_after_terminal_journal_recovery",
                );
                emit_finalize_ack(app_handle, &ledger.assistant_node_id, &finalize_ack);
                update_local_session_status(
                    app_handle,
                    &ledger.assistant_node_id,
                    &snapshot.status,
                    snapshot.repo_path.as_deref(),
                );
                recovered += 1;
                crate::app_log!(
                    "[AGENT_RECOVERY] event=terminal_journal_replay.recovered node_id={} run_id={} err={}",
                    ledger.assistant_node_id,
                    ledger.run_id,
                    upload_error
                );
            }
            Err(err) => {
                if let Err(persist_err) = persist_local_node_snapshot(app_handle, &snapshot) {
                    crate::app_log!(
                        "[AGENT_RECOVERY] event=terminal_journal_replay.snapshot_persist_failed node_id={} err={}",
                        ledger.assistant_node_id,
                        persist_err
                    );
                }
                let _ = telemetry.update_agent_run_phase(
                    &ledger.assistant_node_id,
                    "failed_finalization",
                    "failed_finalization",
                    Some(&err),
                );
                let _ = telemetry.mark_agent_run_needs_user_action(
                    &ledger.assistant_node_id,
                    "Recovered terminal journal, but native finalization failed; cleanup is blocked.",
                );
                crate::app_log!(
                    "[AGENT_RECOVERY] event=terminal_journal_replay.failed node_id={} run_id={} err={}",
                    ledger.assistant_node_id,
                    ledger.run_id,
                    err
                );
            }
        }
    }

    Ok(recovered)
}

const STARTUP_RESUME_PROMPT: &str = "Continue the interrupted run.";

fn string_from_json(value: &JsonValue, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(|entry| entry.as_str())
        .filter(|entry| !entry.trim().is_empty())
        .map(|entry| entry.to_string())
}

fn string_from_event_payload(payload: &JsonValue, key: &str) -> Option<String> {
    string_from_json(payload, key).or_else(|| {
        payload
            .get("meta")
            .and_then(|meta| string_from_json(meta, key))
    })
}

fn latest_provider_thread_id(
    events: &[crate::db::AgentRunJournalEvent],
    execution_data: &JsonValue,
) -> Option<String> {
    for event in events.iter().rev() {
        let Ok(payload) = serde_json::from_str::<JsonValue>(&event.payload) else {
            continue;
        };
        if let Some(thread_id) = string_from_event_payload(&payload, "provider_thread_id")
            .or_else(|| string_from_json(&payload, "session_id"))
        {
            return Some(thread_id);
        }
    }
    string_from_execution_meta(execution_data, "provider_thread_id")
        .or_else(|| string_from_execution_meta(execution_data, "agent_session_id"))
}

fn latest_provider_arg_value(
    events: &[crate::db::AgentRunJournalEvent],
    execution_data: &JsonValue,
    keys: &[&str],
) -> Option<String> {
    for event in events.iter().rev() {
        let Ok(payload) = serde_json::from_str::<JsonValue>(&event.payload) else {
            continue;
        };
        for key in keys {
            if let Some(value) = string_from_event_payload(&payload, key) {
                return Some(value);
            }
        }
    }
    keys.iter()
        .find_map(|key| string_from_execution_meta(execution_data, key))
}

fn startup_resume_args(
    agent_type: &str,
    assistant_node_id: &str,
    provider_thread_id: &str,
    events: &[crate::db::AgentRunJournalEvent],
    execution_data: &JsonValue,
) -> Vec<String> {
    let mut args = Vec::new();
    if let Some(model) = latest_provider_arg_value(
        events,
        execution_data,
        &["provider_model", "llmModel", "model"],
    ) {
        args.extend(["--model".to_string(), model]);
    }
    if let Some(reasoning_effort) = latest_provider_arg_value(
        events,
        execution_data,
        &["provider_reasoning_effort", "reasoning_effort"],
    ) {
        args.push(if agent_type == "claude" {
            "--effort".to_string()
        } else {
            "--reasoning-effort".to_string()
        });
        args.push(reasoning_effort);
    }
    if let Some(permission_mode) = latest_provider_arg_value(
        events,
        execution_data,
        &["provider_run_mode", "permission_mode"],
    ) {
        args.extend(["--permission-mode".to_string(), permission_mode]);
    }
    args.extend([
        "--provider-thread-strategy".to_string(),
        "resume".to_string(),
        "--provider-thread-id".to_string(),
        provider_thread_id.to_string(),
        "--node-id".to_string(),
        assistant_node_id.to_string(),
        STARTUP_RESUME_PROMPT.to_string(),
    ]);
    args
}

pub fn resume_interrupted_agent_runs_on_startup(app_handle: &AppHandle) -> Result<usize, String> {
    let telemetry = app_handle.state::<crate::db::TelemetryDb>();
    let candidates = telemetry.list_startup_resume_candidates()?;
    let mut resumed = 0usize;

    for ledger in candidates {
        let agent_state = app_handle.state::<AgentState>();
        let sessions = agent_state.sessions.lock();
        if sessions
            .as_ref()
            .map(|sessions| sessions.contains_key(&ledger.assistant_node_id))
            .unwrap_or(false)
        {
            continue;
        }
        drop(sessions);

        let Some(agent_type) = ledger.agent_type.as_deref() else {
            continue;
        };
        let Some(repo_path) = ledger.repo_path.as_deref() else {
            continue;
        };
        let Some(worktree_path) = ledger.worktree_path.as_deref() else {
            continue;
        };
        let Some(login_profile_id) = ledger.login_profile_id.clone() else {
            continue;
        };

        let mut execution_data = execution_data_from_local_payload(
            telemetry.get_local_node_payload(&ledger.assistant_node_id)?,
        );
        ensure_context_recovery_fields(
            &mut execution_data,
            ledger.workspace_id.as_deref(),
            ledger.user_node_id.as_deref(),
        );
        if let Some(object) = execution_data.as_object_mut() {
            let meta = object
                .entry("meta".to_string())
                .or_insert_with(|| JsonValue::Object(JsonMap::new()));
            if let Some(meta_object) = meta.as_object_mut() {
                if let Some(branch_name) = ledger.branch_name.as_deref() {
                    meta_object.insert(
                        "git_branch_name".to_string(),
                        JsonValue::String(branch_name.to_string()),
                    );
                }
                meta_object.insert(
                    "git_worktree_path".to_string(),
                    JsonValue::String(worktree_path.to_string()),
                );
            }
        }

        let events = telemetry.list_agent_run_events_after(&ledger.run_id, 0)?;
        let Some(provider_thread_id) = latest_provider_thread_id(&events, &execution_data) else {
            continue;
        };
        let args = startup_resume_args(
            agent_type,
            &ledger.assistant_node_id,
            &provider_thread_id,
            &events,
            &execution_data,
        );
        let run_context = AgentRunContext {
            run_id: ledger.run_id.clone(),
            execution_data,
            git_branch_name: ledger.branch_name.clone(),
            repo_path: ledger.repo_path.clone(),
            parent_commit: ledger.parent_commit.clone(),
            author_name: None,
            prompt_fallback: Some(STARTUP_RESUME_PROMPT.to_string()),
            auth_user_id: None,
        };

        telemetry.mark_agent_run_startup_resuming(&ledger.assistant_node_id)?;
        telemetry.append_agent_run_event(
            &ledger.run_id,
            &ledger.assistant_node_id,
            "agent:lifecycle",
            Some("running"),
            Some("resuming_provider_thread"),
            &serde_json::json!({
                "type": "agent:lifecycle",
                "status": "running",
                "phase": "resuming_provider_thread",
                "run_id": ledger.run_id.clone(),
                "nodeId": ledger.assistant_node_id.clone(),
                "provider_thread_id": provider_thread_id.clone(),
                "resume_prompt": STARTUP_RESUME_PROMPT,
            })
            .to_string(),
        )?;

        crate::app_log!(
            "[AGENT_RECOVERY] event=startup_provider_resume.start node_id={} run_id={} agent_type={} provider_thread_id={}",
            ledger.assistant_node_id,
            ledger.run_id,
            agent_type,
            provider_thread_id
        );
        let worktree_config = match crate::worktree_config::load_agent_worktree_config(repo_path) {
            Ok(config) => config,
            Err(err) => {
                let _ = telemetry.update_agent_run_phase(
                    &ledger.assistant_node_id,
                    "needs_user_action",
                    "needs_user_action",
                    Some(&err),
                );
                let _ = telemetry.mark_agent_run_needs_user_action(
                    &ledger.assistant_node_id,
                    "App restarted before this run reached a terminal state, and automatic provider-thread resume failed.",
                );
                crate::app_log!(
                    "[AGENT_RECOVERY] event=startup_provider_resume.config_failed node_id={} run_id={} err={}",
                    ledger.assistant_node_id,
                    ledger.run_id,
                    err
                );
                continue;
            }
        };
        match spawn_agent_internal(
            app_handle.clone(),
            &agent_state,
            agent_type.to_string(),
            worktree_path.to_string(),
            args,
            ledger.assistant_node_id.clone(),
            String::new(),
            None,
            Some(login_profile_id),
            Some(run_context),
            worktree_config,
        ) {
            Ok(_) => {
                resumed += 1;
            }
            Err(err) => {
                let _ = telemetry.update_agent_run_phase(
                    &ledger.assistant_node_id,
                    "needs_user_action",
                    "needs_user_action",
                    Some(&err),
                );
                let _ = telemetry.mark_agent_run_needs_user_action(
                    &ledger.assistant_node_id,
                    "App restarted before this run reached a terminal state, and automatic provider-thread resume failed.",
                );
                crate::app_log!(
                    "[AGENT_RECOVERY] event=startup_provider_resume.failed node_id={} run_id={} err={}",
                    ledger.assistant_node_id,
                    ledger.run_id,
                    err
                );
            }
        }
    }

    Ok(resumed)
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
        "agent_id": agent_id_from_execution_data(&snapshot.execution_data),
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

fn bool_from_execution_meta(execution_data: &JsonValue, key: &str) -> bool {
    execution_data
        .get("meta")
        .and_then(|value| value.get(key))
        .and_then(|value| value.as_bool())
        .unwrap_or(false)
}

fn is_insight_run_execution_data(execution_data: &JsonValue) -> bool {
    bool_from_execution_meta(execution_data, "agentree_insight_run")
}

fn insight_stage_from_execution_data(execution_data: &JsonValue) -> String {
    string_from_execution_meta(execution_data, "insight_stage")
        .unwrap_or_else(|| "validate".to_string())
}

fn insight_parent_node_id_from_execution_data(execution_data: &JsonValue) -> Option<String> {
    string_from_execution_meta(execution_data, "insight_parent_node_id")
        .or_else(|| parent_id_from_execution_data(execution_data))
}

fn extract_json_from_agent_text(content: &str) -> Option<JsonValue> {
    if let Ok(value) = serde_json::from_str::<JsonValue>(content.trim()) {
        return Some(value);
    }
    let trimmed = content.trim();
    let start = trimmed.find('[').or_else(|| trimmed.find('{'))?;
    let end = trimmed.rfind(']').or_else(|| trimmed.rfind('}'))?;
    if end <= start {
        return None;
    }
    serde_json::from_str::<JsonValue>(&trimmed[start..=end]).ok()
}

fn insight_candidates_for_snapshot(snapshot: &AgentRunSnapshot) -> Vec<JsonValue> {
    let Some(parsed) = extract_json_from_agent_text(&snapshot.final_content) else {
        return Vec::new();
    };
    let raw_candidates = if let Some(array) = parsed.as_array() {
        array.clone()
    } else if let Some(array) = parsed.get("candidates").and_then(|value| value.as_array()) {
        array.clone()
    } else if let Some(array) = parsed.get("insights").and_then(|value| value.as_array()) {
        array.clone()
    } else {
        Vec::new()
    };
    raw_candidates.into_iter().take(8).collect()
}

fn persist_insights_for_snapshot(
    app_handle: &AppHandle,
    snapshot: &AgentRunSnapshot,
) -> Result<usize, String> {
    if snapshot.status != "completed" {
        return Ok(0);
    }
    if insight_stage_from_execution_data(&snapshot.execution_data) != "validate" {
        return Ok(0);
    }
    let workspace_id = workspace_id_from_execution_data(&snapshot.execution_data)
        .ok_or_else(|| "Missing workspace_id for insight run.".to_string())?;
    let parent_node_id = insight_parent_node_id_from_execution_data(&snapshot.execution_data)
        .ok_or_else(|| "Missing parent node id for insight run.".to_string())?;
    let candidates = insight_candidates_for_snapshot(snapshot);
    let telemetry = app_handle.state::<crate::db::TelemetryDb>();
    let observation_summary = snapshot
        .final_content
        .split_whitespace()
        .take(80)
        .collect::<Vec<_>>()
        .join(" ");
    let trigger_class =
        string_from_execution_meta(&snapshot.execution_data, "insight_trigger_class")
            .unwrap_or_else(|| "light".to_string());
    let trigger_reason =
        string_from_execution_meta(&snapshot.execution_data, "insight_trigger_reason")
            .unwrap_or_else(|| "light_assistant_completed".to_string());
    let (candidate_count, surfaced_count) = telemetry
        .persist_background_insight_candidates_for_user(
            &workspace_id,
            snapshot.auth_user_id.as_deref(),
            &parent_node_id,
            &snapshot.node_id,
            &trigger_class,
            &trigger_reason,
            snapshot.prompt_tokens,
            snapshot.completion_tokens,
            snapshot.total_tokens,
            candidates,
            &observation_summary,
        )?;
    crate::app_log!(
        "[INSIGHTS] event=background_candidates_persisted node_id={} candidates={} surfaced={}",
        snapshot.node_id,
        candidate_count,
        surfaced_count
    );
    Ok(surfaced_count)
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

fn normalize_commit_message_body(value: &str) -> Option<String> {
    let normalized = value
        .replace("\r\n", "\n")
        .replace('\r', "\n")
        .split("\n\n")
        .map(|paragraph| {
            paragraph
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ")
                .trim_matches(|ch| ch == '"' || ch == '\'' || ch == '`')
                .to_string()
        })
        .filter(|paragraph| !paragraph.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n")
        .trim()
        .trim_matches(|ch| ch == '"' || ch == '\'' || ch == '`')
        .to_string();
    if normalized.is_empty() {
        return None;
    }
    Some(
        normalized
            .chars()
            .take(1200)
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

fn commit_body_from_execution_data(execution_data: &JsonValue) -> Option<String> {
    execution_data
        .get("meta")
        .and_then(|value| value.as_object())
        .and_then(|meta| {
            meta.get("commit_body")
                .or_else(|| meta.get("agent_commit_body"))
                .or_else(|| meta.get("runtime_commit_body"))
        })
        .and_then(|value| value.as_str())
        .and_then(normalize_commit_message_body)
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
    let subject = commit_subject_from_execution_data(&snapshot.execution_data)
        .or_else(|| normalize_commit_message_fallback(Some(snapshot.final_content.as_str())))
        .unwrap_or_else(|| {
            format!(
                "Update {}",
                &snapshot.node_id[..snapshot.node_id.len().min(8)]
            )
        });
    match commit_body_from_execution_data(&snapshot.execution_data) {
        Some(body) => format!("{subject}\n\n{body}"),
        None => subject,
    }
}

fn should_create_worktree_commit_for_snapshot(snapshot: &AgentRunSnapshot) -> bool {
    snapshot.status == "completed" || snapshot.status == "cancelled"
}

fn worktree_commit_message_for_snapshot(snapshot: &AgentRunSnapshot) -> String {
    if snapshot.status == "cancelled" {
        return format!("Cancelled run snapshot: {}", snapshot.node_id);
    }
    commit_message_for_snapshot(snapshot)
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

/// Whether the AI merge was launched with the opt-in to advance the real target
/// branch onto the merge commit. Defaults to false, so a merge never moves a
/// branch or working tree unless the user explicitly asked for it.
fn merge_update_target_branch_from_execution_data(execution_data: &JsonValue) -> bool {
    execution_data
        .get("meta")
        .and_then(|value| value.as_object())
        .and_then(|meta| meta.get("merge_update_target_branch"))
        .and_then(|value| value.as_bool())
        .unwrap_or(false)
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
        let output_commits = if source_kind == "agent" {
            match crate::git_workspace::read_commit_metadata_range_sync(
                repo_path,
                parent_commit,
                &commit_sha,
            ) {
                Ok(mut commits) => {
                    if !commits.iter().any(|metadata| metadata.sha == commit_sha) {
                        commits.push(commit.clone());
                    }
                    commits
                }
                Err(err) => {
                    crate::app_log!(
                        "[AGENT_WORKTREE] event=commit_range_read_failed node_id={} base_commit={} output_commit={} err={}",
                        snapshot.node_id,
                        parent_commit,
                        commit_sha,
                        err
                    );
                    vec![commit.clone()]
                }
            }
        } else {
            vec![commit.clone()]
        };
        let local_commits = output_commits
            .into_iter()
            .map(|metadata| {
                let is_output_tip = metadata.sha == commit_sha;
                let subject = if is_output_tip {
                    commit_subject.clone()
                } else if metadata.subject.trim().is_empty() {
                    "Agent changes".to_string()
                } else {
                    metadata.subject.clone()
                };
                let parents = if is_output_tip && metadata.parents.is_empty() {
                    vec![parent_commit.to_string()]
                } else {
                    metadata.parents.clone()
                };

                crate::db::LocalCommitImport {
                    sha: metadata.sha,
                    parents,
                    subject: Some(subject),
                    author_name: metadata
                        .author_name
                        .clone()
                        .or_else(|| snapshot.author_name.clone()),
                    author_email: metadata.author_email.clone(),
                    authored_at: metadata
                        .authored_at
                        .clone()
                        .or_else(|| Some(fallback_timestamp.clone())),
                    committed_at: metadata
                        .authored_at
                        .clone()
                        .or_else(|| Some(fallback_timestamp.clone())),
                    source_kind: Some(source_kind.to_string()),
                    produced_by_node_id: Some(snapshot.node_id.clone()),
                    files_changed_count: metadata.files_changed_count.map(|value| value as i64).or(
                        if is_output_tip {
                            Some(files_changed_count)
                        } else {
                            None
                        },
                    ),
                    total_additions: metadata.total_additions.map(|value| value as i64),
                    total_deletions: metadata.total_deletions.map(|value| value as i64),
                }
            })
            .collect::<Vec<_>>();
        let _ = app_handle
            .state::<crate::db::TelemetryDb>()
            .import_local_commits_with_parent_closure(
                &workspace_id,
                local_commits,
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

    if should_create_worktree_commit_for_snapshot(snapshot) {
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
                let commit_message = worktree_commit_message_for_snapshot(snapshot);
                let source_commits =
                    merge_source_commits_from_execution_data(&snapshot.execution_data);
                let target_branch =
                    merge_target_branch_from_execution_data(&snapshot.execution_data);
                let update_target_branch =
                    merge_update_target_branch_from_execution_data(&snapshot.execution_data);
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
                        update_target_branch,
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
                    let commit_message = worktree_commit_message_for_snapshot(snapshot);
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
    if is_insight_run_execution_data(&snapshot.execution_data) {
        let insight_count = persist_insights_for_snapshot(app_handle, snapshot)?;
        crate::app_log!(
            "[INSIGHTS] event=local_insight_run_finalized node_id={} status={} insights={}",
            snapshot.node_id,
            snapshot.status,
            insight_count
        );
        let telemetry = app_handle.state::<crate::db::TelemetryDb>();
        let finalize_ack = FinalizeAckPayload {
            run_id: snapshot.run_id.clone(),
            status: snapshot.status.clone(),
            persisted: false,
            output_commit_sha: snapshot.output_commit_sha.clone(),
            base_commit_sha: snapshot.parent_commit.clone(),
            commit_created,
        };
        store_finalize_ack(&telemetry, &snapshot.node_id, &finalize_ack);
        let workspace_id = workspace_id_from_execution_data(&snapshot.execution_data);
        let finalization_is_durable =
            !telemetry.workspace_cloud_backup_enabled(workspace_id.as_deref())?;
        return Ok(FinalizeRunSnapshotOutcome::QueuedForRetry {
            finalize_ack,
            upload_error: if finalization_is_durable {
                "local-only insight finalization".to_string()
            } else {
                "insight records queued for background sync".to_string()
            },
            finalization_durable: finalization_is_durable,
        });
    }
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
    let sync_event = telemetry
        .enqueue_local_sync_event_for_user(
            Some(workspace_id.as_str()),
            snapshot.auth_user_id.as_deref(),
            "node",
            &snapshot.node_id,
            "node.update_terminal",
            &payload_json,
            Some(&snapshot.run_id),
        )
        .map_err(|queue_err| {
            format!("failed to enqueue local terminal sync retry: {}", queue_err)
        })?;
    let finalization_is_durable = sync_event.status == "local_only";
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
        upload_error: if finalization_is_durable {
            "local-only finalization".to_string()
        } else {
            "queued for background sync".to_string()
        },
        finalization_durable: finalization_is_durable,
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
    login_profile_id: Option<String>,
    run_context: Option<AgentRunContext>,
    worktree_config: crate::worktree_config::AgentWorktreeConfig,
) -> Result<u32, String> {
    crate::app_log!(
        "[AGENT_WORKTREE] event=spawn.start node_id={} agent_type={} cwd={} has_run_context={}",
        session_id,
        agent_type,
        cwd,
        run_context.is_some()
    );
    let mut args = args;
    let mut program_override: Option<String> = None;
    if agent_type.as_str() == "codex" {
        let command = crate::runtime_scripts::codex_adapter_command(&app)?;
        for arg in command.args_prefix.into_iter().rev() {
            args.insert(0, arg);
        }
        program_override = Some(command.program);
    }
    if agent_type.as_str() == "claude" {
        let invocation = crate::managed_runtime::claude_adapter_invocation(&app)?;
        args.insert(0, invocation.adapter_script.to_string_lossy().into_owned());
        program_override = Some(invocation.node_program);
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
        "claude" => program_override
            .ok_or_else(|| "Claude adapter invocation was not resolved.".to_string())?,
        "codex" => {
            program_override.ok_or_else(|| "Codex adapter command was not resolved.".to_string())?
        }
        "bash" => crate::managed_runtime::node_program(&app)?,
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

    let base_mcp_url = crate::mcp::mcp_server_url();
    let mcp_url = if base_mcp_url.contains('?') {
        format!("{}&agentree_node_id={}", base_mcp_url, session_id)
    } else {
        format!("{}?agentree_node_id={}", base_mcp_url, session_id)
    };
    let mut command = Command::new(&program);
    let artifacts_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Could not resolve app data dir: {}", error))?
        .join("artifacts")
        .join(&session_id);
    std::fs::create_dir_all(&artifacts_dir).map_err(|error| {
        format!(
            "Could not create artifact directory {}: {}",
            artifacts_dir.display(),
            error
        )
    })?;
    command
        .args(&args)
        .current_dir(&cwd)
        .env("AGENTREE_MCP_URL", &mcp_url)
        .env("MCP_SERVER_URL", &mcp_url)
        .env("AGENTREE_ARTIFACTS_DIR", &artifacts_dir)
        .env("AGENTREE_TRACE_ID", trace_id.clone().unwrap_or_default())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    if agent_args_request_full_access(&args) {
        command.env("PATH", crate::command_guards::build_agent_path());
    } else {
        crate::command_guards::apply_agent_command_env_with_config(
            &mut command,
            &app,
            &session_id,
            Path::new(&cwd),
            &worktree_config,
        )?;
    }
    #[cfg(unix)]
    {
        command.process_group(0);
    }

    let mut codex_auth_state_to_persist: Option<(String, std::path::PathBuf)> = None;
    if let Some(profile_id) = login_profile_id.as_deref() {
        let telemetry = app.state::<crate::db::TelemetryDb>();
        let cache_dir = app
            .path()
            .app_cache_dir()
            .map_err(|error| format!("Could not resolve app cache dir: {}", error))?;
        let materialized = crate::login_profiles::resolve_runtime_credentials(
            &telemetry,
            &crate::login_profiles::KeyringCredentialVault,
            profile_id,
            cache_dir,
        )?;
        if materialized.provider != agent_type {
            return Err(format!(
                "Login profile {} is for {}, not {}",
                profile_id, materialized.provider, agent_type
            ));
        }
        if agent_type.as_str() == "codex" && materialized.auth_type == "codex_chatgpt_session" {
            let model = arg_value(&args, "--model");
            if !codex_chatgpt_session_supports_model(model) {
                return Err(format!(
                    "{} is not available through a Codex ChatGPT subscription. Use a Codex OpenAI API key profile to run this model.",
                    model.unwrap_or("This model")
                ));
            }
            if let Some(codex_home) = materialized.codex_home.clone() {
                codex_auth_state_to_persist = Some((profile_id.to_string(), codex_home));
            }
        }
        if agent_type.as_str() == "claude" && materialized.auth_type == "claude_oauth" {
            for key in [
                "ANTHROPIC_API_KEY",
                "ANTHROPIC_AUTH_TOKEN",
                "ANTHROPIC_BASE_URL",
                "ANTHROPIC_MODEL",
                "ANTHROPIC_DEFAULT_HAIKU_MODEL",
                "ANTHROPIC_DEFAULT_OPUS_MODEL",
                "ANTHROPIC_DEFAULT_SONNET_MODEL",
                "CLAUDE_CODE_OAUTH_TOKEN",
            ] {
                command.env_remove(key);
            }
        }
        for (key, value) in &materialized.env {
            command.env(key, value);
        }
    } else if agent_type.as_str() == "codex" {
        return Err(
            "Codex agent runs require an Agentree login profile; refusing to fall back to ~/.codex."
                .to_string(),
        );
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
                "[AGENT_WORKTREE] event=spawn.command_error node_id={} agent_type={} cwd={} program={} err={}",
                session_id,
                agent_type,
                cwd,
                program,
                err
            );
            return Err(err.to_string());
        }
    };

    let child_id = child.id();
    let child_stdin = child.stdin.take();
    let child_stdin = child_stdin.map(|stdin| Arc::new(Mutex::new(stdin)));
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
    if let Some(child_stdin) = child_stdin {
        state
            .stdins
            .lock()
            .unwrap()
            .insert(session_id.clone(), child_stdin);
    }
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
    let codex_auth_state_to_persist_for_wait = codex_auth_state_to_persist.clone();
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
                if let Some((profile_id, codex_home)) =
                    codex_auth_state_to_persist_for_wait.as_ref()
                {
                    let telemetry = app_handle.state::<crate::db::TelemetryDb>();
                    if let Err(error) = crate::login_profiles::persist_codex_auth_state(
                        &telemetry,
                        &crate::login_profiles::KeyringCredentialVault,
                        profile_id,
                        codex_home,
                    ) {
                        crate::app_log!(
                            "[AGENT_WORKTREE] event=codex_auth_state_persist_failed node_id={} profile_id={} err={}",
                            session_id_for_wait,
                            profile_id,
                            error
                        );
                    }
                }
                {
                    let app_state = app_handle.state::<AgentState>();
                    let mut children = app_state.children.lock().unwrap();
                    children.remove(&child_id);
                    let mut sessions = app_state.sessions.lock().unwrap();
                    sessions.remove(&session_id_for_wait);
                    let mut stdins = app_state.stdins.lock().unwrap();
                    stdins.remove(&session_id_for_wait);
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

fn agent_args_request_full_access(args: &[String]) -> bool {
    args.windows(2).any(|window| {
        window[0] == "--permission-mode"
            && (window[1] == "full-access" || window[1] == "bypassPermissions")
    })
}

#[tauri::command]
#[specta::specta]
pub async fn start_agent_run(
    app: AppHandle,
    _state: State<'_, AgentState>,
    intent: StartAgentRunIntent,
) -> Result<StartAgentRunResponse, String> {
    start_agent_run_internal(app, intent).await
}

pub(crate) async fn start_agent_run_internal(
    app: AppHandle,
    intent: StartAgentRunIntent,
) -> Result<StartAgentRunResponse, String> {
    let mut intent = intent;
    let telemetry = app.state::<crate::db::TelemetryDb>();
    let record_prelaunch_stage = |stage: &str| {
        if let Err(err) =
            telemetry.record_agent_prelaunch_stage(&intent.assistant_node_id, &intent.run_id, stage)
        {
            crate::app_log!(
                "[AGENT_PRELAUNCH] event=stage_persist_failed node_id={} run_id={} stage={} err={}",
                intent.assistant_node_id,
                intent.run_id,
                stage,
                err
            );
        }
    };
    record_prelaunch_stage("native_command_received");
    if let Some(workspace_id) = intent
        .workspace_id
        .as_deref()
        .filter(|value| !value.is_empty())
    {
        let trusted_repo_path = telemetry.resolve_trusted_local_workspace_repo_path(
            workspace_id,
            &intent.current_user_id,
            Some(intent.repo_path.as_str()),
        )?;
        intent.repo_path = trusted_repo_path;
    }
    if intent.agent_type == "codex" && intent.login_profile_id.is_none() {
        return Err(
            "Codex agent runs require an Agentree login profile; refusing to fall back to ~/.codex."
                .to_string(),
        );
    }
    record_prelaunch_stage("worktree_preview_started");
    let preview = crate::git_workspace::preview_agent_worktree(
        intent.repo_path.clone(),
        intent.assistant_node_id.clone(),
        intent.parent_commit.clone(),
    )
    .await?;
    record_prelaunch_stage("worktree_preview_completed");
    if let Some(profile_id) = intent.login_profile_id.as_deref() {
        let profile = telemetry.get_login_profile(profile_id)?;
        if profile.provider != intent.agent_type {
            return Err(format!(
                "Login profile {} is for {}, not {}",
                profile_id, profile.provider, intent.agent_type
            ));
        }
        intent.run_context.execution_data = crate::login_profiles::metadata_with_login_profile(
            intent.run_context.execution_data,
            &profile,
        );
    }
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
        login_profile_id: intent.login_profile_id.clone(),
    };
    let accepted_event_payload = serde_json::json!({
        "type": "agent:lifecycle",
        "status": "accepted",
        "phase": "accepted",
        "run_id": intent.run_id.clone(),
        "nodeId": intent.assistant_node_id.clone(),
    })
    .to_string();
    match telemetry.admit_agent_run(&initial_run, &accepted_event_payload)? {
        crate::db::AgentRunAdmission::Accepted => {}
        crate::db::AgentRunAdmission::Existing {
            worktree_path,
            branch_name,
            status,
            pid,
        } => {
            crate::app_log!(
                "[AGENT_PRELAUNCH] event=duplicate_start_reused node_id={} run_id={} status={}",
                intent.assistant_node_id,
                intent.run_id,
                status
            );
            return Ok(StartAgentRunResponse {
                run_id: intent.run_id,
                assistant_node_id: intent.assistant_node_id,
                worktree_path: worktree_path.unwrap_or(preview.worktree_path),
                branch_name: branch_name.unwrap_or(preview.branch_name),
                pid: pid.and_then(|value| u32::try_from(value).ok()),
                initial_status: status,
            });
        }
    }

    crate::mcp::set_mcp_current_context(&intent.auth_token, intent.workspace_id.as_deref())?;

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
    let worktree = match tauri::async_runtime::block_on(
        crate::git_workspace::create_agent_worktree(
            app.clone(),
            intent.repo_path.clone(),
            intent.assistant_node_id.clone(),
            intent.parent_commit.clone(),
            Some(intent.run_id.clone()),
            intent.workspace_id.clone(),
            Some(intent.agent_type.clone()),
        ),
    ) {
        Ok(worktree) => worktree,
        Err(err) => {
            let _ = telemetry.update_agent_run_phase(
                &intent.assistant_node_id,
                "failed_setup",
                "failed_setup",
                Some(&err),
            );
            if let Err(finalize_err) = finalize_setup_failure(&app, &intent, "failed_setup", &err) {
                crate::app_log!(
                        "[AGENT_WORKTREE] event=setup_failure_finalize_error node_id={} status=failed_setup err={}",
                        intent.assistant_node_id,
                        finalize_err
                    );
            }
            return Err(err);
        }
    };

    let mut run_context = intent.run_context.clone();
    run_context.run_id = intent.run_id.clone();
    run_context.repo_path = Some(intent.repo_path.clone());
    run_context.parent_commit = Some(intent.parent_commit.clone());
    run_context.git_branch_name = Some(worktree.branch_name.clone());
    run_context.auth_user_id = Some(intent.current_user_id.clone());
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
    let worktree_config = crate::worktree_config::load_agent_worktree_config(&intent.repo_path)?;
    match spawn_agent_internal(
        app.clone(),
        &agent_state,
        intent.agent_type.clone(),
        worktree.worktree_path.clone(),
        intent.args.clone(),
        intent.assistant_node_id.clone(),
        intent.auth_token.clone(),
        intent.trace_id.clone(),
        intent.login_profile_id.clone(),
        Some(run_context),
        worktree_config,
    ) {
        Ok(_) => Ok(()),
        Err(err) => {
            let _ = telemetry.update_agent_run_phase(
                &intent.assistant_node_id,
                "failed_spawn",
                "failed_spawn",
                Some(&err),
            );
            if let Err(finalize_err) = finalize_setup_failure(&app, &intent, "failed_spawn", &err) {
                crate::app_log!(
                    "[AGENT_WORKTREE] event=setup_failure_finalize_error node_id={} status=failed_spawn err={}",
                    intent.assistant_node_id,
                    finalize_err
                );
            }
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
    let telemetry = app.state::<crate::db::TelemetryDb>();
    let ledger_result =
        telemetry.mark_agent_run_finalized(&intent.assistant_node_id, status, false, None);
    let local_node_result = (|| {
        let existing_payload = telemetry
            .get_local_node_payload(&intent.assistant_node_id)?
            .and_then(|payload| serde_json::from_str::<JsonValue>(&payload).ok());
        let workspace_id = intent
            .workspace_id
            .clone()
            .or_else(|| workspace_id_from_execution_data(&intent.run_context.execution_data))
            .ok_or_else(|| {
                format!(
                    "Cannot persist {} for {} without a workspace id.",
                    status, intent.assistant_node_id
                )
            })?;
        let payload = local_node_payload_for_setup_failure(
            existing_payload,
            &intent.assistant_node_id,
            &workspace_id,
            &intent.run_context.execution_data,
            status,
            failure_reason,
        );
        telemetry.upsert_local_node(
            &intent.assistant_node_id,
            &workspace_id,
            &payload.to_string(),
        )
    })();

    // Live terminal delivery must not depend on either persistence layer. The
    // ledger and local node allow recovery; these events release the current UI.
    emit_agent_event(
        app,
        &intent.assistant_node_id,
        &serde_json::json!({
            "type": "error",
            "data": failure_reason,
            "phase": status,
        }),
    );
    emit_agent_event(
        app,
        &intent.assistant_node_id,
        &serde_json::json!({
            "type": "exit",
            "status": status,
            "reason": failure_reason,
            "phase": "terminal",
        }),
    );
    ledger_result?;
    local_node_result?;
    Ok(())
}

fn local_node_payload_for_setup_failure(
    existing_payload: Option<JsonValue>,
    assistant_node_id: &str,
    workspace_id: &str,
    run_execution_data: &JsonValue,
    status: &str,
    failure_reason: &str,
) -> JsonValue {
    let mut payload = existing_payload.unwrap_or_else(|| {
        serde_json::json!({
            "id": assistant_node_id,
            "workspaceId": workspace_id,
            "role": "assistant",
            "content": "",
        })
    });
    if !payload.is_object() {
        payload = JsonValue::Object(JsonMap::new());
    }

    let mut execution_data = payload
        .get("execution_data")
        .cloned()
        .unwrap_or_else(|| JsonValue::Object(JsonMap::new()));
    if !execution_data.is_object() {
        execution_data = JsonValue::Object(JsonMap::new());
    }
    merge_json_value(&mut execution_data, run_execution_data);
    let terminal_at = unix_millis_to_rfc3339(unix_timestamp_millis());
    if let Some(object) = execution_data.as_object_mut() {
        object.insert(
            "ended_at".to_string(),
            JsonValue::String(terminal_at.clone()),
        );
        object.insert(
            "last_terminal_status".to_string(),
            JsonValue::String(status.to_string()),
        );
        object.insert(
            "setup_error".to_string(),
            JsonValue::String(failure_reason.to_string()),
        );
        object.insert(
            "failure_reason".to_string(),
            JsonValue::String(failure_reason.to_string()),
        );
    }
    if let Some(object) = payload.as_object_mut() {
        object.insert(
            "id".to_string(),
            JsonValue::String(assistant_node_id.to_string()),
        );
        object.insert(
            "workspaceId".to_string(),
            JsonValue::String(workspace_id.to_string()),
        );
        object.insert(
            "role".to_string(),
            JsonValue::String("assistant".to_string()),
        );
        object
            .entry("content".to_string())
            .or_insert_with(|| JsonValue::String(String::new()));
        object.insert("status".to_string(), JsonValue::String(status.to_string()));
        object.insert("updatedAt".to_string(), JsonValue::String(terminal_at));
        object.insert("execution_data".to_string(), execution_data);
    }
    payload
}

fn chrono_like_now() -> String {
    format!("{}", unix_timestamp_millis())
}

#[tauri::command]
#[specta::specta]
pub fn steer_agent_run(
    app: AppHandle,
    state: State<AgentState>,
    assistant_node_id: String,
    content: String,
    idempotency_key: String,
) -> Result<(), String> {
    steer_agent_run_internal(&app, &state, &assistant_node_id, &content, &idempotency_key)
}

pub(crate) fn steer_agent_run_internal(
    app: &AppHandle,
    state: &AgentState,
    assistant_node_id: &str,
    content: &str,
    idempotency_key: &str,
) -> Result<(), String> {
    let content = content.trim().to_string();
    if content.is_empty() {
        return Err("Steering message cannot be empty.".to_string());
    }

    let stdin = {
        let stdins = state.stdins.lock().map_err(|e| e.to_string())?;
        stdins.get(assistant_node_id).cloned()
    };
    let Some(stdin) = stdin else {
        let failure = serde_json::json!({
            "type": "provider_steer_failed",
            "assistant_node_id": assistant_node_id.clone(),
            "idempotency_key": idempotency_key.clone(),
            "content": content.clone(),
            "error": "No active agent control channel found.",
        });
        emit_agent_event(app, assistant_node_id, &failure);
        return Err(format!(
            "No active agent control channel found for {}",
            assistant_node_id
        ));
    };

    let requested = serde_json::json!({
        "type": "user_steer_requested",
        "assistant_node_id": assistant_node_id.clone(),
        "idempotency_key": idempotency_key.clone(),
        "content": content.clone(),
    });
    if let Some(run_state) = state
        .run_states
        .lock()
        .map_err(|e| e.to_string())?
        .get(assistant_node_id)
        .cloned()
    {
        let mut run_state = run_state.lock().map_err(|e| e.to_string())?;
        update_run_state_from_event(&mut run_state, &requested);
    }
    emit_agent_event(app, assistant_node_id, &requested);

    let control = serde_json::json!({
        "type": "steer_agent_run",
        "control_type": "steer",
        "content": content.clone(),
        "idempotency_key": idempotency_key.clone(),
        "timestamp": unix_timestamp_millis(),
    });
    let mut line = control.to_string();
    line.push('\n');

    let write_result = {
        let mut stdin = stdin.lock().map_err(|e| e.to_string())?;
        stdin
            .write_all(line.as_bytes())
            .and_then(|_| stdin.flush())
            .map_err(|err| err.to_string())
    };

    match write_result {
        Ok(()) => {
            let ack = serde_json::json!({
                "type": "provider_steer_ack",
                "assistant_node_id": assistant_node_id.clone(),
                "idempotency_key": idempotency_key.clone(),
            });
            emit_agent_event(app, assistant_node_id, &ack);
            Ok(())
        }
        Err(err) => {
            let failure = serde_json::json!({
                "type": "provider_steer_failed",
                "assistant_node_id": assistant_node_id.clone(),
                "idempotency_key": idempotency_key.clone(),
                "content": content.clone(),
                "error": err.clone(),
            });
            emit_agent_event(app, assistant_node_id, &failure);
            Err(err)
        }
    }
}

#[tauri::command]
#[specta::specta]
pub fn stop_agent(
    app: AppHandle,
    state: State<AgentState>,
    session_id: String,
) -> Result<(), String> {
    stop_agent_with_descendants(&app, &state, &session_id).map(|_| ())
}

pub(crate) fn stop_agent_with_descendants(
    app: &AppHandle,
    state: &AgentState,
    session_id: &str,
) -> Result<Vec<String>, String> {
    let telemetry = app.state::<crate::db::TelemetryDb>();
    let workspace_id = telemetry
        .get_local_node_payload(session_id)?
        .and_then(|payload| serde_json::from_str::<JsonValue>(&payload).ok())
        .and_then(|payload| {
            payload
                .get("workspaceId")
                .or_else(|| payload.get("workspace_id"))
                .and_then(JsonValue::as_str)
                .map(str::to_string)
        })
        .ok_or_else(|| format!("Agent node {session_id} was not found."))?;
    // Freeze the controller before discovering descendants so it cannot accept
    // more thread-control calls while the descendant-first shutdown is running.
    mark_agent_cancel_requested(state, session_id)?;
    let rows = telemetry.list_local_nodes_for_workspace(&workspace_id)?;
    let mut children: HashMap<String, Vec<String>> = HashMap::new();
    for row in rows {
        let Some(controller_id) = row.controlled_by_node_id else {
            continue;
        };
        let Ok(payload) = serde_json::from_str::<JsonValue>(&row.payload) else {
            continue;
        };
        if payload.get("role").and_then(JsonValue::as_str) != Some("assistant") {
            continue;
        }
        children.entry(controller_id).or_default().push(row.node_id);
    }
    for child_ids in children.values_mut() {
        child_ids.sort();
    }
    let running: HashSet<String> = state
        .sessions
        .lock()
        .map_err(|error| error.to_string())?
        .keys()
        .cloned()
        .collect();
    let order = descendant_first_stop_order(session_id, &children, &running);
    if order.is_empty() {
        return Err(format!("No active agent sessions found for {session_id}"));
    }
    for node_id in &order {
        mark_agent_cancel_requested(state, node_id)?;
    }
    let mut errors = Vec::new();
    for node_id in &order {
        if let Err(error) = stop_agent_internal(state, node_id) {
            errors.push(format!("{node_id}: {error}"));
        }
    }
    if !errors.is_empty() {
        return Err(format!(
            "Failed to stop one or more agent sessions: {}",
            errors.join("; ")
        ));
    }
    Ok(order)
}

fn descendant_first_stop_order(
    session_id: &str,
    children: &HashMap<String, Vec<String>>,
    running: &HashSet<String>,
) -> Vec<String> {
    let mut descendants = Vec::new();
    let mut visiting = HashSet::new();
    fn visit(
        node_id: &str,
        depth: usize,
        children: &HashMap<String, Vec<String>>,
        visiting: &mut HashSet<String>,
        descendants: &mut Vec<(usize, String)>,
    ) {
        if !visiting.insert(node_id.to_string()) {
            return;
        }
        descendants.push((depth, node_id.to_string()));
        for child_id in children.get(node_id).into_iter().flatten() {
            visit(child_id, depth + 1, children, visiting, descendants);
        }
    }
    visit(session_id, 0, children, &mut visiting, &mut descendants);
    descendants.sort_by(|(left_depth, left_id), (right_depth, right_id)| {
        right_depth
            .cmp(left_depth)
            .then_with(|| left_id.cmp(right_id))
    });
    descendants
        .into_iter()
        .filter_map(|(_, node_id)| running.contains(&node_id).then_some(node_id))
        .collect()
}

pub(crate) fn stop_agent_internal(state: &AgentState, session_id: &str) -> Result<(), String> {
    let pid = {
        let sessions = state.sessions.lock().map_err(|e| e.to_string())?;
        sessions.get(session_id).copied()
    };

    let Some(pid) = pid else {
        return Err(format!("No agent session found for {}", session_id));
    };

    mark_agent_cancel_requested(state, session_id)?;

    terminate_agent_child(state, session_id, pid, true)
}

fn mark_agent_cancel_requested(state: &AgentState, session_id: &str) -> Result<(), String> {
    if let Some(run_state) = state
        .run_states
        .lock()
        .map_err(|e| e.to_string())?
        .get(session_id)
        .cloned()
    {
        let mut run_state = run_state.lock().map_err(|e| e.to_string())?;
        run_state.cancel_requested = true;
        if run_state.terminal_status.is_none() {
            run_state.terminal_status = Some("cancelled".to_string());
        }
    }
    Ok(())
}

pub(crate) fn session_auth_token(state: &AgentState, session_id: &str) -> Result<String, String> {
    let token = state
        .session_tokens
        .lock()
        .map_err(|error| error.to_string())?
        .get(session_id)
        .cloned()
        .ok_or_else(|| format!("No active agent session found for {}", session_id))?;
    if let Some(run_state) = state
        .run_states
        .lock()
        .map_err(|error| error.to_string())?
        .get(session_id)
        .cloned()
    {
        if run_state
            .lock()
            .map_err(|error| error.to_string())?
            .cancel_requested
        {
            return Err(format!("Agent session {} is stopping", session_id));
        }
    }
    Ok(token)
}

pub(crate) fn is_agent_session_running(
    state: &AgentState,
    session_id: &str,
) -> Result<bool, String> {
    Ok(state
        .sessions
        .lock()
        .map_err(|error| error.to_string())?
        .contains_key(session_id))
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
        ai_label_from_execution_data, arg_value, build_finalize_snapshot,
        cleanup_requires_server_final_persisted, cleanup_terminal_status_allows_cleanup,
        codex_chatgpt_session_supports_model, commit_body_from_execution_data,
        commit_message_for_snapshot, commit_subject_from_execution_data,
        decide_agent_run_watchdog_timeout, descendant_first_stop_order,
        ensure_context_recovery_fields, is_terminal_runtime_status, latest_provider_thread_id,
        local_node_payload_for_setup_failure, local_node_payload_for_snapshot,
        run_ledger_user_node_id_from_context, should_persist_failure_reason,
        snapshot_from_replayed_journal, startup_resume_args, terminal_status_for_runtime_activity,
        update_run_state_from_event, AgentRunContext, AgentRunSnapshot, AgentRunState,
        STARTUP_RESUME_PROMPT,
    };
    use serde_json::json;
    use std::collections::{HashMap, HashSet};

    fn test_run_state() -> AgentRunState {
        AgentRunState::new(AgentRunContext {
            run_id: "run-1".to_string(),
            execution_data: json!({}),
            git_branch_name: None,
            repo_path: None,
            parent_commit: None,
            author_name: None,
            prompt_fallback: None,
            auth_user_id: None,
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
            auth_user_id: None,
        }
    }

    #[test]
    fn cascade_stop_orders_deepest_running_descendants_before_controller() {
        let children = HashMap::from([
            (
                "root".to_string(),
                vec!["child-b".to_string(), "child-a".to_string()],
            ),
            ("child-a".to_string(), vec!["grandchild".to_string()]),
        ]);
        let running = HashSet::from([
            "root".to_string(),
            "child-a".to_string(),
            "child-b".to_string(),
            "grandchild".to_string(),
        ]);

        assert_eq!(
            descendant_first_stop_order("root", &children, &running),
            vec!["grandchild", "child-a", "child-b", "root"]
        );
    }

    #[test]
    fn cascade_stop_traverses_through_completed_controllers() {
        let children = HashMap::from([
            ("root".to_string(), vec!["completed-child".to_string()]),
            (
                "completed-child".to_string(),
                vec!["running-grandchild".to_string()],
            ),
        ]);
        let running = HashSet::from(["running-grandchild".to_string()]);

        assert_eq!(
            descendant_first_stop_order("root", &children, &running),
            vec!["running-grandchild"]
        );
    }

    #[test]
    fn cleanup_blocks_non_terminal_statuses() {
        assert!(!cleanup_terminal_status_allows_cleanup("running"));
        assert!(!cleanup_terminal_status_allows_cleanup(
            "preparing_worktree"
        ));
        assert!(cleanup_terminal_status_allows_cleanup("completed"));
        assert!(cleanup_terminal_status_allows_cleanup("failed_setup"));
        assert!(cleanup_terminal_status_allows_cleanup(
            "failed_finalization"
        ));
        assert!(cleanup_terminal_status_allows_cleanup("failed_runtime"));
    }

    #[test]
    fn cleanup_requires_durable_server_finalization_for_completed_runs_only() {
        assert!(cleanup_requires_server_final_persisted("completed"));
        assert!(!cleanup_requires_server_final_persisted("failed"));
        assert!(!cleanup_requires_server_final_persisted("cancelled"));
        assert!(!cleanup_requires_server_final_persisted("failed_spawn"));
        assert!(!cleanup_requires_server_final_persisted(
            "failed_finalization"
        ));
    }

    #[test]
    fn codex_chatgpt_session_accepts_only_subscription_models() {
        let args = vec!["--model".to_string(), "gpt-image-2".to_string()];

        assert_eq!(arg_value(&args, "--model"), Some("gpt-image-2"));
        assert!(!codex_chatgpt_session_supports_model(arg_value(
            &args, "--model"
        )));
        assert!(!codex_chatgpt_session_supports_model(Some("gpt-5-nano")));
        assert!(codex_chatgpt_session_supports_model(Some("gpt-5.5")));
        assert!(codex_chatgpt_session_supports_model(Some("gpt-5.6-luna")));
    }

    #[test]
    fn local_node_snapshot_payload_persists_selected_model_metadata() {
        let snapshot = test_snapshot(
            json!({
                "workspace_id": "workspace-1",
                "parentId": "user-1",
                "meta": {
                    "agent_id": "codex:gpt-5.5:high",
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
        assert_eq!(payload["agent_id"], "codex:gpt-5.5:high");
        assert_eq!(
            payload["execution_data"]["meta"]["provider_model"],
            "openai/gpt-5.5-high"
        );
    }

    #[test]
    fn failed_snapshot_persists_stderr_failure_reason() {
        let mut state = AgentRunState::new(AgentRunContext {
            run_id: "run-1".to_string(),
            execution_data: json!({
                "workspace_id": "workspace-1",
                "parentId": "user-1"
            }),
            git_branch_name: None,
            repo_path: None,
            parent_commit: None,
            author_name: None,
            prompt_fallback: None,
            auth_user_id: None,
        });

        update_run_state_from_event(
            &mut state,
            &json!({
                "type": "stderr",
                "data": "ImportError: cannot import name 'ParamSpec' from 'typing'"
            }),
        );

        let snapshot =
            build_finalize_snapshot(&mut state, "assistant-1").expect("failed run snapshot");

        assert_eq!(snapshot.status, "failed");
        assert_eq!(
            snapshot.execution_data["failure_reason"],
            "ImportError: cannot import name 'ParamSpec' from 'typing'"
        );
        assert_eq!(
            local_node_payload_for_snapshot(&snapshot, "workspace-1")["execution_data"]
                ["failure_reason"],
            "ImportError: cannot import name 'ParamSpec' from 'typing'"
        );
    }

    #[test]
    fn setup_failure_payload_preserves_node_identity_and_exposes_reason() {
        let existing = json!({
            "id": "assistant-1",
            "workspaceId": "workspace-1",
            "threadId": "thread-1",
            "parentId": "user-1",
            "role": "assistant",
            "content": "",
            "status": "pending",
            "execution_data": {
                "meta": {
                    "provider": "claude",
                    "login_profile_id": "profile-1"
                }
            }
        });
        let payload = local_node_payload_for_setup_failure(
            Some(existing),
            "assistant-1",
            "workspace-1",
            &json!({
                "current_run_id": "run-1",
                "meta": {
                    "provider_model": "claude-fable-5"
                }
            }),
            "failed_spawn",
            "Login profile credentials are missing. Reconnect this profile in Logins and try again.",
        );

        assert_eq!(payload["status"], "failed_spawn");
        assert_eq!(payload["threadId"], "thread-1");
        assert_eq!(payload["parentId"], "user-1");
        assert_eq!(
            payload["execution_data"]["last_terminal_status"],
            "failed_spawn"
        );
        assert_eq!(
            payload["execution_data"]["failure_reason"],
            "Login profile credentials are missing. Reconnect this profile in Logins and try again."
        );
        assert_eq!(
            payload["execution_data"]["meta"]["login_profile_id"],
            "profile-1"
        );
        assert_eq!(
            payload["execution_data"]["meta"]["provider_model"],
            "claude-fable-5"
        );
    }

    #[test]
    fn watchdog_times_out_silent_non_terminal_runs() {
        let decision = decide_agent_run_watchdog_timeout(
            1_000,
            601_000,
            600_000,
            None,
            false,
            false,
            "thread_ready",
        );

        assert!(decision.timed_out);
        assert_eq!(decision.idle_ms, 600_000);
        assert!(decision
            .reason
            .as_deref()
            .unwrap()
            .contains("last activity was thread_ready"));
    }

    #[test]
    fn watchdog_ignores_terminal_finalized_or_recent_runs() {
        assert!(
            !decide_agent_run_watchdog_timeout(
                1_000,
                601_000,
                600_000,
                Some("completed"),
                false,
                false,
                "message"
            )
            .timed_out
        );
        assert!(
            !decide_agent_run_watchdog_timeout(
                1_000, 601_000, 600_000, None, true, false, "message"
            )
            .timed_out
        );
        assert!(
            !decide_agent_run_watchdog_timeout(
                1_000, 601_000, 600_000, None, false, true, "message"
            )
            .timed_out
        );
        assert!(
            !decide_agent_run_watchdog_timeout(
                1_000, 600_999, 600_000, None, false, false, "message"
            )
            .timed_out
        );
    }

    #[test]
    fn runtime_activity_terminal_statuses_match_finalization_failures() {
        assert!(is_terminal_runtime_status("failed_finalization"));
        assert!(!is_terminal_runtime_status("finalizing"));
    }

    #[test]
    fn runtime_activity_terminal_status_requires_run_terminal_event() {
        assert_eq!(
            terminal_status_for_runtime_activity("tool_result", Some("completed")),
            None
        );
        assert_eq!(
            terminal_status_for_runtime_activity("tool_result", Some("failed")),
            None
        );
        assert_eq!(
            terminal_status_for_runtime_activity("provider_stop", Some("completed")),
            Some("completed")
        );
        assert_eq!(
            terminal_status_for_runtime_activity("finalize_ack", Some("completed")),
            Some("completed")
        );
        assert_eq!(
            terminal_status_for_runtime_activity("agent:lifecycle", Some("failed_runtime")),
            Some("failed_runtime")
        );
        assert_eq!(
            terminal_status_for_runtime_activity("finalize_progress", Some("finalizing")),
            None
        );
    }

    #[test]
    fn startup_resume_uses_latest_provider_thread_and_fixed_prompt() {
        let events = vec![
            crate::db::AgentRunJournalEvent {
                run_id: "run-1".to_string(),
                assistant_node_id: "assistant-1".to_string(),
                seq: 1,
                event_type: "provider_meta".to_string(),
                status: None,
                phase: None,
                payload: json!({
                    "type": "provider_meta",
                    "meta": {
                        "provider_thread_id": "thread-old",
                        "provider_model": "gpt-old"
                    }
                })
                .to_string(),
                timestamp: 1,
            },
            crate::db::AgentRunJournalEvent {
                run_id: "run-1".to_string(),
                assistant_node_id: "assistant-1".to_string(),
                seq: 2,
                event_type: "session".to_string(),
                status: None,
                phase: None,
                payload: json!({"type": "session", "session_id": "thread-current"}).to_string(),
                timestamp: 2,
            },
            crate::db::AgentRunJournalEvent {
                run_id: "run-1".to_string(),
                assistant_node_id: "assistant-1".to_string(),
                seq: 3,
                event_type: "provider_meta".to_string(),
                status: None,
                phase: None,
                payload: json!({
                    "type": "provider_meta",
                    "meta": {
                        "provider_model": "gpt-5.5",
                        "provider_reasoning_effort": "high",
                        "provider_run_mode": "safe-write"
                    }
                })
                .to_string(),
                timestamp: 3,
            },
        ];
        let execution_data = json!({"meta": {}});

        assert_eq!(
            latest_provider_thread_id(&events, &execution_data).as_deref(),
            Some("thread-current")
        );
        let args = startup_resume_args(
            "codex",
            "assistant-1",
            "thread-current",
            &events,
            &execution_data,
        );

        assert_eq!(args.last().map(String::as_str), Some(STARTUP_RESUME_PROMPT));
        assert!(args
            .windows(2)
            .any(|pair| pair[0] == "--model" && pair[1] == "gpt-5.5"));
        assert!(args
            .windows(2)
            .any(|pair| pair[0] == "--reasoning-effort" && pair[1] == "high"));
        assert!(args
            .windows(2)
            .any(|pair| pair[0] == "--provider-thread-id" && pair[1] == "thread-current"));
        assert!(args
            .windows(2)
            .any(|pair| pair[0] == "--node-id" && pair[1] == "assistant-1"));
    }

    #[test]
    fn failure_reason_persistence_includes_finalization_failures() {
        assert!(should_persist_failure_reason("failed_finalization"));
        assert!(!should_persist_failure_reason("cancelled"));
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
            auth_user_id: None,
        };

        assert_eq!(
            run_ledger_user_node_id_from_context(&context).as_deref(),
            Some("user-1")
        );
    }

    #[test]
    fn run_ledger_user_node_id_ignores_context_parent_metadata() {
        let context = AgentRunContext {
            run_id: "run-1".to_string(),
            execution_data: json!({
                "meta": {
                    "context_parent_node_id": "assistant-before-user"
                }
            }),
            git_branch_name: None,
            repo_path: None,
            parent_commit: None,
            author_name: None,
            prompt_fallback: None,
            auth_user_id: None,
        };

        assert_eq!(run_ledger_user_node_id_from_context(&context), None);
    }

    #[test]
    fn commit_subject_comes_from_runtime_metadata() {
        let execution_data = json!({
            "meta": {
                "commit_subject": "  `feat: add structured commit subjects.`  "
            }
        });

        assert_eq!(
            commit_subject_from_execution_data(&execution_data).as_deref(),
            Some("feat: add structured commit subjects")
        );
        assert_eq!(
            commit_message_for_snapshot(&test_snapshot(execution_data, "Implemented the feature."))
                .as_str(),
            "feat: add structured commit subjects"
        );
    }

    #[test]
    fn commit_message_includes_runtime_body_metadata() {
        let execution_data = json!({
            "meta": {
                "commit_subject": "  `feat: generate commit bodies.`  ",
                "commit_body": " Explain why the body is useful.\n\nMention agents.rs and adapter schemas. "
            }
        });

        assert_eq!(
            commit_body_from_execution_data(&execution_data).as_deref(),
            Some("Explain why the body is useful.\n\nMention agents.rs and adapter schemas.")
        );
        assert_eq!(
            commit_message_for_snapshot(&test_snapshot(execution_data, "Implemented the feature."))
                .as_str(),
            "feat: generate commit bodies\n\nExplain why the body is useful.\n\nMention agents.rs and adapter schemas."
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
    fn thinking_deltas_preserve_delta_metadata_in_timeline() {
        let mut state = test_run_state();
        update_run_state_from_event(
            &mut state,
            &json!({"type": "thinking", "content": "Reading ", "is_delta": true, "timestamp": 1}),
        );
        update_run_state_from_event(
            &mut state,
            &json!({"type": "thinking", "content": "files", "isDelta": true, "timestamp": 2}),
        );

        assert_eq!(state.timeline.len(), 2);
        assert_eq!(state.timeline[0]["content"], "Reading ");
        assert_eq!(state.timeline[0]["isDelta"], true);
        assert_eq!(state.timeline[1]["content"], "files");
        assert_eq!(state.timeline[1]["isDelta"], true);
    }

    #[test]
    fn provider_final_content_replaces_interim_message_snapshots_in_timeline() {
        let mut state = test_run_state();
        update_run_state_from_event(
            &mut state,
            &json!({"type": "message_completed", "content": "Working on the fix.", "provider_item_id": "msg-1", "timestamp": 1}),
        );
        update_run_state_from_event(
            &mut state,
            &json!({"type": "message_completed", "content": "Working on the fix. Checking tests.", "provider_item_id": "msg-1", "timestamp": 2}),
        );
        update_run_state_from_event(
            &mut state,
            &json!({"type": "provider_stop", "provider_status": "completed", "final_content": "Implemented.\n\nVerification passed.", "provider_item_id": "msg-1", "timestamp": 3}),
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
    fn provider_final_content_preserves_prior_completed_message_items_in_timeline() {
        let mut state = test_run_state();
        update_run_state_from_event(
            &mut state,
            &json!({"type": "message_completed", "content": "Initial orchestration note.", "provider_item_id": "msg-1", "timestamp": 1}),
        );
        update_run_state_from_event(
            &mut state,
            &json!({"type": "tool_use", "name": "spawn_agents", "id": "tool-1", "timestamp": 2}),
        );
        update_run_state_from_event(
            &mut state,
            &json!({"type": "message_completed", "content": "Final status.", "provider_item_id": "msg-2", "timestamp": 3}),
        );
        update_run_state_from_event(
            &mut state,
            &json!({"type": "provider_stop", "provider_status": "completed", "final_content": "Final status.", "timestamp": 4}),
        );

        let message_events: Vec<_> = state
            .timeline
            .iter()
            .filter(|event| event["type"] == "message")
            .collect();
        assert_eq!(state.content, "Final status.");
        assert_eq!(message_events.len(), 2);
        assert_eq!(message_events[0]["content"], "Initial orchestration note.");
        assert_eq!(message_events[0]["provider_item_id"], "msg-1");
        assert_eq!(message_events[1]["content"], "Final status.");
        assert_eq!(message_events[1]["provider_item_id"], "msg-2");
    }

    #[test]
    fn replayed_terminal_journal_builds_completed_snapshot() {
        let ledger = crate::db::AgentRunLedgerRow {
            run_id: "run-1".to_string(),
            user_node_id: Some("user-1".to_string()),
            assistant_node_id: "assistant-1".to_string(),
            workspace_id: Some("workspace-1".to_string()),
            repo_path: Some("/tmp/repo".to_string()),
            worktree_path: Some("/tmp/worktree".to_string()),
            branch_name: Some("agentree/assistant-1".to_string()),
            parent_commit: Some("base-sha".to_string()),
            pid: Some(123),
            agent_type: Some("codex".to_string()),
            status: "running".to_string(),
            phase: "running".to_string(),
            last_seq: 3,
            started_at: 1,
            updated_at: 2,
            terminal_status: None,
            finalize_attempt_count: 0,
            cleanup_attempt_count: 0,
            server_start_persisted: false,
            server_final_persisted: false,
            output_commit_sha: None,
            failure_reason: None,
            needs_user_action_reason: None,
            cleanup_completed: false,
            login_profile_id: None,
        };
        let events = vec![
            crate::db::AgentRunJournalEvent {
                run_id: "run-1".to_string(),
                assistant_node_id: "assistant-1".to_string(),
                seq: 1,
                event_type: "message_delta".to_string(),
                status: None,
                phase: None,
                payload: json!({"type": "message_delta", "delta": "draft", "timestamp": 1})
                    .to_string(),
                timestamp: 1,
            },
            crate::db::AgentRunJournalEvent {
                run_id: "run-1".to_string(),
                assistant_node_id: "assistant-1".to_string(),
                seq: 2,
                event_type: "artifact_registered".to_string(),
                status: None,
                phase: None,
                payload: json!({
                    "type": "artifact_registered",
                    "artifact": {
                        "id": "artifact-1",
                        "kind": "image",
                        "title": "Preview image",
                        "mimeType": "image/png",
                        "path": "/tmp/preview.png",
                        "isPrimary": true
                    },
                    "timestamp": 2
                })
                .to_string(),
                timestamp: 2,
            },
            crate::db::AgentRunJournalEvent {
                run_id: "run-1".to_string(),
                assistant_node_id: "assistant-1".to_string(),
                seq: 3,
                event_type: "provider_stop".to_string(),
                status: None,
                phase: None,
                payload: json!({
                    "type": "provider_stop",
                    "provider_status": "completed",
                    "provider_stop_reason": "end_turn",
                    "final_content": "final answer",
                    "usage": {"input_tokens": 3, "output_tokens": 5, "total_tokens": 8},
                    "timestamp": 3
                })
                .to_string(),
                timestamp: 3,
            },
        ];

        let snapshot = snapshot_from_replayed_journal(
            &ledger,
            &events,
            json!({"workspace_id": "workspace-1", "parentId": "user-1"}),
            Some("prompt".to_string()),
        )
        .expect("terminal snapshot");

        assert_eq!(snapshot.status, "completed");
        assert_eq!(snapshot.final_content, "final answer");
        assert_eq!(
            snapshot.execution_data["last_terminal_status"],
            json!("completed")
        );
        assert_eq!(snapshot.prompt_tokens, Some(3));
        assert_eq!(snapshot.completion_tokens, Some(5));
        assert_eq!(snapshot.total_tokens, Some(8));
        assert_eq!(snapshot.execution_data["artifacts"][0]["id"], "artifact-1");
        assert_eq!(
            snapshot.execution_data["artifacts"][0]["isPrimary"],
            json!(true)
        );
        let artifact_timeline_row = snapshot.execution_data["timeline"]
            .as_array()
            .and_then(|events| {
                events
                    .iter()
                    .find(|event| event.get("toolName") == Some(&json!("show_output")))
            })
            .cloned();
        assert_eq!(
            artifact_timeline_row,
            Some(json!({
                "type": "tool_result",
                "timestamp": 2,
                "toolName": "show_output",
                "toolOutput": "Preview image",
                "isError": false,
                "toolUseId": "artifact-1"
            }))
        );
    }

    #[test]
    fn replayed_terminal_journal_repairs_missing_parent_from_ledger_user_node() {
        let ledger = crate::db::AgentRunLedgerRow {
            run_id: "run-1".to_string(),
            user_node_id: Some("user-1".to_string()),
            assistant_node_id: "assistant-1".to_string(),
            workspace_id: Some("workspace-1".to_string()),
            repo_path: Some("/tmp/repo".to_string()),
            worktree_path: Some("/tmp/worktree".to_string()),
            branch_name: Some("agentree/assistant-1".to_string()),
            parent_commit: Some("base-sha".to_string()),
            pid: Some(123),
            agent_type: Some("codex".to_string()),
            status: "running".to_string(),
            phase: "running".to_string(),
            last_seq: 1,
            started_at: 1,
            updated_at: 2,
            terminal_status: None,
            finalize_attempt_count: 0,
            cleanup_attempt_count: 0,
            server_start_persisted: false,
            server_final_persisted: false,
            output_commit_sha: None,
            failure_reason: None,
            needs_user_action_reason: None,
            cleanup_completed: false,
            login_profile_id: None,
        };
        let events = vec![crate::db::AgentRunJournalEvent {
            run_id: "run-1".to_string(),
            assistant_node_id: "assistant-1".to_string(),
            seq: 1,
            event_type: "provider_stop".to_string(),
            status: None,
            phase: None,
            payload: json!({
                "type": "provider_stop",
                "provider_status": "completed",
                "final_content": "final answer",
                "timestamp": 1
            })
            .to_string(),
            timestamp: 1,
        }];
        let mut execution_data = json!({
            "workspace_id": "workspace-1",
            "meta": {
                "context_parent_node_id": "assistant-before-user"
            }
        });

        ensure_context_recovery_fields(
            &mut execution_data,
            ledger.workspace_id.as_deref(),
            ledger.user_node_id.as_deref(),
        );
        let snapshot = snapshot_from_replayed_journal(&ledger, &events, execution_data, None)
            .expect("terminal snapshot");
        let payload = local_node_payload_for_snapshot(&snapshot, "workspace-1");

        assert_eq!(snapshot.execution_data["parentId"], json!("user-1"));
        assert_eq!(payload["parentId"], json!("user-1"));
        assert_eq!(
            payload["execution_data"]["meta"]["context_parent_node_id"],
            json!("assistant-before-user")
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
