use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager, State};

const LOCAL_COMMIT_PARENT_CLOSURE_LIMIT: usize = 5_000;

fn unix_timestamp() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("Time went backwards")
        .as_secs() as i64
}

fn utc_iso_now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn normalize_thread_title(value: &str) -> Option<String> {
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
            .take(80)
            .collect::<String>()
            .trim()
            .to_string(),
    )
}

fn thread_title_from_payload(payload: &JsonValue) -> Option<String> {
    payload
        .get("execution_data")
        .or_else(|| payload.get("executionData"))
        .and_then(|value| value.get("meta"))
        .and_then(|meta| {
            meta.get("thread_title")
                .or_else(|| meta.get("threadTitle"))
                .or_else(|| meta.get("agent_thread_title"))
                .or_else(|| meta.get("runtime_thread_title"))
        })
        .and_then(|value| value.as_str())
        .and_then(normalize_thread_title)
}

fn clean_payload_string(value: Option<&JsonValue>) -> Option<&str> {
    value
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

fn controlled_by_node_id_from_payload(payload: &JsonValue) -> Option<&str> {
    clean_payload_string(payload.get("controlled_by_node_id"))
        .or_else(|| clean_payload_string(payload.get("controlledByNodeId")))
        .or_else(|| {
            payload
                .get("execution_data")
                .or_else(|| payload.get("executionData"))
                .and_then(|value| value.get("meta"))
                .and_then(|meta| {
                    clean_payload_string(meta.get("controlled_by_node_id"))
                        .or_else(|| clean_payload_string(meta.get("controlledByNodeId")))
                        .or_else(|| clean_payload_string(meta.get("controlled_by")))
                        .or_else(|| clean_payload_string(meta.get("controlledBy")))
                })
        })
}

fn is_structured_timeline_event_type(event_type: &str) -> bool {
    matches!(
        event_type,
        "tool_use"
            | "tool_result"
            | "tool_output_delta"
            | "thinking"
            | "error"
            | "stderr"
            | "user_steer_requested"
    )
}

fn timeline_has_structured_events(timeline: Option<&Vec<JsonValue>>) -> bool {
    timeline
        .map(|entries| {
            entries.iter().any(|entry| {
                entry
                    .get("type")
                    .and_then(|value| value.as_str())
                    .map(is_structured_timeline_event_type)
                    .unwrap_or(false)
            })
        })
        .unwrap_or(false)
}

fn execution_data_has_structured_timeline(execution_data: &JsonValue) -> bool {
    timeline_has_structured_events(
        execution_data
            .get("timeline")
            .and_then(|value| value.as_array()),
    )
}

fn payload_has_structured_timeline(payload: &JsonValue) -> bool {
    payload
        .get("execution_data")
        .map(execution_data_has_structured_timeline)
        .unwrap_or(false)
}

fn execution_data_has_artifacts(execution_data: &JsonValue) -> bool {
    execution_data
        .get("artifacts")
        .and_then(|value| value.as_array())
        .map(|artifacts| !artifacts.is_empty())
        .unwrap_or(false)
}

fn payload_has_artifacts(payload: &JsonValue) -> bool {
    payload
        .get("execution_data")
        .map(execution_data_has_artifacts)
        .unwrap_or(false)
}

fn timeline_tool_use_id(event: &JsonValue) -> Option<&str> {
    event
        .get("toolUseId")
        .or_else(|| event.get("tool_use_id"))
        .or_else(|| event.get("id"))
        .and_then(|value| value.as_str())
}

fn append_tool_output_delta_to_timeline(
    timeline: &mut Vec<JsonValue>,
    tool_use_id: &str,
    delta: &str,
) {
    for event in timeline.iter_mut().rev() {
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
                JsonValue::String(crate::tool_output::append_bounded_tool_output(
                    &existing, delta,
                )),
            );
        }
        return;
    }
}

fn normalize_journal_timeline_event(event: &JsonValue) -> Option<JsonValue> {
    let event_type = event.get("type")?.as_str()?;
    let timestamp = event
        .get("timestamp")
        .and_then(|value| value.as_i64())
        .unwrap_or_else(|| unix_timestamp() * 1000);

    let mut normalized = match event_type {
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
            "idempotency_key": event.get("idempotency_key").cloned()
                .or_else(|| event.get("idempotencyKey").cloned())
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
        "error" | "stderr" => Some(serde_json::json!({
            "type": "error",
            "timestamp": timestamp,
            "content": event.get("content").cloned()
                .or_else(|| event.get("data").cloned())
                .unwrap_or(JsonValue::Null),
        })),
        _ => None,
    };
    if let Some(event) = normalized.as_mut() {
        crate::tool_output::sanitize_tool_output_fields(event);
    }
    normalized
}

fn merge_timeline_into_payload(payload: &mut JsonValue, timeline: Vec<JsonValue>) {
    if timeline.is_empty() {
        return;
    }
    if !payload.is_object() {
        return;
    }
    let Some(payload_object) = payload.as_object_mut() else {
        return;
    };
    let execution_data = payload_object
        .entry("execution_data".to_string())
        .or_insert_with(|| serde_json::json!({}));
    if !execution_data.is_object() {
        *execution_data = serde_json::json!({});
    }
    if let Some(execution_object) = execution_data.as_object_mut() {
        execution_object.insert("timeline".to_string(), JsonValue::Array(timeline));
    }
}

pub struct TelemetryDb {
    conn: Mutex<Connection>,
    db_path: PathBuf,
}

#[derive(Debug)]
pub(crate) struct DeletedLoginProfileMetadata {
    profile: crate::login_profiles::LoginProfile,
    secret_ref: Option<String>,
}

fn login_profile_from_row(
    row: &rusqlite::Row<'_>,
) -> rusqlite::Result<crate::login_profiles::LoginProfile> {
    let config_text: String = row.get(5)?;
    Ok(crate::login_profiles::LoginProfile {
        id: row.get(0)?,
        provider: row.get(1)?,
        display_name: row.get(2)?,
        auth_type: row.get(3)?,
        redacted_hint: row.get(4)?,
        config: serde_json::from_str(&config_text).unwrap_or_else(|_| serde_json::json!({})),
        status: row.get(6)?,
        status_message: row.get(7)?,
        plan_type: row.get(8)?,
        is_default: row.get::<_, i64>(9)? != 0,
        created_at: row.get(10)?,
        updated_at: row.get(11)?,
        last_checked_at: row.get(12)?,
    })
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentRunLedgerUpsert {
    pub run_id: String,
    pub user_node_id: Option<String>,
    pub assistant_node_id: String,
    pub workspace_id: Option<String>,
    pub repo_path: Option<String>,
    pub worktree_path: Option<String>,
    pub branch_name: Option<String>,
    pub parent_commit: Option<String>,
    pub pid: Option<i64>,
    pub agent_type: Option<String>,
    pub status: String,
    pub phase: String,
    pub login_profile_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum AgentRunAdmission {
    Accepted,
    Existing {
        worktree_path: Option<String>,
        branch_name: Option<String>,
        status: String,
        pid: Option<i64>,
    },
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentRunLedgerRow {
    pub run_id: String,
    pub user_node_id: Option<String>,
    pub assistant_node_id: String,
    pub workspace_id: Option<String>,
    pub repo_path: Option<String>,
    pub worktree_path: Option<String>,
    pub branch_name: Option<String>,
    pub parent_commit: Option<String>,
    pub pid: Option<i64>,
    pub agent_type: Option<String>,
    pub status: String,
    pub phase: String,
    pub last_seq: i64,
    pub started_at: i64,
    pub updated_at: i64,
    pub terminal_status: Option<String>,
    pub finalize_attempt_count: i64,
    pub cleanup_attempt_count: i64,
    pub server_start_persisted: bool,
    pub server_final_persisted: bool,
    pub output_commit_sha: Option<String>,
    pub failure_reason: Option<String>,
    pub needs_user_action_reason: Option<String>,
    pub cleanup_completed: bool,
    pub login_profile_id: Option<String>,
}

#[derive(Debug, Clone)]
pub(crate) struct AgentLaunchRequestRow {
    pub request_id: String,
    pub workspace_id: String,
    pub thread_id: Option<String>,
    pub user_node_id: String,
    pub assistant_node_id: String,
    pub run_id: String,
    pub status: String,
    pub request_json: String,
    pub failure_reason: Option<String>,
    pub lease_owner: Option<String>,
    pub lease_expires_at: Option<i64>,
}

#[derive(Debug, Clone)]
pub(crate) struct AgentLaunchClaim {
    pub row: AgentLaunchRequestRow,
    pub acquired: bool,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentRunStateResponse {
    pub ledger: Option<AgentRunLedgerRow>,
    pub running: bool,
    pub pid: Option<i64>,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentRunJournalEvent {
    pub run_id: String,
    pub assistant_node_id: String,
    pub seq: i64,
    pub event_type: String,
    pub status: Option<String>,
    pub phase: Option<String>,
    pub payload: String,
    pub timestamp: i64,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct LocalNodeRow {
    pub node_id: String,
    pub workspace_id: String,
    pub controlled_by_node_id: Option<String>,
    pub payload: String,
    pub sync_status: String,
    pub finalized_at: i64,
    pub server_ack_at: Option<i64>,
    pub retry_attempt: i64,
    pub next_retry_at: Option<i64>,
    pub last_upload_error: Option<String>,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct LocalInsightRow {
    pub insight_id: String,
    pub workspace_id: String,
    pub payload: String,
    pub sync_status: String,
    pub created_at: String,
    pub updated_at: String,
    pub server_ack_at: Option<i64>,
    pub retry_attempt: i64,
    pub next_retry_at: Option<i64>,
    pub last_upload_error: Option<String>,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct LocalInsightCandidateRow {
    pub candidate_id: String,
    pub workspace_id: String,
    pub parent_node_id: String,
    pub agent_kind: String,
    pub claim: String,
    pub rationale: Option<String>,
    pub status: String,
    pub novelty_score: f64,
    pub relevance_score: f64,
    pub actionability_score: f64,
    pub risk_score: f64,
    pub timing_score: f64,
    pub confidence: f64,
    pub priority: Option<f64>,
    pub surface_reason: Option<String>,
    pub surfaced_insight_id: Option<String>,
    pub source_run_node_id: Option<String>,
    pub exploration_json: Option<String>,
    pub payload: String,
    pub created_at: String,
    pub updated_at: String,
}

struct InsightCandidateDraft {
    id: String,
    agent_kind: String,
    claim: String,
    rationale: Option<String>,
    novelty_score: f64,
    relevance_score: f64,
    actionability_score: f64,
    risk_score: f64,
    timing_score: f64,
    confidence: f64,
    priority: f64,
    should_surface: bool,
    surface_reason: String,
    payload: JsonValue,
    exploration: JsonValue,
}

fn clamp_score(value: f64) -> f64 {
    if value.is_nan() {
        return 0.5;
    }
    value.clamp(0.0, 1.0)
}

fn normalize_insight_agent_kind(value: Option<&str>) -> String {
    match value.unwrap_or("hypothesis").trim() {
        "hypothesis" | "doubt" | "meta" | "association" | "memory" | "kb" | "risk"
        | "opportunity" => value.unwrap_or("hypothesis").trim().to_string(),
        _ => "hypothesis".to_string(),
    }
}

fn json_string_field<'a>(value: &'a JsonValue, keys: &[&str]) -> Option<&'a str> {
    keys.iter()
        .find_map(|key| value.get(*key).and_then(|field| field.as_str()))
        .map(str::trim)
        .filter(|field| !field.is_empty())
}

fn json_score_field(value: &JsonValue, keys: &[&str], default: f64) -> f64 {
    for key in keys {
        if let Some(score) = value.get(*key).and_then(|field| field.as_f64()) {
            return clamp_score(score);
        }
        if let Some(score) = value
            .get("validationResults")
            .or_else(|| value.get("validation"))
            .and_then(|validation| validation.get(*key))
            .and_then(|field| field.as_f64())
        {
            return clamp_score(score);
        }
    }
    default
}

fn insight_claim_is_generic(claim: &str) -> bool {
    let normalized = claim.to_ascii_lowercase();
    [
        "consider tradeoffs",
        "think about",
        "it may be useful",
        "you could consider",
        "keep in mind",
        "best practice",
        "be careful",
    ]
    .iter()
    .any(|phrase| normalized.contains(phrase))
}

fn build_insight_exploration(raw: &JsonValue, rationale: Option<&str>) -> JsonValue {
    if let Some(exploration) = raw.get("exploration").cloned() {
        return exploration;
    }
    serde_json::json!({
        "analysis": json_string_field(raw, &["fullExploration", "analysis", "evidence", "support"]).or(rationale),
        "raw": raw,
    })
}

fn parse_insight_candidate(
    workspace_id: &str,
    parent_node_id: &str,
    source_run_node_id: &str,
    trigger_class: &str,
    trigger_reason: &str,
    prompt_tokens: Option<i64>,
    completion_tokens: Option<i64>,
    total_tokens: Option<i64>,
    raw: JsonValue,
) -> Option<InsightCandidateDraft> {
    let claim = json_string_field(&raw, &["claim", "content", "title", "insight"])?.to_string();
    let rationale = json_string_field(&raw, &["rationale", "reasoning", "why", "surfaceReason"])
        .map(|value| value.to_string());
    let agent_kind = normalize_insight_agent_kind(json_string_field(
        &raw,
        &["agentKind", "agentType", "strategy", "type"],
    ));
    let mut novelty_score =
        json_score_field(&raw, &["novelty", "noveltyScore", "novelty_score"], 0.55);
    let mut relevance_score = json_score_field(
        &raw,
        &["relevance", "relevanceScore", "relevance_score"],
        0.55,
    );
    let mut actionability_score = json_score_field(
        &raw,
        &["actionability", "actionabilityScore", "actionability_score"],
        0.5,
    );
    let risk_score = json_score_field(&raw, &["risk", "riskScore", "risk_score"], 0.35);
    let timing_score = json_score_field(&raw, &["timing", "timingScore", "timing_score"], 0.5);
    let mut confidence = json_score_field(
        &raw,
        &["confidence", "confidenceScore", "confidence_score"],
        0.55,
    );

    let word_count = claim.split_whitespace().count();
    if word_count < 5 {
        relevance_score = clamp_score(relevance_score - 0.15);
        actionability_score = clamp_score(actionability_score - 0.2);
    }
    if insight_claim_is_generic(&claim) {
        novelty_score = clamp_score(novelty_score - 0.25);
        actionability_score = clamp_score(actionability_score - 0.2);
    }
    let has_evidence = rationale
        .as_deref()
        .map(|value| value.split_whitespace().count() >= 8)
        .unwrap_or(false)
        || json_string_field(
            &raw,
            &["fullExploration", "analysis", "evidence", "support"],
        )
        .map(|value| value.split_whitespace().count() >= 8)
        .unwrap_or(false);
    if !has_evidence && risk_score > 0.55 {
        confidence = clamp_score(confidence - 0.15);
    }

    let priority = clamp_score(
        ((novelty_score + relevance_score + actionability_score + timing_score + confidence) / 5.0)
            - (risk_score * 0.25),
    );
    let should_surface = novelty_score >= 0.45
        && relevance_score >= 0.5
        && actionability_score >= 0.42
        && timing_score >= 0.45
        && confidence >= 0.5
        && risk_score <= 0.75
        && priority >= 0.48;
    let surface_reason = json_string_field(&raw, &["surfaceReason", "reason", "whyNow"])
        .map(|value| value.to_string())
        .unwrap_or_else(|| {
            if should_surface {
                "Validated as novel, relevant, actionable, and timely.".to_string()
            } else {
                "Saved quietly because it did not clear the attention gate.".to_string()
            }
        });
    let id = json_string_field(&raw, &["id", "candidateId", "candidate_id"])
        .map(|value| value.to_string())
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let exploration = build_insight_exploration(&raw, rationale.as_deref());
    let created_at = utc_iso_now();
    let payload = serde_json::json!({
        "id": id,
        "candidateId": id,
        "agentKind": agent_kind,
        "agentType": agent_kind,
        "isLocal": true,
        "claim": claim,
        "content": claim,
        "rationale": rationale,
        "reasoning": rationale,
        "fullExploration": exploration.get("analysis").and_then(|value| value.as_str()),
        "sourceWorkspaceId": workspace_id,
        "sourceRunNodeId": source_run_node_id,
        "triggerClass": trigger_class,
        "triggerReason": trigger_reason,
        "promptTokens": prompt_tokens,
        "completionTokens": completion_tokens,
        "totalTokens": total_tokens,
        "parentNodeId": parent_node_id,
        "validationResults": {
            "novelty": novelty_score,
            "relevance": relevance_score,
            "actionability": actionability_score,
            "risk": risk_score,
            "timing": timing_score,
            "confidence": confidence,
            "surface": should_surface,
            "reason": surface_reason,
            "priority": priority,
        },
        "createdAt": created_at,
        "updatedAt": created_at,
    });

    Some(InsightCandidateDraft {
        id,
        agent_kind,
        claim,
        rationale,
        novelty_score,
        relevance_score,
        actionability_score,
        risk_score,
        timing_score,
        confidence,
        priority,
        should_surface,
        surface_reason,
        payload,
        exploration,
    })
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ThreadSessionPayload {
    pub id: String,
    pub workspace_id: String,
    pub title: Option<String>,
    pub status: String,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
    pub base_commit_sha: Option<String>,
    pub first_message_id: Option<String>,
    pub parent_thread_id: Option<String>,
    pub source: String,
    pub anchor_node_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ConvertSubgraphToThreadResult {
    pub thread: ThreadSessionPayload,
    pub conversion_id: String,
    pub root_node_id: String,
    pub source_thread_id: Option<String>,
    pub target_thread_id: String,
    pub original_parent_id: String,
    pub moved_node_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct LocalSyncEventRow {
    pub id: String,
    pub workspace_id: Option<String>,
    pub user_id: Option<String>,
    pub cloud_account_id: Option<String>,
    pub entity_type: String,
    pub entity_id: String,
    pub event_type: String,
    pub payload_json: String,
    pub idempotency_key: String,
    pub status: String,
    pub attempt_count: i64,
    pub next_attempt_at: Option<i64>,
    pub last_error: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct LocalIdentity {
    pub local_user_id: String,
    pub local_device_id: String,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct LocalDeletedNodeRoot {
    pub workspace_id: String,
    pub node_id: String,
    pub deleted_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct LocalWorkspaceRow {
    pub id: String,
    pub name: String,
    pub user_id: String,
    pub local_repo_path: Option<String>,
    pub folder_path: Option<String>,
    pub repo_path: Option<String>,
    pub base_commit_sha: Option<String>,
    pub connection_status: String,
    pub sync_status: String,
    pub created_at: String,
    pub updated_at: String,
    pub deleted_at: Option<String>,
    pub local_updated_at: i64,
    pub server_workspace_id: Option<String>,
    pub server_version: Option<String>,
    pub name_dirty: bool,
    pub metadata_dirty: bool,
    pub cloud_backup_enabled: bool,
    pub cloud_account_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct LocalWorkspaceMutationRequest {
    pub workspace_id: String,
    pub current_user_id: String,
    pub name: Option<String>,
    pub local_repo_path: Option<String>,
    pub base_commit_sha: Option<String>,
    pub repo_fingerprint: Option<String>,
    pub mutation_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct LocalCommitImport {
    pub sha: String,
    pub parents: Vec<String>,
    pub subject: Option<String>,
    pub author_name: Option<String>,
    pub author_email: Option<String>,
    pub authored_at: Option<String>,
    pub committed_at: Option<String>,
    pub source_kind: Option<String>,
    pub produced_by_node_id: Option<String>,
    pub files_changed_count: Option<i64>,
    pub total_additions: Option<i64>,
    pub total_deletions: Option<i64>,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct LocalCommitRow {
    pub sha: String,
    pub subject: Option<String>,
    pub author_name: Option<String>,
    pub author_email: Option<String>,
    pub authored_at: Option<String>,
    pub committed_at: Option<String>,
    pub source_kind: String,
    pub produced_by_node_id: Option<String>,
    pub first_parent_sha: Option<String>,
    pub files_changed_count: Option<i64>,
    pub total_additions: Option<i64>,
    pub total_deletions: Option<i64>,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct LocalCommitParentRow {
    pub child_sha: String,
    pub parent_sha: String,
    pub parent_index: i64,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct LocalCommitObservationRow {
    pub commit_sha: String,
    pub git_ref: Option<String>,
    pub source_kind: String,
    pub first_seen_at: String,
    pub last_seen_at: String,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct LocalCommitGraphSnapshot {
    pub commits: Vec<LocalCommitRow>,
    pub commit_parents: Vec<LocalCommitParentRow>,
    pub commit_observations: Vec<LocalCommitObservationRow>,
}

#[derive(Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct TelemetryEventRow {
    event_type: String,
    data: String,
    timestamp: i64,
}

#[derive(Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct TelemetrySessionSnapshot {
    session_id: String,
    status: String,
    created_at: i64,
    completed_at: Option<i64>,
    worktree_path: Option<String>,
    repo_path: Option<String>,
    events: Vec<TelemetryEventRow>,
}

impl TelemetryDb {
    pub fn open(app_data_dir: &Path) -> Result<Self, String> {
        std::fs::create_dir_all(app_data_dir).map_err(|e| e.to_string())?;
        let db_path = app_data_dir.join("telemetry.db");
        let conn = Connection::open(&db_path).map_err(|e| e.to_string())?;
        conn.execute_batch(
            r#"
            PRAGMA journal_mode = WAL;
            PRAGMA synchronous = NORMAL;
            PRAGMA busy_timeout = 5000;
            PRAGMA foreign_keys = ON;

            CREATE TABLE IF NOT EXISTS agent_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT NOT NULL,
                event_type TEXT NOT NULL,
                data TEXT NOT NULL,
                timestamp INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_agent_events_session ON agent_events(session_id);
            CREATE INDEX IF NOT EXISTS idx_agent_events_ts ON agent_events(timestamp);

            CREATE TABLE IF NOT EXISTS tool_calls (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT NOT NULL,
                name TEXT NOT NULL,
                parameters TEXT,
                result TEXT,
                error TEXT,
                started_at INTEGER NOT NULL,
                completed_at INTEGER NOT NULL,
                duration_ms INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_tool_calls_session ON tool_calls(session_id);
            CREATE INDEX IF NOT EXISTS idx_tool_calls_name ON tool_calls(name);

            CREATE TABLE IF NOT EXISTS local_messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT NOT NULL,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                timestamp INTEGER NOT NULL,
                metadata TEXT,
                synced INTEGER NOT NULL DEFAULT 0
            );
            CREATE INDEX IF NOT EXISTS idx_local_messages_session ON local_messages(session_id);
            CREATE INDEX IF NOT EXISTS idx_local_messages_unsynced ON local_messages(synced);

            CREATE TABLE IF NOT EXISTS session_status (
                session_id TEXT PRIMARY KEY,
                status TEXT NOT NULL DEFAULT 'running',
                created_at INTEGER NOT NULL,
                completed_at INTEGER,
                worktree_path TEXT,
                repo_path TEXT
            );

            CREATE TABLE IF NOT EXISTS session_kv (
                session_id TEXT NOT NULL,
                key TEXT NOT NULL,
                value TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                PRIMARY KEY (session_id, key)
            );

            CREATE TABLE IF NOT EXISTS agent_run_ledger (
                run_id TEXT PRIMARY KEY,
                user_node_id TEXT,
                assistant_node_id TEXT NOT NULL UNIQUE,
                workspace_id TEXT,
                repo_path TEXT,
                worktree_path TEXT,
                branch_name TEXT,
                parent_commit TEXT,
                pid INTEGER,
                agent_type TEXT,
                status TEXT NOT NULL,
                phase TEXT NOT NULL,
                last_seq INTEGER NOT NULL DEFAULT 0,
                started_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                terminal_status TEXT,
                finalize_attempt_count INTEGER NOT NULL DEFAULT 0,
                cleanup_attempt_count INTEGER NOT NULL DEFAULT 0,
                server_start_persisted INTEGER NOT NULL DEFAULT 0,
                server_final_persisted INTEGER NOT NULL DEFAULT 0,
                output_commit_sha TEXT,
                failure_reason TEXT,
                needs_user_action_reason TEXT,
                cleanup_completed INTEGER NOT NULL DEFAULT 0,
                login_profile_id TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_agent_run_ledger_assistant ON agent_run_ledger(assistant_node_id);
            CREATE INDEX IF NOT EXISTS idx_agent_run_ledger_status ON agent_run_ledger(status);
            CREATE INDEX IF NOT EXISTS idx_agent_run_ledger_repo ON agent_run_ledger(repo_path);

            CREATE TABLE IF NOT EXISTS agent_launch_requests (
                request_id TEXT PRIMARY KEY,
                workspace_id TEXT NOT NULL,
                thread_id TEXT,
                user_node_id TEXT NOT NULL,
                assistant_node_id TEXT NOT NULL,
                run_id TEXT NOT NULL,
                status TEXT NOT NULL,
                request_json TEXT NOT NULL,
                failure_reason TEXT,
                lease_owner TEXT,
                lease_expires_at INTEGER,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );
            CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_launch_requests_assistant
                ON agent_launch_requests(assistant_node_id);
            CREATE INDEX IF NOT EXISTS idx_agent_launch_requests_status
                ON agent_launch_requests(status, lease_expires_at);

            CREATE TABLE IF NOT EXISTS login_profiles (
                id TEXT PRIMARY KEY,
                provider TEXT NOT NULL,
                display_name TEXT NOT NULL,
                auth_type TEXT NOT NULL,
                secret_ref TEXT,
                redacted_hint TEXT,
                config_json TEXT NOT NULL DEFAULT '{}',
                status TEXT NOT NULL DEFAULT 'unchecked',
                status_message TEXT,
                plan_type TEXT,
                is_default INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                last_checked_at INTEGER
            );
            CREATE INDEX IF NOT EXISTS idx_login_profiles_provider
                ON login_profiles(provider, is_default, updated_at);

            CREATE TABLE IF NOT EXISTS agent_run_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                run_id TEXT NOT NULL,
                assistant_node_id TEXT NOT NULL,
                seq INTEGER NOT NULL,
                event_type TEXT NOT NULL,
                status TEXT,
                phase TEXT,
                payload TEXT NOT NULL,
                timestamp INTEGER NOT NULL,
                UNIQUE(run_id, seq)
            );
            CREATE INDEX IF NOT EXISTS idx_agent_run_events_run_seq ON agent_run_events(run_id, seq);
            CREATE INDEX IF NOT EXISTS idx_agent_run_events_assistant ON agent_run_events(assistant_node_id);

            -- Legacy migration source only. Active local rendering reads local_nodes.
            CREATE TABLE IF NOT EXISTS local_authoritative_nodes (
                node_id TEXT PRIMARY KEY,
                workspace_id TEXT NOT NULL,
                payload TEXT NOT NULL,
                sync_status TEXT NOT NULL DEFAULT 'local_only',
                finalized_at INTEGER NOT NULL,
                server_ack_at INTEGER,
                retry_attempt INTEGER NOT NULL DEFAULT 0,
                next_retry_at INTEGER,
                last_upload_error TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_local_authoritative_nodes_workspace ON local_authoritative_nodes(workspace_id);
            CREATE INDEX IF NOT EXISTS idx_local_authoritative_nodes_sync ON local_authoritative_nodes(sync_status, next_retry_at);

            CREATE TABLE IF NOT EXISTS local_app_kv (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS local_nodes (
                id TEXT PRIMARY KEY,
                workspace_id TEXT NOT NULL,
                parent_id TEXT,
                controlled_by_node_id TEXT,
                role TEXT NOT NULL,
                content TEXT NOT NULL DEFAULT '',
                status TEXT,
                thread_id TEXT,
                execution_data_json TEXT,
                payload_json TEXT,
                prompt_tokens INTEGER,
                completion_tokens INTEGER,
                total_tokens INTEGER,
                base_commit_sha TEXT,
                output_commit_sha TEXT,
                base_selected_from_node_id TEXT,
                git_branch_name TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                deleted_at TEXT,
                local_updated_at INTEGER NOT NULL,
                server_ack_at TEXT,
                server_version TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_local_nodes_workspace ON local_nodes(workspace_id, deleted_at, created_at);
            CREATE INDEX IF NOT EXISTS idx_local_nodes_parent ON local_nodes(parent_id);

            CREATE TABLE IF NOT EXISTS thread_sessions (
                id TEXT PRIMARY KEY,
                workspace_id TEXT NOT NULL,
                title TEXT,
                status TEXT NOT NULL DEFAULT 'active',
                base_commit_sha TEXT,
                first_message_id TEXT,
                parent_thread_id TEXT,
                source TEXT NOT NULL DEFAULT 'user',
                anchor_node_id TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                deleted_at TEXT,
                local_updated_at INTEGER NOT NULL,
                server_ack_at TEXT,
                server_version TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_thread_sessions_workspace
                ON thread_sessions(workspace_id, deleted_at, status, updated_at);

            CREATE TABLE IF NOT EXISTS subgraph_thread_conversions (
                id TEXT PRIMARY KEY,
                workspace_id TEXT NOT NULL,
                idempotency_key TEXT NOT NULL,
                root_node_id TEXT NOT NULL,
                source_thread_id TEXT,
                target_thread_id TEXT NOT NULL,
                original_parent_id TEXT NOT NULL,
                moved_node_ids_json TEXT NOT NULL,
                created_at TEXT NOT NULL,
                UNIQUE(workspace_id, idempotency_key),
                UNIQUE(workspace_id, root_node_id)
            );

            CREATE TABLE IF NOT EXISTS local_workspaces (
                id TEXT PRIMARY KEY,
                user_id TEXT,
                name TEXT NOT NULL,
                folder_path TEXT,
                repo_path TEXT,
                local_repo_path TEXT,
                repo_fingerprint TEXT,
                base_commit_sha TEXT,
                connection_status TEXT NOT NULL DEFAULT 'remote_unconnected',
                sync_status TEXT NOT NULL DEFAULT 'local_only',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                deleted_at TEXT,
                local_updated_at INTEGER NOT NULL,
                last_local_change_id TEXT,
                server_workspace_id TEXT,
                server_ack_at TEXT,
                server_version TEXT,
                name_dirty INTEGER NOT NULL DEFAULT 0,
                metadata_dirty INTEGER NOT NULL DEFAULT 0,
                cloud_backup_enabled INTEGER NOT NULL DEFAULT 0,
                cloud_account_id TEXT
            );

            CREATE TABLE IF NOT EXISTS local_sync_events (
                id TEXT PRIMARY KEY,
                workspace_id TEXT,
                user_id TEXT,
                entity_type TEXT NOT NULL,
                entity_id TEXT NOT NULL,
                event_type TEXT NOT NULL,
                payload_json TEXT NOT NULL,
                idempotency_key TEXT NOT NULL UNIQUE,
                cloud_account_id TEXT,
                status TEXT NOT NULL,
                attempt_count INTEGER NOT NULL DEFAULT 0,
                next_attempt_at INTEGER,
                last_error TEXT,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_local_sync_events_due
                ON local_sync_events(status, next_attempt_at, created_at);
            CREATE INDEX IF NOT EXISTS idx_local_sync_events_entity
                ON local_sync_events(entity_type, entity_id, created_at);
            CREATE INDEX IF NOT EXISTS idx_local_sync_events_entity_status_updated
                ON local_sync_events(entity_type, entity_id, status, updated_at);

            CREATE TABLE IF NOT EXISTS local_insights (
                id TEXT PRIMARY KEY,
                workspace_id TEXT NOT NULL,
                agent_type TEXT NOT NULL,
                is_local INTEGER NOT NULL DEFAULT 1,
                content TEXT NOT NULL,
                full_exploration TEXT,
                reasoning TEXT,
                source_workspace_id TEXT,
                source_file_id TEXT,
                parent_node_id TEXT NOT NULL,
                source_run_node_id TEXT,
                validation_results_json TEXT,
                payload_json TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'active',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                deleted_at TEXT,
                local_updated_at INTEGER NOT NULL,
                server_ack_at TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_local_insights_workspace_status
                ON local_insights(workspace_id, status, local_updated_at);
            CREATE INDEX IF NOT EXISTS idx_local_insights_parent
                ON local_insights(workspace_id, parent_node_id);

            CREATE TABLE IF NOT EXISTS background_observations (
                id TEXT PRIMARY KEY,
                workspace_id TEXT NOT NULL,
                source_node_id TEXT NOT NULL,
                source_event_type TEXT NOT NULL,
                summary TEXT NOT NULL,
                created_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_background_observations_workspace_source
                ON background_observations(workspace_id, source_node_id, created_at);

            CREATE TABLE IF NOT EXISTS insight_candidates (
                id TEXT PRIMARY KEY,
                workspace_id TEXT NOT NULL,
                parent_node_id TEXT NOT NULL,
                agent_kind TEXT NOT NULL,
                claim TEXT NOT NULL,
                rationale TEXT,
                status TEXT NOT NULL DEFAULT 'seed',
                novelty_score REAL NOT NULL DEFAULT 0.5,
                relevance_score REAL NOT NULL DEFAULT 0.5,
                actionability_score REAL NOT NULL DEFAULT 0.5,
                risk_score REAL NOT NULL DEFAULT 0.5,
                timing_score REAL NOT NULL DEFAULT 0.5,
                confidence REAL NOT NULL DEFAULT 0.5,
                source_run_node_id TEXT,
                payload_json TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                deleted_at TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_insight_candidates_workspace_status
                ON insight_candidates(workspace_id, status, updated_at);
            CREATE INDEX IF NOT EXISTS idx_insight_candidates_parent
                ON insight_candidates(workspace_id, parent_node_id, status);

            CREATE TABLE IF NOT EXISTS insight_explorations (
                id TEXT PRIMARY KEY,
                candidate_id TEXT NOT NULL,
                run_node_id TEXT,
                exploration_type TEXT NOT NULL,
                content_json TEXT NOT NULL,
                created_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_insight_explorations_candidate
                ON insight_explorations(candidate_id, created_at);

            CREATE TABLE IF NOT EXISTS surfaced_insights (
                id TEXT PRIMARY KEY,
                candidate_id TEXT NOT NULL UNIQUE,
                workspace_id TEXT NOT NULL,
                surface_reason TEXT NOT NULL,
                priority REAL NOT NULL,
                seen_at TEXT,
                acted_at TEXT,
                dismissed_at TEXT,
                promoted_node_id TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_surfaced_insights_workspace_active
                ON surfaced_insights(workspace_id, dismissed_at, priority, updated_at);

            CREATE TABLE IF NOT EXISTS insight_feedback (
                id TEXT PRIMARY KEY,
                insight_id TEXT NOT NULL,
                action TEXT NOT NULL,
                context_json TEXT,
                created_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_insight_feedback_insight
                ON insight_feedback(insight_id, created_at);

            CREATE TABLE IF NOT EXISTS local_commits (
                workspace_id TEXT NOT NULL,
                sha TEXT NOT NULL,
                subject TEXT,
                author_name TEXT,
                author_email TEXT,
                authored_at TEXT,
                committed_at TEXT,
                source_kind TEXT NOT NULL DEFAULT 'unknown',
                produced_by_node_id TEXT,
                first_parent_sha TEXT,
                files_changed_count INTEGER,
                total_additions INTEGER,
                total_deletions INTEGER,
                local_updated_at INTEGER NOT NULL,
                server_ack_at TEXT,
                PRIMARY KEY (workspace_id, sha)
            );
            CREATE INDEX IF NOT EXISTS idx_local_commits_workspace_first_parent
                ON local_commits(workspace_id, first_parent_sha);
            CREATE INDEX IF NOT EXISTS idx_local_commits_workspace_produced_by_node
                ON local_commits(workspace_id, produced_by_node_id);

            CREATE TABLE IF NOT EXISTS local_commit_parents (
                workspace_id TEXT NOT NULL,
                child_sha TEXT NOT NULL,
                parent_sha TEXT NOT NULL,
                parent_index INTEGER NOT NULL,
                local_updated_at INTEGER NOT NULL,
                server_ack_at TEXT,
                PRIMARY KEY (workspace_id, child_sha, parent_index)
            );
            CREATE INDEX IF NOT EXISTS idx_local_commit_parents_parent
                ON local_commit_parents(workspace_id, parent_sha);

            CREATE TABLE IF NOT EXISTS local_commit_observations (
                workspace_id TEXT NOT NULL,
                commit_sha TEXT NOT NULL,
                git_ref TEXT,
                source_kind TEXT NOT NULL DEFAULT 'unknown',
                first_seen_at INTEGER NOT NULL,
                last_seen_at INTEGER NOT NULL,
                server_ack_at TEXT,
                PRIMARY KEY (workspace_id, commit_sha, git_ref, source_kind)
            );
            "#,
        )
        .map_err(|e| e.to_string())?;
        let _ = conn.execute("ALTER TABLE local_workspaces ADD COLUMN user_id TEXT", []);
        let _ = conn.execute(
            "ALTER TABLE local_workspaces ADD COLUMN local_repo_path TEXT",
            [],
        );
        let _ = conn.execute(
            "ALTER TABLE local_workspaces ADD COLUMN repo_fingerprint TEXT",
            [],
        );
        let _ = conn.execute(
            "ALTER TABLE local_workspaces ADD COLUMN connection_status TEXT NOT NULL DEFAULT 'remote_unconnected'",
            [],
        );
        let _ = conn.execute(
            "ALTER TABLE local_workspaces ADD COLUMN sync_status TEXT NOT NULL DEFAULT 'local_only'",
            [],
        );
        let _ = conn.execute(
            "ALTER TABLE local_workspaces ADD COLUMN last_local_change_id TEXT",
            [],
        );
        let _ = conn.execute(
            "ALTER TABLE local_workspaces ADD COLUMN server_workspace_id TEXT",
            [],
        );
        let _ = conn.execute(
            "ALTER TABLE local_workspaces ADD COLUMN name_dirty INTEGER NOT NULL DEFAULT 0",
            [],
        );
        let _ = conn.execute(
            "ALTER TABLE local_workspaces ADD COLUMN metadata_dirty INTEGER NOT NULL DEFAULT 0",
            [],
        );
        let _ = conn.execute(
            "ALTER TABLE local_workspaces ADD COLUMN cloud_backup_enabled INTEGER NOT NULL DEFAULT 0",
            [],
        );
        let _ = conn.execute(
            "ALTER TABLE local_workspaces ADD COLUMN cloud_account_id TEXT",
            [],
        );
        let _ = conn.execute(
            "ALTER TABLE local_sync_events ADD COLUMN cloud_account_id TEXT",
            [],
        );
        let _ = Self::repair_local_workspace_repo_paths(&conn);
        let _ = conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_local_workspaces_user_status ON local_workspaces(user_id, deleted_at, connection_status, updated_at)",
            [],
        );
        let _ = conn.execute("ALTER TABLE local_nodes ADD COLUMN payload_json TEXT", []);
        let _ = conn.execute(
            "ALTER TABLE thread_sessions ADD COLUMN parent_thread_id TEXT",
            [],
        );
        let _ = conn.execute(
            "ALTER TABLE thread_sessions ADD COLUMN anchor_node_id TEXT",
            [],
        );
        let _ = conn.execute("ALTER TABLE local_sync_events ADD COLUMN user_id TEXT", []);
        let _ = conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_local_sync_events_due_user ON local_sync_events(user_id, status, next_attempt_at, created_at)",
            [],
        );
        let _ = conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_local_sync_events_entity_status_updated ON local_sync_events(entity_type, entity_id, status, updated_at)",
            [],
        );
        let _ = conn.execute(
            "ALTER TABLE agent_run_ledger ADD COLUMN output_commit_sha TEXT",
            [],
        );
        let _ = conn.execute(
            "ALTER TABLE agent_run_ledger ADD COLUMN login_profile_id TEXT",
            [],
        );
        let _ = conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_agent_run_ledger_login_profile ON agent_run_ledger(login_profile_id, status, updated_at)",
            [],
        );
        let _ = conn.execute(
            "ALTER TABLE local_nodes ADD COLUMN base_commit_sha TEXT",
            [],
        );
        let _ = conn.execute(
            "ALTER TABLE local_nodes ADD COLUMN output_commit_sha TEXT",
            [],
        );
        let _ = conn.execute(
            "ALTER TABLE local_nodes ADD COLUMN base_selected_from_node_id TEXT",
            [],
        );
        let _ = conn.execute("ALTER TABLE local_nodes ADD COLUMN thread_id TEXT", []);
        let _ = conn.execute(
            "ALTER TABLE local_nodes ADD COLUMN controlled_by_node_id TEXT",
            [],
        );
        let _ = conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_local_nodes_thread ON local_nodes(workspace_id, thread_id)",
            [],
        );
        let _ = conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_local_nodes_controlled_by ON local_nodes(controlled_by_node_id)",
            [],
        );
        let _ = conn.execute(
            "ALTER TABLE thread_sessions ADD COLUMN parent_thread_id TEXT",
            [],
        );
        let _ = conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_thread_sessions_parent ON thread_sessions(parent_thread_id, deleted_at, updated_at)",
            [],
        );
        let _ = conn.execute(
            "UPDATE agent_run_ledger SET output_commit_sha = commit_sha WHERE output_commit_sha IS NULL AND commit_sha IS NOT NULL",
            [],
        );
        let _ = conn.execute(
            "UPDATE local_nodes SET output_commit_sha = git_commit_sha WHERE output_commit_sha IS NULL AND git_commit_sha IS NOT NULL",
            [],
        );
        let _ = conn.execute(
            "UPDATE local_nodes SET output_commit_sha = json_extract(payload_json, '$.git_commit_sha') WHERE output_commit_sha IS NULL AND json_extract(payload_json, '$.git_commit_sha') IS NOT NULL",
            [],
        );
        let _ = conn.execute(
            "UPDATE local_nodes SET output_commit_sha = json_extract(payload_json, '$.gitCommitSha') WHERE output_commit_sha IS NULL AND json_extract(payload_json, '$.gitCommitSha') IS NOT NULL",
            [],
        );

        conn.execute(
            r#"
            INSERT OR IGNORE INTO local_nodes (
                id, workspace_id, parent_id, controlled_by_node_id, role, content, status, thread_id,
                execution_data_json, payload_json, prompt_tokens, completion_tokens, total_tokens,
                base_commit_sha, output_commit_sha, base_selected_from_node_id, git_branch_name, created_at, updated_at,
                deleted_at, local_updated_at, server_ack_at
            )
            SELECT
                node_id,
                workspace_id,
                json_extract(payload, '$.parentId'),
                COALESCE(
                    json_extract(payload, '$.controlled_by_node_id'),
                    json_extract(payload, '$.controlledByNodeId'),
                    json_extract(payload, '$.execution_data.meta.controlled_by_node_id'),
                    json_extract(payload, '$.execution_data.meta.controlledByNodeId'),
                    json_extract(payload, '$.execution_data.meta.controlled_by'),
                    json_extract(payload, '$.execution_data.meta.controlledBy')
                ),
                COALESCE(json_extract(payload, '$.role'), 'assistant'),
                COALESCE(json_extract(payload, '$.content'), ''),
                json_extract(payload, '$.status'),
                COALESCE(json_extract(payload, '$.threadId'), json_extract(payload, '$.thread_id')),
                json_extract(payload, '$.execution_data'),
                payload,
                json_extract(payload, '$.promptTokens'),
                json_extract(payload, '$.completionTokens'),
                json_extract(payload, '$.totalTokens'),
                json_extract(payload, '$.base_commit_sha'),
                json_extract(payload, '$.output_commit_sha'),
                json_extract(payload, '$.base_selected_from_node_id'),
                json_extract(payload, '$.git_branch_name'),
                COALESCE(json_extract(payload, '$.createdAt'), datetime(finalized_at, 'unixepoch')),
                COALESCE(json_extract(payload, '$.updatedAt'), datetime(finalized_at, 'unixepoch')),
                NULL,
                finalized_at,
                server_ack_at
            FROM local_authoritative_nodes
            "#,
            [],
        )
        .map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE local_sync_events SET status = 'pending' WHERE status = 'in_flight'",
            [],
        )
        .map_err(|e| e.to_string())?;

        Ok(Self {
            conn: Mutex::new(conn),
            db_path,
        })
    }

    pub fn path(&self) -> String {
        self.db_path.to_string_lossy().to_string()
    }

    pub fn ensure_session(
        &self,
        session_id: &str,
        repo_path: Option<&str>,
        worktree_path: Option<&str>,
    ) -> Result<(), String> {
        let now = unix_timestamp();
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            r#"
            INSERT INTO session_status (session_id, status, created_at, repo_path, worktree_path)
            VALUES (?1, 'running', ?2, ?3, ?4)
            ON CONFLICT(session_id) DO UPDATE SET
                repo_path = COALESCE(excluded.repo_path, session_status.repo_path),
                worktree_path = COALESCE(excluded.worktree_path, session_status.worktree_path)
            "#,
            params![session_id, now, repo_path, worktree_path],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn log_event(&self, session_id: &str, event_type: &str, data: &str) -> Result<(), String> {
        self.ensure_session(session_id, None, None)?;
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO agent_events (session_id, event_type, data, timestamp) VALUES (?1, ?2, ?3, ?4)",
            params![session_id, event_type, data, unix_timestamp()],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn record_tool_call(
        &self,
        session_id: &str,
        name: &str,
        parameters: Option<&str>,
        result: Option<&str>,
        error: Option<&str>,
        started_at: i64,
        completed_at: i64,
    ) -> Result<i64, String> {
        self.ensure_session(session_id, None, None)?;
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let duration_ms = (completed_at - started_at).max(0) * 1000;
        conn.execute(
            r#"
            INSERT INTO tool_calls (session_id, name, parameters, result, error, started_at, completed_at, duration_ms)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
            "#,
            params![session_id, name, parameters, result, error, started_at, completed_at, duration_ms],
        )
        .map_err(|e| e.to_string())?;
        Ok(conn.last_insert_rowid())
    }

    pub fn kv_set(&self, session_id: &str, key: &str, value: &str) -> Result<(), String> {
        self.ensure_session(session_id, None, None)?;
        let now = unix_timestamp();
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            r#"
            INSERT INTO session_kv (session_id, key, value, created_at, updated_at)
            VALUES (?1, ?2, ?3, ?4, ?4)
            ON CONFLICT(session_id, key) DO UPDATE SET
                value = excluded.value,
                updated_at = excluded.updated_at
            "#,
            params![session_id, key, value, now],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn kv_get(&self, session_id: &str, key: &str) -> Result<Option<String>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.query_row(
            "SELECT value FROM session_kv WHERE session_id = ?1 AND key = ?2",
            params![session_id, key],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|e| e.to_string())
    }

    pub fn local_app_kv_set(&self, key: &str, value: &str) -> Result<(), String> {
        let now = unix_timestamp();
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            r#"
            INSERT INTO local_app_kv (key, value, created_at, updated_at)
            VALUES (?1, ?2, ?3, ?3)
            ON CONFLICT(key) DO UPDATE SET
                value = excluded.value,
                updated_at = excluded.updated_at
            "#,
            params![key, value, now],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn local_app_kv_get(&self, key: &str) -> Result<Option<String>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.query_row(
            "SELECT value FROM local_app_kv WHERE key = ?1",
            params![key],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|e| e.to_string())
    }

    pub fn add_message(
        &self,
        session_id: &str,
        role: &str,
        content: &str,
        metadata: Option<&str>,
    ) -> Result<i64, String> {
        self.ensure_session(session_id, None, None)?;
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            r#"
            INSERT INTO local_messages (session_id, role, content, timestamp, metadata)
            VALUES (?1, ?2, ?3, ?4, ?5)
            "#,
            params![session_id, role, content, unix_timestamp(), metadata],
        )
        .map_err(|e| e.to_string())?;
        Ok(conn.last_insert_rowid())
    }

    pub fn update_session_status(
        &self,
        session_id: &str,
        status: &str,
        repo_path: Option<&str>,
        worktree_path: Option<&str>,
    ) -> Result<(), String> {
        self.ensure_session(session_id, repo_path, worktree_path)?;
        let completed_at = match status {
            "completed" | "failed" | "cancelled" | "error" => Some(unix_timestamp()),
            _ => None,
        };
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            r#"
            UPDATE session_status
            SET status = ?2,
                completed_at = COALESCE(?3, completed_at),
                repo_path = COALESCE(?4, repo_path),
                worktree_path = COALESCE(?5, worktree_path)
            WHERE session_id = ?1
            "#,
            params![session_id, status, completed_at, repo_path, worktree_path],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn get_session_snapshot(
        &self,
        session_id: &str,
    ) -> Result<Option<TelemetrySessionSnapshot>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let session_row = conn
            .query_row(
                r#"
                SELECT session_id, status, created_at, completed_at, worktree_path, repo_path
                FROM session_status
                WHERE session_id = ?1
                "#,
                params![session_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, i64>(2)?,
                        row.get::<_, Option<i64>>(3)?,
                        row.get::<_, Option<String>>(4)?,
                        row.get::<_, Option<String>>(5)?,
                    ))
                },
            )
            .optional()
            .map_err(|e| e.to_string())?;

        let Some((session_id, status, created_at, completed_at, worktree_path, repo_path)) =
            session_row
        else {
            return Ok(None);
        };

        let mut stmt = conn
            .prepare(
                r#"
                SELECT event_type, data, timestamp
                FROM agent_events
                WHERE session_id = ?1
                ORDER BY timestamp ASC, id ASC
                "#,
            )
            .map_err(|e| e.to_string())?;
        let events = stmt
            .query_map(params![session_id.clone()], |row| {
                Ok(TelemetryEventRow {
                    event_type: row.get(0)?,
                    data: row.get(1)?,
                    timestamp: row.get(2)?,
                })
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;

        Ok(Some(TelemetrySessionSnapshot {
            session_id,
            status,
            created_at,
            completed_at,
            worktree_path,
            repo_path,
            events,
        }))
    }

    pub fn upsert_agent_run_ledger(&self, run: &AgentRunLedgerUpsert) -> Result<(), String> {
        let now = unix_timestamp();
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            r#"
            INSERT INTO agent_run_ledger (
                run_id, user_node_id, assistant_node_id, workspace_id, repo_path,
                worktree_path, branch_name, parent_commit, pid, agent_type,
                status, phase, started_at, updated_at, login_profile_id
            )
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?13, ?14)
            ON CONFLICT(run_id) DO UPDATE SET
                user_node_id = COALESCE(excluded.user_node_id, agent_run_ledger.user_node_id),
                assistant_node_id = excluded.assistant_node_id,
                workspace_id = COALESCE(excluded.workspace_id, agent_run_ledger.workspace_id),
                repo_path = COALESCE(excluded.repo_path, agent_run_ledger.repo_path),
                worktree_path = COALESCE(excluded.worktree_path, agent_run_ledger.worktree_path),
                branch_name = COALESCE(excluded.branch_name, agent_run_ledger.branch_name),
                parent_commit = COALESCE(excluded.parent_commit, agent_run_ledger.parent_commit),
                pid = COALESCE(excluded.pid, agent_run_ledger.pid),
                agent_type = COALESCE(excluded.agent_type, agent_run_ledger.agent_type),
                status = excluded.status,
                phase = excluded.phase,
                login_profile_id = COALESCE(excluded.login_profile_id, agent_run_ledger.login_profile_id),
                updated_at = excluded.updated_at
            "#,
            params![
                run.run_id,
                run.user_node_id,
                run.assistant_node_id,
                run.workspace_id,
                run.repo_path,
                run.worktree_path,
                run.branch_name,
                run.parent_commit,
                run.pid,
                run.agent_type,
                run.status,
                run.phase,
                now,
                run.login_profile_id,
            ],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Atomically claims an assistant node for its one durable run and records
    /// the initial lifecycle event. Replaying the same run is idempotent; a
    /// different run can never replace the node's ledger or live worktree.
    pub(crate) fn admit_agent_run(
        &self,
        run: &AgentRunLedgerUpsert,
        accepted_event_payload: &str,
    ) -> Result<AgentRunAdmission, String> {
        let now = unix_timestamp();
        let admitted_at = utc_iso_now();
        let mut conn = self.conn.lock().map_err(|e| e.to_string())?;
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|e| e.to_string())?;

        let existing_run = tx
            .query_row(
                r#"
                SELECT assistant_node_id, worktree_path, branch_name, status, pid
                FROM agent_run_ledger
                WHERE run_id = ?1
                "#,
                params![run.run_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, Option<String>>(1)?,
                        row.get::<_, Option<String>>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, Option<i64>>(4)?,
                    ))
                },
            )
            .optional()
            .map_err(|e| e.to_string())?;

        if let Some((assistant_node_id, worktree_path, branch_name, status, pid)) = existing_run {
            if assistant_node_id != run.assistant_node_id {
                return Err(format!(
                    "Agent run {} already belongs to assistant node {}; refusing to reuse it for {}.",
                    run.run_id, assistant_node_id, run.assistant_node_id
                ));
            }
            tx.commit().map_err(|e| e.to_string())?;
            return Ok(AgentRunAdmission::Existing {
                worktree_path,
                branch_name,
                status,
                pid,
            });
        }

        let existing_node_run = tx
            .query_row(
                r#"
                SELECT run_id, status
                FROM agent_run_ledger
                WHERE assistant_node_id = ?1
                "#,
                params![run.assistant_node_id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()
            .map_err(|e| e.to_string())?;

        if let Some((existing_run_id, status)) = existing_node_run {
            return Err(format!(
                "Assistant node {} already belongs to run {} (status: {}); refusing to start conflicting run {}.",
                run.assistant_node_id, existing_run_id, status, run.run_id
            ));
        }

        tx.execute(
            r#"
            INSERT INTO agent_run_ledger (
                run_id, user_node_id, assistant_node_id, workspace_id, repo_path,
                worktree_path, branch_name, parent_commit, pid, agent_type,
                status, phase, last_seq, started_at, updated_at, login_profile_id
            )
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, 1, ?13, ?13, ?14)
            "#,
            params![
                run.run_id,
                run.user_node_id,
                run.assistant_node_id,
                run.workspace_id,
                run.repo_path,
                run.worktree_path,
                run.branch_name,
                run.parent_commit,
                run.pid,
                run.agent_type,
                run.status,
                run.phase,
                now,
                run.login_profile_id,
            ],
        )
        .map_err(|e| e.to_string())?;
        tx.execute(
            r#"
            INSERT INTO agent_run_events (
                run_id, assistant_node_id, seq, event_type, status, phase, payload, timestamp
            )
            VALUES (?1, ?2, 1, 'agent:lifecycle', 'accepted', 'accepted', ?3, ?4)
            "#,
            params![
                run.run_id,
                run.assistant_node_id,
                accepted_event_payload,
                now
            ],
        )
        .map_err(|e| e.to_string())?;
        tx.execute(
            r#"
            UPDATE local_nodes
            SET
                payload_json = json_set(
                    CASE WHEN json_valid(COALESCE(payload_json, ''))
                        THEN json(payload_json) ELSE json('{}') END,
                    '$.execution_data.meta.prelaunch_run_id', ?2,
                    '$.execution_data.meta.prelaunch_stage', 'native_run_admitted',
                    '$.execution_data.meta.prelaunch_stage_at', ?3
                ),
                execution_data_json = json_set(
                    CASE WHEN json_valid(COALESCE(execution_data_json, ''))
                        THEN json(execution_data_json) ELSE json('{}') END,
                    '$.meta.prelaunch_run_id', ?2,
                    '$.meta.prelaunch_stage', 'native_run_admitted',
                    '$.meta.prelaunch_stage_at', ?3
                )
            WHERE id = ?1 AND deleted_at IS NULL
            "#,
            params![run.assistant_node_id, run.run_id, admitted_at],
        )
        .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(AgentRunAdmission::Accepted)
    }

    pub(crate) fn claim_agent_launch_request(
        &self,
        request_id: &str,
        workspace_id: &str,
        thread_id: Option<&str>,
        user_node_id: &str,
        assistant_node_id: &str,
        run_id: &str,
        request_json: &str,
        lease_owner: &str,
        lease_duration_seconds: i64,
    ) -> Result<AgentLaunchClaim, String> {
        let now = unix_timestamp();
        let lease_expires_at = now.saturating_add(lease_duration_seconds.max(1));
        let mut conn = self.conn.lock().map_err(|error| error.to_string())?;
        let tx = conn.transaction().map_err(|error| error.to_string())?;
        tx.execute(
            r#"
            INSERT INTO agent_launch_requests (
                request_id, workspace_id, thread_id, user_node_id, assistant_node_id,
                run_id, status, request_json, lease_owner, lease_expires_at,
                created_at, updated_at
            )
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'preparing', ?7, ?8, ?9, ?10, ?10)
            ON CONFLICT(request_id) DO NOTHING
            "#,
            params![
                request_id,
                workspace_id,
                thread_id,
                user_node_id,
                assistant_node_id,
                run_id,
                request_json,
                lease_owner,
                lease_expires_at,
                now,
            ],
        )
        .map_err(|error| error.to_string())?;

        let mut row = tx
            .query_row(
                r#"
                SELECT request_id, workspace_id, thread_id, user_node_id,
                       assistant_node_id, run_id, status, request_json,
                       failure_reason, lease_owner, lease_expires_at
                FROM agent_launch_requests
                WHERE request_id = ?1
                "#,
                params![request_id],
                |row| {
                    Ok(AgentLaunchRequestRow {
                        request_id: row.get(0)?,
                        workspace_id: row.get(1)?,
                        thread_id: row.get(2)?,
                        user_node_id: row.get(3)?,
                        assistant_node_id: row.get(4)?,
                        run_id: row.get(5)?,
                        status: row.get(6)?,
                        request_json: row.get(7)?,
                        failure_reason: row.get(8)?,
                        lease_owner: row.get(9)?,
                        lease_expires_at: row.get(10)?,
                    })
                },
            )
            .map_err(|error| error.to_string())?;

        if row.workspace_id != workspace_id
            || row.thread_id.as_deref() != thread_id
            || row.user_node_id != user_node_id
            || row.assistant_node_id != assistant_node_id
            || row.run_id != run_id
        {
            return Err(format!(
                "Launch request {request_id} was already used with different launch parameters."
            ));
        }

        let owns_current_lease = row.lease_owner.as_deref() == Some(lease_owner);
        let lease_expired = row.lease_expires_at.unwrap_or(0) <= now;
        let recoverable = matches!(row.status.as_str(), "preparing" | "starting");
        let acquired = owns_current_lease || (recoverable && lease_expired);
        if acquired && !owns_current_lease {
            tx.execute(
                r#"
                UPDATE agent_launch_requests
                SET lease_owner = ?2,
                    lease_expires_at = ?3,
                    request_json = ?4,
                    updated_at = ?5
                WHERE request_id = ?1
                  AND status IN ('preparing', 'starting')
                  AND COALESCE(lease_expires_at, 0) <= ?5
                "#,
                params![request_id, lease_owner, lease_expires_at, request_json, now],
            )
            .map_err(|error| error.to_string())?;
            row.lease_owner = Some(lease_owner.to_string());
            row.lease_expires_at = Some(lease_expires_at);
            row.request_json = request_json.to_string();
        }
        tx.commit().map_err(|error| error.to_string())?;
        Ok(AgentLaunchClaim { row, acquired })
    }

    pub(crate) fn get_agent_launch_request(
        &self,
        request_id: &str,
    ) -> Result<Option<AgentLaunchRequestRow>, String> {
        let conn = self.conn.lock().map_err(|error| error.to_string())?;
        conn.query_row(
            r#"
            SELECT request_id, workspace_id, thread_id, user_node_id,
                   assistant_node_id, run_id, status, request_json,
                   failure_reason, lease_owner, lease_expires_at
            FROM agent_launch_requests
            WHERE request_id = ?1
            "#,
            params![request_id],
            |row| {
                Ok(AgentLaunchRequestRow {
                    request_id: row.get(0)?,
                    workspace_id: row.get(1)?,
                    thread_id: row.get(2)?,
                    user_node_id: row.get(3)?,
                    assistant_node_id: row.get(4)?,
                    run_id: row.get(5)?,
                    status: row.get(6)?,
                    request_json: row.get(7)?,
                    failure_reason: row.get(8)?,
                    lease_owner: row.get(9)?,
                    lease_expires_at: row.get(10)?,
                })
            },
        )
        .optional()
        .map_err(|error| error.to_string())
    }

    pub(crate) fn list_expired_agent_launch_requests(
        &self,
        limit: usize,
    ) -> Result<Vec<AgentLaunchRequestRow>, String> {
        let now = unix_timestamp();
        let conn = self.conn.lock().map_err(|error| error.to_string())?;
        let mut stmt = conn
            .prepare(
                r#"
                SELECT request_id, workspace_id, thread_id, user_node_id,
                       assistant_node_id, run_id, status, request_json,
                       failure_reason, lease_owner, lease_expires_at
                FROM agent_launch_requests
                WHERE status IN ('preparing', 'starting')
                  AND COALESCE(lease_expires_at, 0) <= ?1
                ORDER BY updated_at ASC
                LIMIT ?2
                "#,
            )
            .map_err(|error| error.to_string())?;
        let rows = stmt
            .query_map(params![now, limit.max(1) as i64], |row| {
                Ok(AgentLaunchRequestRow {
                    request_id: row.get(0)?,
                    workspace_id: row.get(1)?,
                    thread_id: row.get(2)?,
                    user_node_id: row.get(3)?,
                    assistant_node_id: row.get(4)?,
                    run_id: row.get(5)?,
                    status: row.get(6)?,
                    request_json: row.get(7)?,
                    failure_reason: row.get(8)?,
                    lease_owner: row.get(9)?,
                    lease_expires_at: row.get(10)?,
                })
            })
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        Ok(rows)
    }

    pub(crate) fn reconcile_agent_launch_request_accepted(
        &self,
        request_id: &str,
    ) -> Result<(), String> {
        let now = unix_timestamp();
        let conn = self.conn.lock().map_err(|error| error.to_string())?;
        conn.execute(
            r#"
            UPDATE agent_launch_requests
            SET status = 'accepted',
                failure_reason = NULL,
                lease_owner = NULL,
                lease_expires_at = NULL,
                updated_at = ?2
            WHERE request_id = ?1
              AND EXISTS (
                SELECT 1
                FROM agent_run_ledger AS ledger
                WHERE ledger.assistant_node_id = agent_launch_requests.assistant_node_id
              )
            "#,
            params![request_id, now],
        )
        .map_err(|error| error.to_string())?;
        Ok(())
    }

    pub(crate) fn update_agent_launch_request(
        &self,
        request_id: &str,
        lease_owner: &str,
        status: &str,
        failure_reason: Option<&str>,
    ) -> Result<(), String> {
        let now = unix_timestamp();
        let conn = self.conn.lock().map_err(|error| error.to_string())?;
        let changed = conn
            .execute(
                r#"
                UPDATE agent_launch_requests
                SET status = ?3,
                    failure_reason = ?4,
                    lease_owner = CASE WHEN ?3 IN ('accepted', 'failed') THEN NULL ELSE lease_owner END,
                    lease_expires_at = CASE WHEN ?3 IN ('accepted', 'failed') THEN NULL ELSE lease_expires_at END,
                    updated_at = ?5
                WHERE request_id = ?1
                  AND lease_owner = ?2
                "#,
                params![request_id, lease_owner, status, failure_reason, now],
            )
            .map_err(|error| error.to_string())?;
        if changed == 0 {
            return Err(format!(
                "Launch request {request_id} is no longer owned by this launcher."
            ));
        }
        Ok(())
    }

    pub(crate) fn renew_agent_launch_request_lease(
        &self,
        request_id: &str,
        lease_owner: &str,
        lease_duration_seconds: i64,
    ) -> Result<bool, String> {
        let now = unix_timestamp();
        let lease_expires_at = now.saturating_add(lease_duration_seconds.max(1));
        let conn = self.conn.lock().map_err(|error| error.to_string())?;
        let changed = conn
            .execute(
                r#"
                UPDATE agent_launch_requests
                SET lease_expires_at = ?3,
                    updated_at = ?4
                WHERE request_id = ?1
                  AND lease_owner = ?2
                  AND status IN ('preparing', 'starting')
                "#,
                params![request_id, lease_owner, lease_expires_at, now],
            )
            .map_err(|error| error.to_string())?;
        Ok(changed == 1)
    }

    pub fn list_login_profiles(&self) -> Result<Vec<crate::login_profiles::LoginProfile>, String> {
        let conn = self.conn.lock().map_err(|error| error.to_string())?;
        let mut stmt = conn
            .prepare(
                r#"
                SELECT id, provider, display_name, auth_type, redacted_hint, config_json,
                       status, status_message, plan_type, is_default, created_at, updated_at, last_checked_at
                FROM login_profiles
                ORDER BY provider, is_default DESC, updated_at DESC
                "#,
            )
            .map_err(|error| error.to_string())?;
        let rows = stmt
            .query_map([], login_profile_from_row)
            .map_err(|error| error.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())
    }

    pub fn get_login_profile(
        &self,
        profile_id: &str,
    ) -> Result<crate::login_profiles::LoginProfile, String> {
        let conn = self.conn.lock().map_err(|error| error.to_string())?;
        conn.query_row(
            r#"
            SELECT id, provider, display_name, auth_type, redacted_hint, config_json,
                   status, status_message, plan_type, is_default, created_at, updated_at, last_checked_at
            FROM login_profiles
            WHERE id = ?1
            "#,
            params![profile_id],
            login_profile_from_row,
        )
        .optional()
        .map_err(|error| error.to_string())?
        .ok_or_else(|| format!("login profile not found: {}", profile_id))
    }

    pub fn upsert_login_profile_metadata(
        &self,
        profile: &crate::login_profiles::LoginProfile,
        secret_ref: Option<&str>,
    ) -> Result<crate::login_profiles::LoginProfile, String> {
        self.write_login_profile_metadata(profile, secret_ref, true)
    }

    fn write_login_profile_metadata(
        &self,
        profile: &crate::login_profiles::LoginProfile,
        secret_ref: Option<&str>,
        clear_provider_default: bool,
    ) -> Result<crate::login_profiles::LoginProfile, String> {
        let conn = self.conn.lock().map_err(|error| error.to_string())?;
        let tx = conn
            .unchecked_transaction()
            .map_err(|error| error.to_string())?;
        if clear_provider_default && profile.is_default {
            tx.execute(
                "UPDATE login_profiles SET is_default = 0, updated_at = ?2 WHERE provider = ?1",
                params![profile.provider, unix_timestamp()],
            )
            .map_err(|error| error.to_string())?;
        }
        let config_json =
            serde_json::to_string(&profile.config).map_err(|error| error.to_string())?;
        tx.execute(
            r#"
            INSERT INTO login_profiles (
                id, provider, display_name, auth_type, secret_ref, redacted_hint, config_json,
                status, status_message, plan_type, is_default, created_at, updated_at, last_checked_at
            )
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
            ON CONFLICT(id) DO UPDATE SET
                display_name = excluded.display_name,
                auth_type = excluded.auth_type,
                secret_ref = COALESCE(excluded.secret_ref, login_profiles.secret_ref),
                redacted_hint = COALESCE(excluded.redacted_hint, login_profiles.redacted_hint),
                config_json = excluded.config_json,
                status = excluded.status,
                status_message = excluded.status_message,
                plan_type = excluded.plan_type,
                is_default = excluded.is_default,
                updated_at = excluded.updated_at,
                last_checked_at = excluded.last_checked_at
            "#,
            params![
                profile.id,
                profile.provider,
                profile.display_name,
                profile.auth_type,
                secret_ref,
                profile.redacted_hint,
                config_json,
                profile.status,
                profile.status_message,
                profile.plan_type,
                if profile.is_default { 1 } else { 0 },
                profile.created_at,
                profile.updated_at,
                profile.last_checked_at,
            ],
        )
        .map_err(|error| error.to_string())?;
        tx.commit().map_err(|error| error.to_string())?;
        drop(conn);
        self.get_login_profile(&profile.id)
    }

    pub(crate) fn delete_login_profile_metadata(
        &self,
        profile_id: &str,
    ) -> Result<Option<DeletedLoginProfileMetadata>, String> {
        let active_runs = self
            .list_active_login_profile_runs()?
            .into_iter()
            .filter(|run| run.login_profile_id == profile_id)
            .collect::<Vec<_>>();
        if !active_runs.is_empty() {
            return Err(format!(
                "cannot delete login profile while {} active run(s) use it",
                active_runs.len()
            ));
        }
        let conn = self.conn.lock().map_err(|error| error.to_string())?;
        let tx = conn
            .unchecked_transaction()
            .map_err(|error| error.to_string())?;
        let deleted = tx
            .query_row(
                r#"
                SELECT id, provider, display_name, auth_type, redacted_hint, config_json,
                       status, status_message, plan_type, is_default, created_at, updated_at,
                       last_checked_at, secret_ref
                FROM login_profiles
                WHERE id = ?1
                "#,
                params![profile_id],
                |row| {
                    Ok(DeletedLoginProfileMetadata {
                        profile: login_profile_from_row(row)?,
                        secret_ref: row.get(13)?,
                    })
                },
            )
            .optional()
            .map_err(|error| error.to_string())?;
        if deleted.is_some() {
            tx.execute(
                "DELETE FROM login_profiles WHERE id = ?1",
                params![profile_id],
            )
            .map_err(|error| error.to_string())?;
        }
        tx.commit().map_err(|error| error.to_string())?;
        Ok(deleted)
    }

    pub(crate) fn restore_login_profile_metadata(
        &self,
        metadata: &DeletedLoginProfileMetadata,
    ) -> Result<(), String> {
        self.write_login_profile_metadata(&metadata.profile, metadata.secret_ref.as_deref(), false)
            .map(|_| ())
    }

    pub fn set_default_login_profile(
        &self,
        provider: &str,
        profile_id: Option<&str>,
    ) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|error| error.to_string())?;
        let tx = conn
            .unchecked_transaction()
            .map_err(|error| error.to_string())?;
        tx.execute(
            "UPDATE login_profiles SET is_default = 0, updated_at = ?2 WHERE provider = ?1",
            params![provider, unix_timestamp()],
        )
        .map_err(|error| error.to_string())?;
        if let Some(profile_id) = profile_id {
            let updated = tx
                .execute(
                    "UPDATE login_profiles SET is_default = 1, updated_at = ?3 WHERE provider = ?1 AND id = ?2",
                    params![provider, profile_id, unix_timestamp()],
                )
                .map_err(|error| error.to_string())?;
            if updated == 0 {
                return Err(format!(
                    "login profile {} does not belong to provider {}",
                    profile_id, provider
                ));
            }
        }
        tx.commit().map_err(|error| error.to_string())
    }

    pub fn mark_login_profile_status(
        &self,
        profile_id: &str,
        status: &str,
        status_message: Option<&str>,
        plan_type: Option<&str>,
        checked_at: i64,
    ) -> Result<crate::login_profiles::LoginProfile, String> {
        let conn = self.conn.lock().map_err(|error| error.to_string())?;
        conn.execute(
            r#"
            UPDATE login_profiles
            SET status = ?2,
                status_message = ?3,
                plan_type = ?4,
                last_checked_at = ?5,
                updated_at = ?5
            WHERE id = ?1
            "#,
            params![profile_id, status, status_message, plan_type, checked_at],
        )
        .map_err(|error| error.to_string())?;
        drop(conn);
        self.get_login_profile(profile_id)
    }

    pub fn list_active_login_profile_runs(
        &self,
    ) -> Result<Vec<crate::login_profiles::ActiveLoginProfileRun>, String> {
        let conn = self.conn.lock().map_err(|error| error.to_string())?;
        let mut stmt = conn
            .prepare(
                r#"
                SELECT login_profile_id, run_id, assistant_node_id, workspace_id, agent_type,
                       status, phase, updated_at
                FROM agent_run_ledger
                WHERE login_profile_id IS NOT NULL
                  AND cleanup_completed = 0
                  AND terminal_status IS NULL
                  AND status NOT IN (
                    'completed', 'cancelled', 'failed', 'error', 'failed_setup',
                    'failed_spawn', 'failed_finalization', 'failed_runtime',
                    'needs_user_action'
                  )
                ORDER BY updated_at DESC
                "#,
            )
            .map_err(|error| error.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                Ok(crate::login_profiles::ActiveLoginProfileRun {
                    login_profile_id: row.get(0)?,
                    run_id: row.get(1)?,
                    assistant_node_id: row.get(2)?,
                    workspace_id: row.get(3)?,
                    agent_type: row.get(4)?,
                    status: row.get(5)?,
                    phase: row.get(6)?,
                    updated_at: row.get(7)?,
                })
            })
            .map_err(|error| error.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())
    }

    pub fn update_agent_run_phase(
        &self,
        assistant_node_id: &str,
        status: &str,
        phase: &str,
        failure_reason: Option<&str>,
    ) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            r#"
            UPDATE agent_run_ledger
            SET status = ?2,
                phase = ?3,
                failure_reason = COALESCE(?4, failure_reason),
                updated_at = ?5
            WHERE assistant_node_id = ?1
            "#,
            params![
                assistant_node_id,
                status,
                phase,
                failure_reason,
                unix_timestamp()
            ],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn mark_agent_run_finalized(
        &self,
        assistant_node_id: &str,
        terminal_status: &str,
        server_final_persisted: bool,
        output_commit_sha: Option<&str>,
    ) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            r#"
            UPDATE agent_run_ledger
            SET status = ?2,
                phase = CASE WHEN cleanup_completed = 1 THEN 'cleaned' ELSE 'terminal' END,
                terminal_status = COALESCE(terminal_status, ?2),
                server_final_persisted = CASE WHEN ?3 THEN 1 ELSE server_final_persisted END,
                output_commit_sha = COALESCE(?4, output_commit_sha),
                needs_user_action_reason = CASE WHEN ?2 = 'completed' THEN NULL ELSE needs_user_action_reason END,
                failure_reason = CASE WHEN ?2 = 'completed' THEN NULL ELSE failure_reason END,
                updated_at = ?5
            WHERE assistant_node_id = ?1
            "#,
            params![
                assistant_node_id,
                terminal_status,
                server_final_persisted,
                output_commit_sha,
                unix_timestamp(),
            ],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn record_agent_run_output_commit(
        &self,
        assistant_node_id: &str,
        output_commit_sha: &str,
    ) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            r#"
            UPDATE agent_run_ledger
            SET output_commit_sha = ?2,
                updated_at = ?3
            WHERE assistant_node_id = ?1
            "#,
            params![assistant_node_id, output_commit_sha, unix_timestamp()],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn increment_agent_run_finalize_attempt(
        &self,
        assistant_node_id: &str,
    ) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            r#"
            UPDATE agent_run_ledger
            SET finalize_attempt_count = finalize_attempt_count + 1,
                updated_at = ?2
            WHERE assistant_node_id = ?1
            "#,
            params![assistant_node_id, unix_timestamp()],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn increment_agent_run_cleanup_attempt(
        &self,
        assistant_node_id: &str,
    ) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            r#"
            UPDATE agent_run_ledger
            SET cleanup_attempt_count = cleanup_attempt_count + 1,
                updated_at = ?2
            WHERE assistant_node_id = ?1
            "#,
            params![assistant_node_id, unix_timestamp()],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn mark_agent_run_cleanup_completed(&self, assistant_node_id: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            r#"
            UPDATE agent_run_ledger
            SET cleanup_completed = 1,
                phase = 'cleaned',
                needs_user_action_reason = NULL,
                updated_at = ?2
            WHERE assistant_node_id = ?1
            "#,
            params![assistant_node_id, unix_timestamp()],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Distinct repo paths that have ever hosted an agent run. Used by the
    /// startup worktree sweep to know which repositories to reconcile.
    pub fn list_agent_run_repo_paths(&self) -> Result<Vec<String>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT DISTINCT repo_path FROM agent_run_ledger \
                 WHERE repo_path IS NOT NULL AND repo_path <> ''",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        let mut paths = Vec::new();
        for row in rows {
            paths.push(row.map_err(|e| e.to_string())?);
        }
        Ok(paths)
    }

    pub fn mark_agent_run_needs_user_action(
        &self,
        assistant_node_id: &str,
        reason: &str,
    ) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            r#"
            UPDATE agent_run_ledger
            SET status = 'needs_user_action',
                phase = 'needs_user_action',
                needs_user_action_reason = ?2,
                updated_at = ?3
            WHERE assistant_node_id = ?1
            "#,
            params![assistant_node_id, reason, unix_timestamp()],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn reconcile_agent_runs_on_startup(&self) -> Result<usize, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut updated = 0;

        updated += conn
            .execute(
                r#"
                UPDATE agent_run_ledger
                SET phase = CASE WHEN cleanup_completed = 1 THEN 'cleaned' ELSE 'terminal' END,
                    status = COALESCE(terminal_status, status),
                    updated_at = ?1
                WHERE server_final_persisted = 1
                  AND terminal_status IS NOT NULL
                  AND status NOT IN ('needs_user_action', 'failed_finalization')
                "#,
                params![unix_timestamp()],
            )
            .map_err(|e| e.to_string())?;

        updated += conn
            .execute(
                r#"
                WITH repaired AS (
                    SELECT
                        n.id,
                        COALESCE(
                            NULLIF(n.content, ''),
                            (
                                SELECT json_extract(e.payload, '$.final_content')
                                FROM agent_run_events e
                                WHERE e.assistant_node_id = n.id
                                  AND e.event_type IN ('provider_stop', 'stop')
                                  AND NULLIF(json_extract(e.payload, '$.final_content'), '') IS NOT NULL
                                ORDER BY e.seq DESC
                                LIMIT 1
                            ),
                            (
                                SELECT json_extract(e.payload, '$.content')
                                FROM agent_run_events e
                                WHERE e.assistant_node_id = n.id
                                  AND e.event_type IN ('message_completed', 'message')
                                  AND NULLIF(json_extract(e.payload, '$.content'), '') IS NOT NULL
                                ORDER BY e.seq DESC
                                LIMIT 1
                            ),
                            ''
                        ) AS content,
                        l.output_commit_sha,
                        l.updated_at
                    FROM local_nodes n
                    JOIN agent_run_ledger l ON l.assistant_node_id = n.id
                    JOIN local_workspaces w ON w.id = l.workspace_id
                    WHERE n.deleted_at IS NULL
                      AND n.status = 'failed'
                      AND l.terminal_status = 'completed'
                      AND w.cloud_backup_enabled = 0
                      AND json_extract(n.execution_data_json, '$.meta.native_recovery_status') IS NOT NULL
                )
                UPDATE local_nodes
                SET status = 'completed',
                    content = (SELECT content FROM repaired WHERE repaired.id = local_nodes.id),
                    output_commit_sha = COALESCE(output_commit_sha, (SELECT output_commit_sha FROM repaired WHERE repaired.id = local_nodes.id)),
                    execution_data_json = json_set(
                        json_remove(
                            CASE
                                WHEN json_valid(COALESCE(execution_data_json, '')) THEN json(execution_data_json)
                                ELSE json_object()
                            END,
                            '$.meta.native_recovery_status',
                            '$.meta.native_recovery_phase',
                            '$.meta.provider_error_message',
                            '$.meta.needs_user_action_reason',
                            '$.meta.failure_reason'
                        ),
                        '$.last_terminal_status',
                        'completed'
                    ),
                    payload_json = json_set(
                        json_remove(
                            CASE
                                WHEN json_valid(COALESCE(payload_json, '')) THEN json(payload_json)
                                ELSE json_object(
                                    'id', id,
                                    'role', role,
                                    'workspaceId', workspace_id,
                                    'parentId', parent_id,
                                    'content', content,
                                    'status', status
                                )
                            END,
                            '$.execution_data.meta.native_recovery_status',
                            '$.execution_data.meta.native_recovery_phase',
                            '$.execution_data.meta.provider_error_message',
                            '$.execution_data.meta.needs_user_action_reason',
                            '$.execution_data.meta.failure_reason'
                        ),
                        '$.status',
                        'completed',
                        '$.content',
                        (SELECT content FROM repaired WHERE repaired.id = local_nodes.id),
                        '$.execution_data.last_terminal_status',
                        'completed',
                        '$.output_commit_sha',
                        (SELECT output_commit_sha FROM repaired WHERE repaired.id = local_nodes.id),
                        '$.outputCommitSha',
                        (SELECT output_commit_sha FROM repaired WHERE repaired.id = local_nodes.id),
                        '$.updatedAt',
                        datetime((SELECT updated_at FROM repaired WHERE repaired.id = local_nodes.id), 'unixepoch')
                    ),
                    updated_at = datetime((SELECT updated_at FROM repaired WHERE repaired.id = local_nodes.id), 'unixepoch'),
                    local_updated_at = (SELECT updated_at FROM repaired WHERE repaired.id = local_nodes.id)
                WHERE id IN (SELECT id FROM repaired)
                "#,
                [],
            )
            .map_err(|e| e.to_string())?;

        updated += conn
            .execute(
                r#"
                UPDATE agent_run_ledger
                SET status = COALESCE(terminal_status, status),
                    phase = CASE WHEN cleanup_completed = 1 THEN 'cleaned' ELSE 'terminal' END,
                    server_final_persisted = 1,
                    failure_reason = NULL,
                    needs_user_action_reason = NULL,
                    updated_at = ?1
                WHERE server_final_persisted = 0
                  AND terminal_status = 'completed'
                  AND EXISTS (
                    SELECT 1
                    FROM local_workspaces w
                    WHERE w.id = agent_run_ledger.workspace_id
                      AND w.cloud_backup_enabled = 0
                  )
                "#,
                params![unix_timestamp()],
            )
            .map_err(|e| e.to_string())?;

        updated += conn
            .execute(
                r#"
                UPDATE agent_run_ledger
                SET status = 'failed_finalization',
                    phase = 'failed_finalization',
                    failure_reason = COALESCE(failure_reason, 'App restarted after native git finalization but before durable server finalization.'),
                    needs_user_action_reason = 'Generated commit exists locally, but server finalization was not durably persisted. Retry finalization before cleanup.',
                    updated_at = ?1
                WHERE cleanup_completed = 0
                  AND server_final_persisted = 0
                  AND output_commit_sha IS NOT NULL
                  AND status NOT IN ('failed_finalization', 'needs_user_action')
                  AND NOT EXISTS (
                    SELECT 1
                    FROM local_sync_events e
                    WHERE e.entity_type = 'node'
                      AND e.entity_id = agent_run_ledger.assistant_node_id
                      AND e.event_type = 'node.update_terminal'
                      AND e.status IN ('pending', 'in_flight')
                  )
                "#,
                params![unix_timestamp()],
            )
            .map_err(|e| e.to_string())?;

        updated += conn
            .execute(
                r#"
                UPDATE agent_run_ledger
                SET status = 'needs_user_action',
                    phase = 'needs_user_action',
                    failure_reason = COALESCE(failure_reason, 'App restarted before the native run reached a terminal state.'),
                    needs_user_action_reason = CASE
                        WHEN worktree_path IS NOT NULL THEN 'App restarted before this run reached a terminal state. The agent worktree is preserved for inspection; automatic process reattach is not available.'
                        ELSE 'App restarted before this run reached a terminal state; automatic process reattach is not available.'
                    END,
                    updated_at = ?1
                WHERE cleanup_completed = 0
                  AND server_final_persisted = 0
                  AND terminal_status IS NULL
                  AND output_commit_sha IS NULL
                  AND status NOT IN (
                    'completed',
                    'failed',
                    'cancelled',
                    'error',
                    'failed_setup',
                    'failed_spawn',
                    'failed_runtime',
                    'needs_user_action'
                  )
                "#,
                params![unix_timestamp()],
            )
            .map_err(|e| e.to_string())?;

        conn.execute(
            r#"
            INSERT INTO local_nodes (
                id, workspace_id, parent_id, role, content, status,
                execution_data_json, payload_json, created_at, updated_at,
                deleted_at, local_updated_at
            )
            SELECT
                assistant_node_id,
                workspace_id,
                user_node_id,
                'assistant',
                '',
                'failed',
                json_object(
                    'last_terminal_status', 'failed',
                    'meta', json_object(
                        'native_recovery_status', status,
                        'native_recovery_phase', phase,
                        'provider_error_message', COALESCE(needs_user_action_reason, failure_reason, 'Native agent run requires attention.'),
                        'needs_user_action_reason', needs_user_action_reason,
                        'failure_reason', failure_reason
                    )
                ),
                json_object(
                    'id', assistant_node_id,
                    'role', 'assistant',
                    'workspaceId', workspace_id,
                    'parentId', user_node_id,
                    'content', '',
                    'status', 'failed',
                    'createdAt', datetime(started_at, 'unixepoch'),
                    'updatedAt', datetime(updated_at, 'unixepoch'),
                    'execution_data', json_object(
                        'last_terminal_status', 'failed',
                        'meta', json_object(
                            'native_recovery_status', status,
                            'native_recovery_phase', phase,
                            'provider_error_message', COALESCE(needs_user_action_reason, failure_reason, 'Native agent run requires attention.'),
                            'needs_user_action_reason', needs_user_action_reason,
                            'failure_reason', failure_reason
                        )
                    )
                ),
                datetime(started_at, 'unixepoch'),
                datetime(updated_at, 'unixepoch'),
                NULL,
                updated_at
            FROM agent_run_ledger
            WHERE workspace_id IS NOT NULL
              AND status IN ('needs_user_action', 'failed_finalization')
            ON CONFLICT(id) DO UPDATE SET
                workspace_id = excluded.workspace_id,
                parent_id = excluded.parent_id,
                role = excluded.role,
                content = excluded.content,
                status = excluded.status,
                execution_data_json = excluded.execution_data_json,
                payload_json = excluded.payload_json,
                updated_at = excluded.updated_at,
                deleted_at = local_nodes.deleted_at,
                local_updated_at = excluded.local_updated_at
            WHERE local_nodes.deleted_at IS NULL
            "#,
            [],
        )
        .map_err(|e| e.to_string())?;
        Ok(updated)
    }

    pub fn reconcile_stale_prelaunch_local_nodes(
        &self,
        stale_after_secs: i64,
        recovery_trigger: &str,
    ) -> Result<usize, String> {
        let now = unix_timestamp();
        let cutoff = now.saturating_sub(stale_after_secs.max(0));
        let updated_at = utc_iso_now();
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let stale_rows: Vec<(String, String, String, Option<String>)> = {
            let mut stmt = conn
                .prepare(
                    r#"
                    SELECT id, workspace_id, COALESCE(payload_json, '{}'), execution_data_json
                    FROM local_nodes AS node
                    WHERE deleted_at IS NULL
                      AND role = 'assistant'
                      AND status IN ('pending', 'creating', 'initializing', 'preparing_worktree', 'running', 'streaming', 'finalizing')
                      AND COALESCE(local_updated_at, 0) <= ?1
                      AND (
                        json_extract(CASE WHEN json_valid(COALESCE(execution_data_json, '')) THEN execution_data_json ELSE '{}' END, '$.current_run_id') IS NULL
                        OR json_extract(CASE WHEN json_valid(COALESCE(execution_data_json, '')) THEN execution_data_json ELSE '{}' END, '$.meta.quick_reply') = 1
                        OR json_extract(CASE WHEN json_valid(COALESCE(payload_json, '')) THEN payload_json ELSE '{}' END, '$.execution_data.current_run_id') IS NULL
                        OR json_extract(CASE WHEN json_valid(COALESCE(payload_json, '')) THEN payload_json ELSE '{}' END, '$.execution_data.meta.quick_reply') = 1
                      )
                      AND NOT EXISTS (
                        SELECT 1
                        FROM agent_run_ledger AS ledger
                        WHERE ledger.assistant_node_id = node.id
                      )
                    "#,
                )
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map(params![cutoff], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, Option<String>>(3)?,
                    ))
                })
                .map_err(|e| e.to_string())?;
            rows.collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?
        };

        let mut updated = 0;
        for (node_id, workspace_id, payload_json, execution_data_json) in stale_rows {
            let mut payload =
                serde_json::from_str::<JsonValue>(&payload_json).unwrap_or_else(|_| {
                    serde_json::json!({
                        "id": node_id,
                        "workspaceId": workspace_id,
                        "role": "assistant",
                        "content": ""
                    })
                });
            if !payload.is_object() {
                payload = serde_json::json!({
                    "id": node_id,
                    "workspaceId": workspace_id,
                    "role": "assistant",
                    "content": ""
                });
            }

            let mut execution_data = payload
                .get("execution_data")
                .cloned()
                .or_else(|| {
                    execution_data_json
                        .as_deref()
                        .and_then(|value| serde_json::from_str::<JsonValue>(value).ok())
                })
                .unwrap_or_else(|| serde_json::json!({}));
            if !execution_data.is_object() {
                execution_data = serde_json::json!({});
            }
            let prelaunch_stage = execution_data
                .pointer("/meta/prelaunch_stage")
                .and_then(JsonValue::as_str);
            let reason = match (recovery_trigger, prelaunch_stage) {
                ("startup", Some(stage)) => format!(
                    "App restarted while native agent setup was at stage '{stage}', before the run was accepted."
                ),
                ("startup", None) => "App restarted before this run reached the native agent runner. No native session or ledger was found.".to_string(),
                (_, Some(stage)) => format!(
                    "Native agent setup stalled at stage '{stage}' before the run was accepted. No native session or ledger was created."
                ),
                (_, None) => "The send flow did not reach the native agent runner before the setup timeout. No native session or ledger was created.".to_string(),
            };
            if let Some(object) = execution_data.as_object_mut() {
                object.insert(
                    "last_terminal_status".to_string(),
                    JsonValue::String("failed_setup".to_string()),
                );
                object.insert("stop_reason".to_string(), JsonValue::String(reason.clone()));
                let meta = object
                    .entry("meta".to_string())
                    .or_insert_with(|| serde_json::json!({}));
                if !meta.is_object() {
                    *meta = serde_json::json!({});
                }
                if let Some(meta_object) = meta.as_object_mut() {
                    meta_object.insert(
                        "native_recovery_status".to_string(),
                        JsonValue::String("failed_setup".to_string()),
                    );
                    meta_object.insert(
                        "native_recovery_phase".to_string(),
                        JsonValue::String("prelaunch_reconciliation".to_string()),
                    );
                    meta_object.insert(
                        "native_recovery_trigger".to_string(),
                        JsonValue::String(recovery_trigger.to_string()),
                    );
                    meta_object.insert(
                        "provider_error_message".to_string(),
                        JsonValue::String(reason.clone()),
                    );
                    meta_object.insert(
                        "failure_reason".to_string(),
                        JsonValue::String(reason.clone()),
                    );
                    meta_object.insert(
                        "needs_user_action_reason".to_string(),
                        JsonValue::String(
                            "Review or rerun this node; no native agent session exists to resume."
                                .to_string(),
                        ),
                    );
                }
            }

            if let Some(object) = payload.as_object_mut() {
                object.insert("id".to_string(), JsonValue::String(node_id.clone()));
                object.insert(
                    "workspaceId".to_string(),
                    JsonValue::String(workspace_id.clone()),
                );
                object.insert(
                    "role".to_string(),
                    JsonValue::String("assistant".to_string()),
                );
                object
                    .entry("content".to_string())
                    .or_insert_with(|| JsonValue::String(String::new()));
                object.insert(
                    "status".to_string(),
                    JsonValue::String("failed_setup".to_string()),
                );
                object.insert(
                    "updatedAt".to_string(),
                    JsonValue::String(updated_at.clone()),
                );
                object.insert("execution_data".to_string(), execution_data.clone());
            }
            let next_execution_data =
                serde_json::to_string(&execution_data).map_err(|e| e.to_string())?;
            let next_payload = serde_json::to_string(&payload).map_err(|e| e.to_string())?;
            updated += conn
                .execute(
                    r#"
                    UPDATE local_nodes
                    SET status = 'failed_setup',
                        execution_data_json = ?2,
                        payload_json = ?3,
                        updated_at = ?4,
                        local_updated_at = ?5
                    WHERE id = ?1
                      AND deleted_at IS NULL
                    "#,
                    params![node_id, next_execution_data, next_payload, updated_at, now],
                )
                .map_err(|e| e.to_string())?;
        }
        Ok(updated)
    }

    pub fn get_agent_run_ledger_by_assistant(
        &self,
        assistant_node_id: &str,
    ) -> Result<Option<AgentRunLedgerRow>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.query_row(
            r#"
            SELECT
                run_id, user_node_id, assistant_node_id, workspace_id, repo_path,
                worktree_path, branch_name, parent_commit, pid, agent_type,
                status, phase, last_seq, started_at, updated_at, terminal_status,
                finalize_attempt_count, cleanup_attempt_count, server_start_persisted,
                server_final_persisted, output_commit_sha, failure_reason,
                needs_user_action_reason, cleanup_completed, login_profile_id
            FROM agent_run_ledger
            WHERE assistant_node_id = ?1
            "#,
            params![assistant_node_id],
            |row| {
                Ok(AgentRunLedgerRow {
                    run_id: row.get(0)?,
                    user_node_id: row.get(1)?,
                    assistant_node_id: row.get(2)?,
                    workspace_id: row.get(3)?,
                    repo_path: row.get(4)?,
                    worktree_path: row.get(5)?,
                    branch_name: row.get(6)?,
                    parent_commit: row.get(7)?,
                    pid: row.get(8)?,
                    agent_type: row.get(9)?,
                    status: row.get(10)?,
                    phase: row.get(11)?,
                    last_seq: row.get(12)?,
                    started_at: row.get(13)?,
                    updated_at: row.get(14)?,
                    terminal_status: row.get(15)?,
                    finalize_attempt_count: row.get(16)?,
                    cleanup_attempt_count: row.get(17)?,
                    server_start_persisted: row.get::<_, i64>(18)? != 0,
                    server_final_persisted: row.get::<_, i64>(19)? != 0,
                    output_commit_sha: row.get(20)?,
                    failure_reason: row.get(21)?,
                    needs_user_action_reason: row.get(22)?,
                    cleanup_completed: row.get::<_, i64>(23)? != 0,
                    login_profile_id: row.get(24)?,
                })
            },
        )
        .optional()
        .map_err(|e| e.to_string())
    }

    pub fn list_terminal_journal_recovery_candidates(
        &self,
    ) -> Result<Vec<AgentRunLedgerRow>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                r#"
                SELECT
                    run_id, user_node_id, assistant_node_id, workspace_id, repo_path,
                    worktree_path, branch_name, parent_commit, pid, agent_type,
                    status, phase, last_seq, started_at, updated_at, terminal_status,
                    finalize_attempt_count, cleanup_attempt_count, server_start_persisted,
                    server_final_persisted, output_commit_sha, failure_reason,
                    needs_user_action_reason, cleanup_completed, login_profile_id
                FROM agent_run_ledger
                WHERE cleanup_completed = 0
                  AND server_final_persisted = 0
                  AND terminal_status IS NULL
                  AND status NOT IN (
                    'completed',
                    'failed',
                    'cancelled',
                    'error',
                    'failed_setup',
                    'failed_spawn',
                    'failed_finalization',
                    'failed_runtime',
                    'needs_user_action'
                  )
                  AND EXISTS (
                    SELECT 1
                    FROM agent_run_events e
                    WHERE e.run_id = agent_run_ledger.run_id
                      AND e.assistant_node_id = agent_run_ledger.assistant_node_id
                      AND e.event_type IN ('stop', 'provider_stop')
                      AND COALESCE(
                        json_extract(CASE WHEN json_valid(e.payload) THEN e.payload ELSE '{}' END, '$.provider_status'),
                        json_extract(CASE WHEN json_valid(e.payload) THEN e.payload ELSE '{}' END, '$.status')
                      ) IN (
                        'completed',
                        'failed',
                        'cancelled',
                        'error',
                        'failed_setup',
                        'failed_spawn',
                        'failed_finalization',
                        'failed_runtime'
                      )
                  )
                ORDER BY updated_at ASC
                "#,
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                Ok(AgentRunLedgerRow {
                    run_id: row.get(0)?,
                    user_node_id: row.get(1)?,
                    assistant_node_id: row.get(2)?,
                    workspace_id: row.get(3)?,
                    repo_path: row.get(4)?,
                    worktree_path: row.get(5)?,
                    branch_name: row.get(6)?,
                    parent_commit: row.get(7)?,
                    pid: row.get(8)?,
                    agent_type: row.get(9)?,
                    status: row.get(10)?,
                    phase: row.get(11)?,
                    last_seq: row.get(12)?,
                    started_at: row.get(13)?,
                    updated_at: row.get(14)?,
                    terminal_status: row.get(15)?,
                    finalize_attempt_count: row.get(16)?,
                    cleanup_attempt_count: row.get(17)?,
                    server_start_persisted: row.get::<_, i64>(18)? != 0,
                    server_final_persisted: row.get::<_, i64>(19)? != 0,
                    output_commit_sha: row.get(20)?,
                    failure_reason: row.get(21)?,
                    needs_user_action_reason: row.get(22)?,
                    cleanup_completed: row.get::<_, i64>(23)? != 0,
                    login_profile_id: row.get(24)?,
                })
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        Ok(rows)
    }

    pub fn list_startup_resume_candidates(&self) -> Result<Vec<AgentRunLedgerRow>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                r#"
                SELECT
                    run_id, user_node_id, assistant_node_id, workspace_id, repo_path,
                    worktree_path, branch_name, parent_commit, pid, agent_type,
                    status, phase, last_seq, started_at, updated_at, terminal_status,
                    finalize_attempt_count, cleanup_attempt_count, server_start_persisted,
                    server_final_persisted, output_commit_sha, failure_reason,
                    needs_user_action_reason, cleanup_completed, login_profile_id
                FROM agent_run_ledger
                WHERE cleanup_completed = 0
                  AND server_final_persisted = 0
                  AND terminal_status IS NULL
                  AND output_commit_sha IS NULL
                  AND status NOT IN (
                    'completed',
                    'failed',
                    'cancelled',
                    'error',
                    'failed_setup',
                    'failed_spawn',
                    'failed_finalization',
                    'failed_runtime'
                  )
                  AND (
                    status != 'needs_user_action'
                    OR needs_user_action_reason LIKE 'App restarted before this run reached a terminal state%'
                  )
                  AND agent_type IN ('codex', 'claude', 'opencode')
                  AND login_profile_id IS NOT NULL
                  AND repo_path IS NOT NULL
                  AND worktree_path IS NOT NULL
                ORDER BY updated_at ASC
                "#,
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                Ok(AgentRunLedgerRow {
                    run_id: row.get(0)?,
                    user_node_id: row.get(1)?,
                    assistant_node_id: row.get(2)?,
                    workspace_id: row.get(3)?,
                    repo_path: row.get(4)?,
                    worktree_path: row.get(5)?,
                    branch_name: row.get(6)?,
                    parent_commit: row.get(7)?,
                    pid: row.get(8)?,
                    agent_type: row.get(9)?,
                    status: row.get(10)?,
                    phase: row.get(11)?,
                    last_seq: row.get(12)?,
                    started_at: row.get(13)?,
                    updated_at: row.get(14)?,
                    terminal_status: row.get(15)?,
                    finalize_attempt_count: row.get(16)?,
                    cleanup_attempt_count: row.get(17)?,
                    server_start_persisted: row.get::<_, i64>(18)? != 0,
                    server_final_persisted: row.get::<_, i64>(19)? != 0,
                    output_commit_sha: row.get(20)?,
                    failure_reason: row.get(21)?,
                    needs_user_action_reason: row.get(22)?,
                    cleanup_completed: row.get::<_, i64>(23)? != 0,
                    login_profile_id: row.get(24)?,
                })
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        Ok(rows)
    }

    pub fn mark_agent_run_startup_resuming(&self, assistant_node_id: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            r#"
            UPDATE agent_run_ledger
            SET status = 'running',
                phase = 'resuming_provider_thread',
                pid = NULL,
                failure_reason = NULL,
                needs_user_action_reason = NULL,
                updated_at = ?2
            WHERE assistant_node_id = ?1
            "#,
            params![assistant_node_id, unix_timestamp()],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn append_agent_run_event(
        &self,
        run_id: &str,
        assistant_node_id: &str,
        event_type: &str,
        status: Option<&str>,
        phase: Option<&str>,
        payload: &str,
    ) -> Result<i64, String> {
        let now = unix_timestamp();
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
        let next_seq: i64 = tx
            .query_row(
                "SELECT COALESCE(MAX(seq), 0) + 1 FROM agent_run_events WHERE run_id = ?1",
                params![run_id],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;
        tx.execute(
            r#"
            INSERT INTO agent_run_events (
                run_id, assistant_node_id, seq, event_type, status, phase, payload, timestamp
            )
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
            "#,
            params![
                run_id,
                assistant_node_id,
                next_seq,
                event_type,
                status,
                phase,
                payload,
                now
            ],
        )
        .map_err(|e| e.to_string())?;
        tx.execute(
            "UPDATE agent_run_ledger SET last_seq = ?2, updated_at = ?3 WHERE run_id = ?1",
            params![run_id, next_seq, now],
        )
        .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(next_seq)
    }

    pub fn list_agent_run_events_after(
        &self,
        run_id: &str,
        after_seq: i64,
    ) -> Result<Vec<AgentRunJournalEvent>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                r#"
                SELECT run_id, assistant_node_id, seq, event_type, status, phase, payload, timestamp
                FROM agent_run_events
                WHERE run_id = ?1 AND seq > ?2
                ORDER BY seq ASC
                "#,
            )
            .map_err(|e| e.to_string())?;
        let mut rows = stmt
            .query_map(params![run_id, after_seq], |row| {
                Ok(AgentRunJournalEvent {
                    run_id: row.get(0)?,
                    assistant_node_id: row.get(1)?,
                    seq: row.get(2)?,
                    event_type: row.get(3)?,
                    status: row.get(4)?,
                    phase: row.get(5)?,
                    payload: row.get(6)?,
                    timestamp: row.get(7)?,
                })
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        for row in &mut rows {
            row.payload = crate::tool_output::sanitize_serialized_tool_outputs(&row.payload);
        }
        Ok(rows)
    }

    fn structured_timeline_from_existing_local_node(
        conn: &Connection,
        node_id: &str,
    ) -> Result<Option<Vec<JsonValue>>, String> {
        let existing = conn
            .query_row(
                "SELECT execution_data_json FROM local_nodes WHERE id = ?1 AND deleted_at IS NULL",
                params![node_id],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()
            .map_err(|e| e.to_string())?
            .flatten();
        let Some(existing) = existing else {
            return Ok(None);
        };
        let Ok(mut existing_execution_data) = serde_json::from_str::<JsonValue>(&existing) else {
            return Ok(None);
        };
        crate::tool_output::sanitize_tool_output_fields(&mut existing_execution_data);
        let Some(timeline) = existing_execution_data
            .get("timeline")
            .and_then(|value| value.as_array())
        else {
            return Ok(None);
        };
        if !timeline_has_structured_events(Some(timeline)) {
            return Ok(None);
        }
        Ok(Some(timeline.clone()))
    }

    fn structured_timeline_from_agent_run_journal(
        conn: &Connection,
        node_id: &str,
    ) -> Result<Option<Vec<JsonValue>>, String> {
        let mut stmt = conn
            .prepare(
                r#"
                SELECT event_type, payload
                FROM agent_run_events
                WHERE assistant_node_id = ?1
                  AND event_type IN ('thinking', 'tool_use', 'tool_result', 'tool_output_delta', 'error', 'stderr', 'user_steer_requested')
                ORDER BY seq ASC
                "#,
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![node_id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;

        let mut timeline = Vec::new();
        for (event_type, payload) in rows {
            let Ok(mut event) = serde_json::from_str::<JsonValue>(&payload) else {
                continue;
            };
            if event.get("type").and_then(|value| value.as_str()).is_none() {
                if let Some(object) = event.as_object_mut() {
                    object.insert("type".to_string(), JsonValue::String(event_type));
                }
            }
            if event.get("type").and_then(|value| value.as_str()) == Some("tool_output_delta") {
                let tool_use_id = event
                    .get("toolUseId")
                    .or_else(|| event.get("tool_use_id"))
                    .or_else(|| event.get("id"))
                    .and_then(|value| value.as_str());
                let delta = event.get("delta").and_then(|value| value.as_str());
                if let (Some(tool_use_id), Some(delta)) = (tool_use_id, delta) {
                    append_tool_output_delta_to_timeline(&mut timeline, tool_use_id, delta);
                }
                continue;
            }
            if let Some(timeline_event) = normalize_journal_timeline_event(&event) {
                timeline.push(timeline_event);
            }
        }

        if timeline_has_structured_events(Some(&timeline)) {
            Ok(Some(timeline))
        } else {
            Ok(None)
        }
    }

    fn repair_payload_timeline_if_needed(
        conn: &Connection,
        node_id: &str,
        payload: &mut JsonValue,
    ) -> Result<(), String> {
        if payload_has_structured_timeline(payload) {
            return Ok(());
        }

        let mut timeline = payload
            .get("execution_data")
            .and_then(|execution_data| execution_data.get("timeline"))
            .and_then(|value| value.as_array())
            .cloned()
            .unwrap_or_default();

        if let Some(existing_timeline) =
            Self::structured_timeline_from_existing_local_node(conn, node_id)?
        {
            merge_timeline_into_payload(payload, existing_timeline);
            return Ok(());
        }

        let Some(mut journal_timeline) =
            Self::structured_timeline_from_agent_run_journal(conn, node_id)?
        else {
            return Ok(());
        };
        timeline.append(&mut journal_timeline);
        merge_timeline_into_payload(payload, timeline);
        Ok(())
    }

    fn repair_payload_artifacts_if_needed(
        conn: &Connection,
        node_id: &str,
        payload: &mut JsonValue,
    ) -> Result<(), String> {
        if payload_has_artifacts(payload) {
            return Ok(());
        }

        if !payload.is_object() {
            return Ok(());
        }
        let Some(payload_object) = payload.as_object_mut() else {
            return Ok(());
        };
        let execution_data = payload_object
            .entry("execution_data".to_string())
            .or_insert_with(|| serde_json::json!({}));

        let mut stmt = conn
            .prepare(
                r#"
                SELECT payload
                FROM agent_run_events
                WHERE assistant_node_id = ?1
                  AND event_type = 'artifact_registered'
                ORDER BY seq ASC
                "#,
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![node_id], |row| row.get::<_, String>(0))
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;

        for payload_json in rows {
            let Ok(event) = serde_json::from_str::<JsonValue>(&payload_json) else {
                continue;
            };
            let Some(artifact) = event.get("artifact").cloned().filter(JsonValue::is_object) else {
                continue;
            };
            crate::artifacts::upsert_artifact_in_execution_data(execution_data, artifact);
        }
        Ok(())
    }

    pub fn repair_legacy_local_node_timelines(&self, limit: usize) -> Result<usize, String> {
        if limit == 0 {
            return Ok(0);
        }

        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let candidates = {
            let mut stmt = conn
                .prepare(
                    r#"
                    SELECT n.id, n.payload_json
                    FROM local_nodes n
                    WHERE n.deleted_at IS NULL
                      AND n.payload_json IS NOT NULL
                      AND json_valid(n.payload_json)
                      AND COALESCE(json_extract(n.payload_json, '$.execution_data.meta.agentree_hidden_node'), 0) != 1
                      AND COALESCE(json_extract(n.payload_json, '$.execution_data.meta.agentree_insight_run'), 0) != 1
                      AND (
                          n.execution_data_json IS NULL
                          OR NOT json_valid(n.execution_data_json)
                          OR NOT EXISTS (
                              SELECT 1
                              FROM json_each(json_extract(n.execution_data_json, '$.timeline')) AS timeline_entry
                              WHERE json_extract(timeline_entry.value, '$.type') IN (
                                  'tool_use',
                                  'tool_result',
                                  'tool_output_delta',
                                  'thinking',
                                  'error',
                                  'stderr',
                                  'user_steer_requested'
                              )
                          )
                          OR (
                              COALESCE(
                                  json_array_length(
                                      json_extract(
                                          CASE
                                              WHEN json_valid(COALESCE(n.execution_data_json, '')) THEN n.execution_data_json
                                              ELSE '{}'
                                          END,
                                          '$.artifacts'
                                      )
                                  ),
                                  0
                              ) = 0
                              AND EXISTS (
                                  SELECT 1
                                  FROM agent_run_events ev
                                  WHERE ev.assistant_node_id = n.id
                                    AND ev.event_type = 'artifact_registered'
                              )
                          )
                      )
                      AND EXISTS (
                          SELECT 1
                          FROM agent_run_events ev
                          WHERE ev.assistant_node_id = n.id
                            AND ev.event_type IN (
                                'thinking',
                                'tool_use',
                                'tool_result',
                                'tool_output_delta',
                                'error',
                                'stderr',
                                'user_steer_requested',
                                'artifact_registered'
                            )
                      )
                    ORDER BY n.local_updated_at ASC
                    LIMIT ?1
                    "#,
                )
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map(params![limit as i64], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })
                .map_err(|e| e.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?;
            rows
        };

        let mut repaired = 0usize;
        for (node_id, payload_json) in candidates {
            let Ok(mut payload) = serde_json::from_str::<JsonValue>(&payload_json) else {
                continue;
            };
            let had_structured_timeline = payload_has_structured_timeline(&payload);
            let had_artifacts = payload_has_artifacts(&payload);
            Self::repair_payload_timeline_if_needed(&conn, &node_id, &mut payload)?;
            Self::repair_payload_artifacts_if_needed(&conn, &node_id, &mut payload)?;
            if had_structured_timeline == payload_has_structured_timeline(&payload)
                && had_artifacts == payload_has_artifacts(&payload)
            {
                continue;
            }
            let payload_json = serde_json::to_string(&payload).map_err(|e| e.to_string())?;
            let execution_data_json = payload
                .get("execution_data")
                .and_then(|value| serde_json::to_string(value).ok());
            conn.execute(
                r#"
                UPDATE local_nodes
                SET payload_json = ?2,
                    execution_data_json = ?3
                WHERE id = ?1
                  AND deleted_at IS NULL
                "#,
                params![node_id, payload_json, execution_data_json],
            )
            .map_err(|e| e.to_string())?;
            repaired += 1;
        }
        Ok(repaired)
    }

    pub fn upsert_local_node(
        &self,
        node_id: &str,
        workspace_id: &str,
        payload: &str,
    ) -> Result<(), String> {
        let now = unix_timestamp();
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut payload_value =
            serde_json::from_str::<JsonValue>(payload).unwrap_or(JsonValue::Null);
        Self::repair_payload_timeline_if_needed(&conn, node_id, &mut payload_value)?;
        let payload = serde_json::to_string(&payload_value).map_err(|e| e.to_string())?;
        let parent_id = payload_value
            .get("parentId")
            .and_then(|value| value.as_str());
        let controlled_by_node_id = controlled_by_node_id_from_payload(&payload_value);
        let role = payload_value
            .get("role")
            .and_then(|value| value.as_str())
            .unwrap_or("assistant");
        let content = payload_value
            .get("content")
            .and_then(|value| value.as_str())
            .unwrap_or("");
        let status = payload_value.get("status").and_then(|value| value.as_str());
        let thread_id = payload_value
            .get("threadId")
            .or_else(|| payload_value.get("thread_id"))
            .and_then(|value| value.as_str());
        let execution_data_json = payload_value
            .get("execution_data")
            .and_then(|value| serde_json::to_string(value).ok());
        let prompt_tokens = payload_value
            .get("promptTokens")
            .and_then(|value| value.as_i64());
        let completion_tokens = payload_value
            .get("completionTokens")
            .and_then(|value| value.as_i64());
        let total_tokens = payload_value
            .get("totalTokens")
            .and_then(|value| value.as_i64());
        let base_commit_sha = payload_value
            .get("base_commit_sha")
            .or_else(|| payload_value.get("baseCommitSha"))
            .and_then(|value| value.as_str());
        let output_commit_sha = payload_value
            .get("output_commit_sha")
            .or_else(|| payload_value.get("outputCommitSha"))
            .and_then(|value| value.as_str());
        let base_selected_from_node_id = payload_value
            .get("base_selected_from_node_id")
            .or_else(|| payload_value.get("baseSelectedFromNodeId"))
            .and_then(|value| value.as_str());
        let git_branch_name = payload_value
            .get("git_branch_name")
            .and_then(|value| value.as_str());
        let created_at = payload_value
            .get("createdAt")
            .and_then(|value| value.as_str())
            .map(|value| value.to_string())
            .unwrap_or_else(chrono_like_now);
        let updated_at = payload_value
            .get("updatedAt")
            .and_then(|value| value.as_str())
            .map(|value| value.to_string())
            .unwrap_or_else(chrono_like_now);
        conn.execute(
            r#"
            INSERT INTO local_nodes (
                id, workspace_id, parent_id, controlled_by_node_id, role, content, status, thread_id,
                execution_data_json, payload_json, prompt_tokens, completion_tokens, total_tokens,
                base_commit_sha, output_commit_sha, base_selected_from_node_id, git_branch_name, created_at, updated_at,
                deleted_at, local_updated_at
            )
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, NULL, ?20)
            ON CONFLICT(id) DO UPDATE SET
                workspace_id = excluded.workspace_id,
                parent_id = excluded.parent_id,
                controlled_by_node_id = excluded.controlled_by_node_id,
                role = excluded.role,
                content = excluded.content,
                status = excluded.status,
                thread_id = COALESCE(excluded.thread_id, local_nodes.thread_id),
                execution_data_json = excluded.execution_data_json,
                payload_json = excluded.payload_json,
                prompt_tokens = excluded.prompt_tokens,
                completion_tokens = excluded.completion_tokens,
                total_tokens = excluded.total_tokens,
                base_commit_sha = excluded.base_commit_sha,
                output_commit_sha = COALESCE(excluded.output_commit_sha, local_nodes.output_commit_sha),
                base_selected_from_node_id = excluded.base_selected_from_node_id,
                git_branch_name = excluded.git_branch_name,
                updated_at = excluded.updated_at,
                deleted_at = local_nodes.deleted_at,
                local_updated_at = excluded.local_updated_at
            "#,
            params![
                node_id,
                workspace_id,
                parent_id,
                controlled_by_node_id,
                role,
                content,
                status,
                thread_id,
                execution_data_json,
                payload,
                prompt_tokens,
                completion_tokens,
                total_tokens,
                base_commit_sha,
                output_commit_sha,
                base_selected_from_node_id,
                git_branch_name,
                created_at,
                updated_at,
                now
            ],
        )
        .map_err(|e| e.to_string())?;
        let effective_thread_id = match thread_id {
            Some(value) => Some(value.to_string()),
            None => conn
                .query_row(
                    "SELECT thread_id FROM local_nodes WHERE id = ?1 AND workspace_id = ?2 AND deleted_at IS NULL",
                    params![node_id, workspace_id],
                    |row| row.get::<_, Option<String>>(0),
                )
                .optional()
                .map_err(|e| e.to_string())?
                .flatten(),
        };
        if let Some(thread_id) = effective_thread_id.as_deref() {
            if role == "user" {
                conn.execute(
                    r#"
                    UPDATE thread_sessions
                    SET
                        first_message_id = COALESCE(first_message_id, ?1),
                        updated_at = CASE WHEN first_message_id IS NULL THEN ?4 ELSE updated_at END,
                        local_updated_at = CASE WHEN first_message_id IS NULL THEN ?5 ELSE local_updated_at END
                    WHERE id = ?2
                      AND workspace_id = ?3
                      AND deleted_at IS NULL
                    "#,
                    params![node_id, thread_id, workspace_id, updated_at, now],
                )
                .map_err(|e| e.to_string())?;
            } else if role == "assistant" {
                if let (Some(parent_id), Some(thread_title)) =
                    (parent_id, thread_title_from_payload(&payload_value))
                {
                    conn.execute(
                        r#"
                        UPDATE thread_sessions
                        SET title = ?1,
                            updated_at = ?6,
                            local_updated_at = ?7
                        WHERE id = ?2
                          AND workspace_id = ?3
                          AND deleted_at IS NULL
                          AND (title IS NULL OR trim(title) = '')
                          AND first_message_id = ?4
                          AND ?5 = (
                              SELECT first_assistant.id
                              FROM local_nodes AS first_assistant
                              WHERE first_assistant.workspace_id = ?3
                                AND first_assistant.thread_id = ?2
                                AND first_assistant.parent_id = ?4
                                AND first_assistant.role = 'assistant'
                                AND first_assistant.deleted_at IS NULL
                              ORDER BY datetime(first_assistant.created_at) ASC, first_assistant.created_at ASC, first_assistant.id ASC
                              LIMIT 1
                          )
                        "#,
                        params![
                            thread_title,
                            thread_id,
                            workspace_id,
                            parent_id,
                            node_id,
                            updated_at,
                            now
                        ],
                    )
                    .map_err(|e| e.to_string())?;
                }
            }
        }
        Ok(())
    }

    pub fn local_first_update_node_tags(
        &self,
        workspace_id: &str,
        user_id: Option<&str>,
        node_id: &str,
        tags: Vec<String>,
        action: &str,
    ) -> Result<String, String> {
        if action != "add" && action != "remove" {
            return Err("Tag action must be 'add' or 'remove'.".to_string());
        }
        let requested_tags = tags
            .into_iter()
            .map(|tag| tag.trim().to_string())
            .filter(|tag| !tag.is_empty())
            .collect::<HashSet<_>>();
        if requested_tags.is_empty() {
            return Err("At least one non-empty tag is required.".to_string());
        }

        let now = unix_timestamp();
        let updated_at = utc_iso_now();
        let mut conn = self.conn.lock().map_err(|e| e.to_string())?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        let payload_json = tx
            .query_row(
                r#"
                SELECT payload_json
                FROM local_nodes
                WHERE id = ?1 AND workspace_id = ?2 AND deleted_at IS NULL
                "#,
                params![node_id, workspace_id],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()
            .map_err(|e| e.to_string())?
            .flatten()
            .ok_or_else(|| "Local message not found.".to_string())?;
        let mut payload: JsonValue = serde_json::from_str(&payload_json)
            .map_err(|e| format!("Invalid local message payload: {e}"))?;
        let object = payload
            .as_object_mut()
            .ok_or_else(|| "Local message payload must be a JSON object.".to_string())?;
        let mut current_tags = object
            .get("tags")
            .and_then(JsonValue::as_array)
            .into_iter()
            .flatten()
            .filter_map(JsonValue::as_str)
            .map(str::to_string)
            .collect::<Vec<_>>();
        if action == "add" {
            for tag in &requested_tags {
                if !current_tags.iter().any(|existing| existing == tag) {
                    current_tags.push(tag.clone());
                }
            }
        } else {
            current_tags.retain(|tag| !requested_tags.contains(tag));
        }
        current_tags.sort();
        object.insert("tags".to_string(), serde_json::json!(current_tags));
        object.insert(
            "updatedAt".to_string(),
            JsonValue::String(updated_at.clone()),
        );
        let updated_payload_json = serde_json::to_string(&payload).map_err(|e| e.to_string())?;
        tx.execute(
            r#"
            UPDATE local_nodes
            SET payload_json = ?3,
                updated_at = ?4,
                local_updated_at = ?5
            WHERE id = ?1 AND workspace_id = ?2 AND deleted_at IS NULL
            "#,
            params![node_id, workspace_id, updated_payload_json, updated_at, now],
        )
        .map_err(|e| e.to_string())?;

        let mut sync_tags = requested_tags.into_iter().collect::<Vec<_>>();
        sync_tags.sort();
        let sync_payload = serde_json::json!({
            "tags": sync_tags,
            "action": action,
        });
        Self::enqueue_local_sync_event_locked(
            &tx,
            now,
            Some(workspace_id),
            user_id,
            "node",
            node_id,
            if action == "add" {
                "node.tags.add"
            } else {
                "node.tags.remove"
            },
            &serde_json::to_string(&sync_payload).map_err(|e| e.to_string())?,
            None,
        )?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(updated_payload_json)
    }

    pub fn local_first_update_node_highlight(
        &self,
        workspace_id: &str,
        user_id: Option<&str>,
        node_id: &str,
        action: &str,
        highlight_json: &str,
    ) -> Result<String, String> {
        if !matches!(action, "add" | "update" | "delete") {
            return Err("Highlight action must be 'add', 'update', or 'delete'.".to_string());
        }
        let highlight: JsonValue = serde_json::from_str(highlight_json)
            .map_err(|e| format!("Invalid highlight payload: {e}"))?;
        let highlight_id = highlight
            .get("id")
            .and_then(JsonValue::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| "Highlight id is required.".to_string())?;
        if action != "delete" {
            let color = highlight
                .get("color")
                .and_then(JsonValue::as_str)
                .ok_or_else(|| "Highlight color is required.".to_string())?;
            if !matches!(color, "yellow" | "green" | "blue" | "rose") {
                return Err("Highlight color is invalid.".to_string());
            }
        }
        if action == "add" {
            let range = highlight
                .get("range")
                .and_then(JsonValue::as_object)
                .ok_or_else(|| "Highlight range is required.".to_string())?;
            let start = range.get("start").and_then(JsonValue::as_u64);
            let end = range.get("end").and_then(JsonValue::as_u64);
            if start.zip(end).is_none_or(|(start, end)| end <= start)
                || range.get("exact").and_then(JsonValue::as_str).is_none()
                || range.get("textHash").and_then(JsonValue::as_str).is_none()
            {
                return Err("Highlight range is invalid.".to_string());
            }
        }

        let now = unix_timestamp();
        let updated_at = utc_iso_now();
        let mut conn = self.conn.lock().map_err(|e| e.to_string())?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        let payload_json = tx
            .query_row(
                r#"
                SELECT payload_json
                FROM local_nodes
                WHERE id = ?1 AND workspace_id = ?2 AND deleted_at IS NULL
                "#,
                params![node_id, workspace_id],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()
            .map_err(|e| e.to_string())?
            .flatten()
            .ok_or_else(|| "Local message not found.".to_string())?;
        let mut payload: JsonValue = serde_json::from_str(&payload_json)
            .map_err(|e| format!("Invalid local message payload: {e}"))?;
        let object = payload
            .as_object_mut()
            .ok_or_else(|| "Local message payload must be a JSON object.".to_string())?;
        let mut annotations = object
            .get("annotations")
            .and_then(JsonValue::as_array)
            .cloned()
            .unwrap_or_default();
        let position = annotations.iter().position(|annotation| {
            annotation.get("type").and_then(JsonValue::as_str) == Some("highlight")
                && annotation.get("id").and_then(JsonValue::as_str) == Some(highlight_id)
        });
        match action {
            "add" => {
                if let Some(position) = position {
                    annotations[position] = highlight.clone();
                } else {
                    annotations.push(highlight.clone());
                }
            }
            "update" => {
                let position = position.ok_or_else(|| "Highlight not found.".to_string())?;
                let annotation = annotations[position]
                    .as_object_mut()
                    .ok_or_else(|| "Stored highlight is invalid.".to_string())?;
                annotation.insert(
                    "color".to_string(),
                    highlight.get("color").cloned().unwrap_or(JsonValue::Null),
                );
                annotation.insert(
                    "updatedAt".to_string(),
                    JsonValue::String(updated_at.clone()),
                );
            }
            "delete" => {
                let position = position.ok_or_else(|| "Highlight not found.".to_string())?;
                annotations.remove(position);
            }
            _ => unreachable!(),
        }
        object.insert("annotations".to_string(), JsonValue::Array(annotations));
        object.insert(
            "updatedAt".to_string(),
            JsonValue::String(updated_at.clone()),
        );
        let updated_payload_json = serde_json::to_string(&payload).map_err(|e| e.to_string())?;
        tx.execute(
            r#"
            UPDATE local_nodes
            SET payload_json = ?3,
                updated_at = ?4,
                local_updated_at = ?5
            WHERE id = ?1 AND workspace_id = ?2 AND deleted_at IS NULL
            "#,
            params![node_id, workspace_id, updated_payload_json, updated_at, now],
        )
        .map_err(|e| e.to_string())?;
        Self::enqueue_local_sync_event_locked(
            &tx,
            now,
            Some(workspace_id),
            user_id,
            "node",
            node_id,
            match action {
                "add" => "node.highlight.add",
                "update" => "node.highlight.update",
                "delete" => "node.highlight.delete",
                _ => unreachable!(),
            },
            highlight_json,
            None,
        )?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(updated_payload_json)
    }

    pub fn local_first_set_node_collapsed(
        &self,
        workspace_id: &str,
        user_id: Option<&str>,
        node_id: &str,
        collapsed: bool,
    ) -> Result<String, String> {
        let now = unix_timestamp();
        let updated_at = utc_iso_now();
        let mut conn = self.conn.lock().map_err(|e| e.to_string())?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        let payload_json = tx
            .query_row(
                r#"
                SELECT payload_json
                FROM local_nodes
                WHERE id = ?1 AND workspace_id = ?2 AND deleted_at IS NULL
                "#,
                params![node_id, workspace_id],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()
            .map_err(|e| e.to_string())?
            .flatten()
            .ok_or_else(|| "Local message not found.".to_string())?;
        let mut payload: JsonValue = serde_json::from_str(&payload_json)
            .map_err(|e| format!("Invalid local message payload: {e}"))?;
        let object = payload
            .as_object_mut()
            .ok_or_else(|| "Local message payload must be a JSON object.".to_string())?;
        object.insert("collapsed".to_string(), JsonValue::Bool(collapsed));
        object.insert(
            "updatedAt".to_string(),
            JsonValue::String(updated_at.clone()),
        );
        let updated_payload_json = serde_json::to_string(&payload).map_err(|e| e.to_string())?;
        tx.execute(
            r#"
            UPDATE local_nodes
            SET payload_json = ?3,
                updated_at = ?4,
                local_updated_at = ?5
            WHERE id = ?1 AND workspace_id = ?2 AND deleted_at IS NULL
            "#,
            params![node_id, workspace_id, updated_payload_json, updated_at, now],
        )
        .map_err(|e| e.to_string())?;
        Self::enqueue_local_sync_event_locked(
            &tx,
            now,
            Some(workspace_id),
            user_id,
            "node",
            node_id,
            "node.collapsed.set",
            &serde_json::json!({ "collapsed": collapsed }).to_string(),
            None,
        )?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(updated_payload_json)
    }

    pub fn hydrate_local_nodes_from_server(
        &self,
        workspace_id: &str,
        payloads: Vec<String>,
    ) -> Result<usize, String> {
        let now = unix_timestamp();
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
        let mut hydrated = 0usize;

        for payload in payloads {
            let mut payload_value =
                serde_json::from_str::<JsonValue>(&payload).unwrap_or(JsonValue::Null);
            let Some(node_id) = payload_value
                .get("id")
                .and_then(|value| value.as_str())
                .map(|value| value.to_string())
            else {
                continue;
            };
            let payload_workspace_id = payload_value
                .get("workspaceId")
                .and_then(|value| value.as_str())
                .unwrap_or(workspace_id);
            if payload_workspace_id != workspace_id {
                continue;
            }
            let has_local_mutation = tx
                .query_row(
                    r#"
                    SELECT EXISTS(
                        SELECT 1
                        FROM local_sync_events
                        WHERE entity_type = 'node'
                          AND entity_id = ?1
                          AND status IN ('pending', 'in_flight', 'dead')
                    )
                    "#,
                    params![node_id],
                    |row| row.get::<_, i64>(0),
                )
                .map_err(|e| e.to_string())?
                != 0;
            let has_local_recovery = tx
                .query_row(
                    r#"
                    SELECT EXISTS(
                        SELECT 1
                        FROM agent_run_ledger
                        WHERE assistant_node_id = ?1
                          AND workspace_id = ?2
                          AND status IN ('needs_user_action', 'failed_finalization')
                    )
                    "#,
                    params![node_id, workspace_id],
                    |row| row.get::<_, i64>(0),
                )
                .map_err(|e| e.to_string())?
                != 0;
            if has_local_mutation || has_local_recovery {
                continue;
            }

            Self::repair_payload_timeline_if_needed(&tx, &node_id, &mut payload_value)?;
            let payload = serde_json::to_string(&payload_value).map_err(|e| e.to_string())?;
            let parent_id = payload_value
                .get("parentId")
                .and_then(|value| value.as_str());
            let controlled_by_node_id = controlled_by_node_id_from_payload(&payload_value);
            let role = payload_value
                .get("role")
                .and_then(|value| value.as_str())
                .unwrap_or("assistant");
            let content = payload_value
                .get("content")
                .and_then(|value| value.as_str())
                .unwrap_or("");
            let status = payload_value.get("status").and_then(|value| value.as_str());
            let thread_id = payload_value
                .get("threadId")
                .or_else(|| payload_value.get("thread_id"))
                .and_then(|value| value.as_str());
            let execution_data_json = payload_value
                .get("execution_data")
                .and_then(|value| serde_json::to_string(value).ok());
            let prompt_tokens = payload_value
                .get("promptTokens")
                .and_then(|value| value.as_i64());
            let completion_tokens = payload_value
                .get("completionTokens")
                .and_then(|value| value.as_i64());
            let total_tokens = payload_value
                .get("totalTokens")
                .and_then(|value| value.as_i64());
            let base_commit_sha = payload_value
                .get("base_commit_sha")
                .or_else(|| payload_value.get("baseCommitSha"))
                .and_then(|value| value.as_str());
            let output_commit_sha = payload_value
                .get("output_commit_sha")
                .or_else(|| payload_value.get("outputCommitSha"))
                .and_then(|value| value.as_str());
            let base_selected_from_node_id = payload_value
                .get("base_selected_from_node_id")
                .or_else(|| payload_value.get("baseSelectedFromNodeId"))
                .and_then(|value| value.as_str());
            let git_branch_name = payload_value
                .get("git_branch_name")
                .and_then(|value| value.as_str());
            let created_at = payload_value
                .get("createdAt")
                .and_then(|value| value.as_str())
                .map(|value| value.to_string())
                .unwrap_or_else(chrono_like_now);
            let updated_at = payload_value
                .get("updatedAt")
                .and_then(|value| value.as_str())
                .map(|value| value.to_string())
                .unwrap_or_else(chrono_like_now);
            let changed = tx.execute(
                r#"
                INSERT INTO local_nodes (
                    id, workspace_id, parent_id, controlled_by_node_id, role, content, status, thread_id,
                    execution_data_json, payload_json, prompt_tokens, completion_tokens, total_tokens,
                    base_commit_sha, output_commit_sha, base_selected_from_node_id, git_branch_name, created_at, updated_at,
                    deleted_at, local_updated_at, server_ack_at
                )
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, NULL, ?20, ?21)
                ON CONFLICT(id) DO NOTHING
                "#,
                params![
                    node_id,
                    workspace_id,
                    parent_id,
                    controlled_by_node_id,
                    role,
                    content,
                    status,
                    thread_id,
                    execution_data_json,
                    payload,
                    prompt_tokens,
                    completion_tokens,
                    total_tokens,
                    base_commit_sha,
                    output_commit_sha,
                    base_selected_from_node_id,
                    git_branch_name,
                    created_at,
                    updated_at,
                    now,
                    now.to_string()
                ],
            )
            .map_err(|e| e.to_string())?;
            hydrated += changed;
        }

        tx.commit().map_err(|e| e.to_string())?;
        Ok(hydrated)
    }

    pub fn mark_local_node_persisted(&self, node_id: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            r#"
            UPDATE local_nodes
            SET server_ack_at = ?2
            WHERE id = ?1
            "#,
            params![node_id, unix_timestamp().to_string()],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn record_agent_prelaunch_stage(
        &self,
        node_id: &str,
        run_id: &str,
        stage: &str,
    ) -> Result<(), String> {
        let recorded_at = utc_iso_now();
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            r#"
            UPDATE local_nodes
            SET
                payload_json = json_set(
                    CASE WHEN json_valid(COALESCE(payload_json, ''))
                        THEN json(payload_json) ELSE json('{}') END,
                    '$.execution_data.meta.prelaunch_run_id', ?2,
                    '$.execution_data.meta.prelaunch_stage', ?3,
                    '$.execution_data.meta.prelaunch_stage_at', ?4
                ),
                execution_data_json = json_set(
                    CASE WHEN json_valid(COALESCE(execution_data_json, ''))
                        THEN json(execution_data_json) ELSE json('{}') END,
                    '$.meta.prelaunch_run_id', ?2,
                    '$.meta.prelaunch_stage', ?3,
                    '$.meta.prelaunch_stage_at', ?4
                )
            WHERE id = ?1
              AND deleted_at IS NULL
              AND NOT EXISTS (
                  SELECT 1
                  FROM agent_run_ledger
                  WHERE assistant_node_id = ?1
              )
            "#,
            params![node_id, run_id, stage, recorded_at],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn update_local_node_runtime_activity(
        &self,
        node_id: &str,
        last_event_at: &str,
        latest_event_type: &str,
        terminal_status: Option<&str>,
    ) -> Result<(), String> {
        let now = unix_timestamp();
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        match terminal_status {
            Some(terminal_status) => {
                conn.execute(
                    r#"
                    UPDATE local_nodes
                    SET
                        payload_json = json_set(
                            CASE
                                WHEN json_valid(COALESCE(payload_json, '')) THEN json(payload_json)
                                ELSE json('{}')
                            END,
                            '$.last_event_at', ?2,
                            '$.execution_data.last_event_at', ?2,
                            '$.execution_data.latest_event_type', ?3,
                            '$.execution_data.last_terminal_status', ?4
                        ),
                        execution_data_json = json_set(
                            CASE
                                WHEN json_valid(COALESCE(execution_data_json, '')) THEN json(execution_data_json)
                                ELSE json('{}')
                            END,
                            '$.last_event_at', ?2,
                            '$.latest_event_type', ?3,
                            '$.last_terminal_status', ?4
                        ),
                        local_updated_at = ?5
                    WHERE id = ?1
                      AND deleted_at IS NULL
                    "#,
                    params![node_id, last_event_at, latest_event_type, terminal_status, now],
                )
            }
            None => {
                conn.execute(
                    r#"
                    UPDATE local_nodes
                    SET
                        payload_json = json_set(
                            CASE
                                WHEN json_valid(COALESCE(payload_json, '')) THEN json(payload_json)
                                ELSE json('{}')
                            END,
                            '$.last_event_at', ?2,
                            '$.execution_data.last_event_at', ?2,
                            '$.execution_data.latest_event_type', ?3
                        ),
                        execution_data_json = json_set(
                            CASE
                                WHEN json_valid(COALESCE(execution_data_json, '')) THEN json(execution_data_json)
                                ELSE json('{}')
                            END,
                            '$.last_event_at', ?2,
                            '$.latest_event_type', ?3
                        ),
                        local_updated_at = ?4
                    WHERE id = ?1
                      AND deleted_at IS NULL
                    "#,
                    params![node_id, last_event_at, latest_event_type, now],
                )
            }
        }
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn list_local_nodes_for_workspace(
        &self,
        workspace_id: &str,
    ) -> Result<Vec<LocalNodeRow>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                r#"
                WITH sync_events AS (
                    SELECT
                        entity_id,
                        MAX(attempt_count) AS retry_attempt,
                        MIN(CASE
                            WHEN status IN ('pending', 'in_flight') THEN next_attempt_at
                            ELSE NULL
                        END) AS next_retry_at
                    FROM local_sync_events
                    WHERE entity_type = 'node'
                      AND status IN ('pending', 'in_flight', 'dead')
                    GROUP BY entity_id
                ),
                latest_error_events AS (
                    SELECT e.entity_id, MAX(e.last_error) AS last_upload_error
                    FROM local_sync_events e
                    JOIN (
                        SELECT entity_id, MAX(updated_at) AS updated_at
                        FROM local_sync_events
                        WHERE entity_type = 'node'
                          AND status IN ('pending', 'in_flight', 'dead')
                          AND last_error IS NOT NULL
                        GROUP BY entity_id
                    ) latest
                      ON latest.entity_id = e.entity_id
                     AND latest.updated_at = e.updated_at
                    WHERE e.entity_type = 'node'
                      AND e.status IN ('pending', 'in_flight', 'dead')
                      AND e.last_error IS NOT NULL
                    GROUP BY e.entity_id
                )
                SELECT
                    n.id,
                    n.workspace_id,
                    n.controlled_by_node_id,
                    CASE
                        WHEN n.output_commit_sha IS NOT NULL THEN json_set(
                            COALESCE(n.payload_json, json_object(
                                'id', n.id,
                                'role', n.role,
                                'workspaceId', n.workspace_id,
                                'parentId', n.parent_id,
                                'controlled_by_node_id', n.controlled_by_node_id,
                                'controlledByNodeId', n.controlled_by_node_id,
                                'content', n.content,
                                'status', n.status,
                                'threadId', n.thread_id,
                                'thread_id', n.thread_id,
                                'execution_data', CASE
                                    WHEN n.execution_data_json IS NULL THEN json('{}')
                                    ELSE json(n.execution_data_json)
                                END,
                                'promptTokens', n.prompt_tokens,
                                'completionTokens', n.completion_tokens,
                                'totalTokens', n.total_tokens,
                                'base_commit_sha', n.base_commit_sha,
                                'base_selected_from_node_id', n.base_selected_from_node_id,
                                'git_branch_name', n.git_branch_name,
                                'createdAt', n.created_at,
                                'updatedAt', n.updated_at
                            )),
                            '$.output_commit_sha',
                            n.output_commit_sha,
                            '$.threadId',
                            n.thread_id,
                            '$.thread_id',
                            n.thread_id,
                            '$.controlled_by_node_id',
                            n.controlled_by_node_id,
                            '$.controlledByNodeId',
                            n.controlled_by_node_id
                        )
                        ELSE json_set(COALESCE(n.payload_json, json_object(
                        'id', n.id,
                        'role', n.role,
                        'workspaceId', n.workspace_id,
                        'parentId', n.parent_id,
                        'controlled_by_node_id', n.controlled_by_node_id,
                        'controlledByNodeId', n.controlled_by_node_id,
                        'content', n.content,
                        'status', n.status,
                        'threadId', n.thread_id,
                        'thread_id', n.thread_id,
                        'execution_data', CASE
                            WHEN n.execution_data_json IS NULL THEN json('{}')
                            ELSE json(n.execution_data_json)
                        END,
                        'promptTokens', n.prompt_tokens,
                        'completionTokens', n.completion_tokens,
                        'totalTokens', n.total_tokens,
                        'base_commit_sha', n.base_commit_sha,
                        'output_commit_sha', n.output_commit_sha,
                        'base_selected_from_node_id', n.base_selected_from_node_id,
                        'git_branch_name', n.git_branch_name,
                        'createdAt', n.created_at,
                        'updatedAt', n.updated_at
                        )),
                            '$.threadId',
                            n.thread_id,
                            '$.thread_id',
                            n.thread_id,
                            '$.controlled_by_node_id',
                            n.controlled_by_node_id,
                            '$.controlledByNodeId',
                            n.controlled_by_node_id
                        )
                    END AS payload,
                    CASE
                        WHEN se.entity_id IS NOT NULL THEN 'local_only'
                        WHEN n.server_ack_at IS NULL THEN 'local_only'
                        ELSE 'persisted'
                    END AS sync_status,
                    n.local_updated_at,
                    CASE
                        WHEN n.server_ack_at IS NULL THEN NULL
                        WHEN n.server_ack_at GLOB '[0-9]*' THEN CAST(n.server_ack_at AS INTEGER)
                        ELSE NULL
                    END AS server_ack_at,
                    COALESCE(se.retry_attempt, 0) AS retry_attempt,
                    se.next_retry_at,
                    le.last_upload_error
                FROM local_nodes n
                LEFT JOIN sync_events se ON se.entity_id = n.id
                LEFT JOIN latest_error_events le ON le.entity_id = n.id
                WHERE n.workspace_id = ?1
                  AND n.deleted_at IS NULL
                  AND COALESCE(json_extract(n.payload_json, '$.execution_data.meta.agentree_hidden_node'), 0) != 1
                  AND COALESCE(json_extract(n.payload_json, '$.execution_data.meta.agentree_insight_run'), 0) != 1
                ORDER BY n.local_updated_at ASC
                "#,
            )
            .map_err(|e| e.to_string())?;
        let mut rows: Vec<LocalNodeRow> = stmt
            .query_map(params![workspace_id], |row| {
                Ok(LocalNodeRow {
                    node_id: row.get(0)?,
                    workspace_id: row.get(1)?,
                    controlled_by_node_id: row.get(2)?,
                    payload: row.get(3)?,
                    sync_status: row.get(4)?,
                    finalized_at: row.get(5)?,
                    server_ack_at: row.get(6)?,
                    retry_attempt: row.get(7)?,
                    next_retry_at: row.get(8)?,
                    last_upload_error: row.get(9)?,
                })
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        for row in &mut rows {
            row.payload = crate::tool_output::sanitize_serialized_tool_outputs(&row.payload);
        }
        rows.sort_by_key(|row| row.finalized_at);
        Ok(rows)
    }

    pub(crate) fn list_local_agent_control_edges_for_user(
        &self,
        user_id: &str,
    ) -> Result<Vec<(String, String)>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                r#"
                SELECT n.id, n.controlled_by_node_id
                FROM local_nodes n
                JOIN local_workspaces w ON w.id = n.workspace_id
                WHERE (w.user_id = ?1 OR w.user_id IS NULL)
                  AND w.deleted_at IS NULL
                  AND n.deleted_at IS NULL
                  AND n.role = 'assistant'
                  AND n.controlled_by_node_id IS NOT NULL
                ORDER BY n.id ASC
                "#,
            )
            .map_err(|e| e.to_string())?;
        let edges = stmt
            .query_map(params![user_id], |row| Ok((row.get(0)?, row.get(1)?)))
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        Ok(edges)
    }

    fn normalize_thread_session_payload(
        payload: ThreadSessionPayload,
    ) -> Result<ThreadSessionPayload, String> {
        let id = payload.id.trim().to_string();
        let workspace_id = payload.workspace_id.trim().to_string();
        if id.is_empty() {
            return Err("thread session id is required".to_string());
        }
        if workspace_id.is_empty() {
            return Err("thread session workspace_id is required".to_string());
        }
        let created_at = payload.created_at.unwrap_or_else(chrono_like_now);
        let updated_at = payload.updated_at.unwrap_or_else(|| created_at.clone());
        let status = match payload.status.as_str() {
            "done" | "archived" => payload.status,
            _ => "active".to_string(),
        };
        let source = match payload.source.as_str() {
            "workspace_default" | "flow" | "legacy" | "delegation" | "converted_subgraph" => {
                payload.source
            }
            _ => "user".to_string(),
        };
        Ok(ThreadSessionPayload {
            id,
            workspace_id,
            title: payload.title.and_then(|value| {
                let trimmed = value.trim().to_string();
                if trimmed.is_empty() {
                    None
                } else {
                    Some(trimmed)
                }
            }),
            status,
            created_at: Some(created_at),
            updated_at: Some(updated_at),
            base_commit_sha: payload.base_commit_sha,
            first_message_id: payload.first_message_id,
            parent_thread_id: payload.parent_thread_id,
            source,
            anchor_node_id: payload.anchor_node_id,
        })
    }

    fn upsert_thread_session_locked(
        conn: &Connection,
        normalized: &ThreadSessionPayload,
        now: i64,
    ) -> Result<(), String> {
        conn.execute(
            r#"
            INSERT INTO thread_sessions (
                id, workspace_id, title, status, base_commit_sha, first_message_id,
                source, parent_thread_id, anchor_node_id, created_at, updated_at, deleted_at, local_updated_at
            )
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, NULL, ?12)
            ON CONFLICT(id) DO UPDATE SET
                workspace_id = excluded.workspace_id,
                title = excluded.title,
                status = excluded.status,
                base_commit_sha = excluded.base_commit_sha,
                first_message_id = COALESCE(excluded.first_message_id, thread_sessions.first_message_id),
                source = excluded.source,
                parent_thread_id = excluded.parent_thread_id,
                anchor_node_id = excluded.anchor_node_id,
                updated_at = excluded.updated_at,
                deleted_at = thread_sessions.deleted_at,
                local_updated_at = excluded.local_updated_at
            "#,
            params![
                normalized.id,
                normalized.workspace_id,
                normalized.title,
                normalized.status,
                normalized.base_commit_sha,
                normalized.first_message_id,
                normalized.source,
                normalized.parent_thread_id,
                normalized.anchor_node_id,
                normalized.created_at,
                normalized.updated_at,
                now
            ],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    #[cfg(test)]
    pub fn upsert_thread_session(
        &self,
        payload: ThreadSessionPayload,
    ) -> Result<ThreadSessionPayload, String> {
        let normalized = Self::normalize_thread_session_payload(payload)?;
        let now = unix_timestamp();
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        Self::upsert_thread_session_locked(&conn, &normalized, now)?;
        Ok(normalized)
    }

    pub fn local_first_create_thread_session(
        &self,
        user_id: Option<&str>,
        payload: ThreadSessionPayload,
    ) -> Result<ThreadSessionPayload, String> {
        let normalized = Self::normalize_thread_session_payload(payload)?;
        let now = unix_timestamp();
        let mut conn = self.conn.lock().map_err(|e| e.to_string())?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        Self::upsert_thread_session_locked(&tx, &normalized, now)?;
        let payload_json = serde_json::to_string(&normalized).map_err(|e| e.to_string())?;
        Self::enqueue_local_sync_event_locked(
            &tx,
            now,
            Some(&normalized.workspace_id),
            user_id,
            "thread",
            &normalized.id,
            "thread.create",
            &payload_json,
            Some(&format!("thread.create:{}", normalized.id)),
        )?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(normalized)
    }

    pub fn convert_subgraph_to_thread(
        &self,
        workspace_id: &str,
        root_node_id: &str,
        idempotency_key: &str,
        target_thread_id: &str,
        current_user_id: Option<&str>,
    ) -> Result<ConvertSubgraphToThreadResult, String> {
        let workspace_id = workspace_id.trim();
        let root_node_id = root_node_id.trim();
        let idempotency_key = idempotency_key.trim();
        let target_thread_id = target_thread_id.trim();
        if workspace_id.is_empty()
            || root_node_id.is_empty()
            || idempotency_key.is_empty()
            || target_thread_id.is_empty()
        {
            return Err(
                "workspaceId, rootNodeId, idempotencyKey, and targetThreadId are required"
                    .to_string(),
            );
        }

        let mut conn = self.conn.lock().map_err(|e| e.to_string())?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        let read_existing = |column: &str,
                             value: &str|
         -> Result<Option<ConvertSubgraphToThreadResult>, String> {
            let sql = format!(
                "SELECT c.id, c.root_node_id, c.source_thread_id, c.target_thread_id, c.original_parent_id, c.moved_node_ids_json, \
                        t.workspace_id, t.title, t.status, t.created_at, t.updated_at, t.base_commit_sha, t.first_message_id, t.source, t.parent_thread_id, t.anchor_node_id \
                 FROM subgraph_thread_conversions c JOIN thread_sessions t ON t.id = c.target_thread_id \
                 WHERE c.workspace_id = ?1 AND c.{column} = ?2"
            );
            tx.query_row(&sql, params![workspace_id, value], |row| {
                let moved_json: String = row.get(5)?;
                Ok(ConvertSubgraphToThreadResult {
                    conversion_id: row.get(0)?,
                    root_node_id: row.get(1)?,
                    source_thread_id: row.get(2)?,
                    target_thread_id: row.get(3)?,
                    original_parent_id: row.get(4)?,
                    moved_node_ids: serde_json::from_str(&moved_json).unwrap_or_default(),
                    thread: ThreadSessionPayload {
                        id: row.get(3)?,
                        workspace_id: row.get(6)?,
                        title: row.get(7)?,
                        status: row.get(8)?,
                        created_at: row.get(9)?,
                        updated_at: row.get(10)?,
                        base_commit_sha: row.get(11)?,
                        first_message_id: row.get(12)?,
                        source: row.get(13)?,
                        parent_thread_id: row.get(14)?,
                        anchor_node_id: row.get(15)?,
                    },
                })
            })
            .optional()
            .map_err(|e| e.to_string())
        };
        if let Some(existing) = read_existing("idempotency_key", idempotency_key)? {
            return Ok(existing);
        }
        if let Some(existing) = read_existing("root_node_id", root_node_id)? {
            return Ok(existing);
        }

        #[derive(Clone)]
        struct ConversionNode {
            id: String,
            parent_id: Option<String>,
            role: String,
            status: Option<String>,
            thread_id: Option<String>,
            content: String,
            base_commit_sha: Option<String>,
            payload_json: Option<String>,
        }
        let nodes = {
            let mut stmt = tx.prepare(
                "SELECT id, parent_id, role, status, thread_id, content, base_commit_sha, payload_json \
                 FROM local_nodes WHERE workspace_id = ?1 AND deleted_at IS NULL"
            ).map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map(params![workspace_id], |row| {
                    Ok(ConversionNode {
                        id: row.get(0)?,
                        parent_id: row.get(1)?,
                        role: row.get(2)?,
                        status: row.get(3)?,
                        thread_id: row.get(4)?,
                        content: row.get(5)?,
                        base_commit_sha: row.get(6)?,
                        payload_json: row.get(7)?,
                    })
                })
                .map_err(|e| e.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?;
            rows
        };
        let by_id: std::collections::HashMap<String, ConversionNode> = nodes
            .iter()
            .cloned()
            .map(|node| (node.id.clone(), node))
            .collect();
        let root = by_id
            .get(root_node_id)
            .ok_or_else(|| "Conversion root does not exist".to_string())?;
        let original_parent_id = root
            .parent_id
            .clone()
            .filter(|id| !id.is_empty())
            .ok_or_else(|| "Only a nested user node can be converted to a thread".to_string())?;
        if root.role != "user" || !by_id.contains_key(&original_parent_id) {
            return Err(
                "Only a nested user node with a valid anchor can be converted to a thread"
                    .to_string(),
            );
        }
        let source_thread_id = root.thread_id.clone();
        let mut children_by_parent: std::collections::HashMap<String, Vec<String>> =
            std::collections::HashMap::new();
        for node in &nodes {
            if let Some(parent_id) = node.parent_id.as_ref() {
                children_by_parent
                    .entry(parent_id.clone())
                    .or_default()
                    .push(node.id.clone());
            }
        }
        let mut moved_node_ids = Vec::new();
        let mut moved = std::collections::HashSet::new();
        let mut queue = std::collections::VecDeque::from([root_node_id.to_string()]);
        while let Some(node_id) = queue.pop_front() {
            if moved.contains(&node_id) {
                continue;
            }
            let Some(node) = by_id.get(&node_id) else {
                continue;
            };
            if node.thread_id != source_thread_id {
                continue;
            }
            moved.insert(node_id.clone());
            moved_node_ids.push(node_id.clone());
            for child_id in children_by_parent.get(&node_id).into_iter().flatten() {
                queue.push_back(child_id.clone());
            }
        }
        const ACTIVE_STATUSES: &[&str] = &[
            "pending",
            "queued",
            "starting",
            "running",
            "streaming",
            "working",
            "cancelling",
        ];
        if let Some(active) = moved_node_ids
            .iter()
            .filter_map(|id| by_id.get(id))
            .find(|node| {
                node.status
                    .as_deref()
                    .map(|status| ACTIVE_STATUSES.contains(&status.to_ascii_lowercase().as_str()))
                    .unwrap_or(false)
            })
        {
            return Err(format!(
                "Node {} is still active; wait for it to finish before converting",
                active.id
            ));
        }

        let now_iso = chrono_like_now();
        let now = unix_timestamp();
        tx.execute(
            "INSERT INTO thread_sessions (id, workspace_id, title, status, base_commit_sha, first_message_id, source, parent_thread_id, anchor_node_id, created_at, updated_at, deleted_at, local_updated_at) \
             VALUES (?1, ?2, ?3, 'active', ?4, ?5, 'converted_subgraph', ?6, ?7, ?8, ?8, NULL, ?9)",
            params![target_thread_id, workspace_id, root.content.trim(), root.base_commit_sha, root_node_id, source_thread_id, original_parent_id, now_iso, now],
        ).map_err(|e| e.to_string())?;

        let mut relative_paths: std::collections::HashMap<String, Vec<String>> =
            std::collections::HashMap::new();
        relative_paths.insert(root_node_id.to_string(), Vec::new());
        for node_id in &moved_node_ids {
            if node_id == root_node_id {
                continue;
            }
            let node = by_id.get(node_id).unwrap();
            let mut path = node
                .parent_id
                .as_ref()
                .and_then(|id| relative_paths.get(id))
                .cloned()
                .unwrap_or_default();
            if let Some(parent_id) = node.parent_id.as_ref() {
                path.push(parent_id.clone());
            }
            relative_paths.insert(node_id.clone(), path);
        }
        for node_id in &moved_node_ids {
            let node = by_id.get(node_id).unwrap();
            let mut payload: JsonValue = node
                .payload_json
                .as_deref()
                .and_then(|value| serde_json::from_str(value).ok())
                .unwrap_or_else(|| serde_json::json!({}));
            if let Some(object) = payload.as_object_mut() {
                object.insert(
                    "threadId".to_string(),
                    JsonValue::String(target_thread_id.to_string()),
                );
                object.insert(
                    "thread_id".to_string(),
                    JsonValue::String(target_thread_id.to_string()),
                );
                if node_id == root_node_id {
                    object.insert("parentId".to_string(), JsonValue::Null);
                    object.insert("parent_id".to_string(), JsonValue::Null);
                }
                let path = relative_paths.get(node_id).cloned().unwrap_or_default();
                object.insert("path_ids".to_string(), serde_json::json!(path));
                object.insert("depth".to_string(), serde_json::json!(path.len()));
                object.insert("updatedAt".to_string(), JsonValue::String(now_iso.clone()));
            }
            tx.execute(
                "UPDATE local_nodes SET thread_id = ?1, parent_id = CASE WHEN id = ?2 THEN NULL ELSE parent_id END, payload_json = ?3, updated_at = ?4, local_updated_at = ?5 WHERE id = ?6",
                params![target_thread_id, root_node_id, payload.to_string(), now_iso, now, node_id],
            ).map_err(|e| e.to_string())?;
        }

        let conversion_id = uuid::Uuid::new_v4().to_string();
        let moved_json = serde_json::to_string(&moved_node_ids).map_err(|e| e.to_string())?;
        tx.execute(
            "INSERT INTO subgraph_thread_conversions (id, workspace_id, idempotency_key, root_node_id, source_thread_id, target_thread_id, original_parent_id, moved_node_ids_json, created_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![conversion_id, workspace_id, idempotency_key, root_node_id, source_thread_id, target_thread_id, original_parent_id, moved_json, now_iso],
        ).map_err(|e| e.to_string())?;

        let sync_payload = serde_json::json!({
            "rootNodeId": root_node_id, "idempotencyKey": idempotency_key, "targetThreadId": target_thread_id
        }).to_string();
        Self::enqueue_local_sync_event_locked(
            &tx,
            now,
            Some(workspace_id),
            current_user_id,
            "thread_conversion",
            root_node_id,
            "thread.convert_subgraph",
            &sync_payload,
            Some(idempotency_key),
        )?;

        let thread = ThreadSessionPayload {
            id: target_thread_id.to_string(),
            workspace_id: workspace_id.to_string(),
            title: Some(root.content.trim().to_string()).filter(|value| !value.is_empty()),
            status: "active".to_string(),
            created_at: Some(now_iso.clone()),
            updated_at: Some(now_iso),
            base_commit_sha: root.base_commit_sha.clone(),
            first_message_id: Some(root_node_id.to_string()),
            source: "converted_subgraph".to_string(),
            parent_thread_id: source_thread_id.clone(),
            anchor_node_id: Some(original_parent_id.clone()),
        };
        let result = ConvertSubgraphToThreadResult {
            thread,
            conversion_id,
            root_node_id: root_node_id.to_string(),
            source_thread_id,
            target_thread_id: target_thread_id.to_string(),
            original_parent_id,
            moved_node_ids,
        };
        tx.commit().map_err(|e| e.to_string())?;
        Ok(result)
    }

    pub fn list_thread_sessions_for_workspace(
        &self,
        workspace_id: &str,
    ) -> Result<Vec<ThreadSessionPayload>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                r#"
                SELECT
                    id, workspace_id, title, status, created_at, updated_at,
                    base_commit_sha, first_message_id, source, parent_thread_id, anchor_node_id
                FROM thread_sessions
                WHERE workspace_id = ?1
                  AND deleted_at IS NULL
                ORDER BY
                    CASE status
                        WHEN 'active' THEN 0
                        WHEN 'done' THEN 1
                        ELSE 2
                    END ASC,
                    updated_at DESC,
                    id ASC
                "#,
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![workspace_id], |row| {
                Ok(ThreadSessionPayload {
                    id: row.get(0)?,
                    workspace_id: row.get(1)?,
                    title: row.get(2)?,
                    status: row.get(3)?,
                    created_at: row.get(4)?,
                    updated_at: row.get(5)?,
                    base_commit_sha: row.get(6)?,
                    first_message_id: row.get(7)?,
                    source: row.get(8)?,
                    parent_thread_id: row.get(9)?,
                    anchor_node_id: row.get(10)?,
                })
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        Ok(rows)
    }

    pub(crate) fn get_thread_session_by_id(
        &self,
        thread_id: &str,
    ) -> Result<Option<ThreadSessionPayload>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.query_row(
            r#"
            SELECT
                id, workspace_id, title, status, created_at, updated_at,
                base_commit_sha, first_message_id, parent_thread_id, source, anchor_node_id
            FROM thread_sessions
            WHERE id = ?1
              AND deleted_at IS NULL
            LIMIT 1
            "#,
            params![thread_id],
            |row| {
                Ok(ThreadSessionPayload {
                    id: row.get(0)?,
                    workspace_id: row.get(1)?,
                    title: row.get(2)?,
                    status: row.get(3)?,
                    created_at: row.get(4)?,
                    updated_at: row.get(5)?,
                    base_commit_sha: row.get(6)?,
                    first_message_id: row.get(7)?,
                    parent_thread_id: row.get(8)?,
                    source: row.get(9)?,
                    anchor_node_id: row.get(10)?,
                })
            },
        )
        .optional()
        .map_err(|e| e.to_string())
    }

    pub(crate) fn claim_thread_first_message(
        &self,
        workspace_id: &str,
        thread_id: &str,
        message_id: &str,
    ) -> Result<bool, String> {
        let now = unix_timestamp();
        let updated_at = chrono_like_now();
        let mut conn = self.conn.lock().map_err(|e| e.to_string())?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        let current_first_message_id = tx
            .query_row(
                r#"
                SELECT first_message_id
                FROM thread_sessions
                WHERE workspace_id = ?1
                  AND id = ?2
                  AND deleted_at IS NULL
                "#,
                params![workspace_id, thread_id],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()
            .map_err(|e| e.to_string())?
            .ok_or_else(|| format!("Thread {thread_id} does not exist."))?;
        if current_first_message_id.is_some() {
            tx.commit().map_err(|e| e.to_string())?;
            return Ok(false);
        }

        let existing_root_id = tx
            .query_row(
                r#"
                SELECT id
                FROM local_nodes
                WHERE workspace_id = ?1
                  AND thread_id = ?2
                  AND parent_id IS NULL
                  AND role = 'user'
                  AND deleted_at IS NULL
                ORDER BY created_at ASC, id ASC
                LIMIT 1
                "#,
                params![workspace_id, thread_id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        let first_message_id = existing_root_id.as_deref().unwrap_or(message_id);
        tx.execute(
            r#"
            UPDATE thread_sessions
            SET first_message_id = ?3,
                updated_at = ?4,
                local_updated_at = ?5
            WHERE workspace_id = ?1
              AND id = ?2
              AND first_message_id IS NULL
              AND deleted_at IS NULL
            "#,
            params![workspace_id, thread_id, first_message_id, updated_at, now],
        )
        .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(existing_root_id.is_none())
    }

    #[cfg(test)]
    pub fn archive_thread_session(
        &self,
        workspace_id: &str,
        thread_id: &str,
    ) -> Result<(), String> {
        let workspace_id = workspace_id.trim();
        let thread_id = thread_id.trim();
        if workspace_id.is_empty() {
            return Err("workspace_id is required".to_string());
        }
        if thread_id.is_empty() {
            return Err("thread_id is required".to_string());
        }
        let now = unix_timestamp();
        let deleted_at = chrono_like_now();
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            r#"
            UPDATE thread_sessions
            SET status = 'archived',
                deleted_at = ?3,
                updated_at = ?3,
                local_updated_at = ?4
            WHERE workspace_id = ?1
              AND id = ?2
              AND deleted_at IS NULL
            "#,
            params![workspace_id, thread_id, deleted_at, now],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn local_first_archive_thread_session(
        &self,
        user_id: Option<&str>,
        workspace_id: &str,
        thread_id: &str,
    ) -> Result<(), String> {
        let workspace_id = workspace_id.trim();
        let thread_id = thread_id.trim();
        if workspace_id.is_empty() {
            return Err("workspace_id is required".to_string());
        }
        if thread_id.is_empty() {
            return Err("thread_id is required".to_string());
        }
        let now = unix_timestamp();
        let deleted_at = chrono_like_now();
        let mut conn = self.conn.lock().map_err(|e| e.to_string())?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        let changed = tx
            .execute(
                r#"
                UPDATE thread_sessions
                SET status = 'archived',
                    deleted_at = ?3,
                    updated_at = ?3,
                    local_updated_at = ?4
                WHERE workspace_id = ?1
                  AND id = ?2
                  AND deleted_at IS NULL
                "#,
                params![workspace_id, thread_id, deleted_at, now],
            )
            .map_err(|e| e.to_string())?;
        if changed == 0 {
            return Err("Thread session not found.".to_string());
        }
        Self::enqueue_local_sync_event_locked(
            &tx,
            now,
            Some(workspace_id),
            user_id,
            "thread",
            thread_id,
            "thread.delete",
            &serde_json::json!({ "workspaceId": workspace_id }).to_string(),
            Some(&format!("thread.delete:{thread_id}")),
        )?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn get_local_node_payload(&self, node_id: &str) -> Result<Option<String>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.query_row(
            "SELECT payload_json FROM local_nodes WHERE id = ?1 AND deleted_at IS NULL",
            params![node_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()
        .map(|value| {
            value
                .flatten()
                .map(|payload| crate::tool_output::sanitize_serialized_tool_outputs(&payload))
        })
        .map_err(|e| e.to_string())
    }

    pub(crate) fn get_local_node_workspace_and_payload(
        &self,
        node_id: &str,
    ) -> Result<Option<(String, String)>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.query_row(
            r#"
            SELECT workspace_id, payload_json
            FROM local_nodes
            WHERE id = ?1
              AND deleted_at IS NULL
            LIMIT 1
            "#,
            params![node_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map(|row| {
            row.map(|(workspace_id, payload): (String, String)| {
                (
                    workspace_id,
                    crate::tool_output::sanitize_serialized_tool_outputs(&payload),
                )
            })
        })
        .map_err(|e| e.to_string())
    }

    pub fn get_local_node_parent_id(&self, node_id: &str) -> Result<Option<String>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.query_row(
            "SELECT parent_id FROM local_nodes WHERE id = ?1 AND deleted_at IS NULL",
            params![node_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()
        .map(|value| value.flatten())
        .map_err(|e| e.to_string())
    }

    pub fn list_local_commit_graph(
        &self,
        workspace_id: &str,
    ) -> Result<LocalCommitGraphSnapshot, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        Self::list_local_commit_graph_locked(&conn, workspace_id)
    }

    fn list_local_commit_graph_locked(
        conn: &Connection,
        workspace_id: &str,
    ) -> Result<LocalCommitGraphSnapshot, String> {
        let mut commit_stmt = conn
            .prepare(
                r#"
                SELECT sha, subject, author_name, author_email, authored_at, committed_at,
                       source_kind, produced_by_node_id, first_parent_sha, files_changed_count,
                       total_additions, total_deletions
                FROM local_commits
                WHERE workspace_id = ?1
                ORDER BY COALESCE(committed_at, authored_at, ''), sha
                "#,
            )
            .map_err(|e| e.to_string())?;
        let commits = commit_stmt
            .query_map(params![workspace_id], |row| {
                Ok(LocalCommitRow {
                    sha: row.get(0)?,
                    subject: row.get(1)?,
                    author_name: row.get(2)?,
                    author_email: row.get(3)?,
                    authored_at: row.get(4)?,
                    committed_at: row.get(5)?,
                    source_kind: row.get(6)?,
                    produced_by_node_id: row.get(7)?,
                    first_parent_sha: row.get(8)?,
                    files_changed_count: row.get(9)?,
                    total_additions: row.get(10)?,
                    total_deletions: row.get(11)?,
                })
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;

        let mut parent_stmt = conn
            .prepare(
                r#"
                SELECT child_sha, parent_sha, parent_index
                FROM local_commit_parents
                WHERE workspace_id = ?1
                ORDER BY child_sha, parent_index
                "#,
            )
            .map_err(|e| e.to_string())?;
        let commit_parents = parent_stmt
            .query_map(params![workspace_id], |row| {
                Ok(LocalCommitParentRow {
                    child_sha: row.get(0)?,
                    parent_sha: row.get(1)?,
                    parent_index: row.get(2)?,
                })
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;

        let mut observation_stmt = conn
            .prepare(
                r#"
                SELECT commit_sha, NULLIF(git_ref, ''), source_kind,
                       strftime('%Y-%m-%dT%H:%M:%fZ', first_seen_at, 'unixepoch'),
                       strftime('%Y-%m-%dT%H:%M:%fZ', last_seen_at, 'unixepoch')
                FROM local_commit_observations
                WHERE workspace_id = ?1
                ORDER BY commit_sha, git_ref, source_kind
                "#,
            )
            .map_err(|e| e.to_string())?;
        let commit_observations = observation_stmt
            .query_map(params![workspace_id], |row| {
                Ok(LocalCommitObservationRow {
                    commit_sha: row.get(0)?,
                    git_ref: row.get(1)?,
                    source_kind: row.get(2)?,
                    first_seen_at: row.get(3)?,
                    last_seen_at: row.get(4)?,
                })
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;

        Ok(LocalCommitGraphSnapshot {
            commits,
            commit_parents,
            commit_observations,
        })
    }

    fn list_local_commit_shas(&self, workspace_id: &str) -> Result<HashSet<String>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare("SELECT sha FROM local_commits WHERE workspace_id = ?1")
            .map_err(|e| e.to_string())?;
        let shas = stmt
            .query_map(params![workspace_id], |row| row.get::<_, String>(0))
            .map_err(|e| e.to_string())?
            .collect::<Result<HashSet<_>, _>>()
            .map_err(|e| e.to_string())?;
        Ok(shas)
    }

    fn materialize_local_commit_parent_closure(
        &self,
        workspace_id: &str,
        commits: Vec<LocalCommitImport>,
        repo_path: Option<&str>,
    ) -> Result<Vec<LocalCommitImport>, String> {
        let existing_shas = self.list_local_commit_shas(workspace_id)?;
        let mut commit_by_sha: HashMap<String, LocalCommitImport> = HashMap::new();
        let mut commit_order: Vec<String> = Vec::new();

        for mut commit in commits {
            let sha = commit.sha.trim().to_string();
            if sha.is_empty() {
                continue;
            }
            commit.sha = sha.clone();
            commit.parents = commit
                .parents
                .iter()
                .map(|parent| parent.trim().to_string())
                .filter(|parent| !parent.is_empty())
                .collect();
            if !commit_by_sha.contains_key(&sha) {
                commit_order.push(sha.clone());
            }
            commit_by_sha.insert(sha, commit);
        }

        if !existing_shas.is_empty() {
            if let Some(repo_path) = repo_path.map(str::trim).filter(|value| !value.is_empty()) {
                let mut queue: VecDeque<String> = commit_by_sha
                    .values()
                    .flat_map(|commit| commit.parents.iter().cloned())
                    .filter(|sha| !existing_shas.contains(sha) && !commit_by_sha.contains_key(sha))
                    .collect();
                let mut queued: HashSet<String> = queue.iter().cloned().collect();
                let mut fetched = 0usize;

                while let Some(parent_sha) = queue.pop_front() {
                    queued.remove(&parent_sha);
                    if existing_shas.contains(&parent_sha)
                        || commit_by_sha.contains_key(&parent_sha)
                    {
                        continue;
                    }
                    if fetched >= LOCAL_COMMIT_PARENT_CLOSURE_LIMIT {
                        return Err(format!(
                            "Local commit parent closure exceeded {} commits while resolving {}",
                            LOCAL_COMMIT_PARENT_CLOSURE_LIMIT, parent_sha
                        ));
                    }

                    let metadata =
                        crate::git_workspace::read_commit_metadata_sync(repo_path, &parent_sha)?;
                    let sha = metadata.sha.trim().to_string();
                    if sha.is_empty()
                        || existing_shas.contains(&sha)
                        || commit_by_sha.contains_key(&sha)
                    {
                        continue;
                    }

                    let parents = metadata
                        .parents
                        .iter()
                        .map(|parent| parent.trim().to_string())
                        .filter(|parent| !parent.is_empty())
                        .collect::<Vec<_>>();
                    for parent in &parents {
                        if !existing_shas.contains(parent)
                            && !commit_by_sha.contains_key(parent)
                            && queued.insert(parent.clone())
                        {
                            queue.push_back(parent.clone());
                        }
                    }

                    commit_order.push(sha.clone());
                    commit_by_sha.insert(
                        sha.clone(),
                        LocalCommitImport {
                            sha,
                            parents,
                            subject: Some(metadata.subject),
                            author_name: metadata.author_name,
                            author_email: metadata.author_email,
                            authored_at: metadata.authored_at.clone(),
                            committed_at: metadata.authored_at,
                            source_kind: Some("external".to_string()),
                            produced_by_node_id: None,
                            files_changed_count: metadata
                                .files_changed_count
                                .map(|value| value as i64),
                            total_additions: metadata.total_additions.map(|value| value as i64),
                            total_deletions: metadata.total_deletions.map(|value| value as i64),
                        },
                    );
                    fetched += 1;
                }
            }
        }

        let available_shas = existing_shas
            .union(&commit_by_sha.keys().cloned().collect::<HashSet<_>>())
            .cloned()
            .collect::<HashSet<_>>();

        let mut visited = HashSet::new();
        let mut ordered = Vec::new();
        fn visit_commit(
            sha: &str,
            commit_by_sha: &HashMap<String, LocalCommitImport>,
            visited: &mut HashSet<String>,
            ordered: &mut Vec<String>,
        ) {
            if !visited.insert(sha.to_string()) {
                return;
            }
            if let Some(commit) = commit_by_sha.get(sha) {
                for parent in &commit.parents {
                    if commit_by_sha.contains_key(parent) {
                        visit_commit(parent, commit_by_sha, visited, ordered);
                    }
                }
            }
            ordered.push(sha.to_string());
        }

        for sha in &commit_order {
            visit_commit(sha, &commit_by_sha, &mut visited, &mut ordered);
        }

        Ok(ordered
            .into_iter()
            .filter_map(|sha| commit_by_sha.remove(&sha))
            .map(|mut commit| {
                commit
                    .parents
                    .retain(|parent| available_shas.contains(parent));
                commit
            })
            .collect())
    }

    fn list_dangling_local_commit_parent_shas(
        &self,
        workspace_id: &str,
    ) -> Result<Vec<String>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                r#"
                SELECT DISTINCT p.parent_sha
                FROM local_commit_parents p
                LEFT JOIN local_commits c
                  ON c.workspace_id = p.workspace_id
                 AND c.sha = p.parent_sha
                WHERE p.workspace_id = ?1
                  AND c.sha IS NULL
                ORDER BY p.parent_sha
                "#,
            )
            .map_err(|e| e.to_string())?;
        let shas = stmt
            .query_map(params![workspace_id], |row| row.get::<_, String>(0))
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        Ok(shas)
    }

    pub fn repair_local_commit_parent_closure(
        &self,
        workspace_id: &str,
        repo_path: &str,
        git_ref: Option<&str>,
    ) -> Result<usize, String> {
        let dangling_parent_shas = self.list_dangling_local_commit_parent_shas(workspace_id)?;
        if dangling_parent_shas.is_empty() {
            return Ok(0);
        }

        let mut commits = Vec::new();
        for sha in dangling_parent_shas {
            let metadata = crate::git_workspace::read_commit_metadata_sync(repo_path, &sha)?;
            commits.push(LocalCommitImport {
                sha: metadata.sha,
                parents: metadata.parents,
                subject: Some(metadata.subject),
                author_name: metadata.author_name,
                author_email: metadata.author_email,
                authored_at: metadata.authored_at.clone(),
                committed_at: metadata.authored_at,
                source_kind: Some("external".to_string()),
                produced_by_node_id: None,
                files_changed_count: metadata.files_changed_count.map(|value| value as i64),
                total_additions: metadata.total_additions.map(|value| value as i64),
                total_deletions: metadata.total_deletions.map(|value| value as i64),
            });
        }

        self.import_local_commits_with_parent_closure(
            workspace_id,
            commits,
            git_ref,
            Some(repo_path),
        )
    }

    pub fn import_local_commits_with_parent_closure(
        &self,
        workspace_id: &str,
        commits: Vec<LocalCommitImport>,
        git_ref: Option<&str>,
        repo_path: Option<&str>,
    ) -> Result<usize, String> {
        let commits =
            self.materialize_local_commit_parent_closure(workspace_id, commits, repo_path)?;
        self.import_local_commits(workspace_id, commits, git_ref)
    }

    pub fn import_local_commits(
        &self,
        workspace_id: &str,
        commits: Vec<LocalCommitImport>,
        git_ref: Option<&str>,
    ) -> Result<usize, String> {
        let now = unix_timestamp();
        let mut conn = self.conn.lock().map_err(|e| e.to_string())?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        let mut imported = 0usize;

        for commit in commits {
            let sha = commit.sha.trim();
            if sha.is_empty() {
                continue;
            }
            let parents = commit
                .parents
                .iter()
                .map(|parent| parent.trim())
                .filter(|parent| !parent.is_empty())
                .collect::<Vec<_>>();
            let first_parent_sha = parents.first().copied();
            let source_kind = commit
                .source_kind
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .unwrap_or("external");
            let existing_commit: bool = tx
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM local_commits WHERE workspace_id = ?1 AND sha = ?2)",
                    params![workspace_id, sha],
                    |row| row.get::<_, i64>(0),
                )
                .map_err(|e| e.to_string())?
                != 0;

            tx.execute(
                r#"
                INSERT INTO local_commits (
                    workspace_id, sha, subject, author_name, author_email, authored_at, committed_at,
                    source_kind, produced_by_node_id, first_parent_sha, files_changed_count,
                    total_additions, total_deletions, local_updated_at
                )
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
                ON CONFLICT(workspace_id, sha) DO UPDATE SET
                    subject = COALESCE(excluded.subject, local_commits.subject),
                    author_name = COALESCE(excluded.author_name, local_commits.author_name),
                    author_email = COALESCE(excluded.author_email, local_commits.author_email),
                    authored_at = COALESCE(excluded.authored_at, local_commits.authored_at),
                    committed_at = COALESCE(excluded.committed_at, local_commits.committed_at),
                    source_kind = CASE
                        WHEN local_commits.source_kind IN ('agent', 'merge') THEN local_commits.source_kind
                        ELSE excluded.source_kind
                    END,
                    produced_by_node_id = COALESCE(local_commits.produced_by_node_id, excluded.produced_by_node_id),
                    first_parent_sha = COALESCE(excluded.first_parent_sha, local_commits.first_parent_sha),
                    files_changed_count = COALESCE(excluded.files_changed_count, local_commits.files_changed_count),
                    total_additions = COALESCE(excluded.total_additions, local_commits.total_additions),
                    total_deletions = COALESCE(excluded.total_deletions, local_commits.total_deletions),
                    local_updated_at = excluded.local_updated_at
                "#,
                params![
                    workspace_id,
                    sha,
                    commit.subject.as_deref(),
                    commit.author_name.as_deref(),
                    commit.author_email.as_deref(),
                    commit.authored_at.as_deref(),
                    commit.committed_at.as_deref().or(commit.authored_at.as_deref()),
                    source_kind,
                    commit.produced_by_node_id.as_deref(),
                    first_parent_sha,
                    commit.files_changed_count,
                    commit.total_additions,
                    commit.total_deletions,
                    now
                ],
            )
            .map_err(|e| e.to_string())?;

            if !existing_commit || !parents.is_empty() {
                tx.execute(
                    "DELETE FROM local_commit_parents WHERE workspace_id = ?1 AND child_sha = ?2",
                    params![workspace_id, sha],
                )
                .map_err(|e| e.to_string())?;
                for (index, parent_sha) in parents.iter().enumerate() {
                    tx.execute(
                        r#"
                        INSERT INTO local_commit_parents (
                            workspace_id, child_sha, parent_sha, parent_index, local_updated_at
                        )
                        VALUES (?1, ?2, ?3, ?4, ?5)
                        "#,
                        params![workspace_id, sha, parent_sha, index as i64, now],
                    )
                    .map_err(|e| e.to_string())?;
                }
            }

            tx.execute(
                r#"
                INSERT INTO local_commit_observations (
                    workspace_id, commit_sha, git_ref, source_kind, first_seen_at, last_seen_at
                )
                VALUES (?1, ?2, COALESCE(?3, ''), ?4, ?5, ?5)
                ON CONFLICT(workspace_id, commit_sha, git_ref, source_kind) DO UPDATE SET
                    last_seen_at = excluded.last_seen_at
                "#,
                params![workspace_id, sha, git_ref, source_kind, now],
            )
            .map_err(|e| e.to_string())?;

            imported += 1;
        }

        tx.commit().map_err(|e| e.to_string())?;
        Ok(imported)
    }

    fn local_device_id_locked(conn: &Connection, now: i64) -> Result<String, String> {
        let existing = conn
            .query_row(
                "SELECT value FROM local_app_kv WHERE key = 'device_id'",
                [],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        if let Some(device_id) = existing {
            return Ok(device_id);
        }
        let device_id = uuid::Uuid::new_v4().to_string();
        conn.execute(
            r#"
            INSERT INTO local_app_kv(key, value, created_at, updated_at)
            VALUES ('device_id', ?1, ?2, ?2)
            "#,
            params![device_id, now],
        )
        .map_err(|e| e.to_string())?;
        Ok(device_id)
    }

    fn local_user_id_locked(conn: &Connection, now: i64) -> Result<String, String> {
        let existing = conn
            .query_row(
                "SELECT value FROM local_app_kv WHERE key = 'local_user_id'",
                [],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        if let Some(local_user_id) = existing {
            Self::repair_legacy_cloud_owned_local_rows_locked(conn, &local_user_id, None)?;
            return Ok(local_user_id);
        }
        let local_user_id = uuid::Uuid::new_v4().to_string();
        conn.execute(
            r#"
            INSERT INTO local_app_kv(key, value, created_at, updated_at)
            VALUES ('local_user_id', ?1, ?2, ?2)
            "#,
            params![local_user_id, now],
        )
        .map_err(|e| e.to_string())?;
        Self::repair_legacy_cloud_owned_local_rows_locked(conn, &local_user_id, None)?;
        Ok(local_user_id)
    }

    fn repair_legacy_cloud_owned_local_rows_locked(
        conn: &Connection,
        local_user_id: &str,
        active_cloud_account_id: Option<&str>,
    ) -> Result<(), String> {
        if local_user_id.trim().is_empty() {
            return Ok(());
        }

        if let Some(cloud_account_id) =
            active_cloud_account_id.filter(|value| !value.trim().is_empty())
        {
            conn.execute(
                r#"
                UPDATE local_workspaces
                SET cloud_account_id = COALESCE(cloud_account_id, user_id),
                    cloud_backup_enabled = 1,
                    sync_status = CASE
                        WHEN sync_status = 'local_only' THEN 'sync_pending'
                        ELSE sync_status
                    END,
                    user_id = ?1
                WHERE user_id = ?2
                  AND user_id != ?1
                  AND (cloud_account_id IS NULL OR cloud_account_id = ?2)
                "#,
                params![local_user_id, cloud_account_id],
            )
            .map_err(|e| e.to_string())?;
        } else {
            conn.execute(
                r#"
                UPDATE local_workspaces
                SET cloud_account_id = user_id,
                    cloud_backup_enabled = 1,
                    sync_status = CASE
                        WHEN sync_status = 'local_only' THEN 'sync_pending'
                        ELSE sync_status
                    END,
                    user_id = ?1
                WHERE user_id IS NOT NULL
                  AND user_id != ?1
                  AND cloud_account_id IS NULL
                "#,
                params![local_user_id],
            )
            .map_err(|e| e.to_string())?;
        }

        conn.execute(
            r#"
            UPDATE local_sync_events
            SET user_id = ?1,
                cloud_account_id = COALESCE(
                    cloud_account_id,
                    (
                        SELECT workspace.cloud_account_id
                        FROM local_workspaces workspace
                        WHERE workspace.id = local_sync_events.workspace_id
                    )
                )
            WHERE status = 'pending'
              AND workspace_id IN (
                SELECT id
                FROM local_workspaces
                WHERE user_id = ?1
                  AND cloud_backup_enabled = 1
                  AND cloud_account_id IS NOT NULL
                  AND (?2 IS NULL OR cloud_account_id = ?2)
              )
              AND (
                user_id IS NULL
                OR user_id != ?1
                OR cloud_account_id IS NULL
              )
            "#,
            params![local_user_id, active_cloud_account_id],
        )
        .map_err(|e| e.to_string())?;

        Ok(())
    }

    pub fn get_local_identity(&self) -> Result<LocalIdentity, String> {
        let now = unix_timestamp();
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let local_user_id = Self::local_user_id_locked(&conn, now)?;
        let local_device_id = Self::local_device_id_locked(&conn, now)?;
        Ok(LocalIdentity {
            local_user_id,
            local_device_id,
        })
    }

    #[cfg(test)]
    pub fn enqueue_local_sync_event(
        &self,
        workspace_id: Option<&str>,
        entity_type: &str,
        entity_id: &str,
        event_type: &str,
        payload_json: &str,
        mutation_id: Option<&str>,
    ) -> Result<LocalSyncEventRow, String> {
        self.enqueue_local_sync_event_for_user(
            workspace_id,
            None,
            entity_type,
            entity_id,
            event_type,
            payload_json,
            mutation_id,
        )
    }

    pub fn enqueue_local_sync_event_for_user(
        &self,
        workspace_id: Option<&str>,
        user_id: Option<&str>,
        entity_type: &str,
        entity_id: &str,
        event_type: &str,
        payload_json: &str,
        mutation_id: Option<&str>,
    ) -> Result<LocalSyncEventRow, String> {
        let now = unix_timestamp();
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        if !Self::workspace_cloud_backup_enabled_locked(&conn, workspace_id)? {
            return Ok(Self::local_only_sync_event(
                workspace_id,
                user_id,
                entity_type,
                entity_id,
                event_type,
                payload_json,
                now,
            ));
        }
        let cloud_account_id = Self::workspace_cloud_account_id_locked(&conn, workspace_id)?;
        let device_id = Self::local_device_id_locked(&conn, now)?;
        let mutation_id = mutation_id
            .map(|value| value.to_string())
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        let idempotency_key = format!("{device_id}:{event_type}:{entity_id}:{mutation_id}");
        let id = uuid::Uuid::new_v4().to_string();
        conn.execute(
            r#"
            INSERT INTO local_sync_events (
                id, workspace_id, user_id, cloud_account_id, entity_type, entity_id, event_type, payload_json,
                idempotency_key, status, attempt_count, next_attempt_at, created_at, updated_at
            )
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'pending', 0, ?10, ?10, ?10)
            ON CONFLICT(idempotency_key) DO UPDATE SET
                workspace_id = excluded.workspace_id,
                user_id = COALESCE(excluded.user_id, local_sync_events.user_id),
                cloud_account_id = excluded.cloud_account_id,
                payload_json = excluded.payload_json,
                status = CASE
                    WHEN local_sync_events.status = 'synced' THEN 'synced'
                    ELSE 'pending'
                END,
                next_attempt_at = CASE
                    WHEN local_sync_events.status = 'synced' THEN local_sync_events.next_attempt_at
                    ELSE ?10
                END,
                updated_at = ?10
            "#,
            params![
                id,
                workspace_id,
                user_id,
                cloud_account_id,
                entity_type,
                entity_id,
                event_type,
                payload_json,
                idempotency_key,
                now
            ],
        )
        .map_err(|e| e.to_string())?;
        drop(conn);
        self.get_local_sync_event_by_idempotency_key(&idempotency_key)?
            .ok_or_else(|| "Failed to read enqueued sync event.".to_string())
    }

    fn workspace_cloud_backup_enabled_locked(
        conn: &Connection,
        workspace_id: Option<&str>,
    ) -> Result<bool, String> {
        let Some(workspace_id) = workspace_id else {
            return Ok(true);
        };
        conn.query_row(
            "SELECT cloud_backup_enabled FROM local_workspaces WHERE id = ?1",
            params![workspace_id],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .map(|value| value.map(|flag| flag != 0).unwrap_or(true))
        .map_err(|e| e.to_string())
    }

    pub fn workspace_cloud_backup_enabled(
        &self,
        workspace_id: Option<&str>,
    ) -> Result<bool, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        Self::workspace_cloud_backup_enabled_locked(&conn, workspace_id)
    }

    fn workspace_cloud_account_id_locked(
        conn: &Connection,
        workspace_id: Option<&str>,
    ) -> Result<Option<String>, String> {
        let Some(workspace_id) = workspace_id else {
            return Ok(None);
        };
        conn.query_row(
            "SELECT cloud_account_id FROM local_workspaces WHERE id = ?1",
            params![workspace_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()
        .map(|value| value.flatten())
        .map_err(|e| e.to_string())
    }

    fn local_only_sync_event(
        workspace_id: Option<&str>,
        user_id: Option<&str>,
        entity_type: &str,
        entity_id: &str,
        event_type: &str,
        payload_json: &str,
        now: i64,
    ) -> LocalSyncEventRow {
        LocalSyncEventRow {
            id: format!("local-only:{}:{}", event_type, entity_id),
            workspace_id: workspace_id.map(str::to_string),
            user_id: user_id.map(str::to_string),
            cloud_account_id: None,
            entity_type: entity_type.to_string(),
            entity_id: entity_id.to_string(),
            event_type: event_type.to_string(),
            payload_json: payload_json.to_string(),
            idempotency_key: format!("local-only:{}:{}", event_type, entity_id),
            status: "local_only".to_string(),
            attempt_count: 0,
            next_attempt_at: None,
            last_error: None,
            created_at: now,
            updated_at: now,
        }
    }

    pub fn enqueue_local_commit_graph_sync(
        &self,
        workspace_id: &str,
        user_id: Option<&str>,
        payload_json: &str,
        mutation_id: Option<&str>,
    ) -> Result<LocalSyncEventRow, String> {
        self.enqueue_local_sync_event_for_user(
            Some(workspace_id),
            user_id,
            "commit_graph",
            workspace_id,
            "commit_graph.git_sync_ingest",
            payload_json,
            mutation_id,
        )
    }

    fn enqueue_local_sync_event_locked(
        conn: &Connection,
        now: i64,
        workspace_id: Option<&str>,
        user_id: Option<&str>,
        entity_type: &str,
        entity_id: &str,
        event_type: &str,
        payload_json: &str,
        mutation_id: Option<&str>,
    ) -> Result<Option<String>, String> {
        if !Self::workspace_cloud_backup_enabled_locked(conn, workspace_id)? {
            return Ok(None);
        }
        let cloud_account_id = Self::workspace_cloud_account_id_locked(conn, workspace_id)?;
        let device_id = Self::local_device_id_locked(conn, now)?;
        let mutation_id = mutation_id
            .map(|value| value.to_string())
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        let idempotency_key = format!("{device_id}:{event_type}:{entity_id}:{mutation_id}");
        let id = uuid::Uuid::new_v4().to_string();
        conn.execute(
            r#"
            INSERT INTO local_sync_events (
                id, workspace_id, user_id, cloud_account_id, entity_type, entity_id, event_type, payload_json,
                idempotency_key, status, attempt_count, next_attempt_at, created_at, updated_at
            )
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'pending', 0, ?10, ?10, ?10)
            ON CONFLICT(idempotency_key) DO UPDATE SET
                workspace_id = excluded.workspace_id,
                user_id = COALESCE(excluded.user_id, local_sync_events.user_id),
                cloud_account_id = excluded.cloud_account_id,
                payload_json = excluded.payload_json,
                status = CASE
                    WHEN local_sync_events.status = 'synced' THEN 'synced'
                    ELSE 'pending'
                END,
                next_attempt_at = CASE
                    WHEN local_sync_events.status = 'synced' THEN local_sync_events.next_attempt_at
                    ELSE ?10
                END,
                updated_at = ?10
            "#,
            params![
                id,
                workspace_id,
                user_id,
                cloud_account_id,
                entity_type,
                entity_id,
                event_type,
                payload_json,
                idempotency_key,
                now
            ],
        )
        .map_err(|e| e.to_string())?;
        Ok(Some(idempotency_key))
    }

    pub fn upsert_local_insight_payload_for_user(
        &self,
        workspace_id: &str,
        user_id: Option<&str>,
        insight_id: &str,
        payload_json: &str,
        mutation_id: Option<&str>,
    ) -> Result<LocalSyncEventRow, String> {
        let now = unix_timestamp();
        let mut conn = self.conn.lock().map_err(|e| e.to_string())?;
        let payload: JsonValue = serde_json::from_str(payload_json).map_err(|e| e.to_string())?;
        let content = payload
            .get("content")
            .and_then(|value| value.as_str())
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| "Insight content is required.".to_string())?;
        let agent_type = payload
            .get("agentType")
            .and_then(|value| value.as_str())
            .unwrap_or("hypothesis");
        let is_local = payload
            .get("isLocal")
            .and_then(|value| value.as_bool())
            .unwrap_or(true);
        let parent_node_id = payload
            .get("parentNodeId")
            .or_else(|| payload.get("parent_node_id"))
            .and_then(|value| value.as_str())
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| "Insight parentNodeId is required.".to_string())?;
        let full_exploration = payload
            .get("fullExploration")
            .and_then(|value| value.as_str());
        let reasoning = payload.get("reasoning").and_then(|value| value.as_str());
        let source_workspace_id = payload
            .get("sourceWorkspaceId")
            .and_then(|value| value.as_str());
        let source_file_id = payload.get("sourceFileId").and_then(|value| value.as_str());
        let source_run_node_id = payload
            .get("sourceRunNodeId")
            .and_then(|value| value.as_str());
        let validation_results_json = payload
            .get("validationResults")
            .and_then(|value| serde_json::to_string(value).ok());
        let created_at = payload
            .get("createdAt")
            .and_then(|value| value.as_str())
            .map(|value| value.to_string())
            .unwrap_or_else(chrono_like_now);
        let updated_at = chrono_like_now();
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        tx.execute(
            r#"
            INSERT INTO local_insights (
                id, workspace_id, agent_type, is_local, content, full_exploration, reasoning,
                source_workspace_id, source_file_id, parent_node_id, source_run_node_id,
                validation_results_json, payload_json, status, created_at, updated_at,
                deleted_at, local_updated_at, server_ack_at
            )
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, 'active', ?14, ?15, NULL, ?16, NULL)
            ON CONFLICT(id) DO UPDATE SET
                workspace_id = excluded.workspace_id,
                agent_type = excluded.agent_type,
                is_local = excluded.is_local,
                content = excluded.content,
                full_exploration = excluded.full_exploration,
                reasoning = excluded.reasoning,
                source_workspace_id = excluded.source_workspace_id,
                source_file_id = excluded.source_file_id,
                parent_node_id = excluded.parent_node_id,
                source_run_node_id = excluded.source_run_node_id,
                validation_results_json = excluded.validation_results_json,
                payload_json = excluded.payload_json,
                status = 'active',
                updated_at = excluded.updated_at,
                deleted_at = NULL,
                local_updated_at = excluded.local_updated_at
            "#,
            params![
                insight_id,
                workspace_id,
                agent_type,
                if is_local { 1 } else { 0 },
                content,
                full_exploration,
                reasoning,
                source_workspace_id,
                source_file_id,
                parent_node_id,
                source_run_node_id,
                validation_results_json,
                payload_json,
                created_at,
                updated_at,
                now
            ],
        )
        .map_err(|e| e.to_string())?;
        let sync_payload = serde_json::json!({
            "action": "upsert",
            "workspaceId": workspace_id,
            "insight": payload,
        });
        let sync_payload_json = serde_json::to_string(&sync_payload).map_err(|e| e.to_string())?;
        let idempotency_key = Self::enqueue_local_sync_event_locked(
            &tx,
            now,
            Some(workspace_id),
            user_id,
            "insight",
            insight_id,
            "insight.upsert",
            &sync_payload_json,
            mutation_id,
        )?;
        tx.commit().map_err(|e| e.to_string())?;
        drop(conn);
        if let Some(idempotency_key) = idempotency_key {
            self.get_local_sync_event_by_idempotency_key(&idempotency_key)?
                .ok_or_else(|| "Failed to read enqueued insight sync event.".to_string())
        } else {
            Ok(Self::local_only_sync_event(
                Some(workspace_id),
                user_id,
                "insight",
                insight_id,
                "insight.upsert",
                &sync_payload_json,
                now,
            ))
        }
    }

    pub fn persist_background_insight_candidates_for_user(
        &self,
        workspace_id: &str,
        user_id: Option<&str>,
        parent_node_id: &str,
        source_run_node_id: &str,
        trigger_class: &str,
        trigger_reason: &str,
        prompt_tokens: Option<i64>,
        completion_tokens: Option<i64>,
        total_tokens: Option<i64>,
        raw_candidates: Vec<JsonValue>,
        observation_summary: &str,
    ) -> Result<(usize, usize), String> {
        let candidates = raw_candidates
            .into_iter()
            .filter_map(|raw| {
                parse_insight_candidate(
                    workspace_id,
                    parent_node_id,
                    source_run_node_id,
                    trigger_class,
                    trigger_reason,
                    prompt_tokens,
                    completion_tokens,
                    total_tokens,
                    raw,
                )
            })
            .collect::<Vec<_>>();
        if candidates.is_empty() {
            return Ok((0, 0));
        }

        let mut conn = self.conn.lock().map_err(|e| e.to_string())?;
        let existing_active_for_parent: i64 = conn
            .query_row(
                r#"
                SELECT COUNT(*)
                FROM surfaced_insights s
                JOIN insight_candidates c ON c.id = s.candidate_id
                WHERE s.workspace_id = ?1
                  AND c.parent_node_id = ?2
                  AND s.dismissed_at IS NULL
                "#,
                params![workspace_id, parent_node_id],
                |row| row.get(0),
            )
            .unwrap_or(0);
        let selected_candidate_id = if existing_active_for_parent == 0 {
            candidates
                .iter()
                .filter(|candidate| candidate.should_surface)
                .max_by(|left, right| {
                    left.priority
                        .partial_cmp(&right.priority)
                        .unwrap_or(std::cmp::Ordering::Equal)
                })
                .map(|candidate| candidate.id.clone())
        } else {
            None
        };

        let now = chrono_like_now();
        let observation_id = uuid::Uuid::new_v4().to_string();
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        tx.execute(
            r#"
            INSERT INTO background_observations (
                id, workspace_id, source_node_id, source_event_type, summary, created_at
            )
            VALUES (?1, ?2, ?3, 'assistant_completed', ?4, ?5)
            ON CONFLICT(id) DO NOTHING
            "#,
            params![
                observation_id,
                workspace_id,
                parent_node_id,
                observation_summary,
                now
            ],
        )
        .map_err(|e| e.to_string())?;

        let mut surfaced_payloads: Vec<(String, JsonValue, String)> = Vec::new();
        for candidate in &candidates {
            let is_selected = selected_candidate_id.as_deref() == Some(candidate.id.as_str());
            let candidate_status = if is_selected {
                "surfaced"
            } else if candidate.should_surface || candidate.priority >= 0.4 {
                "validated"
            } else {
                "archived"
            };
            let payload_json =
                serde_json::to_string(&candidate.payload).map_err(|err| err.to_string())?;
            tx.execute(
                r#"
                INSERT INTO insight_candidates (
                    id, workspace_id, parent_node_id, agent_kind, claim, rationale, status,
                    novelty_score, relevance_score, actionability_score, risk_score, timing_score,
                    confidence, source_run_node_id, payload_json, created_at, updated_at, deleted_at
                )
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, NULL)
                ON CONFLICT(id) DO UPDATE SET
                    workspace_id = excluded.workspace_id,
                    parent_node_id = excluded.parent_node_id,
                    agent_kind = excluded.agent_kind,
                    claim = excluded.claim,
                    rationale = excluded.rationale,
                    status = excluded.status,
                    novelty_score = excluded.novelty_score,
                    relevance_score = excluded.relevance_score,
                    actionability_score = excluded.actionability_score,
                    risk_score = excluded.risk_score,
                    timing_score = excluded.timing_score,
                    confidence = excluded.confidence,
                    source_run_node_id = excluded.source_run_node_id,
                    payload_json = excluded.payload_json,
                    updated_at = excluded.updated_at,
                    deleted_at = NULL
                "#,
                params![
                    candidate.id,
                    workspace_id,
                    parent_node_id,
                    candidate.agent_kind,
                    candidate.claim,
                    candidate.rationale,
                    candidate_status,
                    candidate.novelty_score,
                    candidate.relevance_score,
                    candidate.actionability_score,
                    candidate.risk_score,
                    candidate.timing_score,
                    candidate.confidence,
                    source_run_node_id,
                    payload_json,
                    now,
                    now
                ],
            )
            .map_err(|e| e.to_string())?;

            let exploration_id = uuid::Uuid::new_v4().to_string();
            let exploration_json =
                serde_json::to_string(&candidate.exploration).map_err(|err| err.to_string())?;
            tx.execute(
                r#"
                INSERT INTO insight_explorations (
                    id, candidate_id, run_node_id, exploration_type, content_json, created_at
                )
                VALUES (?1, ?2, ?3, 'initial_private_exploration', ?4, ?5)
                "#,
                params![
                    exploration_id,
                    candidate.id,
                    source_run_node_id,
                    exploration_json,
                    now
                ],
            )
            .map_err(|e| e.to_string())?;

            if is_selected {
                tx.execute(
                    r#"
                    INSERT INTO surfaced_insights (
                        id, candidate_id, workspace_id, surface_reason, priority,
                        seen_at, acted_at, dismissed_at, promoted_node_id, created_at, updated_at
                    )
                    VALUES (?1, ?2, ?3, ?4, ?5, NULL, NULL, NULL, NULL, ?6, ?7)
                    ON CONFLICT(candidate_id) DO UPDATE SET
                        surface_reason = excluded.surface_reason,
                        priority = excluded.priority,
                        dismissed_at = NULL,
                        updated_at = excluded.updated_at
                    "#,
                    params![
                        candidate.id,
                        candidate.id,
                        workspace_id,
                        candidate.surface_reason,
                        candidate.priority,
                        now,
                        now
                    ],
                )
                .map_err(|e| e.to_string())?;
                let mut surface_payload = candidate.payload.clone();
                if let Some(object) = surface_payload.as_object_mut() {
                    object.insert(
                        "surfaceReason".to_string(),
                        JsonValue::String(candidate.surface_reason.clone()),
                    );
                    object.insert("priority".to_string(), JsonValue::from(candidate.priority));
                    object.insert(
                        "status".to_string(),
                        JsonValue::String("surfaced".to_string()),
                    );
                }
                surfaced_payloads.push((
                    candidate.id.clone(),
                    surface_payload,
                    format!("{}:{}", source_run_node_id, candidate.id),
                ));
            }
        }
        tx.commit().map_err(|e| e.to_string())?;
        drop(conn);

        let mut surfaced = 0usize;
        for (insight_id, payload, mutation_id) in surfaced_payloads {
            let payload_json = serde_json::to_string(&payload).map_err(|err| err.to_string())?;
            self.upsert_local_insight_payload_for_user(
                workspace_id,
                user_id,
                &insight_id,
                &payload_json,
                Some(&mutation_id),
            )?;
            surfaced += 1;
        }

        Ok((candidates.len(), surfaced))
    }

    pub fn local_first_dismiss_insight(
        &self,
        workspace_id: &str,
        user_id: Option<&str>,
        insight_id: &str,
    ) -> Result<LocalSyncEventRow, String> {
        let now = unix_timestamp();
        let mut conn = self.conn.lock().map_err(|e| e.to_string())?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        tx.execute(
            r#"
            UPDATE local_insights
            SET status = 'dismissed',
                deleted_at = ?3,
                updated_at = ?3,
                local_updated_at = ?4
            WHERE workspace_id = ?1
              AND id = ?2
              AND status != 'dismissed'
            "#,
            params![workspace_id, insight_id, chrono_like_now(), now],
        )
        .map_err(|e| e.to_string())?;
        tx.execute(
            r#"
            UPDATE surfaced_insights
            SET dismissed_at = ?3,
                updated_at = ?3
            WHERE workspace_id = ?1
              AND id = ?2
              AND dismissed_at IS NULL
            "#,
            params![workspace_id, insight_id, chrono_like_now()],
        )
        .map_err(|e| e.to_string())?;
        tx.execute(
            r#"
            UPDATE insight_candidates
            SET status = 'dismissed',
                updated_at = ?3
            WHERE workspace_id = ?1
              AND id = ?2
            "#,
            params![workspace_id, insight_id, chrono_like_now()],
        )
        .map_err(|e| e.to_string())?;
        let feedback_id = uuid::Uuid::new_v4().to_string();
        tx.execute(
            r#"
            INSERT INTO insight_feedback (id, insight_id, action, context_json, created_at)
            VALUES (?1, ?2, 'dismissed', ?3, ?4)
            "#,
            params![
                feedback_id,
                insight_id,
                serde_json::json!({ "workspaceId": workspace_id, "userId": user_id }).to_string(),
                chrono_like_now()
            ],
        )
        .map_err(|e| e.to_string())?;
        let sync_payload = serde_json::json!({
            "action": "dismiss",
            "workspaceId": workspace_id,
            "insightId": insight_id,
        });
        let sync_payload_json = serde_json::to_string(&sync_payload).map_err(|e| e.to_string())?;
        let idempotency_key = Self::enqueue_local_sync_event_locked(
            &tx,
            now,
            Some(workspace_id),
            user_id,
            "insight",
            insight_id,
            "insight.dismiss",
            &sync_payload_json,
            None,
        )?;
        tx.commit().map_err(|e| e.to_string())?;
        drop(conn);
        if let Some(idempotency_key) = idempotency_key {
            self.get_local_sync_event_by_idempotency_key(&idempotency_key)?
                .ok_or_else(|| "Failed to read enqueued insight dismiss event.".to_string())
        } else {
            Ok(Self::local_only_sync_event(
                Some(workspace_id),
                user_id,
                "insight",
                insight_id,
                "insight.dismiss",
                &sync_payload_json,
                now,
            ))
        }
    }

    pub fn record_local_insight_feedback(
        &self,
        workspace_id: &str,
        user_id: Option<&str>,
        insight_id: &str,
        action: &str,
        context_json: Option<&str>,
    ) -> Result<(), String> {
        let action = match action {
            "seen" | "expanded" | "dismissed" | "promoted" | "copied" | "ignored" => action,
            _ => return Err(format!("Unsupported insight feedback action: {}", action)),
        };
        let now = chrono_like_now();
        let context = context_json
            .map(|value| serde_json::from_str::<JsonValue>(value).unwrap_or(JsonValue::Null))
            .unwrap_or_else(|| serde_json::json!({}));
        let mut context = match context {
            JsonValue::Object(map) => JsonValue::Object(map),
            other => serde_json::json!({ "value": other }),
        };
        if let Some(object) = context.as_object_mut() {
            object.insert(
                "workspaceId".to_string(),
                JsonValue::String(workspace_id.to_string()),
            );
            if let Some(user_id) = user_id {
                object.insert("userId".to_string(), JsonValue::String(user_id.to_string()));
            }
        }
        let promoted_node_id = context
            .get("promotedNodeId")
            .and_then(|value| value.as_str())
            .map(|value| value.to_string());
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            r#"
            INSERT INTO insight_feedback (id, insight_id, action, context_json, created_at)
            VALUES (?1, ?2, ?3, ?4, ?5)
            "#,
            params![
                uuid::Uuid::new_v4().to_string(),
                insight_id,
                action,
                serde_json::to_string(&context).map_err(|err| err.to_string())?,
                now
            ],
        )
        .map_err(|e| e.to_string())?;
        match action {
            "seen" => {
                conn.execute(
                    r#"
                    UPDATE surfaced_insights
                    SET seen_at = COALESCE(seen_at, ?3),
                        updated_at = ?3
                    WHERE workspace_id = ?1 AND id = ?2
                    "#,
                    params![workspace_id, insight_id, now],
                )
                .map_err(|e| e.to_string())?;
            }
            "expanded" | "copied" => {
                conn.execute(
                    r#"
                    UPDATE surfaced_insights
                    SET seen_at = COALESCE(seen_at, ?3),
                        acted_at = ?3,
                        updated_at = ?3
                    WHERE workspace_id = ?1 AND id = ?2
                    "#,
                    params![workspace_id, insight_id, now],
                )
                .map_err(|e| e.to_string())?;
            }
            "promoted" => {
                conn.execute(
                    r#"
                    UPDATE surfaced_insights
                    SET seen_at = COALESCE(seen_at, ?3),
                        acted_at = ?3,
                        promoted_node_id = COALESCE(?4, promoted_node_id),
                        updated_at = ?3
                    WHERE workspace_id = ?1 AND id = ?2
                    "#,
                    params![workspace_id, insight_id, now, promoted_node_id],
                )
                .map_err(|e| e.to_string())?;
                conn.execute(
                    r#"
                    UPDATE insight_candidates
                    SET status = 'promoted',
                        updated_at = ?3
                    WHERE workspace_id = ?1 AND id = ?2
                    "#,
                    params![workspace_id, insight_id, now],
                )
                .map_err(|e| e.to_string())?;
            }
            "ignored" | "dismissed" => {}
            _ => {}
        }
        Ok(())
    }

    pub fn list_local_insights_for_workspace(
        &self,
        workspace_id: &str,
    ) -> Result<Vec<LocalInsightRow>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                r#"
                SELECT
                    s.id,
                    s.workspace_id,
                    COALESCE(i.payload_json, c.payload_json),
                    CASE
                        WHEN EXISTS (
                            SELECT 1
                            FROM local_sync_events e
                            WHERE e.entity_type = 'insight'
                              AND e.entity_id = s.id
                              AND e.status IN ('pending', 'in_flight', 'dead')
                        ) THEN 'local_only'
                        WHEN i.id IS NULL OR i.server_ack_at IS NULL THEN 'local_only'
                        ELSE 'persisted'
                    END AS sync_status,
                    COALESCE(i.created_at, s.created_at),
                    COALESCE(i.updated_at, s.updated_at),
                    CASE
                        WHEN i.server_ack_at IS NULL THEN NULL
                        WHEN i.server_ack_at GLOB '[0-9]*' THEN CAST(i.server_ack_at AS INTEGER)
                        ELSE NULL
                    END AS server_ack_at,
                    COALESCE((
                        SELECT MAX(e.attempt_count)
                        FROM local_sync_events e
                        WHERE e.entity_type = 'insight'
                          AND e.entity_id = s.id
                          AND e.status IN ('pending', 'in_flight', 'dead')
                    ), 0) AS retry_attempt,
                    (
                        SELECT MIN(e.next_attempt_at)
                        FROM local_sync_events e
                        WHERE e.entity_type = 'insight'
                          AND e.entity_id = s.id
                          AND e.status IN ('pending', 'in_flight')
                    ) AS next_retry_at,
                    (
                        SELECT e.last_error
                        FROM local_sync_events e
                        WHERE e.entity_type = 'insight'
                          AND e.entity_id = s.id
                          AND e.status IN ('pending', 'in_flight', 'dead')
                          AND e.last_error IS NOT NULL
                        ORDER BY e.updated_at DESC
                        LIMIT 1
                    ) AS last_upload_error
                FROM surfaced_insights s
                JOIN insight_candidates c ON c.id = s.candidate_id
                LEFT JOIN local_insights i ON i.id = s.id
                WHERE s.workspace_id = ?1
                  AND s.dismissed_at IS NULL
                  AND c.deleted_at IS NULL
                  AND c.status IN ('surfaced', 'promoted')
                ORDER BY s.priority DESC, s.updated_at DESC
                "#,
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![workspace_id], |row| {
                Ok(LocalInsightRow {
                    insight_id: row.get(0)?,
                    workspace_id: row.get(1)?,
                    payload: row.get(2)?,
                    sync_status: row.get(3)?,
                    created_at: row.get(4)?,
                    updated_at: row.get(5)?,
                    server_ack_at: row.get(6)?,
                    retry_attempt: row.get(7)?,
                    next_retry_at: row.get(8)?,
                    last_upload_error: row.get(9)?,
                })
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        Ok(rows)
    }

    pub fn list_local_insight_candidates_for_workspace(
        &self,
        workspace_id: &str,
    ) -> Result<Vec<LocalInsightCandidateRow>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                r#"
                SELECT
                    c.id,
                    c.workspace_id,
                    c.parent_node_id,
                    c.agent_kind,
                    c.claim,
                    c.rationale,
                    c.status,
                    c.novelty_score,
                    c.relevance_score,
                    c.actionability_score,
                    c.risk_score,
                    c.timing_score,
                    c.confidence,
                    s.priority,
                    s.surface_reason,
                    s.id AS surfaced_insight_id,
                    c.source_run_node_id,
                    (
                        SELECT e.content_json
                        FROM insight_explorations e
                        WHERE e.candidate_id = c.id
                        ORDER BY e.created_at DESC
                        LIMIT 1
                    ) AS exploration_json,
                    c.payload_json,
                    c.created_at,
                    c.updated_at
                FROM insight_candidates c
                LEFT JOIN surfaced_insights s
                  ON s.candidate_id = c.id
                 AND s.dismissed_at IS NULL
                WHERE c.workspace_id = ?1
                  AND c.deleted_at IS NULL
                  AND c.status != 'dismissed'
                ORDER BY
                    CASE c.status
                        WHEN 'surfaced' THEN 0
                        WHEN 'validated' THEN 1
                        WHEN 'promoted' THEN 2
                        WHEN 'seed' THEN 3
                        ELSE 4
                    END,
                    COALESCE(s.priority, (
                        (c.novelty_score + c.relevance_score + c.actionability_score + c.timing_score + c.confidence) / 5.0
                    ) - (c.risk_score * 0.25)) DESC,
                    c.updated_at DESC
                "#,
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![workspace_id], |row| {
                Ok(LocalInsightCandidateRow {
                    candidate_id: row.get(0)?,
                    workspace_id: row.get(1)?,
                    parent_node_id: row.get(2)?,
                    agent_kind: row.get(3)?,
                    claim: row.get(4)?,
                    rationale: row.get(5)?,
                    status: row.get(6)?,
                    novelty_score: row.get(7)?,
                    relevance_score: row.get(8)?,
                    actionability_score: row.get(9)?,
                    risk_score: row.get(10)?,
                    timing_score: row.get(11)?,
                    confidence: row.get(12)?,
                    priority: row.get(13)?,
                    surface_reason: row.get(14)?,
                    surfaced_insight_id: row.get(15)?,
                    source_run_node_id: row.get(16)?,
                    exploration_json: row.get(17)?,
                    payload: row.get(18)?,
                    created_at: row.get(19)?,
                    updated_at: row.get(20)?,
                })
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        Ok(rows)
    }

    pub fn mark_local_insight_persisted(&self, insight_id: &str) -> Result<(), String> {
        let now = unix_timestamp();
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            r#"
            UPDATE local_insights
            SET server_ack_at = ?2,
                updated_at = ?3
            WHERE id = ?1
            "#,
            params![insight_id, now.to_string(), chrono_like_now()],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn has_retryable_terminal_node_sync(&self, node_id: &str) -> Result<bool, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let exists: i64 = conn
            .query_row(
                r#"
                SELECT EXISTS (
                    SELECT 1
                    FROM local_sync_events
                    WHERE entity_type = 'node'
                      AND entity_id = ?1
                      AND event_type = 'node.update_terminal'
                      AND status IN ('pending', 'in_flight')
                )
                "#,
                params![node_id],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;
        Ok(exists != 0)
    }

    #[cfg(test)]
    pub fn get_local_sync_event(&self, id: &str) -> Result<Option<LocalSyncEventRow>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        Self::get_local_sync_event_locked(&conn, id)
    }

    #[cfg(test)]
    fn get_local_sync_event_locked(
        conn: &Connection,
        id: &str,
    ) -> Result<Option<LocalSyncEventRow>, String> {
        conn.query_row(
            r#"
            SELECT id, workspace_id, user_id, cloud_account_id, entity_type, entity_id, event_type, payload_json,
                   idempotency_key, status, attempt_count, next_attempt_at, last_error,
                   created_at, updated_at
            FROM local_sync_events
            WHERE id = ?1
            "#,
            params![id],
            Self::local_sync_event_row_from_sql,
        )
        .optional()
        .map_err(|e| e.to_string())
    }

    fn local_sync_event_row_from_sql(
        row: &rusqlite::Row<'_>,
    ) -> rusqlite::Result<LocalSyncEventRow> {
        Ok(LocalSyncEventRow {
            id: row.get(0)?,
            workspace_id: row.get(1)?,
            user_id: row.get(2)?,
            cloud_account_id: row.get(3)?,
            entity_type: row.get(4)?,
            entity_id: row.get(5)?,
            event_type: row.get(6)?,
            payload_json: row.get(7)?,
            idempotency_key: row.get(8)?,
            status: row.get(9)?,
            attempt_count: row.get(10)?,
            next_attempt_at: row.get(11)?,
            last_error: row.get(12)?,
            created_at: row.get(13)?,
            updated_at: row.get(14)?,
        })
    }

    pub fn get_local_sync_event_by_idempotency_key(
        &self,
        idempotency_key: &str,
    ) -> Result<Option<LocalSyncEventRow>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.query_row(
            r#"
            SELECT id, workspace_id, user_id, cloud_account_id, entity_type, entity_id, event_type, payload_json,
                   idempotency_key, status, attempt_count, next_attempt_at, last_error,
                   created_at, updated_at
            FROM local_sync_events
            WHERE idempotency_key = ?1
            "#,
            params![idempotency_key],
            Self::local_sync_event_row_from_sql,
        )
        .optional()
        .map_err(|e| e.to_string())
    }

    #[cfg(test)]
    pub fn list_due_local_sync_events_for_user(
        &self,
        user_id: &str,
        limit: i64,
    ) -> Result<Vec<LocalSyncEventRow>, String> {
        let now = unix_timestamp();
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        Self::repair_legacy_cloud_owned_local_rows_locked(&conn, user_id, None)?;
        let mut stmt = conn
            .prepare(
                r#"
                SELECT id, workspace_id, user_id, cloud_account_id, entity_type, entity_id, event_type, payload_json,
                       idempotency_key, status, attempt_count, next_attempt_at, last_error,
                       created_at, updated_at
                FROM local_sync_events
                WHERE status = 'pending'
                  AND user_id = ?2
                  AND (next_attempt_at IS NULL OR next_attempt_at <= ?1)
                ORDER BY
                  created_at ASC,
                  CASE
                    WHEN entity_type = 'workspace' AND event_type = 'workspace.create' THEN 0
                    WHEN entity_type = 'thread' AND event_type = 'thread.create' THEN 1
                    WHEN entity_type = 'thread' AND event_type = 'thread.delete' THEN 3
                    ELSE 2
                  END,
                  updated_at ASC
                LIMIT ?3
                "#,
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(
                params![now, user_id, limit],
                Self::local_sync_event_row_from_sql,
            )
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        Ok(rows)
    }

    #[cfg(test)]
    pub fn list_due_local_sync_events_for_user_and_cloud(
        &self,
        user_id: &str,
        cloud_account_id: &str,
        workspace_id: Option<&str>,
        limit: i64,
    ) -> Result<Vec<LocalSyncEventRow>, String> {
        self.list_due_local_sync_events_for_user_and_cloud_by_type(
            user_id,
            cloud_account_id,
            workspace_id,
            None,
            limit,
        )
    }

    pub fn next_local_sync_retry_at(
        &self,
        user_id: &str,
        cloud_account_id: &str,
    ) -> Result<Option<i64>, String> {
        let now = unix_timestamp();
        let conn = self.conn.lock().map_err(|error| error.to_string())?;
        conn.query_row(
            r#"
            SELECT MIN(COALESCE(next_attempt_at, ?1))
            FROM local_sync_events
            WHERE status = 'pending'
              AND user_id = ?2
              AND cloud_account_id = ?3
              AND EXISTS (
                SELECT 1
                FROM local_workspaces workspace
                WHERE workspace.id = local_sync_events.workspace_id
                  AND workspace.cloud_backup_enabled = 1
                  AND workspace.cloud_account_id = ?3
              )
              AND (
                event_type = 'workspace.bootstrap'
                OR NOT EXISTS (
                  SELECT 1
                  FROM local_sync_events bootstrap
                  WHERE bootstrap.workspace_id = local_sync_events.workspace_id
                    AND bootstrap.event_type = 'workspace.bootstrap'
                    AND bootstrap.status IN ('pending', 'in_flight')
                )
              )
            "#,
            params![now, user_id, cloud_account_id],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())
    }

    fn list_due_local_sync_events_for_user_and_cloud_by_type(
        &self,
        user_id: &str,
        cloud_account_id: &str,
        workspace_id: Option<&str>,
        event_type: Option<&str>,
        limit: i64,
    ) -> Result<Vec<LocalSyncEventRow>, String> {
        let now = unix_timestamp();
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                r#"
                SELECT id, workspace_id, user_id, cloud_account_id, entity_type, entity_id, event_type, payload_json,
                       idempotency_key, status, attempt_count, next_attempt_at, last_error,
                       created_at, updated_at
                FROM local_sync_events
                WHERE status = 'pending'
                  AND user_id = ?2
                  AND cloud_account_id = ?3
                  AND (?4 IS NULL OR workspace_id = ?4)
                  AND (?5 IS NULL OR event_type = ?5)
                  AND EXISTS (
                    SELECT 1
                    FROM local_workspaces workspace
                    WHERE workspace.id = local_sync_events.workspace_id
                      AND workspace.cloud_backup_enabled = 1
                      AND workspace.cloud_account_id = ?3
                  )
                  AND (
                    event_type = 'workspace.bootstrap'
                    OR NOT EXISTS (
                      SELECT 1
                      FROM local_sync_events bootstrap
                      WHERE bootstrap.workspace_id = local_sync_events.workspace_id
                        AND bootstrap.event_type = 'workspace.bootstrap'
                        AND bootstrap.status IN ('pending', 'in_flight')
                    )
                  )
                  AND (
                    ?5 = 'workspace.bootstrap'
                    OR next_attempt_at IS NULL
                    OR next_attempt_at <= ?1
                  )
                ORDER BY
                  created_at ASC,
                  CASE
                    WHEN entity_type = 'workspace' AND event_type IN ('workspace.bootstrap', 'workspace.create') THEN 0
                    WHEN entity_type = 'thread' AND event_type = 'thread.create' THEN 1
                    WHEN entity_type = 'thread' AND event_type = 'thread.delete' THEN 3
                    ELSE 2
                  END,
                  updated_at ASC
                LIMIT ?6
                "#,
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(
                params![
                    now,
                    user_id,
                    cloud_account_id,
                    workspace_id,
                    event_type,
                    limit
                ],
                Self::local_sync_event_row_from_sql,
            )
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        Ok(rows)
    }

    pub fn mark_local_sync_event_in_flight(&self, id: &str) -> Result<bool, String> {
        let now = unix_timestamp();
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let changed = conn
            .execute(
                r#"
                UPDATE local_sync_events
                SET status = 'in_flight', updated_at = ?2
                WHERE id = ?1 AND status = 'pending'
                "#,
                params![id, now],
            )
            .map_err(|e| e.to_string())?;
        Ok(changed > 0)
    }

    fn requeue_blocking_terminal_parent_if_needed(
        &self,
        event: &LocalSyncEventRow,
    ) -> Result<Option<String>, String> {
        if event.entity_type != "node" || event.event_type != "node.update_terminal" {
            return Ok(None);
        }

        let payload =
            serde_json::from_str::<JsonValue>(&event.payload_json).unwrap_or(JsonValue::Null);
        let Some(parent_id) = payload
            .get("userMessage")
            .and_then(|value| value.get("parentId"))
            .and_then(|value| value.as_str())
        else {
            return Ok(None);
        };

        let now = unix_timestamp();
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let parent: Option<(String, Option<String>, Option<i64>)> = conn
            .query_row(
                r#"
                SELECT status, last_error, next_attempt_at
                FROM local_sync_events
                WHERE entity_type = 'node'
                  AND entity_id = ?1
                  AND (
                    (user_id = ?2)
                    OR (user_id IS NULL AND ?2 IS NULL)
                  )
                  AND event_type = 'node.update_terminal'
                  AND status IN ('pending', 'in_flight', 'dead')
                ORDER BY created_at ASC
                LIMIT 1
                "#,
                params![parent_id, event.user_id.as_deref()],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()
            .map_err(|e| e.to_string())?;

        if let Some((status, last_error, parent_next_attempt_at)) = parent.as_ref() {
            if status == "dead" {
                let parent_error = last_error
                    .as_deref()
                    .filter(|value| !value.trim().is_empty())
                    .unwrap_or("terminal parent sync is dead");
                conn.execute(
                    r#"
                    UPDATE local_sync_events
                    SET status = 'dead',
                        next_attempt_at = NULL,
                        last_error = ?2,
                        updated_at = ?3
                    WHERE id = ?1
                      AND status IN ('pending', 'in_flight')
                    "#,
                    params![
                        &event.id,
                        format!(
                            "Blocked by permanently failed terminal parent {}: {}",
                            parent_id, parent_error
                        ),
                        now
                    ],
                )
                .map_err(|e| e.to_string())?;
                return Ok(Some(parent_id.to_string()));
            }

            let child_next_attempt_at = parent_next_attempt_at
                .filter(|next_attempt_at| *next_attempt_at > now)
                .unwrap_or(now + 60);
            conn.execute(
                r#"
                UPDATE local_sync_events
                SET next_attempt_at = ?2,
                    updated_at = ?3
                WHERE id = ?1
                  AND status = 'pending'
                "#,
                params![&event.id, child_next_attempt_at, now],
            )
            .map_err(|e| e.to_string())?;

            conn.execute(
                r#"
                UPDATE local_sync_events
                SET status = 'pending',
                    next_attempt_at = ?2,
                    updated_at = ?2
                WHERE entity_type = 'node'
                  AND entity_id = ?1
                  AND (
                    (user_id = ?3)
                    OR (user_id IS NULL AND ?3 IS NULL)
                  )
                  AND event_type = 'node.update_terminal'
                  AND status = 'dead'
                "#,
                params![parent_id, now, event.user_id.as_deref()],
            )
            .map_err(|e| e.to_string())?;
        }

        Ok(parent.map(|_| parent_id.to_string()))
    }

    pub fn mark_local_sync_event_synced(&self, id: &str) -> Result<(), String> {
        let now = unix_timestamp();
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            r#"
            UPDATE local_sync_events
            SET status = 'synced', next_attempt_at = NULL, last_error = NULL, updated_at = ?2
            WHERE id = ?1
            "#,
            params![id, now],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn mark_local_sync_event_retry(&self, id: &str, error: &str) -> Result<(), String> {
        let now = unix_timestamp();
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let attempt_count = conn
            .query_row(
                "SELECT attempt_count FROM local_sync_events WHERE id = ?1",
                params![id],
                |row| row.get::<_, i64>(0),
            )
            .optional()
            .map_err(|e| e.to_string())?
            .unwrap_or(0)
            + 1;
        let base = (1_i64 << attempt_count.min(10)).min(3600);
        let jitter = (uuid::Uuid::new_v4().as_u128() % ((base / 4).max(1) as u128)) as i64;
        conn.execute(
            r#"
            UPDATE local_sync_events
            SET status = 'pending',
                attempt_count = ?2,
                next_attempt_at = ?3,
                last_error = ?4,
                updated_at = ?5
            WHERE id = ?1
            "#,
            params![id, attempt_count, now + base + jitter, error, now],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn mark_local_sync_event_dead(&self, id: &str, error: &str) -> Result<(), String> {
        let now = unix_timestamp();
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            r#"
            UPDATE local_sync_events
            SET status = 'dead', next_attempt_at = NULL, last_error = ?2, updated_at = ?3
            WHERE id = ?1
            "#,
            params![id, error, now],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn local_first_delete_branch(
        &self,
        workspace_id: &str,
        user_id: Option<&str>,
        root_node_id: &str,
    ) -> Result<LocalSyncEventRow, String> {
        let now = unix_timestamp();
        let deleted_at = chrono_like_now();
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            r#"
            INSERT INTO local_nodes (
                id, workspace_id, role, content, created_at, updated_at, deleted_at, local_updated_at
            )
            VALUES (?1, ?2, 'unknown', '', ?3, ?3, ?3, ?4)
            ON CONFLICT(id) DO UPDATE SET
                workspace_id = excluded.workspace_id,
                deleted_at = excluded.deleted_at,
                local_updated_at = excluded.local_updated_at
            "#,
            params![root_node_id, workspace_id, deleted_at, now],
        )
        .map_err(|e| e.to_string())?;
        conn.execute(
            r#"
            WITH RECURSIVE branch(id) AS (
                SELECT id FROM local_nodes WHERE workspace_id = ?1 AND id = ?2
                UNION ALL
                SELECT n.id
                FROM local_nodes n
                JOIN branch b ON n.parent_id = b.id
                WHERE n.workspace_id = ?1
            )
            UPDATE local_nodes
            SET deleted_at = ?3,
                local_updated_at = ?4
            WHERE workspace_id = ?1
              AND id IN (SELECT id FROM branch)
            "#,
            params![workspace_id, root_node_id, deleted_at, now],
        )
        .map_err(|e| e.to_string())?;
        drop(conn);
        let payload = serde_json::json!({
            "workspace_id": workspace_id,
            "node_id": root_node_id,
            "delete_mode": "branch",
            "deleted_at": deleted_at,
        });
        self.enqueue_local_sync_event_for_user(
            Some(workspace_id),
            user_id,
            "node",
            root_node_id,
            "node.delete",
            &serde_json::to_string(&payload).map_err(|e| e.to_string())?,
            None,
        )
    }

    fn local_workspace_row_from_sql(
        row: &rusqlite::Row<'_>,
    ) -> rusqlite::Result<LocalWorkspaceRow> {
        Ok(LocalWorkspaceRow {
            id: row.get(0)?,
            name: row.get(1)?,
            user_id: row.get::<_, Option<String>>(2)?.unwrap_or_default(),
            local_repo_path: row.get(3)?,
            folder_path: row.get(4)?,
            repo_path: row.get(5)?,
            base_commit_sha: row.get(6)?,
            connection_status: row.get(7)?,
            sync_status: row.get(8)?,
            created_at: row.get(9)?,
            updated_at: row.get(10)?,
            deleted_at: row.get(11)?,
            local_updated_at: row.get(12)?,
            server_workspace_id: row.get(13)?,
            server_version: row.get(14)?,
            name_dirty: row.get::<_, i64>(15)? != 0,
            metadata_dirty: row.get::<_, i64>(16)? != 0,
            cloud_backup_enabled: row.get::<_, i64>(17)? != 0,
            cloud_account_id: row.get(18)?,
        })
    }

    fn select_local_workspace_locked(
        conn: &Connection,
        workspace_id: &str,
        user_id: &str,
    ) -> Result<Option<LocalWorkspaceRow>, String> {
        conn.query_row(
            r#"
            SELECT
                id, name, user_id, local_repo_path, folder_path, repo_path, base_commit_sha,
                connection_status, sync_status, created_at, updated_at, deleted_at,
                local_updated_at, server_workspace_id, server_version, name_dirty, metadata_dirty,
                cloud_backup_enabled, cloud_account_id
            FROM local_workspaces
            WHERE id = ?1 AND (user_id = ?2 OR user_id IS NULL)
            ORDER BY user_id IS NULL ASC
            LIMIT 1
            "#,
            params![workspace_id, user_id],
            Self::local_workspace_row_from_sql,
        )
        .optional()
        .map_err(|e| e.to_string())
    }

    pub fn get_local_workspace_by_id(
        &self,
        workspace_id: &str,
    ) -> Result<Option<LocalWorkspaceRow>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.query_row(
            r#"
            SELECT
                id, name, user_id, local_repo_path, folder_path, repo_path, base_commit_sha,
                connection_status, sync_status, created_at, updated_at, deleted_at,
                local_updated_at, server_workspace_id, server_version, name_dirty, metadata_dirty,
                cloud_backup_enabled, cloud_account_id
            FROM local_workspaces
            WHERE id = ?1 AND deleted_at IS NULL
            ORDER BY user_id IS NULL ASC
            LIMIT 1
            "#,
            params![workspace_id],
            Self::local_workspace_row_from_sql,
        )
        .optional()
        .map_err(|e| e.to_string())
    }

    pub(crate) fn get_local_workspace_for_user(
        &self,
        workspace_id: &str,
        user_id: &str,
    ) -> Result<Option<LocalWorkspaceRow>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        Self::select_local_workspace_locked(&conn, workspace_id, user_id)
    }

    pub fn list_local_workspaces(
        &self,
        user_id: &str,
        active_cloud_account_id: Option<&str>,
    ) -> Result<Vec<LocalWorkspaceRow>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        Self::repair_legacy_cloud_owned_local_rows_locked(&conn, user_id, active_cloud_account_id)?;
        let mut stmt = conn
            .prepare(
                r#"
                SELECT
                    id, name, user_id, local_repo_path, folder_path, repo_path, base_commit_sha,
                    connection_status, sync_status, created_at, updated_at, deleted_at,
                    local_updated_at, server_workspace_id, server_version, name_dirty, metadata_dirty,
                    CASE
                        WHEN cloud_backup_enabled = 1 AND cloud_account_id = ?2 THEN 1
                        ELSE 0
                    END AS cloud_backup_enabled,
                    cloud_account_id
                FROM local_workspaces
                WHERE user_id = ?1
                  AND deleted_at IS NULL
                  AND (
                      local_repo_path IS NOT NULL
                      OR cloud_account_id IS NULL
                      OR cloud_account_id = ?2
                  )
                ORDER BY local_updated_at DESC, updated_at DESC
                "#,
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(
                params![user_id, active_cloud_account_id],
                Self::local_workspace_row_from_sql,
            )
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        Ok(rows)
    }

    pub fn merge_server_workspaces(
        &self,
        user_id: &str,
        cloud_account_id: &str,
        payloads: Vec<String>,
    ) -> Result<Vec<LocalWorkspaceRow>, String> {
        let now = unix_timestamp();
        let now_text = chrono_like_now();
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        Self::repair_legacy_cloud_owned_local_rows_locked(&conn, user_id, Some(cloud_account_id))?;
        for payload_json in payloads {
            let payload: JsonValue = match serde_json::from_str(&payload_json) {
                Ok(value) => value,
                Err(_) => continue,
            };
            let Some(id) = payload.get("id").and_then(|value| value.as_str()) else {
                continue;
            };
            let name = payload
                .get("name")
                .and_then(|value| value.as_str())
                .unwrap_or("Untitled workspace");
            let server_version = payload
                .get("updatedAt")
                .or_else(|| payload.get("updated_at"))
                .and_then(|value| value.as_str())
                .unwrap_or(&now_text);
            let existing = Self::select_local_workspace_locked(&conn, id, user_id)?;
            if existing
                .as_ref()
                .and_then(|row| row.deleted_at.as_ref())
                .is_some()
            {
                continue;
            }
            if let Some(row) = existing {
                if row
                    .cloud_account_id
                    .as_deref()
                    .is_some_and(|existing_cloud| existing_cloud != cloud_account_id)
                    && row.local_repo_path.is_none()
                {
                    continue;
                }
                if row.name_dirty {
                    conn.execute(
                        r#"
                        UPDATE local_workspaces
                        SET user_id = ?5,
                            server_workspace_id = COALESCE(server_workspace_id, ?2),
                            server_version = ?3,
                            server_ack_at = COALESCE(server_ack_at, ?4),
                            cloud_backup_enabled = 1,
                            cloud_account_id = ?6
                        WHERE id = ?1 AND (user_id = ?5 OR user_id IS NULL)
                        "#,
                        params![id, id, server_version, now_text, user_id, cloud_account_id],
                    )
                    .map_err(|e| e.to_string())?;
                } else {
                    conn.execute(
                        r#"
                        UPDATE local_workspaces
                        SET user_id = ?5,
                            name = ?2,
                            server_workspace_id = COALESCE(server_workspace_id, ?1),
                            server_version = ?3,
                            server_ack_at = COALESCE(server_ack_at, ?4),
                            updated_at = ?4,
                            cloud_backup_enabled = 1,
                            cloud_account_id = ?6
                        WHERE id = ?1 AND (user_id = ?5 OR user_id IS NULL)
                        "#,
                        params![
                            id,
                            name,
                            server_version,
                            now_text,
                            user_id,
                            cloud_account_id
                        ],
                    )
                    .map_err(|e| e.to_string())?;
                }
            } else {
                conn.execute(
                    r#"
                    INSERT INTO local_workspaces (
                        id, user_id, name, base_commit_sha, connection_status, sync_status,
                        created_at, updated_at, local_updated_at, server_workspace_id,
                        server_ack_at, server_version, cloud_backup_enabled, cloud_account_id
                    )
                    VALUES (?1, ?2, ?3, ?4, 'remote_unconnected', 'synced', ?5, ?5, ?6, ?1, ?5, ?7, 1, ?8)
                    "#,
                    params![
                        id,
                        user_id,
                        name,
                        payload
                            .get("base_commit_sha")
                            .or_else(|| payload.get("baseCommitSha"))
                            .and_then(|value| value.as_str()),
                        now_text,
                        now,
                        server_version,
                        cloud_account_id
                    ],
                )
                .map_err(|e| e.to_string())?;
            }
        }
        drop(conn);
        self.list_local_workspaces(user_id, Some(cloud_account_id))
    }

    fn canonical_local_repo_path(path: &str) -> Result<String, String> {
        let trimmed = path.trim();
        if trimmed.is_empty() {
            return Err("Local repo path is required.".to_string());
        }
        let canonical = std::fs::canonicalize(trimmed)
            .map_err(|e| format!("Cannot access local repo path {}: {}", trimmed, e))?;
        if !canonical.is_dir() {
            return Err("Local repo path is not a directory.".to_string());
        }
        let output = Command::new("git")
            .arg("-C")
            .arg(&canonical)
            .args(["rev-parse", "--is-inside-work-tree"])
            .output()
            .map_err(|e| format!("Failed to run git for local repo path {}: {}", trimmed, e))?;
        if !output.status.success() || String::from_utf8_lossy(&output.stdout).trim() != "true" {
            return Err("Local repo path is not a git worktree.".to_string());
        }
        Ok(canonical.to_string_lossy().to_string())
    }

    fn repair_local_workspace_repo_paths(conn: &Connection) -> Result<(), String> {
        let candidates = {
            let mut stmt = conn
                .prepare(
                    r#"
                    SELECT id, local_repo_path, repo_path, folder_path
                    FROM local_workspaces
                    WHERE deleted_at IS NULL
                    "#,
                )
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, Option<String>>(1)?,
                        row.get::<_, Option<String>>(2)?,
                        row.get::<_, Option<String>>(3)?,
                    ))
                })
                .map_err(|e| e.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?;
            rows
        };

        for (id, local_repo_path, repo_path, folder_path) in candidates {
            let candidate = local_repo_path
                .as_deref()
                .or(repo_path.as_deref())
                .or(folder_path.as_deref());
            match candidate.and_then(|path| Self::canonical_local_repo_path(path).ok()) {
                Some(canonical) => {
                    conn.execute(
                        r#"
                        UPDATE local_workspaces
                        SET local_repo_path = ?2,
                            folder_path = ?2,
                            repo_path = ?2,
                            connection_status = 'connected'
                        WHERE id = ?1 AND deleted_at IS NULL
                        "#,
                        params![id, canonical],
                    )
                    .map_err(|e| e.to_string())?;
                }
                None => {
                    conn.execute(
                        r#"
                        UPDATE local_workspaces
                        SET local_repo_path = NULL,
                            connection_status = 'remote_unconnected'
                        WHERE id = ?1 AND deleted_at IS NULL
                        "#,
                        params![id],
                    )
                    .map_err(|e| e.to_string())?;
                }
            }
        }
        Ok(())
    }

    pub fn local_first_create_workspace(
        &self,
        request: LocalWorkspaceMutationRequest,
    ) -> Result<LocalWorkspaceRow, String> {
        let path = request
            .local_repo_path
            .as_deref()
            .ok_or_else(|| "Local repo path is required.".to_string())
            .and_then(Self::canonical_local_repo_path)?;
        let now = unix_timestamp();
        let now_text = chrono_like_now();
        let local_change_id = request
            .mutation_id
            .clone()
            .unwrap_or_else(|| format!("workspace.create:{}:{}", request.workspace_id, now));
        let name = request.name.unwrap_or_else(|| {
            Path::new(&path)
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("Untitled workspace")
                .to_string()
        });
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            r#"
            INSERT INTO local_workspaces (
                id, user_id, name, folder_path, repo_path, local_repo_path, repo_fingerprint,
                base_commit_sha, connection_status, sync_status, created_at, updated_at,
                local_updated_at, last_local_change_id, metadata_dirty
            )
            VALUES (?1, ?2, ?3, ?4, ?4, ?4, ?5, ?6, 'connected', 'local_only', ?7, ?7, ?8, ?9, 1)
            ON CONFLICT(id) DO UPDATE SET
                user_id = excluded.user_id,
                name = excluded.name,
                folder_path = excluded.folder_path,
                repo_path = excluded.repo_path,
                local_repo_path = excluded.local_repo_path,
                repo_fingerprint = excluded.repo_fingerprint,
                base_commit_sha = excluded.base_commit_sha,
                connection_status = 'connected',
                sync_status = CASE
                    WHEN cloud_backup_enabled = 1 THEN 'sync_pending'
                    ELSE 'local_only'
                END,
                updated_at = excluded.updated_at,
                local_updated_at = excluded.local_updated_at,
                deleted_at = NULL,
                last_local_change_id = excluded.last_local_change_id,
                metadata_dirty = 1
            "#,
            params![
                &request.workspace_id,
                &request.current_user_id,
                name,
                &path,
                request.repo_fingerprint.as_deref(),
                request.base_commit_sha.as_deref(),
                now_text,
                now,
                local_change_id.as_str()
            ],
        )
        .map_err(|e| e.to_string())?;
        let row = Self::select_local_workspace_locked(
            &conn,
            &request.workspace_id,
            &request.current_user_id,
        )?
        .ok_or_else(|| "Local workspace was not created.".to_string())?;
        drop(conn);
        let payload = serde_json::json!({
            "id": row.id,
            "name": row.name,
            "folderPath": row.local_repo_path,
            "repoPath": row.local_repo_path,
            "baseCommitSha": row.base_commit_sha,
        });
        self.enqueue_local_sync_event_for_user(
            Some(&request.workspace_id),
            Some(request.current_user_id.as_str()),
            "workspace",
            &request.workspace_id,
            "workspace.create",
            &serde_json::to_string(&payload).map_err(|e| e.to_string())?,
            Some(local_change_id.as_str()),
        )?;
        Ok(row)
    }

    pub fn local_first_rename_workspace(
        &self,
        workspace_id: &str,
        user_id: &str,
        name: &str,
    ) -> Result<LocalWorkspaceRow, String> {
        let trimmed_name = name.trim();
        if trimmed_name.is_empty() {
            return Err("Workspace name cannot be empty.".to_string());
        }
        let now = unix_timestamp();
        let now_text = chrono_like_now();
        let local_change_id = format!("workspace.rename:{}:{}", workspace_id, now);
        let mut conn = self.conn.lock().map_err(|e| e.to_string())?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        let updated = tx
            .execute(
                r#"
                UPDATE local_workspaces
                SET name = ?3,
                    updated_at = ?4,
                    local_updated_at = ?5,
                    sync_status = CASE
                        WHEN cloud_backup_enabled = 1 THEN 'sync_pending'
                        ELSE 'local_only'
                    END,
                    name_dirty = 1,
                    last_local_change_id = ?6
                WHERE id = ?1 AND user_id = ?2 AND deleted_at IS NULL
                "#,
                params![
                    workspace_id,
                    user_id,
                    trimmed_name,
                    now_text,
                    now,
                    local_change_id.as_str()
                ],
            )
            .map_err(|e| e.to_string())?;
        if updated == 0 {
            return Err("Workspace not found for active account.".to_string());
        }
        let row = Self::select_local_workspace_locked(&tx, workspace_id, user_id)?
            .ok_or_else(|| "Workspace not found for active account.".to_string())?;
        let payload = serde_json::json!({
            "id": workspace_id,
            "name": trimmed_name,
        });
        let payload_json = serde_json::to_string(&payload).map_err(|e| e.to_string())?;
        Self::enqueue_local_sync_event_locked(
            &tx,
            now,
            Some(workspace_id),
            Some(user_id),
            "workspace",
            workspace_id,
            "workspace.update",
            &payload_json,
            Some(local_change_id.as_str()),
        )?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(row)
    }

    pub fn local_first_reconnect_workspace(
        &self,
        request: LocalWorkspaceMutationRequest,
    ) -> Result<LocalWorkspaceRow, String> {
        let path = request
            .local_repo_path
            .as_deref()
            .ok_or_else(|| "Local repo path is required.".to_string())
            .and_then(Self::canonical_local_repo_path)?;
        let now = unix_timestamp();
        let now_text = chrono_like_now();
        let local_change_id = request
            .mutation_id
            .clone()
            .unwrap_or_else(|| format!("workspace.reconnect:{}:{}", request.workspace_id, now));
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let updated = conn
            .execute(
                r#"
                UPDATE local_workspaces
                SET folder_path = ?3,
                    repo_path = ?3,
                    local_repo_path = ?3,
                    repo_fingerprint = ?4,
                    base_commit_sha = COALESCE(?5, base_commit_sha),
                    connection_status = 'connected',
                    sync_status = CASE
                        WHEN cloud_backup_enabled = 1 THEN 'sync_pending'
                        ELSE 'local_only'
                    END,
                    updated_at = ?6,
                    local_updated_at = ?7,
                    metadata_dirty = 1,
                    last_local_change_id = ?8
                WHERE id = ?1 AND user_id = ?2 AND deleted_at IS NULL
                "#,
                params![
                    request.workspace_id,
                    request.current_user_id,
                    path,
                    request.repo_fingerprint,
                    request.base_commit_sha,
                    now_text,
                    now,
                    local_change_id.as_str()
                ],
            )
            .map_err(|e| e.to_string())?;
        if updated == 0 {
            return Err("Workspace not found for active account.".to_string());
        }
        let row = Self::select_local_workspace_locked(
            &conn,
            &request.workspace_id,
            &request.current_user_id,
        )?
        .ok_or_else(|| "Workspace not found for active account.".to_string())?;
        drop(conn);
        let payload = serde_json::json!({
            "id": row.id,
            "folderPath": row.local_repo_path,
            "repoPath": row.local_repo_path,
            "baseCommitSha": row.base_commit_sha,
        });
        self.enqueue_local_sync_event_for_user(
            Some(&request.workspace_id),
            Some(request.current_user_id.as_str()),
            "workspace",
            &request.workspace_id,
            "workspace.update",
            &serde_json::to_string(&payload).map_err(|e| e.to_string())?,
            Some(local_change_id.as_str()),
        )?;
        Ok(row)
    }

    pub fn enable_workspace_cloud_backup(
        &self,
        workspace_id: &str,
        user_id: &str,
        cloud_account_id: &str,
    ) -> Result<LocalWorkspaceRow, String> {
        if cloud_account_id.trim().is_empty() {
            return Err("Cannot enable backup without an active cloud account.".to_string());
        }
        let now = unix_timestamp();
        let now_text = chrono_like_now();
        let snapshot_id = uuid::Uuid::new_v4().to_string();
        let local_change_id = format!("workspace.enable_backup:{workspace_id}:{snapshot_id}");
        let mut conn = self.conn.lock().map_err(|e| e.to_string())?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        let existing = Self::select_local_workspace_locked(&tx, workspace_id, user_id)?
            .ok_or_else(|| "Workspace not found for local identity.".to_string())?;
        if existing.cloud_backup_enabled
            && existing.cloud_account_id.as_deref() == Some(cloud_account_id)
        {
            tx.commit().map_err(|e| e.to_string())?;
            return Ok(existing);
        }
        let updated = tx
            .execute(
                r#"
                UPDATE local_workspaces
                SET cloud_backup_enabled = 1,
                    cloud_account_id = ?3,
                    sync_status = 'sync_pending',
                    metadata_dirty = 1,
                    updated_at = ?4,
                    local_updated_at = ?5,
                    last_local_change_id = ?6
                WHERE id = ?1 AND user_id = ?2 AND deleted_at IS NULL
                "#,
                params![
                    workspace_id,
                    user_id,
                    cloud_account_id,
                    now_text,
                    now,
                    local_change_id.as_str()
                ],
            )
            .map_err(|e| e.to_string())?;
        if updated == 0 {
            return Err("Workspace not found for local identity.".to_string());
        }
        let row = Self::select_local_workspace_locked(&tx, workspace_id, user_id)?
            .ok_or_else(|| "Workspace not found for local identity.".to_string())?;
        let payload =
            Self::build_workspace_cloud_bootstrap_payload_locked(&tx, &row, &snapshot_id, now)?;
        Self::enqueue_local_sync_event_locked(
            &tx,
            now,
            Some(workspace_id),
            Some(user_id),
            "workspace",
            workspace_id,
            "workspace.bootstrap",
            &payload.to_string(),
            Some(&snapshot_id),
        )?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(row)
    }

    fn build_workspace_cloud_bootstrap_payload_locked(
        conn: &Connection,
        workspace: &LocalWorkspaceRow,
        snapshot_id: &str,
        captured_at: i64,
    ) -> Result<JsonValue, String> {
        let workspace_id = workspace.id.as_str();
        let node_pairs = {
            let mut node_stmt = conn
                .prepare(
                    r#"
                    SELECT
                        assistant.id,
                        user.payload_json,
                        assistant.payload_json,
                        assistant.content,
                        COALESCE(assistant.status, 'completed'),
                        assistant.execution_data_json,
                        assistant.prompt_tokens,
                        assistant.completion_tokens,
                        assistant.total_tokens,
                        assistant.output_commit_sha,
                        assistant.git_branch_name,
                        COALESCE(
                            json_extract(CASE WHEN json_valid(COALESCE(assistant.execution_data_json, '')) THEN assistant.execution_data_json ELSE '{}' END, '$.current_run_id'),
                            json_extract(CASE WHEN json_valid(COALESCE(assistant.execution_data_json, '')) THEN assistant.execution_data_json ELSE '{}' END, '$.meta.run_id'),
                            ledger.run_id,
                            assistant.id
                        )
                    FROM local_nodes assistant
                    JOIN local_nodes user
                      ON user.id = assistant.parent_id
                     AND user.workspace_id = assistant.workspace_id
                     AND user.deleted_at IS NULL
                    LEFT JOIN agent_run_ledger ledger
                      ON ledger.assistant_node_id = assistant.id
                    WHERE assistant.workspace_id = ?1
                      AND assistant.deleted_at IS NULL
                      AND assistant.role = 'assistant'
                      AND assistant.parent_id IS NOT NULL
                      AND assistant.status IN (
                        'completed',
                        'failed',
                        'cancelled',
                        'error',
                        'needs_user_action',
                        'failed_setup',
                        'failed_spawn',
                        'failed_runtime',
                        'failed_finalization'
                      )
                    ORDER BY assistant.local_updated_at ASC
                    "#,
                )
                .map_err(|e| e.to_string())?;
            let node_snapshots = node_stmt
                .query_map(params![workspace_id], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, Option<String>>(1)?,
                        row.get::<_, Option<String>>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, Option<String>>(5)?,
                        row.get::<_, Option<i64>>(6)?,
                        row.get::<_, Option<i64>>(7)?,
                        row.get::<_, Option<i64>>(8)?,
                        row.get::<_, Option<String>>(9)?,
                        row.get::<_, Option<String>>(10)?,
                        row.get::<_, String>(11)?,
                    ))
                })
                .map_err(|e| e.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?;
            let mut pairs = Vec::with_capacity(node_snapshots.len());
            for (
                _assistant_id,
                user_payload_json,
                assistant_payload_json,
                final_content,
                status,
                execution_data_json,
                prompt_tokens,
                completion_tokens,
                total_tokens,
                output_commit_sha,
                git_branch_name,
                run_id,
            ) in node_snapshots
            {
                let (Some(user_payload_json), Some(assistant_payload_json)) =
                    (user_payload_json, assistant_payload_json)
                else {
                    continue;
                };
                let user_message = serde_json::from_str::<JsonValue>(&user_payload_json)
                    .unwrap_or(JsonValue::Null);
                let assistant_message = serde_json::from_str::<JsonValue>(&assistant_payload_json)
                    .unwrap_or(JsonValue::Null);
                if user_message.is_null() || assistant_message.is_null() {
                    continue;
                }
                let execution_data = execution_data_json
                    .as_deref()
                    .and_then(|raw| serde_json::from_str::<JsonValue>(raw).ok())
                    .unwrap_or(JsonValue::Null);
                pairs.push(serde_json::json!({
                    "userMessage": user_message,
                    "assistantMessage": assistant_message,
                    "finalize": {
                        "runId": run_id,
                        "status": status,
                        "finalContent": final_content,
                        "executionData": execution_data,
                        "promptTokens": prompt_tokens,
                        "completionTokens": completion_tokens,
                        "totalTokens": total_tokens,
                        "outputCommitSha": output_commit_sha,
                        "gitBranchName": git_branch_name,
                    }
                }));
            }
            pairs
        };

        let insights = {
            let mut insight_stmt = conn
                .prepare(
                    r#"
                    SELECT id, payload_json
                    FROM local_insights
                    WHERE workspace_id = ?1
                      AND deleted_at IS NULL
                      AND status = 'active'
                    ORDER BY local_updated_at ASC
                    "#,
                )
                .map_err(|e| e.to_string())?;
            let insight_snapshots = insight_stmt
                .query_map(params![workspace_id], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })
                .map_err(|e| e.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?;
            insight_snapshots
                .into_iter()
                .filter_map(|(_id, payload_json)| {
                    serde_json::from_str::<JsonValue>(&payload_json).ok()
                })
                .filter(|value| !value.is_null())
                .collect::<Vec<_>>()
        };

        let threads = {
            let mut stmt = conn
                .prepare(
                    r#"
                    SELECT id, title, status, base_commit_sha, first_message_id, source,
                           created_at, updated_at
                    FROM thread_sessions
                    WHERE workspace_id = ?1 AND deleted_at IS NULL
                    ORDER BY created_at ASC, id ASC
                    "#,
                )
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map(params![workspace_id], |row| {
                    Ok(serde_json::json!({
                        "id": row.get::<_, String>(0)?,
                        "title": row.get::<_, Option<String>>(1)?,
                        "status": row.get::<_, String>(2)?,
                        "baseCommitSha": row.get::<_, Option<String>>(3)?,
                        "firstMessageId": row.get::<_, Option<String>>(4)?,
                        "source": row.get::<_, String>(5)?,
                        "createdAt": row.get::<_, Option<String>>(6)?,
                        "updatedAt": row.get::<_, Option<String>>(7)?,
                    }))
                })
                .map_err(|e| e.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?;
            rows
        };

        let graph = Self::list_local_commit_graph_locked(conn, workspace_id)?;
        let parents_by_child = graph.commit_parents.iter().fold(
            HashMap::<String, Vec<String>>::new(),
            |mut map, parent| {
                map.entry(parent.child_sha.clone())
                    .or_default()
                    .push(parent.parent_sha.clone());
                map
            },
        );
        let commits = graph
            .commits
            .iter()
            .map(|commit| {
                serde_json::json!({
                    "sha": commit.sha,
                    "parents": parents_by_child
                        .get(&commit.sha)
                        .cloned()
                        .or_else(|| commit.first_parent_sha.clone().map(|sha| vec![sha]))
                        .unwrap_or_default(),
                    "subject": commit.subject,
                    "authorName": commit.author_name,
                    "authorEmail": commit.author_email,
                    "authoredAt": commit.authored_at,
                    "committedAt": commit.committed_at,
                    "sourceKind": commit.source_kind,
                    "producedByNodeId": commit.produced_by_node_id,
                    "filesChangedCount": commit.files_changed_count,
                    "totalAdditions": commit.total_additions,
                    "totalDeletions": commit.total_deletions,
                })
            })
            .collect::<Vec<_>>();
        let observations = graph
            .commit_observations
            .iter()
            .map(|observation| {
                serde_json::json!({
                    "commitSha": observation.commit_sha,
                    "gitRef": observation.git_ref,
                    "sourceKind": observation.source_kind,
                    "firstSeenAt": observation.first_seen_at,
                    "lastSeenAt": observation.last_seen_at,
                })
            })
            .collect::<Vec<_>>();

        Ok(serde_json::json!({
            "schemaVersion": 1,
            "snapshotId": snapshot_id,
            "capturedAt": captured_at,
            "workspace": {
                "id": workspace.id,
                "name": workspace.name,
                "baseCommitSha": workspace.base_commit_sha,
            },
            "threads": threads,
            "nodePairs": node_pairs,
            "insights": insights,
            "commitGraph": {
                "commits": commits,
                "observations": observations,
            },
        }))
    }

    pub fn mark_local_workspace_persisted(
        &self,
        event: &LocalSyncEventRow,
        response_body: Option<&JsonValue>,
    ) -> Result<(), String> {
        let now_text = chrono_like_now();
        let server_version = response_body
            .and_then(|body| body.get("updatedAt").or_else(|| body.get("updated_at")))
            .and_then(|value| value.as_str())
            .unwrap_or(&now_text);
        let payload = serde_json::from_str::<JsonValue>(&event.payload_json).ok();
        let clear_name_dirty = event.event_type == "workspace.bootstrap"
            || event.event_type == "workspace.update"
                && payload
                    .as_ref()
                    .and_then(|value| value.as_object())
                    .map_or(false, |object| object.contains_key("name"));
        let clear_metadata_dirty = event.event_type == "workspace.bootstrap"
            || event.event_type == "workspace.create"
            || (event.event_type == "workspace.update"
                && payload
                    .as_ref()
                    .and_then(|value| value.as_object())
                    .map_or(false, |object| {
                        object.contains_key("folderPath")
                            || object.contains_key("repoPath")
                            || object.contains_key("baseCommitSha")
                    }));
        let mutation_id = Self::local_sync_event_mutation_id(event);
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            r#"
            UPDATE local_workspaces
            SET sync_status = 'synced',
                server_ack_at = ?2,
                server_version = ?3,
                name_dirty = CASE
                    WHEN ?4 = 1
                        AND (
                            last_local_change_id = ?6
                            OR last_local_change_id IS NULL
                            OR last_local_change_id NOT LIKE 'workspace.rename:%'
                        )
                    THEN 0
                    ELSE name_dirty
                END,
                metadata_dirty = CASE
                    WHEN ?5 = 1
                        AND (
                            last_local_change_id = ?6
                            OR last_local_change_id IS NULL
                            OR last_local_change_id LIKE 'workspace.rename:%'
                        )
                    THEN 0
                    ELSE metadata_dirty
                END
            WHERE id = ?1
            "#,
            params![
                event.entity_id,
                now_text,
                server_version,
                clear_name_dirty,
                clear_metadata_dirty,
                mutation_id.as_deref()
            ],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    fn local_sync_event_mutation_id(event: &LocalSyncEventRow) -> Option<String> {
        let marker = format!(":{}:{}:", event.event_type, event.entity_id);
        event
            .idempotency_key
            .split_once(marker.as_str())
            .map(|(_, mutation_id)| mutation_id)
            .filter(|mutation_id| !mutation_id.is_empty())
            .map(|mutation_id| mutation_id.to_string())
    }

    pub fn resolve_trusted_local_workspace_repo_path(
        &self,
        workspace_id: &str,
        user_id: &str,
        advisory_repo_path: Option<&str>,
    ) -> Result<String, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let row = Self::select_local_workspace_locked(&conn, workspace_id, user_id)?
            .ok_or_else(|| "Workspace not found for active account.".to_string())?;
        if row.connection_status != "connected" {
            return Err(
                "This workspace is not connected to a local folder on this machine. Reconnect repository."
                    .to_string(),
            );
        }
        let stored = row.local_repo_path.as_deref().ok_or_else(|| {
            "This workspace is not connected to a local folder on this machine. Reconnect repository."
                .to_string()
        })?;
        let trusted = Self::canonical_local_repo_path(stored)?;
        if let Some(advisory) = advisory_repo_path.filter(|value| !value.trim().is_empty()) {
            let advisory = Self::canonical_local_repo_path(advisory)?;
            if advisory != trusted {
                return Err(
                    "Repo path does not match the trusted local workspace binding.".to_string(),
                );
            }
        }
        Ok(trusted)
    }

    pub fn local_first_delete_workspace(
        &self,
        workspace_id: &str,
        user_id: Option<&str>,
    ) -> Result<LocalSyncEventRow, String> {
        let now = unix_timestamp();
        let deleted_at = chrono_like_now();
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            r#"
            INSERT INTO local_workspaces (
                id, user_id, name, connection_status, sync_status, created_at, updated_at, deleted_at, local_updated_at
            )
            VALUES (?1, ?4, '', 'remote_unconnected', 'sync_pending', ?2, ?2, ?2, ?3)
            ON CONFLICT(id) DO UPDATE SET
                user_id = COALESCE(local_workspaces.user_id, excluded.user_id),
                deleted_at = excluded.deleted_at,
                sync_status = CASE
                    WHEN cloud_backup_enabled = 1 THEN 'sync_pending'
                    ELSE 'local_only'
                END,
                local_updated_at = excluded.local_updated_at
            "#,
            params![workspace_id, deleted_at, now, user_id],
        )
        .map_err(|e| e.to_string())?;
        conn.execute(
            r#"
            UPDATE local_nodes
            SET deleted_at = ?2, local_updated_at = ?3
            WHERE workspace_id = ?1 AND deleted_at IS NULL
            "#,
            params![workspace_id, deleted_at, now],
        )
        .map_err(|e| e.to_string())?;
        drop(conn);
        let payload = serde_json::json!({
            "workspace_id": workspace_id,
            "deleted_at": deleted_at,
        });
        self.enqueue_local_sync_event_for_user(
            Some(workspace_id),
            user_id,
            "workspace",
            workspace_id,
            "workspace.delete",
            &serde_json::to_string(&payload).map_err(|e| e.to_string())?,
            None,
        )
    }

    pub fn list_local_deleted_node_roots(
        &self,
        workspace_id: &str,
    ) -> Result<Vec<LocalDeletedNodeRoot>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                r#"
                SELECT id, local_updated_at
                FROM local_nodes
                WHERE workspace_id = ?1 AND deleted_at IS NOT NULL
                ORDER BY local_updated_at ASC
                "#,
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![workspace_id], |row| {
                Ok(LocalDeletedNodeRoot {
                    workspace_id: workspace_id.to_string(),
                    node_id: row.get(0)?,
                    deleted_at: row.get(1)?,
                })
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        Ok(rows)
    }

    pub fn list_local_deleted_workspace_ids(&self) -> Result<Vec<String>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                r#"
                SELECT id
                FROM local_workspaces
                WHERE deleted_at IS NOT NULL
                ORDER BY local_updated_at ASC
                "#,
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        Ok(rows)
    }
}

fn chrono_like_now() -> String {
    format!("{}", unix_timestamp() * 1000)
}

#[tauri::command]
#[specta::specta]
pub fn create_session_db(
    telemetry: State<TelemetryDb>,
    session_id: String,
) -> Result<String, String> {
    telemetry.ensure_session(&session_id, None, None)?;
    Ok(telemetry.path())
}

pub fn log_event(
    app_handle: &AppHandle,
    session_id: &str,
    type_: &str,
    data: &str,
) -> Result<(), String> {
    let telemetry = app_handle.state::<TelemetryDb>();
    telemetry.log_event(session_id, type_, data)
}

#[tauri::command]
#[specta::specta]
pub fn record_tool_call(
    telemetry: State<TelemetryDb>,
    session_id: String,
    name: String,
    parameters: Option<String>,
    result: Option<String>,
    error: Option<String>,
    started_at: i64,
    completed_at: i64,
) -> Result<i64, String> {
    telemetry.record_tool_call(
        &session_id,
        &name,
        parameters.as_deref(),
        result.as_deref(),
        error.as_deref(),
        started_at,
        completed_at,
    )
}

#[tauri::command]
#[specta::specta]
pub fn kv_set(
    telemetry: State<TelemetryDb>,
    session_id: String,
    key: String,
    value: String,
) -> Result<(), String> {
    telemetry.kv_set(&session_id, &key, &value)
}

#[tauri::command]
#[specta::specta]
pub fn kv_get(
    telemetry: State<TelemetryDb>,
    session_id: String,
    key: String,
) -> Result<Option<String>, String> {
    telemetry.kv_get(&session_id, &key)
}

#[tauri::command]
#[specta::specta]
pub fn save_orchestration_user_templates(
    telemetry: State<TelemetryDb>,
    templates_json: String,
) -> Result<(), String> {
    let parsed: JsonValue = serde_json::from_str(&templates_json)
        .map_err(|e| format!("Invalid orchestration templates JSON: {}", e))?;
    if !parsed.is_array() {
        return Err("Orchestration templates JSON must be an array.".to_string());
    }
    telemetry.local_app_kv_set("orchestration_user_templates", &templates_json)
}

#[tauri::command]
#[specta::specta]
pub fn get_orchestration_user_templates(
    telemetry: State<TelemetryDb>,
) -> Result<Option<String>, String> {
    telemetry.local_app_kv_get("orchestration_user_templates")
}

#[tauri::command]
#[specta::specta]
pub fn save_default_prompt_overrides(
    telemetry: State<TelemetryDb>,
    prompts_json: String,
) -> Result<(), String> {
    let parsed: JsonValue = serde_json::from_str(&prompts_json)
        .map_err(|e| format!("Invalid default prompt overrides JSON: {}", e))?;
    if !parsed.is_array() {
        return Err("Default prompt overrides JSON must be an array.".to_string());
    }
    telemetry.local_app_kv_set("default_prompt_overrides", &prompts_json)
}

#[tauri::command]
#[specta::specta]
pub fn get_default_prompt_overrides(
    telemetry: State<TelemetryDb>,
) -> Result<Option<String>, String> {
    telemetry.local_app_kv_get("default_prompt_overrides")
}

#[tauri::command]
#[specta::specta]
pub fn add_message(
    telemetry: State<TelemetryDb>,
    session_id: String,
    role: String,
    content: String,
    metadata: Option<String>,
) -> Result<i64, String> {
    telemetry.add_message(&session_id, &role, &content, metadata.as_deref())
}

#[tauri::command]
#[specta::specta]
pub fn update_session_status(
    telemetry: State<TelemetryDb>,
    session_id: String,
    status: String,
) -> Result<(), String> {
    telemetry.update_session_status(&session_id, &status, None, None)
}

#[tauri::command]
#[specta::specta]
pub fn get_session_snapshot(
    telemetry: State<TelemetryDb>,
    session_id: String,
) -> Result<Option<TelemetrySessionSnapshot>, String> {
    telemetry.get_session_snapshot(&session_id)
}

#[tauri::command]
#[specta::specta]
pub fn get_agent_run_ledger(
    telemetry: State<TelemetryDb>,
    assistant_node_id: String,
) -> Result<Option<AgentRunLedgerRow>, String> {
    telemetry.get_agent_run_ledger_by_assistant(&assistant_node_id)
}

#[tauri::command]
#[specta::specta]
pub fn replay_agent_run_events(
    telemetry: State<TelemetryDb>,
    run_id: String,
    after_seq: Option<i64>,
) -> Result<Vec<AgentRunJournalEvent>, String> {
    telemetry.list_agent_run_events_after(&run_id, after_seq.unwrap_or(0))
}

#[tauri::command]
#[specta::specta]
pub fn list_local_nodes(
    telemetry: State<TelemetryDb>,
    workspace_id: String,
) -> Result<Vec<LocalNodeRow>, String> {
    let started_at = std::time::Instant::now();
    let result = telemetry.list_local_nodes_for_workspace(&workspace_id);
    if let Ok(rows) = result.as_ref() {
        let elapsed = started_at.elapsed();
        if elapsed >= std::time::Duration::from_millis(250) {
            crate::app_log!(
                "[PERF][DB] list_local_nodes workspace={} rows={} duration_ms={}",
                workspace_id,
                rows.len(),
                elapsed.as_millis()
            );
        }
    }
    result
}

#[tauri::command]
#[specta::specta]
pub fn list_local_insights(
    telemetry: State<TelemetryDb>,
    workspace_id: String,
) -> Result<Vec<LocalInsightRow>, String> {
    telemetry.list_local_insights_for_workspace(&workspace_id)
}

#[tauri::command]
#[specta::specta]
pub fn list_local_insight_candidates(
    telemetry: State<TelemetryDb>,
    workspace_id: String,
) -> Result<Vec<LocalInsightCandidateRow>, String> {
    telemetry.list_local_insight_candidates_for_workspace(&workspace_id)
}

#[tauri::command]
#[specta::specta]
pub fn upsert_local_insight(
    telemetry: State<TelemetryDb>,
    workspace_id: String,
    current_user_id: String,
    insight_id: String,
    payload_json: String,
    mutation_id: Option<String>,
) -> Result<LocalSyncEventRow, String> {
    telemetry.upsert_local_insight_payload_for_user(
        &workspace_id,
        Some(current_user_id.as_str()),
        &insight_id,
        &payload_json,
        mutation_id.as_deref(),
    )
}

#[tauri::command]
#[specta::specta]
pub fn local_first_dismiss_insight(
    telemetry: State<TelemetryDb>,
    workspace_id: String,
    current_user_id: String,
    insight_id: String,
) -> Result<LocalSyncEventRow, String> {
    telemetry.local_first_dismiss_insight(
        &workspace_id,
        Some(current_user_id.as_str()),
        &insight_id,
    )
}

#[tauri::command]
#[specta::specta]
pub fn record_local_insight_feedback(
    telemetry: State<TelemetryDb>,
    workspace_id: String,
    current_user_id: String,
    insight_id: String,
    action: String,
    context_json: Option<String>,
) -> Result<(), String> {
    telemetry.record_local_insight_feedback(
        &workspace_id,
        Some(current_user_id.as_str()),
        &insight_id,
        &action,
        context_json.as_deref(),
    )
}

#[tauri::command]
#[specta::specta]
pub fn hydrate_local_nodes_from_server(
    telemetry: State<TelemetryDb>,
    workspace_id: String,
    payloads: Vec<String>,
) -> Result<usize, String> {
    telemetry.hydrate_local_nodes_from_server(&workspace_id, payloads)
}

#[tauri::command]
#[specta::specta]
pub fn local_first_create_thread_session(
    telemetry: State<TelemetryDb>,
    current_user_id: String,
    payload: ThreadSessionPayload,
) -> Result<ThreadSessionPayload, String> {
    telemetry.local_first_create_thread_session(Some(current_user_id.as_str()), payload)
}

#[tauri::command]
#[specta::specta]
pub fn convert_subgraph_to_thread(
    telemetry: State<TelemetryDb>,
    workspace_id: String,
    root_node_id: String,
    idempotency_key: String,
    target_thread_id: String,
    current_user_id: String,
) -> Result<ConvertSubgraphToThreadResult, String> {
    telemetry.convert_subgraph_to_thread(
        &workspace_id,
        &root_node_id,
        &idempotency_key,
        &target_thread_id,
        Some(current_user_id.as_str()),
    )
}

#[tauri::command]
#[specta::specta]
pub fn list_thread_sessions(
    telemetry: State<TelemetryDb>,
    workspace_id: String,
) -> Result<Vec<ThreadSessionPayload>, String> {
    let started_at = std::time::Instant::now();
    let result = telemetry.list_thread_sessions_for_workspace(&workspace_id);
    if let Ok(rows) = result.as_ref() {
        let elapsed = started_at.elapsed();
        if elapsed >= std::time::Duration::from_millis(250) {
            crate::app_log!(
                "[PERF][DB] list_thread_sessions workspace={} rows={} duration_ms={}",
                workspace_id,
                rows.len(),
                elapsed.as_millis()
            );
        }
    }
    result
}

#[tauri::command]
#[specta::specta]
pub fn local_first_delete_thread_session(
    telemetry: State<TelemetryDb>,
    current_user_id: String,
    workspace_id: String,
    thread_id: String,
) -> Result<(), String> {
    telemetry.local_first_archive_thread_session(
        Some(current_user_id.as_str()),
        &workspace_id,
        &thread_id,
    )
}

#[tauri::command]
#[specta::specta]
pub fn upsert_local_node(
    telemetry: State<TelemetryDb>,
    workspace_id: String,
    node_id: String,
    payload: String,
) -> Result<(), String> {
    telemetry.upsert_local_node(&node_id, &workspace_id, &payload)
}

#[tauri::command]
#[specta::specta]
pub fn local_first_update_node_tags(
    telemetry: State<TelemetryDb>,
    workspace_id: String,
    current_user_id: String,
    node_id: String,
    tags: Vec<String>,
    action: String,
) -> Result<String, String> {
    telemetry.local_first_update_node_tags(
        &workspace_id,
        Some(current_user_id.as_str()),
        &node_id,
        tags,
        &action,
    )
}

#[tauri::command]
#[specta::specta]
pub fn local_first_update_node_highlight(
    telemetry: State<TelemetryDb>,
    workspace_id: String,
    current_user_id: String,
    node_id: String,
    action: String,
    highlight_json: String,
) -> Result<String, String> {
    telemetry.local_first_update_node_highlight(
        &workspace_id,
        Some(current_user_id.as_str()),
        &node_id,
        &action,
        &highlight_json,
    )
}

#[tauri::command]
#[specta::specta]
pub fn local_first_set_node_collapsed(
    telemetry: State<TelemetryDb>,
    workspace_id: String,
    current_user_id: String,
    node_id: String,
    collapsed: bool,
) -> Result<String, String> {
    telemetry.local_first_set_node_collapsed(
        &workspace_id,
        Some(current_user_id.as_str()),
        &node_id,
        collapsed,
    )
}

#[tauri::command]
#[specta::specta]
pub fn import_local_commits(
    telemetry: State<TelemetryDb>,
    workspace_id: String,
    commits: Vec<LocalCommitImport>,
    git_ref: Option<String>,
    repo_path: Option<String>,
) -> Result<usize, String> {
    telemetry.import_local_commits_with_parent_closure(
        &workspace_id,
        commits,
        git_ref.as_deref(),
        repo_path.as_deref(),
    )
}

#[tauri::command]
#[specta::specta]
pub fn list_local_commit_graph(
    telemetry: State<TelemetryDb>,
    workspace_id: String,
) -> Result<LocalCommitGraphSnapshot, String> {
    let started_at = std::time::Instant::now();
    let result = telemetry.list_local_commit_graph(&workspace_id);
    if let Ok(graph) = result.as_ref() {
        let elapsed = started_at.elapsed();
        if elapsed >= std::time::Duration::from_millis(250) {
            crate::app_log!(
                "[PERF][DB] list_local_commit_graph workspace={} commits={} parents={} observations={} duration_ms={}",
                workspace_id,
                graph.commits.len(),
                graph.commit_parents.len(),
                graph.commit_observations.len(),
                elapsed.as_millis()
            );
        }
    }
    result
}

#[tauri::command]
#[specta::specta]
pub fn repair_local_commit_graph(
    telemetry: State<TelemetryDb>,
    workspace_id: String,
    repo_path: String,
    git_ref: Option<String>,
) -> Result<usize, String> {
    telemetry.repair_local_commit_parent_closure(&workspace_id, &repo_path, git_ref.as_deref())
}

#[tauri::command]
#[specta::specta]
pub fn enqueue_local_commit_graph_sync(
    telemetry: State<TelemetryDb>,
    workspace_id: String,
    current_user_id: String,
    payload_json: String,
    mutation_id: Option<String>,
) -> Result<LocalSyncEventRow, String> {
    telemetry.enqueue_local_commit_graph_sync(
        &workspace_id,
        Some(current_user_id.as_str()),
        &payload_json,
        mutation_id.as_deref(),
    )
}

#[tauri::command]
#[specta::specta]
pub fn get_local_identity(telemetry: State<TelemetryDb>) -> Result<LocalIdentity, String> {
    telemetry.get_local_identity()
}

#[tauri::command]
#[specta::specta]
pub fn list_local_workspaces(
    telemetry: State<TelemetryDb>,
    current_user_id: String,
    active_cloud_account_id: Option<String>,
) -> Result<Vec<LocalWorkspaceRow>, String> {
    telemetry.list_local_workspaces(&current_user_id, active_cloud_account_id.as_deref())
}

#[tauri::command]
#[specta::specta]
pub fn merge_server_workspaces(
    telemetry: State<TelemetryDb>,
    current_user_id: String,
    cloud_account_id: String,
    payloads: Vec<String>,
) -> Result<Vec<LocalWorkspaceRow>, String> {
    telemetry.merge_server_workspaces(&current_user_id, &cloud_account_id, payloads)
}

#[tauri::command]
#[specta::specta]
pub fn local_first_create_workspace(
    telemetry: State<TelemetryDb>,
    request: LocalWorkspaceMutationRequest,
) -> Result<LocalWorkspaceRow, String> {
    telemetry.local_first_create_workspace(request)
}

#[tauri::command]
#[specta::specta]
pub fn local_first_rename_workspace(
    telemetry: State<TelemetryDb>,
    workspace_id: String,
    current_user_id: String,
    name: String,
) -> Result<LocalWorkspaceRow, String> {
    telemetry.local_first_rename_workspace(&workspace_id, &current_user_id, &name)
}

#[tauri::command]
#[specta::specta]
pub fn local_first_reconnect_workspace(
    telemetry: State<TelemetryDb>,
    request: LocalWorkspaceMutationRequest,
) -> Result<LocalWorkspaceRow, String> {
    telemetry.local_first_reconnect_workspace(request)
}

#[tauri::command]
#[specta::specta]
pub fn enable_workspace_cloud_backup(
    telemetry: State<TelemetryDb>,
    workspace_id: String,
    current_user_id: String,
    cloud_account_id: String,
) -> Result<LocalWorkspaceRow, String> {
    crate::config::validated_server_base_url()?;
    telemetry.enable_workspace_cloud_backup(&workspace_id, &current_user_id, &cloud_account_id)
}

#[tauri::command]
#[specta::specta]
pub fn local_first_delete_branch(
    telemetry: State<TelemetryDb>,
    workspace_id: String,
    current_user_id: String,
    root_node_id: String,
) -> Result<LocalSyncEventRow, String> {
    telemetry.local_first_delete_branch(
        &workspace_id,
        Some(current_user_id.as_str()),
        &root_node_id,
    )
}

#[tauri::command]
#[specta::specta]
pub fn local_first_delete_workspace(
    telemetry: State<TelemetryDb>,
    workspace_id: String,
    current_user_id: String,
) -> Result<LocalSyncEventRow, String> {
    telemetry.local_first_delete_workspace(&workspace_id, Some(current_user_id.as_str()))
}

#[tauri::command]
#[specta::specta]
pub fn list_local_deleted_node_roots(
    telemetry: State<TelemetryDb>,
    workspace_id: String,
) -> Result<Vec<LocalDeletedNodeRoot>, String> {
    telemetry.list_local_deleted_node_roots(&workspace_id)
}

#[tauri::command]
#[specta::specta]
pub fn list_local_deleted_workspace_ids(
    telemetry: State<TelemetryDb>,
) -> Result<Vec<String>, String> {
    telemetry.list_local_deleted_workspace_ids()
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CloudSyncCapability {
    pub available: bool,
    pub unavailable_reason: Option<String>,
}

#[tauri::command]
#[specta::specta]
pub fn get_cloud_sync_capability() -> CloudSyncCapability {
    match crate::config::validated_server_base_url() {
        Ok(_) => CloudSyncCapability {
            available: true,
            unavailable_reason: None,
        },
        Err(error) => CloudSyncCapability {
            available: false,
            unavailable_reason: Some(error),
        },
    }
}

#[tauri::command]
#[specta::specta]
pub fn get_next_local_sync_retry_at(
    telemetry: State<TelemetryDb>,
    current_user_id: String,
    cloud_account_id: String,
) -> Result<Option<i64>, String> {
    telemetry.next_local_sync_retry_at(&current_user_id, &cloud_account_id)
}

fn sync_event(
    client: &reqwest::blocking::Client,
    auth_token: &str,
    server_base_url: &str,
    event: &LocalSyncEventRow,
) -> Result<Option<JsonValue>, String> {
    if event.entity_type == "workspace" && event.event_type == "workspace.bootstrap" {
        let payload: JsonValue =
            serde_json::from_str(&event.payload_json).map_err(|err| err.to_string())?;
        let response = client
            .post(format!(
                "{}/workspaces/{}/sync/bootstrap",
                server_base_url, event.entity_id
            ))
            .header("Authorization", format!("Bearer {}", auth_token))
            .header("Idempotency-Key", &event.idempotency_key)
            .timeout(Duration::from_secs(30))
            .json(&payload)
            .send()
            .map_err(|err| format!("{} transport error: {}", event.event_type, err))?;
        if response.status().is_success() {
            return match response.json::<JsonValue>() {
                Ok(body) => Ok(Some(body)),
                Err(_) => Ok(None),
            };
        }
        return Err(local_sync_response_error(&event.event_type, response));
    }

    if event.entity_type == "thread"
        && (event.event_type == "thread.create" || event.event_type == "thread.delete")
    {
        let workspace_id = event
            .workspace_id
            .as_deref()
            .filter(|value| !value.is_empty())
            .ok_or_else(|| format!("{} event is missing workspace id", event.event_type))?;
        let request = if event.event_type == "thread.create" {
            let payload: JsonValue =
                serde_json::from_str(&event.payload_json).map_err(|err| err.to_string())?;
            client
                .post(format!(
                    "{}/workspaces/{}/threads",
                    server_base_url, workspace_id
                ))
                .json(&payload)
        } else {
            client.delete(format!(
                "{}/workspaces/{}/threads/{}",
                server_base_url, workspace_id, event.entity_id
            ))
        };
        let response = request
            .header("Authorization", format!("Bearer {}", auth_token))
            .header("Idempotency-Key", &event.idempotency_key)
            .send()
            .map_err(|err| format!("{} transport error: {}", event.event_type, err))?;
        if response.status().is_success()
            || (event.event_type == "thread.delete" && response.status().as_u16() == 404)
        {
            return Ok(response.json::<JsonValue>().ok());
        }
        return Err(local_sync_response_error(&event.event_type, response));
    }

    if event.entity_type == "node" && event.event_type == "node.collapsed.set" {
        let payload: JsonValue =
            serde_json::from_str(&event.payload_json).map_err(|err| err.to_string())?;
        let response = client
            .patch(format!("{}/messages/{}", server_base_url, event.entity_id))
            .header("Authorization", format!("Bearer {}", auth_token))
            .header("Idempotency-Key", &event.idempotency_key)
            .json(&payload)
            .send()
            .map_err(|err| format!("{} transport error: {}", event.event_type, err))?;
        if response.status().is_success() {
            return Ok(response.json::<JsonValue>().ok());
        }
        return Err(local_sync_response_error(&event.event_type, response));
    }

    if event.entity_type == "node" && event.event_type.starts_with("node.highlight.") {
        let highlight: JsonValue =
            serde_json::from_str(&event.payload_json).map_err(|err| err.to_string())?;
        let highlight_id = highlight
            .get("id")
            .and_then(JsonValue::as_str)
            .ok_or_else(|| format!("{} payload is missing id", event.event_type))?;
        let mut url = reqwest::Url::parse(server_base_url)
            .map_err(|err| format!("Invalid server URL: {err}"))?;
        let mut segments = url
            .path_segments_mut()
            .map_err(|_| "Server URL cannot be used for highlight sync.".to_string())?;
        segments.extend(["messages", event.entity_id.as_str(), "highlights"]);
        if event.event_type != "node.highlight.add" {
            segments.push(highlight_id);
        }
        drop(segments);

        let request = match event.event_type.as_str() {
            "node.highlight.add" => client.post(url).json(&serde_json::json!({
                "id": highlight_id,
                "color": highlight.get("color"),
                "range": highlight.get("range"),
            })),
            "node.highlight.update" => client.patch(url).json(&serde_json::json!({
                "color": highlight.get("color"),
            })),
            "node.highlight.delete" => client.delete(url),
            _ => return Err(format!("No sync handler for {}", event.event_type)),
        };
        let response = request
            .header("Authorization", format!("Bearer {}", auth_token))
            .header("Idempotency-Key", &event.idempotency_key)
            .send()
            .map_err(|err| format!("{} transport error: {}", event.event_type, err))?;
        if response.status().is_success()
            || (event.event_type == "node.highlight.delete" && response.status().as_u16() == 404)
        {
            return Ok(response.json::<JsonValue>().ok());
        }
        return Err(local_sync_response_error(&event.event_type, response));
    }

    if event.entity_type == "node"
        && (event.event_type == "node.tags.add" || event.event_type == "node.tags.remove")
    {
        let payload: JsonValue =
            serde_json::from_str(&event.payload_json).map_err(|err| err.to_string())?;
        let tags = payload
            .get("tags")
            .and_then(JsonValue::as_array)
            .ok_or_else(|| format!("{} payload is missing tags", event.event_type))?;
        if event.event_type == "node.tags.add" {
            let response = client
                .post(format!(
                    "{}/messages/{}/tags",
                    server_base_url, event.entity_id
                ))
                .header("Authorization", format!("Bearer {}", auth_token))
                .header("Idempotency-Key", &event.idempotency_key)
                .json(&serde_json::json!({ "tags": tags }))
                .send()
                .map_err(|err| format!("{} transport error: {}", event.event_type, err))?;
            if response.status().is_success() {
                return Ok(response.json::<JsonValue>().ok());
            }
            return Err(local_sync_response_error(&event.event_type, response));
        }

        for tag in tags.iter().filter_map(JsonValue::as_str) {
            let mut url = reqwest::Url::parse(server_base_url)
                .map_err(|err| format!("Invalid server URL: {err}"))?;
            url.path_segments_mut()
                .map_err(|_| "Server URL cannot be used for tag sync.".to_string())?
                .extend(["messages", event.entity_id.as_str(), "tags", tag]);
            let response = client
                .delete(url)
                .header("Authorization", format!("Bearer {}", auth_token))
                .header(
                    "Idempotency-Key",
                    format!("{}:{}", event.idempotency_key, tag),
                )
                .send()
                .map_err(|err| format!("{} transport error: {}", event.event_type, err))?;
            if !response.status().is_success() && response.status().as_u16() != 404 {
                return Err(local_sync_response_error(&event.event_type, response));
            }
        }
        return Ok(None);
    }

    if event.entity_type == "thread_conversion" && event.event_type == "thread.convert_subgraph" {
        let workspace_id = event
            .workspace_id
            .as_deref()
            .ok_or_else(|| "thread conversion event is missing workspace_id".to_string())?;
        let payload: JsonValue =
            serde_json::from_str(&event.payload_json).map_err(|err| err.to_string())?;
        let response = client
            .post(format!(
                "{}/workspaces/{}/threads/convert-subgraph",
                server_base_url, workspace_id
            ))
            .header("Authorization", format!("Bearer {}", auth_token))
            .header("Idempotency-Key", &event.idempotency_key)
            .json(&payload)
            .send()
            .map_err(|err| format!("{} transport error: {}", event.event_type, err))?;
        if response.status().is_success() {
            return Ok(None);
        }
        return Err(local_sync_response_error(&event.event_type, response));
    }

    if event.entity_type == "node" && event.event_type == "node.update_terminal" {
        let payload: JsonValue =
            serde_json::from_str(&event.payload_json).map_err(|err| err.to_string())?;
        let endpoint =
            if payload.get("userMessage").is_some() && payload.get("assistantMessage").is_some() {
                "stream/finalize-local-pair"
            } else {
                "stream/finalize"
            };
        let response = client
            .post(format!("{}/{}", server_base_url, endpoint))
            .header("Authorization", format!("Bearer {}", auth_token))
            .header("Idempotency-Key", &event.idempotency_key)
            .json(&payload)
            .send()
            .map_err(|err| format!("{} transport error: {}", event.event_type, err))?;
        if response.status().is_success() {
            return match response.json::<JsonValue>() {
                Ok(body) => Ok(Some(body)),
                Err(_) => Ok(None),
            };
        }
        return Err(local_sync_response_error(&event.event_type, response));
    }

    if event.entity_type == "insight"
        && (event.event_type == "insight.upsert" || event.event_type == "insight.dismiss")
    {
        let workspace_id = event
            .workspace_id
            .as_deref()
            .filter(|value| !value.is_empty())
            .unwrap_or(event.entity_id.as_str());
        let payload: JsonValue =
            serde_json::from_str(&event.payload_json).map_err(|err| err.to_string())?;
        let response = client
            .post(format!(
                "{}/workspaces/{}/insights/sync",
                server_base_url, workspace_id
            ))
            .header("Authorization", format!("Bearer {}", auth_token))
            .header("Idempotency-Key", &event.idempotency_key)
            .json(&payload)
            .send()
            .map_err(|err| format!("{} transport error: {}", event.event_type, err))?;
        if response.status().is_success() {
            return Ok(None);
        }
        return Err(local_sync_response_error(&event.event_type, response));
    }

    if event.entity_type == "workspace"
        && (event.event_type == "workspace.create" || event.event_type == "workspace.update")
    {
        let payload: JsonValue =
            serde_json::from_str(&event.payload_json).map_err(|err| err.to_string())?;
        let request = if event.event_type == "workspace.create" {
            client.post(format!("{}/workspaces", server_base_url))
        } else {
            client.patch(format!(
                "{}/workspaces/{}",
                server_base_url, event.entity_id
            ))
        };
        let response = request
            .header("Authorization", format!("Bearer {}", auth_token))
            .header("Idempotency-Key", &event.idempotency_key)
            .json(&payload)
            .send()
            .map_err(|err| format!("{} transport error: {}", event.event_type, err))?;
        if response.status().is_success() {
            return match response.json::<JsonValue>() {
                Ok(body) => Ok(Some(body)),
                Err(_) => Ok(None),
            };
        }
        return Err(local_sync_response_error(&event.event_type, response));
    }

    let url = match (event.entity_type.as_str(), event.event_type.as_str()) {
        ("commit_graph", "commit_graph.git_sync_ingest") => {
            let workspace_id = event
                .workspace_id
                .as_deref()
                .filter(|value| !value.is_empty())
                .unwrap_or(event.entity_id.as_str());
            let payload: JsonValue =
                serde_json::from_str(&event.payload_json).map_err(|err| err.to_string())?;
            let response = client
                .post(format!(
                    "{}/workspaces/{}/git-sync/ingest",
                    server_base_url, workspace_id
                ))
                .header("Authorization", format!("Bearer {}", auth_token))
                .header("Idempotency-Key", &event.idempotency_key)
                .json(&payload)
                .send()
                .map_err(|err| format!("{} transport error: {}", event.event_type, err))?;
            if response.status().is_success() {
                return Ok(None);
            }
            return Err(local_sync_response_error(&event.event_type, response));
        }
        ("node", "node.delete") => {
            format!("{}/messages/{}/branch", server_base_url, event.entity_id)
        }
        ("workspace", "workspace.delete") => {
            format!("{}/workspaces/{}", server_base_url, event.entity_id)
        }
        _ => {
            return Err(format!(
                "No sync handler for {} {}",
                event.entity_type, event.event_type
            ));
        }
    };
    let response = client
        .delete(url)
        .header("Authorization", format!("Bearer {}", auth_token))
        .header("Idempotency-Key", &event.idempotency_key)
        .send()
        .map_err(|err| format!("{} transport error: {}", event.event_type, err))?;
    if response.status().is_success() || response.status().as_u16() == 404 {
        Ok(None)
    } else {
        Err(local_sync_response_error(&event.event_type, response))
    }
}

fn local_sync_response_error(event_type: &str, response: reqwest::blocking::Response) -> String {
    let status = response.status();
    let body = response.text().unwrap_or_default();
    let body = body.trim();
    if body.is_empty() {
        return format!("{} failed with status {}", event_type, status);
    }
    let snippet: String = body.chars().take(500).collect();
    format!("{} failed with status {}: {}", event_type, status, snippet)
}

fn is_permanent_local_sync_error(error: &str) -> bool {
    error.starts_with("node.update_terminal failed with status 404 Not Found")
        || error.starts_with("commit_graph.git_sync_ingest failed with status 404 Not Found")
}

#[tauri::command]
#[specta::specta]
pub async fn process_local_sync_events(
    app: tauri::AppHandle,
    auth_token: String,
    current_user_id: String,
    cloud_account_id: String,
    workspace_id: Option<String>,
    bootstrap_only: Option<bool>,
    limit: Option<i64>,
) -> Result<usize, String> {
    if current_user_id.trim().is_empty() {
        return Err("Cannot process local sync events without a current user id.".to_string());
    }
    if cloud_account_id.trim().is_empty() {
        return Err(
            "Cannot process local sync events without an active cloud account id.".to_string(),
        );
    }
    // Validate before reading or marking any outbox rows. A build without a
    // usable cloud endpoint must leave pending work untouched for a later run.
    let server_base_url = crate::config::validated_server_base_url()?;
    let telemetry = app.state::<TelemetryDb>();
    let events = telemetry.list_due_local_sync_events_for_user_and_cloud_by_type(
        current_user_id.trim(),
        cloud_account_id.trim(),
        workspace_id.as_deref(),
        bootstrap_only
            .unwrap_or(false)
            .then_some("workspace.bootstrap"),
        limit.unwrap_or(25).clamp(1, 100),
    )?;
    // Pre-compute all in-flight marks while we still have access to the telemetry State.
    let mut flyable_events = Vec::new();
    for event in events {
        if let Some(parent_id) = telemetry.requeue_blocking_terminal_parent_if_needed(&event)? {
            crate::app_log!(
                "[LOCAL_SYNC] event={} entity_type={} entity_id={} status=deferred_for_parent parent_id={}",
                event.event_type,
                event.entity_type,
                event.entity_id,
                parent_id
            );
            continue;
        }
        if telemetry.mark_local_sync_event_in_flight(&event.id)? {
            flyable_events.push(event);
        }
    }
    if flyable_events.is_empty() {
        return Ok(0);
    }

    // Move the blocking HTTP work onto an OS thread so that the
    // reqwest::blocking::Client (which owns an internal tokio runtime)
    // is created and dropped outside of the async context.
    tauri::async_runtime::spawn_blocking(move || {
        let telemetry = app.state::<TelemetryDb>();
        let client = reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(5))
            .build()
            .map_err(|err| err.to_string())?;
        let mut synced = 0usize;
        let mut first_retry_error: Option<String> = None;
        for event in flyable_events {
            let result = sync_event(&client, &auth_token, &server_base_url, &event);
            match result {
                Ok(response_body) => {
                    if event.entity_type == "node" && event.event_type == "node.update_terminal" {
                        let _ = telemetry.mark_local_node_persisted(&event.entity_id);
                        if let Ok(payload) = serde_json::from_str::<JsonValue>(&event.payload_json)
                        {
                            if let Some(user_node_id) = payload
                                .get("userMessage")
                                .and_then(|value| value.get("id"))
                                .and_then(|value| value.as_str())
                            {
                                let _ = telemetry.mark_local_node_persisted(user_node_id);
                            }
                            let finalize_payload = payload.get("finalize").unwrap_or(&payload);
                            let status = finalize_payload
                                .get("status")
                                .and_then(|value| value.as_str())
                                .unwrap_or("completed");
                            let payload_output_commit_sha = finalize_payload
                                .get("outputCommitSha")
                                .or_else(|| finalize_payload.get("output_commit_sha"))
                                .and_then(|value| value.as_str());
                            let response_output_commit_sha =
                                response_body.as_ref().and_then(|body| {
                                    body.get("outputCommitSha")
                                        .or_else(|| body.get("output_commit_sha"))
                                        .and_then(|value| value.as_str())
                                });
                            let output_commit_sha =
                                response_output_commit_sha.or(payload_output_commit_sha);
                            let _ = telemetry.mark_agent_run_finalized(
                                &event.entity_id,
                                status,
                                true,
                                output_commit_sha,
                            );
                        }
                    }
                    if event.entity_type == "insight" {
                        let _ = telemetry.mark_local_insight_persisted(&event.entity_id);
                    }
                    if event.entity_type == "workspace" {
                        let _ = telemetry
                            .mark_local_workspace_persisted(&event, response_body.as_ref());
                    }
                    telemetry.mark_local_sync_event_synced(&event.id)?;
                    synced += 1;
                    crate::app_log!(
                        "[LOCAL_SYNC] event={} entity_type={} entity_id={} status=synced",
                        event.event_type,
                        event.entity_type,
                        event.entity_id
                    );
                }
                Err(err) => {
                    if err.starts_with("No sync handler") || is_permanent_local_sync_error(&err) {
                        let _ = telemetry.mark_local_sync_event_dead(&event.id, &err);
                    } else {
                        let _ = telemetry.mark_local_sync_event_retry(&event.id, &err);
                        if first_retry_error.is_none() {
                            first_retry_error = Some(err.clone());
                        }
                    }
                    crate::app_log!(
                        "[LOCAL_SYNC] event={} entity_type={} entity_id={} status={} err={}",
                        event.event_type,
                        event.entity_type,
                        event.entity_id,
                        if is_permanent_local_sync_error(&err) {
                            "dead"
                        } else {
                            "retry"
                        },
                        err
                    );
                }
            }
        }
        if let Some(err) = first_retry_error {
            return Err(err);
        }
        Ok(synced)
    })
    .await
    .map_err(|e| format!("Local sync task failed: {}", e))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn open_test_db() -> (tempfile::TempDir, TelemetryDb) {
        let dir = tempfile::tempdir().expect("tempdir");
        let db = TelemetryDb::open(dir.path()).expect("open telemetry db");
        (dir, db)
    }

    fn acknowledge_workspace_bootstrap(db: &TelemetryDb, user_id: &str, cloud_account_id: &str) {
        let bootstrap = db
            .list_due_local_sync_events_for_user_and_cloud(user_id, cloud_account_id, None, 25)
            .expect("list bootstrap event")
            .into_iter()
            .find(|event| event.event_type == "workspace.bootstrap")
            .expect("workspace bootstrap event");
        db.mark_local_sync_event_synced(&bootstrap.id)
            .expect("acknowledge workspace bootstrap");
    }

    fn admission_run(run_id: &str, assistant_node_id: &str) -> AgentRunLedgerUpsert {
        AgentRunLedgerUpsert {
            run_id: run_id.to_string(),
            user_node_id: Some(format!("user-{assistant_node_id}")),
            assistant_node_id: assistant_node_id.to_string(),
            workspace_id: Some("workspace-1".to_string()),
            repo_path: Some("/tmp/repo".to_string()),
            worktree_path: Some(format!("/tmp/worktrees/{assistant_node_id}")),
            branch_name: Some(format!("agentree/{assistant_node_id}")),
            parent_commit: Some("parent-sha".to_string()),
            pid: None,
            agent_type: Some("codex".to_string()),
            status: "accepted".to_string(),
            phase: "accepted".to_string(),
            login_profile_id: None,
        }
    }

    #[test]
    fn agent_run_admission_is_idempotent_and_rejects_conflicting_run() {
        let (_dir, db) = open_test_db();
        let original = admission_run("run-1", "assistant-1");
        let payload = r#"{"type":"agent:lifecycle","status":"accepted"}"#;
        db.upsert_local_node(
            "assistant-1",
            "workspace-1",
            r#"{"id":"assistant-1","workspaceId":"workspace-1","role":"assistant","status":"pending","execution_data":{"meta":{}}}"#,
        )
        .expect("local assistant node");

        assert_eq!(
            db.admit_agent_run(&original, payload)
                .expect("accept first run"),
            AgentRunAdmission::Accepted
        );
        assert_eq!(
            db.admit_agent_run(&original, payload)
                .expect("replay first run"),
            AgentRunAdmission::Existing {
                worktree_path: original.worktree_path.clone(),
                branch_name: original.branch_name.clone(),
                status: "accepted".to_string(),
                pid: None,
            }
        );

        let event_count: i64 = db
            .conn
            .lock()
            .expect("database lock")
            .query_row(
                "SELECT COUNT(*) FROM agent_run_events WHERE run_id = 'run-1'",
                [],
                |row| row.get(0),
            )
            .expect("event count");
        assert_eq!(event_count, 1, "an idempotent replay must not add events");

        let conflict = db
            .admit_agent_run(&admission_run("run-2", "assistant-1"), payload)
            .expect_err("different run for same node must conflict");
        assert!(conflict.contains("already belongs to run run-1"));
        db.record_agent_prelaunch_stage("assistant-1", "run-2", "worktree_preview_completed")
            .expect("conflicting prelaunch stage is ignored");
        let ledger = db
            .get_agent_run_ledger_by_assistant("assistant-1")
            .expect("read ledger")
            .expect("ledger exists");
        assert_eq!(ledger.run_id, "run-1");
        let local_node = db
            .get_local_node_payload("assistant-1")
            .expect("read local node")
            .expect("local node exists");
        let local_node: JsonValue = serde_json::from_str(&local_node).expect("local node payload");
        assert_eq!(
            local_node["execution_data"]["meta"]["prelaunch_run_id"],
            "run-1"
        );
        assert_eq!(
            local_node["execution_data"]["meta"]["prelaunch_stage"],
            "native_run_admitted"
        );
    }

    #[test]
    fn agent_run_admission_rejects_run_id_reused_for_another_node() {
        let (_dir, db) = open_test_db();
        let payload = r#"{"type":"agent:lifecycle","status":"accepted"}"#;
        db.admit_agent_run(&admission_run("run-1", "assistant-1"), payload)
            .expect("accept first run");

        let conflict = db
            .admit_agent_run(&admission_run("run-1", "assistant-2"), payload)
            .expect_err("same run id for another node must conflict");
        assert!(conflict.contains("already belongs to assistant node assistant-1"));
        assert!(db
            .get_agent_run_ledger_by_assistant("assistant-2")
            .expect("read second node")
            .is_none());
    }

    #[test]
    fn concurrent_agent_run_admission_has_exactly_one_winner() {
        let dir = tempfile::tempdir().expect("tempdir");
        let first_db = TelemetryDb::open(dir.path()).expect("open first database connection");
        let second_db = TelemetryDb::open(dir.path()).expect("open second database connection");
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));

        let attempts = [(first_db, "run-1"), (second_db, "run-2")]
            .into_iter()
            .map(|(db, run_id)| {
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    db.admit_agent_run(
                        &admission_run(run_id, "assistant-1"),
                        r#"{"type":"agent:lifecycle","status":"accepted"}"#,
                    )
                })
            })
            .collect::<Vec<_>>();

        let results = attempts
            .into_iter()
            .map(|attempt| attempt.join().expect("admission thread"))
            .collect::<Vec<_>>();
        assert_eq!(
            results
                .iter()
                .filter(|result| matches!(result, Ok(AgentRunAdmission::Accepted)))
                .count(),
            1
        );
        assert_eq!(results.iter().filter(|result| result.is_err()).count(), 1);

        let verifier = TelemetryDb::open(dir.path()).expect("open verifier connection");
        let event_count: i64 = verifier
            .conn
            .lock()
            .expect("database lock")
            .query_row("SELECT COUNT(*) FROM agent_run_events", [], |row| {
                row.get(0)
            })
            .expect("event count");
        assert_eq!(event_count, 1);
    }

    #[test]
    fn agent_launch_request_claims_are_exclusive_and_recover_expired_work() {
        let (_dir, db) = open_test_db();
        let first = db
            .claim_agent_launch_request(
                "request-1",
                "workspace-1",
                Some("thread-1"),
                "user-1",
                "assistant-1",
                "run-1",
                "{}",
                "owner-1",
                120,
            )
            .expect("first claim");
        assert!(first.acquired);

        let concurrent = db
            .claim_agent_launch_request(
                "request-1",
                "workspace-1",
                Some("thread-1"),
                "user-1",
                "assistant-1",
                "run-1",
                "{}",
                "owner-2",
                120,
            )
            .expect("concurrent claim");
        assert!(!concurrent.acquired);
        assert!(db
            .renew_agent_launch_request_lease("request-1", "owner-1", 120)
            .expect("renew owned lease"));
        assert!(!db
            .renew_agent_launch_request_lease("request-1", "owner-2", 120)
            .expect("reject foreign lease renewal"));

        {
            let conn = db.conn.lock().expect("lock db");
            conn.execute(
                "UPDATE agent_launch_requests SET lease_expires_at = 0 WHERE request_id = ?1",
                params!["request-1"],
            )
            .expect("expire claim");
        }
        let expired = db
            .list_expired_agent_launch_requests(10)
            .expect("list expired claims");
        assert_eq!(expired.len(), 1);
        assert_eq!(expired[0].request_id, "request-1");
        let recovered = db
            .claim_agent_launch_request(
                "request-1",
                "workspace-1",
                Some("thread-1"),
                "user-1",
                "assistant-1",
                "run-1",
                "{}",
                "owner-2",
                120,
            )
            .expect("recovered claim");
        assert!(recovered.acquired);
        assert_eq!(recovered.row.lease_owner.as_deref(), Some("owner-2"));

        db.upsert_agent_run_ledger(&AgentRunLedgerUpsert {
            run_id: "run-1".to_string(),
            user_node_id: Some("user-1".to_string()),
            assistant_node_id: "assistant-1".to_string(),
            workspace_id: Some("workspace-1".to_string()),
            repo_path: None,
            worktree_path: None,
            branch_name: None,
            parent_commit: None,
            pid: None,
            agent_type: Some("codex".to_string()),
            status: "accepted".to_string(),
            phase: "accepted".to_string(),
            login_profile_id: None,
        })
        .expect("persist run ledger");
        db.reconcile_agent_launch_request_accepted("request-1")
            .expect("reconcile accepted launch");
        let reconciled = db
            .get_agent_launch_request("request-1")
            .expect("read launch request")
            .expect("launch request exists");
        assert_eq!(reconciled.status, "accepted");
        assert!(reconciled.lease_owner.is_none());
        assert!(db
            .list_expired_agent_launch_requests(10)
            .expect("accepted requests are not recoverable")
            .is_empty());
    }

    #[test]
    fn generated_insight_candidate_payload_uses_iso_timestamps() {
        let candidate = parse_insight_candidate(
            "workspace-1",
            "parent-1",
            "run-1",
            "light",
            "assistant_completed",
            Some(10),
            Some(20),
            Some(30),
            serde_json::json!({
                "claim": "This workflow needs browser verification after UI changes",
                "rationale": "The implementation changed visible UI behavior, so browser verification would reduce regression risk.",
                "novelty": 0.8,
                "relevance": 0.8,
                "actionability": 0.8,
                "timing": 0.8,
                "confidence": 0.8,
                "risk": 0.2
            }),
        )
        .expect("candidate");
        let created_at = candidate
            .payload
            .get("createdAt")
            .and_then(|value| value.as_str())
            .expect("createdAt");

        assert!(chrono::DateTime::parse_from_rfc3339(created_at).is_ok());
    }

    #[test]
    fn opening_existing_local_workspaces_without_user_id_migrates_before_indexing() {
        let dir = tempfile::tempdir().expect("tempdir");
        let db_path = dir.path().join("telemetry.db");
        {
            let conn = Connection::open(&db_path).expect("create legacy db");
            conn.execute_batch(
                r#"
                CREATE TABLE local_workspaces (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    folder_path TEXT,
                    repo_path TEXT,
                    base_commit_sha TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    deleted_at TEXT,
                    local_updated_at INTEGER NOT NULL,
                    server_ack_at TEXT
                );
                "#,
            )
            .expect("legacy local_workspaces schema");
        }

        let db = TelemetryDb::open(dir.path()).expect("migrate existing db");
        let conn = db.conn.lock().expect("lock db");
        assert!(conn
            .prepare("SELECT user_id FROM local_workspaces LIMIT 0")
            .is_ok());
        let has_user_status_index: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = 'idx_local_workspaces_user_status'",
                [],
                |row| row.get(0),
            )
            .expect("index count");
        assert_eq!(has_user_status_index, 1);
    }

    #[test]
    fn opening_existing_local_nodes_without_thread_id_migrates_schema() {
        let dir = tempfile::tempdir().expect("tempdir");
        let db_path = dir.path().join("telemetry.db");
        {
            let conn = Connection::open(&db_path).expect("create legacy db");
            conn.execute_batch(
                r#"
                CREATE TABLE local_nodes (
                    id TEXT PRIMARY KEY,
                    workspace_id TEXT NOT NULL,
                    parent_id TEXT,
                    role TEXT NOT NULL,
                    content TEXT NOT NULL DEFAULT '',
                    status TEXT,
                    execution_data_json TEXT,
                    payload_json TEXT,
                    prompt_tokens INTEGER,
                    completion_tokens INTEGER,
                    total_tokens INTEGER,
                    base_commit_sha TEXT,
                    output_commit_sha TEXT,
                    base_selected_from_node_id TEXT,
                    git_branch_name TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    deleted_at TEXT,
                    local_updated_at INTEGER NOT NULL,
                    server_ack_at TEXT,
                    server_version TEXT
                );
                "#,
            )
            .expect("legacy local_nodes schema");
        }

        let db = TelemetryDb::open(dir.path()).expect("migrate existing db");
        let conn = db.conn.lock().expect("lock db");
        let has_thread_id = conn
            .prepare("SELECT thread_id FROM local_nodes LIMIT 0")
            .is_ok();
        let has_controlled_by_node_id = conn
            .prepare("SELECT controlled_by_node_id FROM local_nodes LIMIT 0")
            .is_ok();
        let has_thread_index: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = 'idx_local_nodes_thread'",
                [],
                |row| row.get(0),
            )
            .expect("index count");
        let has_controlled_by_index: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = 'idx_local_nodes_controlled_by'",
                [],
                |row| row.get(0),
            )
            .expect("controlled_by index count");
        assert!(has_thread_id);
        assert!(has_controlled_by_node_id);
        assert_eq!(has_thread_index, 1);
        assert_eq!(has_controlled_by_index, 1);
    }

    #[test]
    fn opening_existing_thread_sessions_without_parent_thread_id_migrates_schema() {
        let dir = tempfile::tempdir().expect("tempdir");
        let db_path = dir.path().join("telemetry.db");
        {
            let conn = Connection::open(&db_path).expect("create legacy db");
            conn.execute_batch(
                r#"
                CREATE TABLE thread_sessions (
                    id TEXT PRIMARY KEY,
                    workspace_id TEXT NOT NULL,
                    title TEXT,
                    status TEXT NOT NULL DEFAULT 'active',
                    base_commit_sha TEXT,
                    first_message_id TEXT,
                    source TEXT NOT NULL DEFAULT 'user',
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    deleted_at TEXT,
                    local_updated_at INTEGER NOT NULL,
                    server_ack_at TEXT,
                    server_version TEXT
                );
                "#,
            )
            .expect("legacy thread_sessions schema");
        }

        let db = TelemetryDb::open(dir.path()).expect("migrate existing db");
        let conn = db.conn.lock().expect("lock db");
        assert!(conn
            .prepare("SELECT parent_thread_id FROM thread_sessions LIMIT 0")
            .is_ok());
        let has_parent_index: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = 'idx_thread_sessions_parent'",
                [],
                |row| row.get(0),
            )
            .expect("parent index count");
        assert_eq!(has_parent_index, 1);
    }

    #[test]
    fn local_node_runtime_activity_updates_compact_metadata_only() {
        let (_dir, db) = open_test_db();
        db.upsert_local_node(
            "assistant-1",
            "workspace-1",
            &serde_json::json!({
                "id": "assistant-1",
                "workspaceId": "workspace-1",
                "role": "assistant",
                "content": "",
                "status": "streaming",
                "execution_data": {}
            })
            .to_string(),
        )
        .expect("upsert local node");

        db.update_local_node_runtime_activity(
            "assistant-1",
            "2026-06-01T00:05:00.000Z",
            "message_delta",
            None,
        )
        .expect("update runtime activity");

        let conn = db.conn.lock().expect("lock db");
        let (payload_json, execution_data_json): (String, String) = conn
            .query_row(
                "SELECT payload_json, execution_data_json FROM local_nodes WHERE id = ?1",
                params!["assistant-1"],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("local node row");
        let payload: JsonValue = serde_json::from_str(&payload_json).expect("payload json");
        let execution_data: JsonValue =
            serde_json::from_str(&execution_data_json).expect("execution data json");

        assert_eq!(
            payload
                .get("last_event_at")
                .and_then(|value| value.as_str()),
            Some("2026-06-01T00:05:00.000Z")
        );
        assert_eq!(
            execution_data
                .get("latest_event_type")
                .and_then(|value| value.as_str()),
            Some("message_delta")
        );
        assert_eq!(
            payload.get("content").and_then(|value| value.as_str()),
            Some("")
        );
    }

    #[test]
    fn opening_existing_agent_run_ledger_without_login_profile_id_migrates_schema() {
        let dir = tempfile::tempdir().expect("tempdir");
        let db_path = dir.path().join("telemetry.db");
        {
            let conn = Connection::open(&db_path).expect("create legacy db");
            conn.execute_batch(
                r#"
                CREATE TABLE agent_run_ledger (
                    run_id TEXT PRIMARY KEY,
                    user_node_id TEXT,
                    assistant_node_id TEXT NOT NULL UNIQUE,
                    workspace_id TEXT,
                    repo_path TEXT,
                    worktree_path TEXT,
                    branch_name TEXT,
                    parent_commit TEXT,
                    pid INTEGER,
                    agent_type TEXT,
                    status TEXT NOT NULL,
                    phase TEXT NOT NULL,
                    last_seq INTEGER NOT NULL DEFAULT 0,
                    started_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL,
                    terminal_status TEXT,
                    finalize_attempt_count INTEGER NOT NULL DEFAULT 0,
                    cleanup_attempt_count INTEGER NOT NULL DEFAULT 0,
                    server_start_persisted INTEGER NOT NULL DEFAULT 0,
                    server_final_persisted INTEGER NOT NULL DEFAULT 0,
                    output_commit_sha TEXT,
                    failure_reason TEXT,
                    needs_user_action_reason TEXT,
                    cleanup_completed INTEGER NOT NULL DEFAULT 0
                );
                "#,
            )
            .expect("legacy agent_run_ledger schema");
        }

        let db = TelemetryDb::open(dir.path()).expect("migrate existing db");
        let conn = db.conn.lock().expect("lock db");
        assert!(conn
            .prepare("SELECT login_profile_id FROM agent_run_ledger LIMIT 0")
            .is_ok());
        let has_login_profile_index: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = 'idx_agent_run_ledger_login_profile'",
                [],
                |row| row.get(0),
            )
            .expect("index count");
        assert_eq!(has_login_profile_index, 1);
    }

    #[test]
    fn thread_sessions_round_trip_locally() {
        let (_dir, db) = open_test_db();
        let session = ThreadSessionPayload {
            id: "thread-1".to_string(),
            workspace_id: "workspace-1".to_string(),
            title: Some("Build feature".to_string()),
            status: "active".to_string(),
            created_at: Some("2026-05-28T00:00:00.000Z".to_string()),
            updated_at: Some("2026-05-28T00:01:00.000Z".to_string()),
            base_commit_sha: Some("base-sha".to_string()),
            first_message_id: None,
            parent_thread_id: None,
            source: "user".to_string(),
            anchor_node_id: None,
        };

        db.upsert_thread_session(session).expect("upsert thread");
        let sessions = db
            .list_thread_sessions_for_workspace("workspace-1")
            .expect("list threads");

        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].id, "thread-1");
        assert_eq!(sessions[0].workspace_id, "workspace-1");
        assert_eq!(sessions[0].title.as_deref(), Some("Build feature"));
        assert_eq!(sessions[0].base_commit_sha.as_deref(), Some("base-sha"));
    }

    #[test]
    fn thread_sessions_can_be_archived_locally() {
        let (_dir, db) = open_test_db();
        db.upsert_thread_session(ThreadSessionPayload {
            id: "thread-1".to_string(),
            workspace_id: "workspace-1".to_string(),
            title: None,
            status: "active".to_string(),
            created_at: Some("2026-05-28T00:00:00.000Z".to_string()),
            updated_at: Some("2026-05-28T00:01:00.000Z".to_string()),
            base_commit_sha: None,
            first_message_id: None,
            parent_thread_id: None,
            source: "user".to_string(),
            anchor_node_id: None,
        })
        .expect("upsert thread");

        db.archive_thread_session("workspace-1", "thread-1")
            .expect("archive thread");

        let sessions = db
            .list_thread_sessions_for_workspace("workspace-1")
            .expect("list threads");
        assert!(sessions.is_empty());
    }

    #[test]
    fn local_first_thread_create_and_delete_commit_outbox_atomically() {
        let (_db_dir, db) = open_test_db();
        let (repo_dir, shas) = init_test_repo_with_commits(1);
        let local_path = std::fs::canonicalize(repo_dir.path())
            .expect("canonical repo")
            .to_string_lossy()
            .to_string();
        db.local_first_create_workspace(LocalWorkspaceMutationRequest {
            workspace_id: "workspace-threads".to_string(),
            current_user_id: "user-1".to_string(),
            name: Some("Threads".to_string()),
            local_repo_path: Some(local_path),
            base_commit_sha: Some(shas[0].clone()),
            repo_fingerprint: Some(format!("base:{}", shas[0])),
            mutation_id: Some("workspace.create:workspace-threads".to_string()),
        })
        .expect("create local workspace");
        db.enable_workspace_cloud_backup("workspace-threads", "user-1", "cloud-1")
            .expect("enable backup");
        acknowledge_workspace_bootstrap(&db, "user-1", "cloud-1");

        let session = db
            .local_first_create_thread_session(
                Some("user-1"),
                ThreadSessionPayload {
                    id: "thread-1".to_string(),
                    workspace_id: "workspace-threads".to_string(),
                    title: Some("Offline thread".to_string()),
                    status: "active".to_string(),
                    created_at: Some("2026-07-22T00:00:00Z".to_string()),
                    updated_at: Some("2026-07-22T00:00:00Z".to_string()),
                    base_commit_sha: Some(shas[0].clone()),
                    first_message_id: None,
                    parent_thread_id: None,
                    source: "user".to_string(),
                    anchor_node_id: None,
                },
            )
            .expect("create thread locally");
        assert_eq!(session.id, "thread-1");
        let create_event = db
            .list_due_local_sync_events_for_user_and_cloud("user-1", "cloud-1", None, 25)
            .expect("list create event")
            .into_iter()
            .find(|event| event.event_type == "thread.create")
            .expect("thread create event");
        assert_eq!(create_event.entity_id, "thread-1");

        db.local_first_archive_thread_session(Some("user-1"), "workspace-threads", "thread-1")
            .expect("archive thread locally");
        assert!(db
            .list_thread_sessions_for_workspace("workspace-threads")
            .expect("list threads")
            .is_empty());
        let delete_event = db
            .list_due_local_sync_events_for_user_and_cloud("user-1", "cloud-1", None, 25)
            .expect("list delete event")
            .into_iter()
            .find(|event| event.event_type == "thread.delete")
            .expect("thread delete event");
        assert_eq!(delete_event.entity_id, "thread-1");
        let ordered_thread_events = db
            .list_due_local_sync_events_for_user_and_cloud("user-1", "cloud-1", None, 25)
            .expect("list ordered thread events")
            .into_iter()
            .filter(|event| event.entity_type == "thread")
            .map(|event| event.event_type)
            .collect::<Vec<_>>();
        assert_eq!(
            ordered_thread_events,
            vec!["thread.create".to_string(), "thread.delete".to_string()]
        );
    }

    #[test]
    fn subgraph_conversion_is_atomic_branched_and_idempotent() {
        let (_dir, db) = open_test_db();
        db.conn
            .lock()
            .unwrap()
            .execute(
                "INSERT INTO local_workspaces (id, name, created_at, updated_at, local_updated_at, cloud_backup_enabled) VALUES ('workspace-1', 'Local only', '2026-07-21T00:00:00.000Z', '2026-07-21T00:00:00.000Z', 1, 0)",
                [],
            )
            .unwrap();
        let nodes = [
            (
                "anchor",
                r#"{"id":"anchor","workspaceId":"workspace-1","role":"assistant","content":"anchor","status":"completed","threadId":"source","thread_id":"source","parentId":null,"createdAt":"2026-07-21T00:00:00.000Z","updatedAt":"2026-07-21T00:00:00.000Z"}"#,
            ),
            (
                "root",
                r#"{"id":"root","workspaceId":"workspace-1","role":"user","content":"convert me","status":"completed","threadId":"source","thread_id":"source","parentId":"anchor","createdAt":"2026-07-21T00:01:00.000Z","updatedAt":"2026-07-21T00:01:00.000Z"}"#,
            ),
            (
                "left",
                r#"{"id":"left","workspaceId":"workspace-1","role":"assistant","content":"left","status":"completed","threadId":"source","thread_id":"source","parentId":"root","createdAt":"2026-07-21T00:02:00.000Z","updatedAt":"2026-07-21T00:02:00.000Z"}"#,
            ),
            (
                "right",
                r#"{"id":"right","workspaceId":"workspace-1","role":"assistant","content":"right","status":"completed","threadId":"source","thread_id":"source","parentId":"root","createdAt":"2026-07-21T00:03:00.000Z","updatedAt":"2026-07-21T00:03:00.000Z"}"#,
            ),
            (
                "nested",
                r#"{"id":"nested","workspaceId":"workspace-1","role":"user","content":"nested thread","status":"completed","threadId":"child","thread_id":"child","parentId":"left","createdAt":"2026-07-21T00:04:00.000Z","updatedAt":"2026-07-21T00:04:00.000Z"}"#,
            ),
            (
                "sibling",
                r#"{"id":"sibling","workspaceId":"workspace-1","role":"user","content":"sibling","status":"completed","threadId":"source","thread_id":"source","parentId":"anchor","createdAt":"2026-07-21T00:05:00.000Z","updatedAt":"2026-07-21T00:05:00.000Z"}"#,
            ),
        ];
        for (id, payload) in nodes {
            db.upsert_local_node(id, "workspace-1", payload)
                .expect("upsert conversion node");
        }

        let result = db
            .convert_subgraph_to_thread(
                "workspace-1",
                "root",
                "convert-1",
                "target-thread",
                Some("user-1"),
            )
            .expect("convert subgraph");
        assert_eq!(result.moved_node_ids, vec!["root", "left", "right"]);
        assert_eq!(result.thread.parent_thread_id.as_deref(), Some("source"));
        assert_eq!(result.thread.anchor_node_id.as_deref(), Some("anchor"));

        let conn = db.conn.lock().expect("db lock");
        let root_row: (Option<String>, Option<String>, String) = conn
            .query_row(
                "SELECT parent_id, thread_id, payload_json FROM local_nodes WHERE id = 'root'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .expect("root row");
        assert_eq!(root_row.0, None);
        assert_eq!(root_row.1.as_deref(), Some("target-thread"));
        let root_payload: JsonValue = serde_json::from_str(&root_row.2).expect("root payload");
        assert_eq!(
            root_payload
                .get("threadId")
                .and_then(|value| value.as_str()),
            Some("target-thread")
        );
        assert!(root_payload.get("parentId").is_some_and(JsonValue::is_null));
        let boundary_thread: String = conn
            .query_row(
                "SELECT thread_id FROM local_nodes WHERE id = 'nested'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let sibling_thread: String = conn
            .query_row(
                "SELECT thread_id FROM local_nodes WHERE id = 'sibling'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let sync_event_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM local_sync_events WHERE event_type = 'thread.convert_subgraph'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(boundary_thread, "child");
        assert_eq!(sibling_thread, "source");
        assert_eq!(sync_event_count, 0);
        drop(conn);

        let repeated = db
            .convert_subgraph_to_thread(
                "workspace-1",
                "root",
                "different-key",
                "different-target",
                Some("user-1"),
            )
            .expect("repeat conversion");
        assert_eq!(repeated.target_thread_id, "target-thread");
        assert_eq!(repeated.conversion_id, result.conversion_id);
    }

    #[test]
    fn subgraph_conversion_rejects_active_descendants_without_partial_writes() {
        let (_dir, db) = open_test_db();
        db.upsert_local_node("anchor", "workspace-1", r#"{"id":"anchor","workspaceId":"workspace-1","role":"assistant","content":"anchor","status":"completed","threadId":"source","parentId":null,"createdAt":"2026-07-21T00:00:00.000Z","updatedAt":"2026-07-21T00:00:00.000Z"}"#).unwrap();
        db.upsert_local_node("root", "workspace-1", r#"{"id":"root","workspaceId":"workspace-1","role":"user","content":"root","status":"completed","threadId":"source","parentId":"anchor","createdAt":"2026-07-21T00:01:00.000Z","updatedAt":"2026-07-21T00:01:00.000Z"}"#).unwrap();
        db.upsert_local_node("running", "workspace-1", r#"{"id":"running","workspaceId":"workspace-1","role":"assistant","content":"running","status":"streaming","threadId":"source","parentId":"root","createdAt":"2026-07-21T00:02:00.000Z","updatedAt":"2026-07-21T00:02:00.000Z"}"#).unwrap();

        let error = db
            .convert_subgraph_to_thread(
                "workspace-1",
                "root",
                "convert-active",
                "target-thread",
                Some("user-1"),
            )
            .expect_err("active conversion must fail");
        assert!(error.contains("still active"));
        let conn = db.conn.lock().unwrap();
        let root_parent: String = conn
            .query_row(
                "SELECT parent_id FROM local_nodes WHERE id = 'root'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let target_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM thread_sessions WHERE id = 'target-thread'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(root_parent, "anchor");
        assert_eq!(target_count, 0);
    }

    #[test]
    fn background_insight_candidates_are_private_until_arbitrated() {
        let (_dir, db) = open_test_db();
        let candidates = vec![
            serde_json::json!({
                "id": "candidate-1",
                "agentKind": "doubt",
                "claim": "Candidate generation and user interruption are still coupled.",
                "rationale": "The branch discusses insight generation, but the attention gate is the unresolved product decision.",
                "analysis": "This is grounded in the active architecture discussion and gives the user a concrete next design boundary.",
                "novelty": 0.86,
                "relevance": 0.88,
                "actionability": 0.74,
                "risk": 0.18,
                "timing": 0.82,
                "confidence": 0.81
            }),
            serde_json::json!({
                "id": "candidate-2",
                "agentKind": "meta",
                "claim": "Consider tradeoffs.",
                "rationale": "Generic advice.",
                "novelty": 0.2,
                "relevance": 0.3,
                "actionability": 0.2,
                "risk": 0.2,
                "timing": 0.4,
                "confidence": 0.4
            }),
        ];

        let (candidate_count, surfaced_count) = db
            .persist_background_insight_candidates_for_user(
                "workspace-1",
                Some("user-1"),
                "parent-1",
                "run-1",
                "light",
                "light_assistant_completed",
                Some(1800),
                Some(220),
                Some(2020),
                candidates,
                "assistant completed",
            )
            .expect("persist candidates");

        assert_eq!(candidate_count, 2);
        assert_eq!(surfaced_count, 1);

        let surfaced = db
            .list_local_insights_for_workspace("workspace-1")
            .expect("list surfaced insights");
        assert_eq!(surfaced.len(), 1);
        assert_eq!(surfaced[0].insight_id, "candidate-1");
        let surfaced_payload: JsonValue =
            serde_json::from_str(&surfaced[0].payload).expect("surfaced payload json");
        assert_eq!(
            surfaced_payload
                .get("triggerReason")
                .and_then(|value| value.as_str()),
            Some("light_assistant_completed")
        );
        assert_eq!(
            surfaced_payload
                .get("promptTokens")
                .and_then(|value| value.as_i64()),
            Some(1800)
        );
        assert_eq!(
            surfaced_payload
                .get("completionTokens")
                .and_then(|value| value.as_i64()),
            Some(220)
        );

        let candidates = db
            .list_local_insight_candidates_for_workspace("workspace-1")
            .expect("list candidates");
        assert_eq!(candidates.len(), 2);
        assert_eq!(candidates[0].candidate_id, "candidate-1");
        assert_eq!(candidates[0].status, "surfaced");
        assert_eq!(candidates[1].candidate_id, "candidate-2");
        assert_eq!(candidates[1].status, "archived");

        db.local_first_dismiss_insight("workspace-1", Some("user-1"), "candidate-1")
            .expect("dismiss surfaced insight");
        assert!(db
            .list_local_insights_for_workspace("workspace-1")
            .expect("list after dismiss")
            .is_empty());
    }

    #[test]
    fn claiming_first_thread_message_is_single_assignment() {
        let (_dir, db) = open_test_db();
        db.upsert_thread_session(ThreadSessionPayload {
            id: "thread-1".to_string(),
            workspace_id: "workspace-1".to_string(),
            title: None,
            status: "active".to_string(),
            created_at: Some("2026-05-31T00:00:00.000Z".to_string()),
            updated_at: Some("2026-05-31T00:00:00.000Z".to_string()),
            base_commit_sha: None,
            first_message_id: None,
            parent_thread_id: None,
            source: "orchestration".to_string(),
            anchor_node_id: None,
        })
        .expect("thread session");

        assert!(db
            .claim_thread_first_message("workspace-1", "thread-1", "user-1")
            .expect("claim first message"));
        assert!(!db
            .claim_thread_first_message("workspace-1", "thread-1", "user-2")
            .expect("reject second claim"));

        let thread = db
            .get_thread_session_by_id("thread-1")
            .expect("read thread")
            .expect("thread exists");
        assert_eq!(thread.first_message_id.as_deref(), Some("user-1"));
    }

    #[test]
    fn first_assistant_thread_title_names_thread_session() {
        let (_dir, db) = open_test_db();
        db.upsert_thread_session(ThreadSessionPayload {
            id: "thread-1".to_string(),
            workspace_id: "workspace-1".to_string(),
            title: None,
            status: "active".to_string(),
            created_at: Some("2026-05-31T00:00:00.000Z".to_string()),
            updated_at: Some("2026-05-31T00:00:00.000Z".to_string()),
            base_commit_sha: None,
            first_message_id: None,
            parent_thread_id: None,
            source: "user".to_string(),
            anchor_node_id: None,
        })
        .expect("thread session");

        db.upsert_local_node(
            "user-1",
            "workspace-1",
            r#"{"id":"user-1","workspaceId":"workspace-1","role":"user","content":"Please fix thread names","threadId":"thread-1","thread_id":"thread-1","createdAt":"2026-05-31T00:00:01.000Z","updatedAt":"2026-05-31T00:00:01.000Z"}"#,
        )
        .expect("user node");
        db.upsert_local_node(
            "assistant-1",
            "workspace-1",
            r#"{"id":"assistant-1","workspaceId":"workspace-1","role":"assistant","parentId":"user-1","content":"Done","threadId":"thread-1","thread_id":"thread-1","aiLabel":"Implemented persistence fix","execution_data":{"meta":{"ai_label":"Implemented persistence fix","thread_title":"Thread Naming Bug"}},"createdAt":"2026-05-31T00:00:02.000Z","updatedAt":"2026-05-31T00:00:02.000Z"}"#,
        )
        .expect("assistant node");

        let sessions = db
            .list_thread_sessions_for_workspace("workspace-1")
            .expect("thread sessions");
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].first_message_id.as_deref(), Some("user-1"));
        assert_eq!(sessions[0].title.as_deref(), Some("Thread Naming Bug"));
    }

    #[test]
    fn final_assistant_snapshot_without_thread_id_preserves_thread_and_names_session() {
        let (_dir, db) = open_test_db();
        db.upsert_thread_session(ThreadSessionPayload {
            id: "thread-1".to_string(),
            workspace_id: "workspace-1".to_string(),
            title: None,
            status: "active".to_string(),
            created_at: Some("2026-05-31T00:00:00.000Z".to_string()),
            updated_at: Some("2026-05-31T00:00:00.000Z".to_string()),
            base_commit_sha: None,
            first_message_id: None,
            parent_thread_id: None,
            source: "user".to_string(),
            anchor_node_id: None,
        })
        .expect("thread session");

        db.upsert_local_node(
            "user-1",
            "workspace-1",
            r#"{"id":"user-1","workspaceId":"workspace-1","role":"user","content":"Please fix thread names","threadId":"thread-1","createdAt":"2026-05-31T00:00:01.000Z","updatedAt":"2026-05-31T00:00:01.000Z"}"#,
        )
        .expect("user node");
        db.upsert_local_node(
            "assistant-1",
            "workspace-1",
            r#"{"id":"assistant-1","workspaceId":"workspace-1","role":"assistant","parentId":"user-1","content":"","status":"pending","threadId":"thread-1","createdAt":"2026-05-31T00:00:02.000Z","updatedAt":"2026-05-31T00:00:02.000Z"}"#,
        )
        .expect("assistant placeholder");
        db.upsert_local_node(
            "assistant-1",
            "workspace-1",
            r#"{"id":"assistant-1","workspaceId":"workspace-1","role":"assistant","parentId":"user-1","content":"Done","status":"completed","execution_data":{"meta":{"thread_title":"Thread Naming Bug"}},"updatedAt":"2026-05-31T00:00:03.000Z"}"#,
        )
        .expect("assistant final snapshot");

        let sessions = db
            .list_thread_sessions_for_workspace("workspace-1")
            .expect("thread sessions");
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].first_message_id.as_deref(), Some("user-1"));
        assert_eq!(sessions[0].title.as_deref(), Some("Thread Naming Bug"));

        let payload = db
            .get_local_node_payload("assistant-1")
            .expect("payload read")
            .expect("assistant payload");
        let value: serde_json::Value = serde_json::from_str(&payload).expect("payload json");
        assert_eq!(value.get("threadId").and_then(|value| value.as_str()), None);
        let rows = db
            .list_local_nodes_for_workspace("workspace-1")
            .expect("local nodes");
        let assistant = rows
            .iter()
            .find(|row| row.node_id == "assistant-1")
            .expect("assistant row");
        let assistant_message: serde_json::Value =
            serde_json::from_str(&assistant.payload).expect("assistant payload json");
        assert_eq!(
            assistant_message
                .get("threadId")
                .and_then(|value| value.as_str()),
            Some("thread-1")
        );
    }

    fn run_test_git(repo_path: &std::path::Path, args: &[&str]) -> String {
        let output = std::process::Command::new("git")
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

    fn init_test_repo_with_commits(count: usize) -> (tempfile::TempDir, Vec<String>) {
        let dir = tempfile::tempdir().expect("repo tempdir");
        run_test_git(dir.path(), &["init"]);
        run_test_git(dir.path(), &["config", "user.name", "Agentree Test"]);
        run_test_git(
            dir.path(),
            &["config", "user.email", "agentree@example.com"],
        );

        let mut shas = Vec::new();
        for index in 0..count {
            std::fs::write(dir.path().join("file.txt"), format!("commit {index}\n"))
                .expect("write test file");
            run_test_git(dir.path(), &["add", "file.txt"]);
            run_test_git(dir.path(), &["commit", "-m", &format!("commit {index}")]);
            shas.push(run_test_git(dir.path(), &["rev-parse", "HEAD"]));
        }
        (dir, shas)
    }

    fn upsert_run(db: &TelemetryDb, assistant_node_id: &str, status: &str, phase: &str) {
        db.upsert_agent_run_ledger(&AgentRunLedgerUpsert {
            run_id: format!("run-{assistant_node_id}"),
            user_node_id: Some(format!("user-{assistant_node_id}")),
            assistant_node_id: assistant_node_id.to_string(),
            workspace_id: Some("workspace-1".to_string()),
            repo_path: Some("/tmp/repo".to_string()),
            worktree_path: Some(format!("/tmp/repo/.agentree/worktrees/{assistant_node_id}")),
            branch_name: Some(format!("agentree/{assistant_node_id}")),
            parent_commit: Some("parent-sha".to_string()),
            pid: Some(1234),
            agent_type: Some("codex".to_string()),
            status: status.to_string(),
            phase: phase.to_string(),
            login_profile_id: None,
        })
        .expect("upsert run");
    }

    fn upsert_login_profile_for_test(db: &TelemetryDb, profile_id: &str) {
        let profile = crate::login_profiles::LoginProfile {
            id: profile_id.to_string(),
            provider: "codex".to_string(),
            display_name: "Codex".to_string(),
            auth_type: "codex_chatgpt_session".to_string(),
            redacted_hint: None,
            config: serde_json::json!({}),
            status: "ready".to_string(),
            status_message: None,
            plan_type: None,
            is_default: true,
            created_at: 1,
            updated_at: 1,
            last_checked_at: None,
        };
        db.upsert_login_profile_metadata(&profile, None)
            .expect("upsert login profile");
    }

    fn upsert_run_for_profile(
        db: &TelemetryDb,
        assistant_node_id: &str,
        status: &str,
        phase: &str,
        profile_id: &str,
    ) {
        db.upsert_agent_run_ledger(&AgentRunLedgerUpsert {
            run_id: format!("run-{assistant_node_id}"),
            user_node_id: Some(format!("user-{assistant_node_id}")),
            assistant_node_id: assistant_node_id.to_string(),
            workspace_id: Some("workspace-1".to_string()),
            repo_path: Some("/tmp/repo".to_string()),
            worktree_path: Some(format!("/tmp/repo/.agentree/worktrees/{assistant_node_id}")),
            branch_name: Some(format!("agentree/{assistant_node_id}")),
            parent_commit: Some("parent-sha".to_string()),
            pid: Some(1234),
            agent_type: Some("codex".to_string()),
            status: status.to_string(),
            phase: phase.to_string(),
            login_profile_id: Some(profile_id.to_string()),
        })
        .expect("upsert run");
    }

    #[test]
    fn recovery_login_profile_runs_do_not_count_as_active() {
        let (_dir, db) = open_test_db();
        upsert_run_for_profile(
            &db,
            "assistant-needs-action",
            "needs_user_action",
            "needs_user_action",
            "profile-codex",
        );

        let active_runs = db.list_active_login_profile_runs().expect("active runs");
        assert!(active_runs.is_empty());
    }

    #[test]
    fn delete_login_profile_allows_recovery_runs_but_blocks_running_runs() {
        let (_dir, db) = open_test_db();
        upsert_login_profile_for_test(&db, "profile-recovery");
        upsert_run_for_profile(
            &db,
            "assistant-recovery",
            "needs_user_action",
            "needs_user_action",
            "profile-recovery",
        );
        db.delete_login_profile_metadata("profile-recovery")
            .expect("recovery run should not block profile deletion");

        upsert_login_profile_for_test(&db, "profile-running");
        upsert_run_for_profile(
            &db,
            "assistant-running",
            "running",
            "running",
            "profile-running",
        );
        let error = db
            .delete_login_profile_metadata("profile-running")
            .expect_err("running run should block profile deletion");
        assert!(error.contains("active run"));
    }

    #[test]
    fn local_commit_graph_round_trips_imported_commits() {
        let (_dir, db) = open_test_db();
        db.import_local_commits(
            "workspace-1",
            vec![LocalCommitImport {
                sha: "child-sha".to_string(),
                parents: vec!["parent-sha".to_string()],
                subject: Some("local commit".to_string()),
                author_name: Some("Agentree".to_string()),
                author_email: None,
                authored_at: Some("2026-05-11T00:00:00.000Z".to_string()),
                committed_at: Some("2026-05-11T00:00:01.000Z".to_string()),
                source_kind: Some("agent".to_string()),
                produced_by_node_id: Some("assistant-1".to_string()),
                files_changed_count: Some(2),
                total_additions: Some(3),
                total_deletions: Some(1),
            }],
            Some("agentree/assistant-1"),
        )
        .expect("import local commits");

        let snapshot = db
            .list_local_commit_graph("workspace-1")
            .expect("list local commit graph");
        assert_eq!(snapshot.commits.len(), 1);
        assert_eq!(snapshot.commits[0].sha, "child-sha");
        assert_eq!(
            snapshot.commits[0].produced_by_node_id.as_deref(),
            Some("assistant-1")
        );
        assert_eq!(snapshot.commit_parents.len(), 1);
        assert_eq!(snapshot.commit_parents[0].parent_sha, "parent-sha");
        assert_eq!(snapshot.commit_observations.len(), 1);
        assert_eq!(
            snapshot.commit_observations[0].git_ref.as_deref(),
            Some("agentree/assistant-1")
        );
    }

    #[test]
    fn local_commit_import_fills_but_does_not_steal_produced_by_node_id() {
        fn commit_import(
            source_kind: &str,
            produced_by_node_id: Option<&str>,
        ) -> LocalCommitImport {
            LocalCommitImport {
                sha: "generated-sha".to_string(),
                parents: vec!["parent-sha".to_string()],
                subject: Some("generated commit".to_string()),
                author_name: None,
                author_email: None,
                authored_at: None,
                committed_at: None,
                source_kind: Some(source_kind.to_string()),
                produced_by_node_id: produced_by_node_id.map(ToString::to_string),
                files_changed_count: None,
                total_additions: None,
                total_deletions: None,
            }
        }

        let (_dir, db) = open_test_db();
        db.import_local_commits(
            "workspace-1",
            vec![commit_import("external", None)],
            Some("refs/heads/main"),
        )
        .expect("seed external commit");

        db.import_local_commits(
            "workspace-1",
            vec![commit_import("agent", Some("assistant-1"))],
            Some("agentree/assistant-1"),
        )
        .expect("attribute external commit to assistant");

        let snapshot = db
            .list_local_commit_graph("workspace-1")
            .expect("list local commit graph after attribution");
        let commit = snapshot
            .commits
            .iter()
            .find(|commit| commit.sha == "generated-sha")
            .expect("generated commit exists");
        assert_eq!(commit.source_kind, "agent");
        assert_eq!(commit.produced_by_node_id.as_deref(), Some("assistant-1"));

        db.import_local_commits(
            "workspace-1",
            vec![commit_import("agent", Some("assistant-2"))],
            Some("agentree/assistant-2"),
        )
        .expect("attempt to reattribute generated commit");
        db.import_local_commits(
            "workspace-1",
            vec![commit_import("external", None)],
            Some("refs/heads/main"),
        )
        .expect("attempt to downgrade generated commit");

        let snapshot = db
            .list_local_commit_graph("workspace-1")
            .expect("list local commit graph after reimports");
        let commit = snapshot
            .commits
            .iter()
            .find(|commit| commit.sha == "generated-sha")
            .expect("generated commit exists");
        assert_eq!(commit.source_kind, "agent");
        assert_eq!(commit.produced_by_node_id.as_deref(), Some("assistant-1"));
    }

    #[test]
    fn local_commit_import_materializes_missing_parent_closure_to_existing_graph() {
        let (_db_dir, db) = open_test_db();
        let (repo_dir, shas) = init_test_repo_with_commits(3);
        let root = shas[0].clone();
        let middle = shas[1].clone();
        let tip = shas[2].clone();

        db.import_local_commits(
            "workspace-1",
            vec![LocalCommitImport {
                sha: root.clone(),
                parents: Vec::new(),
                subject: Some("commit 0".to_string()),
                author_name: None,
                author_email: None,
                authored_at: None,
                committed_at: None,
                source_kind: Some("external".to_string()),
                produced_by_node_id: None,
                files_changed_count: None,
                total_additions: None,
                total_deletions: None,
            }],
            Some("refs/heads/main"),
        )
        .expect("seed root commit");

        db.import_local_commits_with_parent_closure(
            "workspace-1",
            vec![LocalCommitImport {
                sha: tip.clone(),
                parents: vec![middle.clone()],
                subject: Some("commit 2".to_string()),
                author_name: None,
                author_email: None,
                authored_at: None,
                committed_at: None,
                source_kind: Some("external".to_string()),
                produced_by_node_id: None,
                files_changed_count: None,
                total_additions: None,
                total_deletions: None,
            }],
            Some("refs/heads/main"),
            Some(repo_dir.path().to_string_lossy().as_ref()),
        )
        .expect("import tip with closure");

        let snapshot = db
            .list_local_commit_graph("workspace-1")
            .expect("list local graph");
        let commit_shas = snapshot
            .commits
            .iter()
            .map(|commit| commit.sha.as_str())
            .collect::<HashSet<_>>();
        assert!(commit_shas.contains(root.as_str()));
        assert!(commit_shas.contains(middle.as_str()));
        assert!(commit_shas.contains(tip.as_str()));
        assert!(snapshot
            .commit_parents
            .iter()
            .any(|parent| parent.child_sha == middle && parent.parent_sha == root));
        assert!(snapshot
            .commit_parents
            .iter()
            .any(|parent| parent.child_sha == tip && parent.parent_sha == middle));
    }

    #[test]
    fn local_commit_import_prunes_unmaterialized_boundary_parent_edges() {
        let (_db_dir, db) = open_test_db();
        let (repo_dir, shas) = init_test_repo_with_commits(2);
        let root = shas[0].clone();
        let tip = shas[1].clone();

        db.import_local_commits_with_parent_closure(
            "workspace-1",
            vec![LocalCommitImport {
                sha: tip.clone(),
                parents: vec![root.clone()],
                subject: Some("commit 1".to_string()),
                author_name: None,
                author_email: None,
                authored_at: None,
                committed_at: None,
                source_kind: Some("external".to_string()),
                produced_by_node_id: None,
                files_changed_count: None,
                total_additions: None,
                total_deletions: None,
            }],
            Some("refs/heads/main"),
            Some(repo_dir.path().to_string_lossy().as_ref()),
        )
        .expect("import bounded tip");

        let snapshot = db
            .list_local_commit_graph("workspace-1")
            .expect("list local graph");
        assert_eq!(snapshot.commits.len(), 1);
        assert_eq!(snapshot.commits[0].sha, tip);
        assert!(snapshot.commit_parents.is_empty());
    }

    #[test]
    fn local_commit_graph_repair_materializes_existing_dangling_parent_edges() {
        let (_db_dir, db) = open_test_db();
        let (repo_dir, shas) = init_test_repo_with_commits(3);
        let root = shas[0].clone();
        let middle = shas[1].clone();
        let tip = shas[2].clone();

        db.import_local_commits(
            "workspace-1",
            vec![
                LocalCommitImport {
                    sha: root.clone(),
                    parents: Vec::new(),
                    subject: Some("commit 0".to_string()),
                    author_name: None,
                    author_email: None,
                    authored_at: None,
                    committed_at: None,
                    source_kind: Some("external".to_string()),
                    produced_by_node_id: None,
                    files_changed_count: None,
                    total_additions: None,
                    total_deletions: None,
                },
                LocalCommitImport {
                    sha: tip.clone(),
                    parents: vec![middle.clone()],
                    subject: Some("commit 2".to_string()),
                    author_name: None,
                    author_email: None,
                    authored_at: None,
                    committed_at: None,
                    source_kind: Some("external".to_string()),
                    produced_by_node_id: None,
                    files_changed_count: None,
                    total_additions: None,
                    total_deletions: None,
                },
            ],
            Some("refs/heads/main"),
        )
        .expect("seed graph with dangling parent");

        let repaired = db
            .repair_local_commit_parent_closure(
                "workspace-1",
                repo_dir.path().to_string_lossy().as_ref(),
                Some("refs/heads/main"),
            )
            .expect("repair graph");
        assert_eq!(repaired, 1);

        let snapshot = db
            .list_local_commit_graph("workspace-1")
            .expect("list local graph");
        assert!(snapshot.commits.iter().any(|commit| commit.sha == middle));
        assert!(snapshot
            .commit_parents
            .iter()
            .any(|parent| parent.child_sha == middle && parent.parent_sha == root));
        assert!(snapshot
            .commit_parents
            .iter()
            .any(|parent| parent.child_sha == tip && parent.parent_sha == middle));
    }

    #[test]
    fn local_commit_import_preserves_merge_parent_edges_across_sparse_ref_sync() {
        let (_db_dir, db) = open_test_db();

        db.import_local_commits(
            "workspace-1",
            vec![LocalCommitImport {
                sha: "merge-sha".to_string(),
                parents: vec!["target-sha".to_string(), "source-sha".to_string()],
                subject: Some("Merge source into target".to_string()),
                author_name: Some("Agentree".to_string()),
                author_email: None,
                authored_at: Some("2026-05-20T00:00:00.000Z".to_string()),
                committed_at: Some("2026-05-20T00:00:00.000Z".to_string()),
                source_kind: Some("merge".to_string()),
                produced_by_node_id: Some("merge-result-node".to_string()),
                files_changed_count: Some(2),
                total_additions: Some(29),
                total_deletions: Some(2),
            }],
            None,
        )
        .expect("seed merge commit");

        db.import_local_commits(
            "workspace-1",
            vec![LocalCommitImport {
                sha: "merge-sha".to_string(),
                parents: Vec::new(),
                subject: Some("Merge source into target".to_string()),
                author_name: None,
                author_email: None,
                authored_at: None,
                committed_at: None,
                source_kind: Some("external".to_string()),
                produced_by_node_id: None,
                files_changed_count: None,
                total_additions: None,
                total_deletions: None,
            }],
            Some("refs/heads/main"),
        )
        .expect("sparse ref sync");

        let snapshot = db
            .list_local_commit_graph("workspace-1")
            .expect("list local graph");
        let commit = snapshot
            .commits
            .iter()
            .find(|commit| commit.sha == "merge-sha")
            .expect("merge commit");
        assert_eq!(commit.source_kind, "merge");
        assert_eq!(
            commit.produced_by_node_id.as_deref(),
            Some("merge-result-node")
        );
        assert_eq!(snapshot.commit_parents.len(), 2);
        assert!(snapshot
            .commit_parents
            .iter()
            .any(|parent| parent.child_sha == "merge-sha"
                && parent.parent_sha == "target-sha"
                && parent.parent_index == 0));
        assert!(snapshot
            .commit_parents
            .iter()
            .any(|parent| parent.child_sha == "merge-sha"
                && parent.parent_sha == "source-sha"
                && parent.parent_index == 1));
    }

    #[test]
    fn startup_recovery_preserves_server_finalized_terminal_run() {
        let (_dir, db) = open_test_db();
        upsert_run(
            &db,
            "assistant-final",
            "persisting_final",
            "persisting_final",
        );
        db.mark_agent_run_finalized("assistant-final", "completed", true, Some("commit-sha"))
            .expect("mark finalized");

        db.reconcile_agent_runs_on_startup().expect("reconcile");
        let row = db
            .get_agent_run_ledger_by_assistant("assistant-final")
            .expect("get row")
            .expect("row");
        assert_eq!(row.status, "completed");
        assert_eq!(row.phase, "terminal");
        assert!(row.server_final_persisted);
        assert_eq!(row.needs_user_action_reason, None);
    }

    #[test]
    fn successful_finalization_clears_stale_recovery_failure_reason() {
        let (_dir, db) = open_test_db();
        upsert_run(&db, "assistant-recovered", "running", "running");

        db.reconcile_agent_runs_on_startup().expect("reconcile");
        let recovered = db
            .get_agent_run_ledger_by_assistant("assistant-recovered")
            .expect("get recovered row")
            .expect("recovered row");
        assert!(recovered
            .failure_reason
            .as_deref()
            .unwrap_or("")
            .contains("App restarted before the native run reached a terminal state"));

        db.mark_agent_run_finalized("assistant-recovered", "completed", true, Some("commit-sha"))
            .expect("mark finalized");

        let row = db
            .get_agent_run_ledger_by_assistant("assistant-recovered")
            .expect("get row")
            .expect("row");
        assert_eq!(row.status, "completed");
        assert_eq!(row.failure_reason, None);
        assert_eq!(row.needs_user_action_reason, None);
    }

    #[test]
    fn startup_resume_candidates_include_prior_restart_fallback_rows() {
        let (_dir, db) = open_test_db();
        db.upsert_agent_run_ledger(&AgentRunLedgerUpsert {
            run_id: "run-resume".to_string(),
            user_node_id: Some("user-resume".to_string()),
            assistant_node_id: "assistant-resume".to_string(),
            workspace_id: Some("workspace-1".to_string()),
            repo_path: Some("/tmp/repo".to_string()),
            worktree_path: Some("/tmp/repo/.agentree/worktrees/assistant-resume".to_string()),
            branch_name: Some("agentree/assistant-resume".to_string()),
            parent_commit: Some("parent-sha".to_string()),
            pid: Some(1234),
            agent_type: Some("codex".to_string()),
            status: "needs_user_action".to_string(),
            phase: "needs_user_action".to_string(),
            login_profile_id: Some("profile-1".to_string()),
        })
        .expect("upsert run");
        db.mark_agent_run_needs_user_action(
            "assistant-resume",
            "App restarted before this run reached a terminal state. The agent worktree is preserved for inspection; automatic process reattach is not available.",
        )
        .expect("mark needs action");

        let candidates = db
            .list_startup_resume_candidates()
            .expect("list resume candidates");
        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].assistant_node_id, "assistant-resume");

        db.mark_agent_run_startup_resuming("assistant-resume")
            .expect("mark resuming");
        let row = db
            .get_agent_run_ledger_by_assistant("assistant-resume")
            .expect("get row")
            .expect("row");
        assert_eq!(row.status, "running");
        assert_eq!(row.phase, "resuming_provider_thread");
        assert_eq!(row.needs_user_action_reason, None);
    }

    #[test]
    fn failed_finalization_preserves_real_failure_reason() {
        let (_dir, db) = open_test_db();
        upsert_run(&db, "assistant-setup-failed", "running", "running");
        db.update_agent_run_phase(
            "assistant-setup-failed",
            "failed",
            "terminal",
            Some("setup failed before process launch"),
        )
        .expect("record setup failure");

        db.mark_agent_run_finalized("assistant-setup-failed", "failed", true, None)
            .expect("mark finalized");

        let row = db
            .get_agent_run_ledger_by_assistant("assistant-setup-failed")
            .expect("get row")
            .expect("row");
        assert_eq!(row.status, "failed");
        assert_eq!(
            row.failure_reason.as_deref(),
            Some("setup failed before process launch")
        );
    }

    #[test]
    fn server_finalization_preserves_cleaned_phase() {
        let (_dir, db) = open_test_db();
        upsert_run(&db, "assistant-cleaned", "completed", "terminal");
        db.mark_agent_run_cleanup_completed("assistant-cleaned")
            .expect("mark cleanup");
        db.mark_agent_run_finalized("assistant-cleaned", "completed", true, Some("commit-sha"))
            .expect("mark finalized");

        let row = db
            .get_agent_run_ledger_by_assistant("assistant-cleaned")
            .expect("get row")
            .expect("row");
        assert_eq!(row.status, "completed");
        assert_eq!(row.phase, "cleaned");
        assert!(row.server_final_persisted);
        assert!(row.cleanup_completed);
    }

    #[test]
    fn startup_recovery_classifies_local_commit_without_server_finalization() {
        let (_dir, db) = open_test_db();
        upsert_run(
            &db,
            "assistant-commit",
            "persisting_final",
            "persisting_final",
        );
        db.record_agent_run_output_commit("assistant-commit", "commit-sha")
            .expect("record commit");

        db.reconcile_agent_runs_on_startup().expect("reconcile");
        let row = db
            .get_agent_run_ledger_by_assistant("assistant-commit")
            .expect("get row")
            .expect("row");
        assert_eq!(row.status, "failed_finalization");
        assert_eq!(row.phase, "failed_finalization");
        assert_eq!(row.output_commit_sha.as_deref(), Some("commit-sha"));
        assert!(row
            .needs_user_action_reason
            .as_deref()
            .unwrap_or("")
            .contains("server finalization"));
    }

    #[test]
    fn startup_recovery_preserves_retryable_local_finalization() {
        let (_dir, db) = open_test_db();
        upsert_run(
            &db,
            "assistant-retry",
            "persisting_final",
            "persisting_final",
        );
        db.mark_agent_run_finalized("assistant-retry", "completed", false, Some("commit-sha"))
            .expect("mark local finalized");
        db.enqueue_local_sync_event(
            Some("workspace-1"),
            "node",
            "assistant-retry",
            "node.update_terminal",
            r#"{"nodeId":"assistant-retry","runId":"run-assistant-retry","status":"completed","outputCommitSha":"commit-sha"}"#,
            Some("run-assistant-retry"),
        )
        .expect("enqueue retry");

        db.reconcile_agent_runs_on_startup().expect("reconcile");
        let row = db
            .get_agent_run_ledger_by_assistant("assistant-retry")
            .expect("get row")
            .expect("row");
        assert_eq!(row.status, "completed");
        assert_eq!(row.phase, "terminal");
        assert!(!row.server_final_persisted);
        assert_eq!(row.needs_user_action_reason, None);
    }

    #[test]
    fn startup_recovery_treats_local_only_completed_run_as_durable() {
        let (_dir, db) = open_test_db();
        {
            let conn = db.conn.lock().expect("lock db");
            conn.execute(
                r#"
                INSERT INTO local_workspaces (
                    id, name, folder_path, repo_path, base_commit_sha,
                    created_at, updated_at, local_updated_at, cloud_backup_enabled
                )
                VALUES (
                    'workspace-1', 'Local Workspace', '/tmp/repo', '/tmp/repo',
                    'parent-sha', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z',
                    1, 0
                )
                "#,
                [],
            )
            .expect("insert local workspace");
        }
        upsert_run(
            &db,
            "assistant-local-only",
            "needs_user_action",
            "needs_user_action",
        );
        db.mark_agent_run_finalized(
            "assistant-local-only",
            "completed",
            false,
            Some("commit-sha"),
        )
        .expect("mark local finalized");
        db.mark_agent_run_needs_user_action(
            "assistant-local-only",
            "Cleanup blocked because completed run is not durably finalized on the server.",
        )
        .expect("mark user action");
        db.append_agent_run_event(
            "run-assistant-local-only",
            "assistant-local-only",
            "provider_stop",
            Some("completed"),
            None,
            r#"{"type":"provider_stop","provider_status":"completed","final_content":"Implemented local-only run."}"#,
        )
        .expect("append final event");
        db.upsert_local_node(
            "assistant-local-only",
            "workspace-1",
            r#"{
                "id":"assistant-local-only",
                "workspaceId":"workspace-1",
                "role":"assistant",
                "parentId":"user-assistant-local-only",
                "content":"",
                "status":"failed",
                "execution_data":{
                    "last_terminal_status":"failed",
                    "meta":{
                        "native_recovery_status":"needs_user_action",
                        "native_recovery_phase":"needs_user_action",
                        "provider_error_message":"Cleanup blocked because completed run is not durably finalized on the server.",
                        "needs_user_action_reason":"Cleanup blocked because completed run is not durably finalized on the server.",
                        "failure_reason":null
                    }
                }
            }"#,
        )
        .expect("upsert stale failed node");
        upsert_run(
            &db,
            "assistant-local-only-no-commit",
            "needs_user_action",
            "needs_user_action",
        );
        db.mark_agent_run_finalized("assistant-local-only-no-commit", "completed", false, None)
            .expect("mark local no-commit finalized");
        db.mark_agent_run_needs_user_action(
            "assistant-local-only-no-commit",
            "Cleanup blocked because completed run is not durably finalized on the server.",
        )
        .expect("mark no-commit user action");
        db.append_agent_run_event(
            "run-assistant-local-only-no-commit",
            "assistant-local-only-no-commit",
            "provider_stop",
            Some("completed"),
            None,
            r#"{"type":"provider_stop","provider_status":"completed","final_content":"Review failed, but the run completed."}"#,
        )
        .expect("append no-commit final event");
        db.upsert_local_node(
            "assistant-local-only-no-commit",
            "workspace-1",
            r#"{
                "id":"assistant-local-only-no-commit",
                "workspaceId":"workspace-1",
                "role":"assistant",
                "parentId":"user-assistant-local-only-no-commit",
                "content":"",
                "status":"failed",
                "execution_data":{
                    "last_terminal_status":"failed",
                    "meta":{
                        "native_recovery_status":"needs_user_action",
                        "native_recovery_phase":"needs_user_action",
                        "provider_error_message":"Cleanup blocked because completed run is not durably finalized on the server.",
                        "needs_user_action_reason":"Cleanup blocked because completed run is not durably finalized on the server.",
                        "failure_reason":null
                    }
                }
            }"#,
        )
        .expect("upsert stale no-commit failed node");

        db.reconcile_agent_runs_on_startup().expect("reconcile");
        let row = db
            .get_agent_run_ledger_by_assistant("assistant-local-only")
            .expect("get row")
            .expect("row");
        assert_eq!(row.status, "completed");
        assert_eq!(row.phase, "terminal");
        assert!(row.server_final_persisted);
        assert_eq!(row.failure_reason, None);
        assert_eq!(row.needs_user_action_reason, None);

        let local_nodes = db
            .list_local_nodes_for_workspace("workspace-1")
            .expect("list local nodes");
        let node = local_nodes
            .iter()
            .find(|node| node.node_id == "assistant-local-only")
            .expect("local node");
        let payload: JsonValue = serde_json::from_str(&node.payload).expect("payload json");
        assert_eq!(payload["status"], "completed");
        assert_eq!(payload["content"], "Implemented local-only run.");
        assert_eq!(
            payload["execution_data"]["last_terminal_status"],
            "completed"
        );
        assert_eq!(
            payload["execution_data"]["meta"].get("native_recovery_status"),
            None
        );
        let no_commit_row = db
            .get_agent_run_ledger_by_assistant("assistant-local-only-no-commit")
            .expect("get no-commit row")
            .expect("no-commit row");
        assert_eq!(no_commit_row.status, "completed");
        assert_eq!(no_commit_row.phase, "terminal");
        assert!(no_commit_row.server_final_persisted);
        assert_eq!(no_commit_row.output_commit_sha, None);
        assert_eq!(no_commit_row.needs_user_action_reason, None);

        let no_commit_node = local_nodes
            .iter()
            .find(|node| node.node_id == "assistant-local-only-no-commit")
            .expect("no-commit local node");
        let no_commit_payload: JsonValue =
            serde_json::from_str(&no_commit_node.payload).expect("no-commit payload json");
        assert_eq!(no_commit_payload["status"], "completed");
        assert_eq!(
            no_commit_payload["content"],
            "Review failed, but the run completed."
        );
        assert_eq!(
            no_commit_payload["execution_data"]["last_terminal_status"],
            "completed"
        );
        assert_eq!(
            no_commit_payload["execution_data"]["meta"].get("native_recovery_status"),
            None
        );
    }

    #[test]
    fn startup_recovery_preserves_worktree_for_unfinished_run() {
        let (_dir, db) = open_test_db();
        upsert_run(&db, "assistant-running", "running", "running");

        db.reconcile_agent_runs_on_startup().expect("reconcile");
        let row = db
            .get_agent_run_ledger_by_assistant("assistant-running")
            .expect("get row")
            .expect("row");
        assert_eq!(row.status, "needs_user_action");
        assert_eq!(row.phase, "needs_user_action");
        assert!(row
            .needs_user_action_reason
            .as_deref()
            .unwrap_or("")
            .contains("worktree is preserved"));
    }

    #[test]
    fn local_nodes_include_recovered_unfinished_runs() {
        let (_dir, db) = open_test_db();
        upsert_run(&db, "assistant-running", "running", "running");

        db.reconcile_agent_runs_on_startup().expect("reconcile");
        let rows = db
            .list_local_nodes_for_workspace("workspace-1")
            .expect("local nodes");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].node_id, "assistant-running");
        assert_eq!(rows[0].sync_status, "local_only");
        let payload: serde_json::Value =
            serde_json::from_str(&rows[0].payload).expect("payload json");
        assert_eq!(payload["status"], "failed");
        assert_eq!(
            payload["execution_data"]["meta"]["native_recovery_status"],
            "needs_user_action"
        );
    }

    #[test]
    fn startup_recovery_marks_stale_prelaunch_local_nodes_failed_setup() {
        let (_dir, db) = open_test_db();
        db.upsert_local_node(
            "assistant-prelaunch",
            "workspace-1",
            r#"{"id":"assistant-prelaunch","workspaceId":"workspace-1","role":"assistant","content":"","status":"pending","execution_data":{"meta":{}}}"#,
        )
        .expect("prelaunch local node");

        let updated = db
            .reconcile_stale_prelaunch_local_nodes(0, "startup")
            .expect("reconcile prelaunch nodes");
        assert_eq!(updated, 1);
        assert!(db
            .get_agent_run_ledger_by_assistant("assistant-prelaunch")
            .expect("ledger lookup")
            .is_none());

        let rows = db
            .list_local_nodes_for_workspace("workspace-1")
            .expect("local nodes");
        assert_eq!(rows.len(), 1);
        let payload: serde_json::Value =
            serde_json::from_str(&rows[0].payload).expect("payload json");
        assert_eq!(payload["status"], "failed_setup");
        assert_eq!(
            payload["execution_data"]["last_terminal_status"],
            "failed_setup"
        );
        assert_eq!(
            payload["execution_data"]["meta"]["native_recovery_status"],
            "failed_setup"
        );
        assert_eq!(
            payload["execution_data"]["meta"]["native_recovery_trigger"],
            "startup"
        );
        assert!(payload["execution_data"]["meta"]["failure_reason"]
            .as_str()
            .unwrap_or("")
            .contains("App restarted"));
    }

    #[test]
    fn watchdog_recovery_reports_the_last_durable_prelaunch_boundary() {
        let (_dir, db) = open_test_db();
        db.upsert_local_node(
            "assistant-prelaunch",
            "workspace-1",
            r#"{"id":"assistant-prelaunch","workspaceId":"workspace-1","role":"assistant","content":"","status":"pending","execution_data":{"meta":{}}}"#,
        )
        .expect("prelaunch local node");
        db.record_agent_prelaunch_stage(
            "assistant-prelaunch",
            "run-prelaunch",
            "worktree_preview_started",
        )
        .expect("record prelaunch stage");

        let updated = db
            .reconcile_stale_prelaunch_local_nodes(0, "watchdog")
            .expect("reconcile prelaunch nodes");
        assert_eq!(updated, 1);

        let rows = db
            .list_local_nodes_for_workspace("workspace-1")
            .expect("local nodes");
        let payload: serde_json::Value =
            serde_json::from_str(&rows[0].payload).expect("payload json");
        assert_eq!(
            payload["execution_data"]["meta"]["native_recovery_trigger"],
            "watchdog"
        );
        assert_eq!(
            payload["execution_data"]["meta"]["prelaunch_run_id"],
            "run-prelaunch"
        );
        assert!(payload["execution_data"]["meta"]["failure_reason"]
            .as_str()
            .unwrap_or("")
            .contains("worktree_preview_started"));
        assert!(!payload["execution_data"]["meta"]["failure_reason"]
            .as_str()
            .unwrap_or("")
            .contains("App restarted"));
    }

    #[test]
    fn startup_recovery_marks_stale_quick_reply_placeholders_failed_setup() {
        let (_dir, db) = open_test_db();
        db.upsert_local_node(
            "assistant-quick-reply",
            "workspace-1",
            r#"{"id":"assistant-quick-reply","workspaceId":"workspace-1","role":"assistant","content":"","status":"pending","execution_data":{"meta":{"quick_reply":true}}}"#,
        )
        .expect("quick reply local node");

        let updated = db
            .reconcile_stale_prelaunch_local_nodes(0, "startup")
            .expect("reconcile prelaunch nodes");
        assert_eq!(updated, 1);
        assert!(db
            .get_agent_run_ledger_by_assistant("assistant-quick-reply")
            .expect("ledger lookup")
            .is_none());

        let rows = db
            .list_local_nodes_for_workspace("workspace-1")
            .expect("local nodes");
        assert_eq!(rows.len(), 1);
        let payload: serde_json::Value =
            serde_json::from_str(&rows[0].payload).expect("payload json");
        assert_eq!(payload["status"], "failed_setup");
        assert_eq!(
            payload["execution_data"]["last_terminal_status"],
            "failed_setup"
        );
        assert_eq!(
            payload["execution_data"]["meta"]["native_recovery_status"],
            "failed_setup"
        );
        assert_eq!(payload["execution_data"]["meta"]["quick_reply"], true);
    }

    #[test]
    fn startup_recovery_overrides_stale_server_running_local_node() {
        let (_dir, db) = open_test_db();
        upsert_run(&db, "assistant-running", "running", "running");
        db.upsert_local_node(
            "assistant-running",
            "workspace-1",
            r#"{"id":"assistant-running","workspaceId":"workspace-1","role":"assistant","content":"","status":"running"}"#,
        )
        .expect("stale server row");

        db.reconcile_agent_runs_on_startup().expect("reconcile");
        let rows = db
            .list_local_nodes_for_workspace("workspace-1")
            .expect("local nodes");
        assert_eq!(rows.len(), 1);
        let payload: serde_json::Value =
            serde_json::from_str(&rows[0].payload).expect("payload json");
        assert_eq!(payload["status"], "failed");
        assert_eq!(
            payload["execution_data"]["meta"]["native_recovery_status"],
            "needs_user_action"
        );

        let stale_server_payload = serde_json::json!({
            "id": "assistant-running",
            "workspaceId": "workspace-1",
            "role": "assistant",
            "content": "",
            "status": "running"
        });
        let hydrated = db
            .hydrate_local_nodes_from_server(
                "workspace-1",
                vec![serde_json::to_string(&stale_server_payload).expect("payload")],
            )
            .expect("hydrate");
        assert_eq!(hydrated, 0);
        let rows_after_hydrate = db
            .list_local_nodes_for_workspace("workspace-1")
            .expect("local nodes");
        let payload_after_hydrate: serde_json::Value =
            serde_json::from_str(&rows_after_hydrate[0].payload).expect("payload json");
        assert_eq!(payload_after_hydrate["status"], "failed");
    }

    #[test]
    fn server_hydration_preserves_full_payload_in_local_nodes() {
        let (_dir, db) = open_test_db();
        let server_payload = serde_json::json!({
            "id": "server-node-1",
            "workspaceId": "workspace-1",
            "role": "assistant",
            "content": "server content",
            "status": "completed",
            "aiLabel": "Preserved label",
            "execution_data": { "meta": { "run_id": "run-1" } },
            "createdAt": "2026-05-08T00:00:00Z",
            "updatedAt": "2026-05-08T00:00:01Z"
        });

        let hydrated = db
            .hydrate_local_nodes_from_server(
                "workspace-1",
                vec![serde_json::to_string(&server_payload).expect("payload")],
            )
            .expect("hydrate");
        assert_eq!(hydrated, 1);

        let rows = db
            .list_local_nodes_for_workspace("workspace-1")
            .expect("local nodes");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].server_ack_at.is_some(), true);
        let payload: serde_json::Value =
            serde_json::from_str(&rows[0].payload).expect("payload json");
        assert_eq!(payload["content"], "server content");
        assert_eq!(payload["aiLabel"], "Preserved label");
        assert_eq!(payload["execution_data"]["meta"]["run_id"], "run-1");
    }

    #[test]
    fn local_nodes_persist_controlled_by_as_first_class_relationship() {
        let (_dir, db) = open_test_db();
        db.upsert_local_node(
            "assistant-child",
            "workspace-1",
            r#"{"id":"assistant-child","workspaceId":"workspace-1","role":"assistant","parentId":"root-user","controlled_by_node_id":"assistant-orchestrator","content":"child","createdAt":"2026-05-08T00:00:00Z","updatedAt":"2026-05-08T00:00:01Z"}"#,
        )
        .expect("local upsert");

        let rows = db
            .list_local_nodes_for_workspace("workspace-1")
            .expect("local nodes");
        assert_eq!(rows.len(), 1);
        assert_eq!(
            rows[0].controlled_by_node_id.as_deref(),
            Some("assistant-orchestrator")
        );
        let payload: serde_json::Value =
            serde_json::from_str(&rows[0].payload).expect("payload json");
        assert_eq!(payload["controlled_by_node_id"], "assistant-orchestrator");
        assert_eq!(payload["controlledByNodeId"], "assistant-orchestrator");

        let controlled_count: i64 = db
            .conn
            .lock()
            .expect("lock db")
            .query_row(
                "SELECT COUNT(*) FROM local_nodes WHERE controlled_by_node_id = ?1",
                params!["assistant-orchestrator"],
                |row| row.get(0),
            )
            .expect("controlled_by query");
        assert_eq!(controlled_count, 1);
    }

    #[test]
    fn agent_control_edges_span_only_workspaces_accessible_to_the_user() {
        let (_dir, db) = open_test_db();
        {
            let conn = db.conn.lock().expect("lock db");
            for (workspace_id, user_id) in [
                ("workspace-parent", "user-1"),
                ("workspace-child", "user-1"),
                ("workspace-foreign", "user-2"),
            ] {
                conn.execute(
                    r#"
                    INSERT INTO local_workspaces (
                        id, user_id, name, connection_status, sync_status,
                        created_at, updated_at, local_updated_at, cloud_backup_enabled
                    ) VALUES (?1, ?2, ?1, 'connected', 'local_only',
                              '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 1, 0)
                    "#,
                    params![workspace_id, user_id],
                )
                .expect("insert workspace");
            }
        }
        for (node_id, workspace_id, controller_id) in [
            ("child", "workspace-parent", "root"),
            ("grandchild", "workspace-child", "child"),
            ("foreign-child", "workspace-foreign", "root"),
        ] {
            db.upsert_local_node(
                node_id,
                workspace_id,
                &serde_json::json!({
                    "id": node_id,
                    "workspaceId": workspace_id,
                    "role": "assistant",
                    "controlled_by_node_id": controller_id,
                    "content": ""
                })
                .to_string(),
            )
            .expect("upsert controlled assistant");
        }

        assert_eq!(
            db.list_local_agent_control_edges_for_user("user-1")
                .expect("control edges"),
            vec![
                ("child".to_string(), "root".to_string()),
                ("grandchild".to_string(), "child".to_string()),
            ]
        );
    }

    #[test]
    fn server_hydration_does_not_replace_existing_local_node() {
        let (_dir, db) = open_test_db();
        db.upsert_local_node(
            "assistant-with-commit",
            "workspace-1",
            r#"{"id":"assistant-with-commit","workspaceId":"workspace-1","role":"assistant","content":"local final","status":"completed","output_commit_sha":"local-commit-sha","execution_data":{"timeline":[{"type":"message","text":"local final"},{"type":"tool_use","name":"shell"},{"type":"tool_result","content":"ok"}]}}"#,
        )
        .expect("local upsert");

        let server_payload = serde_json::json!({
            "id": "assistant-with-commit",
            "workspaceId": "workspace-1",
            "role": "assistant",
            "content": "server final",
            "status": "completed",
            "output_commit_sha": null,
            "execution_data": { "timeline": [{ "type": "message", "text": "server final" }] },
            "createdAt": "2026-05-08T00:00:00Z",
            "updatedAt": "2026-05-08T00:00:01Z"
        });
        let hydrated = db
            .hydrate_local_nodes_from_server(
                "workspace-1",
                vec![serde_json::to_string(&server_payload).expect("payload")],
            )
            .expect("hydrate");
        assert_eq!(hydrated, 0);

        let rows = db
            .list_local_nodes_for_workspace("workspace-1")
            .expect("local nodes");
        let payload: serde_json::Value =
            serde_json::from_str(&rows[0].payload).expect("payload json");
        assert_eq!(payload["content"], "local final");
        assert_eq!(payload["output_commit_sha"], "local-commit-sha");
        assert_eq!(
            payload["execution_data"]["timeline"]
                .as_array()
                .expect("timeline")
                .len(),
            3
        );
    }

    #[test]
    fn local_node_upsert_preserves_existing_structured_timeline() {
        let (_dir, db) = open_test_db();
        db.upsert_local_node(
            "assistant-with-tools",
            "workspace-1",
            r#"{"id":"assistant-with-tools","workspaceId":"workspace-1","role":"assistant","content":"full","status":"completed","execution_data":{"timeline":[{"type":"message","content":"full"},{"type":"tool_use","toolName":"shell","toolUseId":"call-1"},{"type":"tool_result","toolUseId":"call-1","toolOutput":"ok"}]}}"#,
        )
        .expect("initial local upsert");

        db.upsert_local_node(
            "assistant-with-tools",
            "workspace-1",
            r#"{"id":"assistant-with-tools","workspaceId":"workspace-1","role":"assistant","content":"summary","status":"completed","execution_data":{"timeline":[{"type":"message","content":"summary"}]}}"#,
        )
        .expect("summary local upsert");

        let rows = db
            .list_local_nodes_for_workspace("workspace-1")
            .expect("local nodes");
        let payload: serde_json::Value =
            serde_json::from_str(&rows[0].payload).expect("payload json");
        let timeline = payload["execution_data"]["timeline"]
            .as_array()
            .expect("timeline");
        assert_eq!(timeline.len(), 3);
        assert_eq!(timeline[1]["type"], "tool_use");
        assert_eq!(timeline[2]["type"], "tool_result");
    }

    #[test]
    fn local_node_upsert_repairs_structured_timeline_from_agent_run_events() {
        let (_dir, db) = open_test_db();
        upsert_run(&db, "assistant-journal", "running", "running");
        db.append_agent_run_event(
            "run-assistant-journal",
            "assistant-journal",
            "thinking",
            None,
            None,
            r#"{"type":"thinking","content":"Reading ","is_delta":true,"timestamp":1778917767400}"#,
        )
        .expect("thinking delta 1");
        db.append_agent_run_event(
            "run-assistant-journal",
            "assistant-journal",
            "thinking",
            None,
            None,
            r#"{"type":"thinking","content":"files","isDelta":true,"timestamp":1778917767450}"#,
        )
        .expect("thinking delta 2");
        db.append_agent_run_event(
            "run-assistant-journal",
            "assistant-journal",
            "user_steer_requested",
            None,
            None,
            r#"{"type":"user_steer_requested","content":"please keep going","idempotency_key":"steer-1","timestamp":1778917767500}"#,
        )
        .expect("user steer");
        db.append_agent_run_event(
            "run-assistant-journal",
            "assistant-journal",
            "tool_use",
            None,
            None,
            r#"{"type":"tool_use","id":"call-1","name":"commandExecution","tool_input":{"command":"sed -n '1,20p' package.json"},"commandActions":[{"type":"read","path":"package.json"}],"timestamp":1778917768000}"#,
        )
        .expect("tool use");
        db.append_agent_run_event(
            "run-assistant-journal",
            "assistant-journal",
            "tool_output_delta",
            None,
            None,
            r#"{"type":"tool_output_delta","toolUseId":"call-1","delta":"partial ","timestamp":1778917768500}"#,
        )
        .expect("tool output delta");
        db.append_agent_run_event(
            "run-assistant-journal",
            "assistant-journal",
            "tool_result",
            None,
            None,
            r#"{"type":"tool_result","toolUseId":"call-1","toolName":"commandExecution","toolOutput":"{\"name\":\"agentree\"}","timestamp":1778917769000}"#,
        )
        .expect("tool result");

        db.upsert_local_node(
            "assistant-journal",
            "workspace-1",
            r#"{"id":"assistant-journal","workspaceId":"workspace-1","role":"assistant","content":"summary","status":"completed","execution_data":{"timeline":[{"type":"message","content":"summary"}]}}"#,
        )
        .expect("summary local upsert");

        let rows = db
            .list_local_nodes_for_workspace("workspace-1")
            .expect("local nodes");
        let payload: serde_json::Value =
            serde_json::from_str(&rows[0].payload).expect("payload json");
        let timeline = payload["execution_data"]["timeline"]
            .as_array()
            .expect("timeline");
        assert_eq!(timeline.len(), 6);
        assert_eq!(timeline[0]["type"], "message");
        assert_eq!(timeline[1]["type"], "thinking");
        assert_eq!(timeline[1]["content"], "Reading ");
        assert_eq!(timeline[1]["isDelta"], true);
        assert_eq!(timeline[2]["type"], "thinking");
        assert_eq!(timeline[2]["content"], "files");
        assert_eq!(timeline[2]["isDelta"], true);
        assert_eq!(timeline[3]["type"], "user_steer_requested");
        assert_eq!(timeline[3]["content"], "please keep going");
        assert_eq!(timeline[3]["idempotency_key"], "steer-1");
        assert_eq!(timeline[4]["type"], "tool_use");
        assert_eq!(timeline[4]["toolName"], "commandExecution");
        assert_eq!(timeline[4]["toolOutput"], "partial ");
        assert_eq!(timeline[5]["type"], "tool_result");
        assert_eq!(timeline[5]["toolOutput"], "{\"name\":\"agentree\"}");
    }

    #[test]
    fn local_node_upsert_preserves_existing_steer_only_timeline() {
        let (_dir, db) = open_test_db();
        db.upsert_local_node(
            "assistant-steer-only",
            "workspace-1",
            r#"{"id":"assistant-steer-only","workspaceId":"workspace-1","role":"assistant","content":"done","status":"completed","execution_data":{"timeline":[{"type":"message","content":"before steer"},{"type":"user_steer_requested","content":"please adjust","idempotency_key":"steer-only-1"},{"type":"message","content":"done"}]}}"#,
        )
        .expect("steer local upsert");

        let rows = db
            .list_local_nodes_for_workspace("workspace-1")
            .expect("local nodes");
        let payload: serde_json::Value =
            serde_json::from_str(&rows[0].payload).expect("payload json");
        let timeline = payload["execution_data"]["timeline"]
            .as_array()
            .expect("timeline");
        assert_eq!(timeline.len(), 3);
        assert_eq!(timeline[1]["type"], "user_steer_requested");
        assert_eq!(timeline[1]["content"], "please adjust");
        assert_eq!(timeline[1]["idempotency_key"], "steer-only-1");
    }

    #[test]
    fn local_node_upsert_repairs_journal_events_without_payload_type() {
        let (_dir, db) = open_test_db();
        upsert_run(&db, "assistant-journal-no-type", "running", "running");
        db.append_agent_run_event(
            "run-assistant-journal-no-type",
            "assistant-journal-no-type",
            "tool_use",
            None,
            None,
            r#"{"id":"call-1","name":"commandExecution","tool_input":{"command":"sed -n '1,20p' package.json"},"commandActions":[{"type":"read","path":"package.json"}],"timestamp":1778917768000}"#,
        )
        .expect("tool use");
        db.append_agent_run_event(
            "run-assistant-journal-no-type",
            "assistant-journal-no-type",
            "tool_result",
            None,
            None,
            r#"{"toolUseId":"call-1","toolName":"commandExecution","toolOutput":"ok","timestamp":1778917769000}"#,
        )
        .expect("tool result");

        db.upsert_local_node(
            "assistant-journal-no-type",
            "workspace-1",
            r#"{"id":"assistant-journal-no-type","workspaceId":"workspace-1","role":"assistant","content":"summary","status":"completed","execution_data":{"timeline":[{"type":"message","content":"summary"}]}}"#,
        )
        .expect("summary local upsert");

        let rows = db
            .list_local_nodes_for_workspace("workspace-1")
            .expect("local nodes");
        let payload: serde_json::Value =
            serde_json::from_str(&rows[0].payload).expect("payload json");
        let timeline = payload["execution_data"]["timeline"]
            .as_array()
            .expect("timeline");
        assert_eq!(timeline.len(), 3);
        assert_eq!(timeline[1]["type"], "tool_use");
        assert_eq!(timeline[1]["toolName"], "commandExecution");
        assert_eq!(timeline[2]["type"], "tool_result");
        assert_eq!(timeline[2]["toolOutput"], "ok");
    }

    #[test]
    fn list_local_nodes_does_not_repair_existing_summary_timeline_from_journal() {
        let (_dir, db) = open_test_db();
        upsert_run(&db, "assistant-existing-bad", "completed", "cleaned");
        db.append_agent_run_event(
            "run-assistant-existing-bad",
            "assistant-existing-bad",
            "tool_use",
            None,
            None,
            r#"{"type":"tool_use","id":"call-1","name":"commandExecution","tool_input":{"command":"sed -n '1,20p' package.json"},"timestamp":1778917768000}"#,
        )
        .expect("tool use");
        db.append_agent_run_event(
            "run-assistant-existing-bad",
            "assistant-existing-bad",
            "tool_result",
            None,
            None,
            r#"{"type":"tool_result","toolUseId":"call-1","toolName":"commandExecution","toolOutput":"ok","timestamp":1778917769000}"#,
        )
        .expect("tool result");

        {
            let conn = db.conn.lock().expect("conn");
            conn.execute(
                r#"
                INSERT INTO local_nodes (
                    id, workspace_id, parent_id, role, content, status,
                    execution_data_json, payload_json, created_at, updated_at,
                    deleted_at, local_updated_at
                )
                VALUES (?1, ?2, ?3, 'assistant', 'summary', 'completed', ?4, ?5, ?6, ?6, NULL, ?7)
                "#,
                params![
                    "assistant-existing-bad",
                    "workspace-1",
                    "user-assistant-existing-bad",
                    r#"{"timeline":[{"type":"message","content":"summary"}]}"#,
                    r#"{"id":"assistant-existing-bad","workspaceId":"workspace-1","parentId":"user-assistant-existing-bad","role":"assistant","content":"summary","status":"completed","execution_data":{"timeline":[{"type":"message","content":"summary"}]}}"#,
                    "2026-05-16T00:00:00Z",
                    1_i64,
                ],
            )
            .expect("insert bad local node");
        }

        let rows = db
            .list_local_nodes_for_workspace("workspace-1")
            .expect("local nodes");
        let payload: serde_json::Value =
            serde_json::from_str(&rows[0].payload).expect("payload json");
        let timeline = payload["execution_data"]["timeline"]
            .as_array()
            .expect("timeline");
        assert_eq!(timeline.len(), 1);
        assert_eq!(timeline[0]["type"], "message");

        let conn = db.conn.lock().expect("db lock");
        let execution_data_json: String = conn
            .query_row(
                "SELECT execution_data_json FROM local_nodes WHERE id = ?1",
                params!["assistant-existing-bad"],
                |row| row.get(0),
            )
            .expect("execution data json");
        let execution_data: serde_json::Value =
            serde_json::from_str(&execution_data_json).expect("execution data");
        let persisted_timeline = execution_data["timeline"].as_array().expect("timeline");
        assert_eq!(persisted_timeline.len(), 1);
    }

    #[test]
    fn repair_legacy_local_node_timelines_repairs_existing_summary_timeline_from_journal() {
        let (_dir, db) = open_test_db();
        upsert_run(&db, "assistant-existing-bad", "completed", "cleaned");
        db.append_agent_run_event(
            "run-assistant-existing-bad",
            "assistant-existing-bad",
            "tool_use",
            None,
            None,
            r#"{"type":"tool_use","id":"call-1","name":"commandExecution","tool_input":{"command":"sed -n '1,20p' package.json"},"timestamp":1778917768000}"#,
        )
        .expect("tool use");
        db.append_agent_run_event(
            "run-assistant-existing-bad",
            "assistant-existing-bad",
            "tool_result",
            None,
            None,
            r#"{"type":"tool_result","toolUseId":"call-1","toolName":"commandExecution","toolOutput":"ok","timestamp":1778917769000}"#,
        )
        .expect("tool result");

        {
            let conn = db.conn.lock().expect("conn");
            conn.execute(
                r#"
                INSERT INTO local_nodes (
                    id, workspace_id, parent_id, role, content, status,
                    execution_data_json, payload_json, created_at, updated_at,
                    deleted_at, local_updated_at
                )
                VALUES (?1, ?2, ?3, 'assistant', 'summary', 'completed', ?4, ?5, ?6, ?6, NULL, ?7)
                "#,
                params![
                    "assistant-existing-bad",
                    "workspace-1",
                    "user-assistant-existing-bad",
                    r#"{"timeline":[{"type":"message","content":"summary"}]}"#,
                    r#"{"id":"assistant-existing-bad","workspaceId":"workspace-1","parentId":"user-assistant-existing-bad","role":"assistant","content":"summary","status":"completed","execution_data":{"timeline":[{"type":"message","content":"summary"}]}}"#,
                    "2026-05-16T00:00:00Z",
                    1_i64,
                ],
            )
            .expect("insert bad local node");
        }

        let repaired = db
            .repair_legacy_local_node_timelines(25)
            .expect("repair legacy timelines");
        assert_eq!(repaired, 1);

        let rows = db
            .list_local_nodes_for_workspace("workspace-1")
            .expect("local nodes");
        let payload: serde_json::Value =
            serde_json::from_str(&rows[0].payload).expect("payload json");
        let timeline = payload["execution_data"]["timeline"]
            .as_array()
            .expect("timeline");
        assert_eq!(timeline.len(), 3);
        assert_eq!(timeline[0]["type"], "message");
        assert_eq!(timeline[1]["type"], "tool_use");
        assert_eq!(timeline[2]["type"], "tool_result");
    }

    #[test]
    fn repair_legacy_local_node_timelines_repairs_missing_artifacts_from_journal() {
        let (_dir, db) = open_test_db();
        upsert_run(&db, "assistant-missing-artifact", "completed", "cleaned");
        db.append_agent_run_event(
            "run-assistant-missing-artifact",
            "assistant-missing-artifact",
            "artifact_registered",
            None,
            None,
            r#"{"type":"artifact_registered","artifact":{"id":"artifact-1","kind":"screenshot","title":"Preview","mimeType":"image/png","storage":{"backend":"local","path":"/tmp/preview.png"},"isPrimary":true},"timestamp":1778917769000}"#,
        )
        .expect("artifact registered");

        {
            let conn = db.conn.lock().expect("conn");
            conn.execute(
                r#"
                INSERT INTO local_nodes (
                    id, workspace_id, parent_id, role, content, status,
                    execution_data_json, payload_json, created_at, updated_at,
                    deleted_at, local_updated_at
                )
                VALUES (?1, ?2, ?3, 'assistant', 'summary', 'completed', ?4, ?5, ?6, ?6, NULL, ?7)
                "#,
                params![
                    "assistant-missing-artifact",
                    "workspace-1",
                    "user-assistant-missing-artifact",
                    r#"{"timeline":[{"type":"tool_result","toolName":"commandExecution","toolOutput":"ok"}]}"#,
                    r#"{"id":"assistant-missing-artifact","workspaceId":"workspace-1","parentId":"user-assistant-missing-artifact","role":"assistant","content":"summary","status":"completed","execution_data":{"timeline":[{"type":"tool_result","toolName":"commandExecution","toolOutput":"ok"}]}}"#,
                    "2026-05-16T00:00:00Z",
                    1_i64,
                ],
            )
            .expect("insert local node");
        }

        let repaired = db
            .repair_legacy_local_node_timelines(25)
            .expect("repair legacy artifacts");
        assert_eq!(repaired, 1);

        let rows = db
            .list_local_nodes_for_workspace("workspace-1")
            .expect("local nodes");
        let payload: serde_json::Value =
            serde_json::from_str(&rows[0].payload).expect("payload json");
        assert_eq!(
            payload["execution_data"]["artifacts"][0]["id"],
            "artifact-1"
        );
        assert_eq!(payload["execution_data"]["artifacts"][0]["isPrimary"], true);

        let execution_data_json: String = {
            let conn = db.conn.lock().expect("conn");
            conn.query_row(
                "SELECT execution_data_json FROM local_nodes WHERE id = ?1",
                params!["assistant-missing-artifact"],
                |row| row.get(0),
            )
            .expect("execution data")
        };
        let execution_data: serde_json::Value =
            serde_json::from_str(&execution_data_json).expect("execution data json");
        assert_eq!(execution_data["artifacts"][0]["id"], "artifact-1");
    }

    #[test]
    fn server_hydration_does_not_override_pending_local_node_mutation() {
        let (_dir, db) = open_test_db();
        db.upsert_local_node(
            "node-pending",
            "workspace-1",
            r#"{"id":"node-pending","workspaceId":"workspace-1","role":"assistant","content":"local final","status":"completed"}"#,
        )
        .expect("local upsert");
        db.enqueue_local_sync_event(
            Some("workspace-1"),
            "node",
            "node-pending",
            "node.update_terminal",
            r#"{"node_id":"node-pending","finalContent":"local final"}"#,
            Some("run-1"),
        )
        .expect("enqueue");

        let server_payload = serde_json::json!({
            "id": "node-pending",
            "workspaceId": "workspace-1",
            "role": "assistant",
            "content": "stale server pending",
            "status": "running",
            "createdAt": "2026-05-08T00:00:00Z",
            "updatedAt": "2026-05-08T00:00:01Z"
        });
        let hydrated = db
            .hydrate_local_nodes_from_server(
                "workspace-1",
                vec![serde_json::to_string(&server_payload).expect("payload")],
            )
            .expect("hydrate");
        assert_eq!(hydrated, 0);

        let rows = db
            .list_local_nodes_for_workspace("workspace-1")
            .expect("local nodes");
        assert_eq!(rows.len(), 1);
        let payload: serde_json::Value =
            serde_json::from_str(&rows[0].payload).expect("payload json");
        assert_eq!(payload["content"], "local final");
        assert_eq!(payload["status"], "completed");
    }

    #[test]
    fn local_sync_event_retry_metadata_survives_reopen() {
        let (dir, db) = open_test_db();
        let event = db
            .enqueue_local_sync_event(
                Some("workspace-1"),
                "node",
                "node-1",
                "node.delete",
                r#"{"delete_mode":"branch"}"#,
                Some("mutation-1"),
            )
            .expect("enqueue");
        assert!(event
            .idempotency_key
            .contains(":node.delete:node-1:mutation-1"));

        db.mark_local_sync_event_retry(&event.id, "offline")
            .expect("retry");
        drop(db);

        let reopened = TelemetryDb::open(dir.path()).expect("reopen");
        let stored = reopened
            .get_local_sync_event(&event.id)
            .expect("read")
            .expect("event");
        assert_eq!(stored.status, "pending");
        assert_eq!(stored.attempt_count, 1);
        assert_eq!(stored.last_error.as_deref(), Some("offline"));
        assert!(stored.next_attempt_at.is_some());
    }

    #[test]
    fn list_local_nodes_includes_retry_metadata_from_sync_events() {
        let (_dir, db) = open_test_db();
        {
            let conn = db.conn.lock().expect("conn");
            conn.execute(
                r#"
                INSERT INTO local_nodes (
                    id, workspace_id, parent_id, role, content, status,
                    execution_data_json, payload_json, created_at, updated_at,
                    server_ack_at, deleted_at, local_updated_at
                )
                VALUES (?1, ?2, NULL, 'assistant', 'synced', 'completed', '{}', ?3, ?4, ?4, '100', NULL, 1)
                "#,
                params![
                    "node-retry",
                    "workspace-1",
                    r#"{"id":"node-retry","workspaceId":"workspace-1","role":"assistant","content":"synced","status":"completed"}"#,
                    "2026-06-24T00:00:00Z",
                ],
            )
            .expect("insert node");
            conn.execute(
                r#"
                INSERT INTO local_sync_events (
                    id, workspace_id, entity_type, entity_id, event_type, payload_json,
                    idempotency_key, status, attempt_count, next_attempt_at, last_error,
                    created_at, updated_at
                )
                VALUES
                    ('event-old', 'workspace-1', 'node', 'node-retry', 'node.update_terminal', '{}',
                     'key-old', 'pending', 1, 200, 'old error', 10, 10),
                    ('event-new', 'workspace-1', 'node', 'node-retry', 'node.update_terminal', '{}',
                     'key-new', 'dead', 3, NULL, 'new error', 20, 20)
                "#,
                [],
            )
            .expect("insert sync events");
        }

        let rows = db
            .list_local_nodes_for_workspace("workspace-1")
            .expect("local nodes");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].sync_status, "local_only");
        assert_eq!(rows[0].server_ack_at, Some(100));
        assert_eq!(rows[0].retry_attempt, 3);
        assert_eq!(rows[0].next_retry_at, Some(200));
        assert_eq!(rows[0].last_upload_error.as_deref(), Some("new error"));
    }

    #[test]
    fn startup_recovers_in_flight_sync_events() {
        let (dir, db) = open_test_db();
        let event = db
            .enqueue_local_sync_event(
                Some("workspace-1"),
                "node",
                "node-1",
                "node.delete",
                r#"{"delete_mode":"branch"}"#,
                Some("mutation-1"),
            )
            .expect("enqueue");
        assert!(db
            .mark_local_sync_event_in_flight(&event.id)
            .expect("in flight"));
        drop(db);

        let reopened = TelemetryDb::open(dir.path()).expect("reopen");
        let stored = reopened
            .get_local_sync_event(&event.id)
            .expect("read")
            .expect("event");
        assert_eq!(stored.status, "pending");
    }

    #[test]
    fn duplicate_sync_enqueue_returns_existing_event() {
        let (_dir, db) = open_test_db();
        let first = db
            .enqueue_local_sync_event(
                Some("workspace-1"),
                "node",
                "node-1",
                "node.update_terminal",
                r#"{"status":"completed"}"#,
                Some("run-1"),
            )
            .expect("first enqueue");
        let second = db
            .enqueue_local_sync_event(
                Some("workspace-1"),
                "node",
                "node-1",
                "node.update_terminal",
                r#"{"status":"completed","finalContent":"new"}"#,
                Some("run-1"),
            )
            .expect("second enqueue");
        assert_eq!(first.id, second.id);
        assert!(second.payload_json.contains("finalContent"));
    }

    #[test]
    fn due_local_sync_events_are_scoped_to_current_user() {
        let (_dir, db) = open_test_db();
        db.enqueue_local_sync_event_for_user(
            Some("workspace-1"),
            Some("user-a"),
            "node",
            "node-a",
            "node.update_terminal",
            r#"{"status":"completed"}"#,
            Some("run-a"),
        )
        .expect("enqueue user a");
        db.enqueue_local_sync_event_for_user(
            Some("workspace-1"),
            Some("user-b"),
            "node",
            "node-b",
            "node.update_terminal",
            r#"{"status":"completed"}"#,
            Some("run-b"),
        )
        .expect("enqueue user b");
        db.enqueue_local_sync_event(
            Some("workspace-1"),
            "node",
            "legacy-node",
            "node.update_terminal",
            r#"{"status":"completed"}"#,
            Some("legacy-run"),
        )
        .expect("enqueue legacy");

        let user_a_events = db
            .list_due_local_sync_events_for_user("user-a", 25)
            .expect("list user a");
        assert_eq!(user_a_events.len(), 1);
        assert_eq!(user_a_events[0].entity_id, "node-a");
        assert_eq!(user_a_events[0].user_id.as_deref(), Some("user-a"));

        let user_b_events = db
            .list_due_local_sync_events_for_user("user-b", 25)
            .expect("list user b");
        assert_eq!(user_b_events.len(), 1);
        assert_eq!(user_b_events[0].entity_id, "node-b");
    }

    #[test]
    fn child_terminal_sync_dies_when_parent_terminal_sync_is_dead() {
        let (_dir, db) = open_test_db();
        let parent = db
            .enqueue_local_sync_event(
                Some("workspace-1"),
                "node",
                "parent-assistant",
                "node.update_terminal",
                r#"{"workspaceId":"workspace-1","userMessage":{"id":"parent-user"},"assistantMessage":{"id":"parent-assistant"},"finalize":{"runId":"parent-run","status":"completed"}}"#,
                Some("parent-run"),
            )
            .expect("enqueue parent");
        db.mark_local_sync_event_dead(
            &parent.id,
            "node.update_terminal failed with status 404 Not Found",
        )
        .expect("dead parent");
        let child = db
            .enqueue_local_sync_event(
                Some("workspace-1"),
                "node",
                "child-assistant",
                "node.update_terminal",
                r#"{"workspaceId":"workspace-1","userMessage":{"id":"child-user","parentId":"parent-assistant"},"assistantMessage":{"id":"child-assistant"},"finalize":{"runId":"child-run","status":"completed"}}"#,
                Some("child-run"),
            )
            .expect("enqueue child");

        let blocking_parent = db
            .requeue_blocking_terminal_parent_if_needed(&child)
            .expect("handle dead parent");

        assert_eq!(blocking_parent.as_deref(), Some("parent-assistant"));
        let parent = db
            .get_local_sync_event(&parent.id)
            .expect("read parent")
            .expect("parent event");
        assert_eq!(parent.status, "dead");
        assert!(parent.next_attempt_at.is_none());
        let child = db
            .get_local_sync_event(&child.id)
            .expect("read child")
            .expect("child event");
        assert_eq!(child.status, "dead");
        assert!(child
            .last_error
            .as_deref()
            .unwrap_or_default()
            .contains("Blocked by permanently failed terminal parent parent-assistant"));
    }

    #[test]
    fn child_terminal_sync_defers_while_parent_terminal_sync_is_pending() {
        let (_dir, db) = open_test_db();
        db.enqueue_local_sync_event(
            Some("workspace-1"),
            "node",
            "parent-assistant",
            "node.update_terminal",
            r#"{"workspaceId":"workspace-1","userMessage":{"id":"parent-user"},"assistantMessage":{"id":"parent-assistant"},"finalize":{"runId":"parent-run","status":"completed"}}"#,
            Some("parent-run"),
        )
        .expect("enqueue parent");
        let before_defer = unix_timestamp();
        let child = db
            .enqueue_local_sync_event(
                Some("workspace-1"),
                "node",
                "child-assistant",
                "node.update_terminal",
                r#"{"workspaceId":"workspace-1","userMessage":{"id":"child-user","parentId":"parent-assistant"},"assistantMessage":{"id":"child-assistant"},"finalize":{"runId":"child-run","status":"completed"}}"#,
                Some("child-run"),
            )
            .expect("enqueue child");

        let blocking_parent = db
            .requeue_blocking_terminal_parent_if_needed(&child)
            .expect("detect parent");

        assert_eq!(blocking_parent.as_deref(), Some("parent-assistant"));
        let child = db
            .get_local_sync_event(&child.id)
            .expect("read child")
            .expect("child event");
        assert_eq!(child.status, "pending");
        assert!(child.next_attempt_at.unwrap_or_default() >= before_defer + 60);
    }

    #[test]
    fn local_node_upsert_does_not_clear_tombstone() {
        let (_dir, db) = open_test_db();
        db.local_first_delete_branch("workspace-1", None, "node-1")
            .expect("delete");
        db.upsert_local_node(
            "node-1",
            "workspace-1",
            r#"{"id":"node-1","role":"assistant","content":"late finalize"}"#,
        )
        .expect("upsert");
        let deleted = db
            .list_local_deleted_node_roots("workspace-1")
            .expect("deleted roots");
        assert_eq!(deleted.len(), 1);
        assert_eq!(deleted[0].node_id, "node-1");
    }

    #[test]
    fn local_first_delete_branch_tombstones_and_enqueues() {
        let (_dir, db) = open_test_db();
        let event = db
            .local_first_delete_branch("workspace-1", None, "node-1")
            .expect("delete branch");
        assert_eq!(event.entity_type, "node");
        assert_eq!(event.event_type, "node.delete");
        assert_eq!(event.entity_id, "node-1");

        let deleted = db
            .list_local_deleted_node_roots("workspace-1")
            .expect("deleted roots");
        assert_eq!(deleted.len(), 1);
        assert_eq!(deleted[0].node_id, "node-1");
    }

    #[test]
    fn local_first_tag_update_commits_payload_and_outbox_together() {
        let (_db_dir, db) = open_test_db();
        let (repo_dir, shas) = init_test_repo_with_commits(1);
        let local_path = std::fs::canonicalize(repo_dir.path())
            .expect("canonical repo")
            .to_string_lossy()
            .to_string();
        db.local_first_create_workspace(LocalWorkspaceMutationRequest {
            workspace_id: "workspace-tags".to_string(),
            current_user_id: "user-1".to_string(),
            name: Some("Tags".to_string()),
            local_repo_path: Some(local_path),
            base_commit_sha: Some(shas[0].clone()),
            repo_fingerprint: Some(format!("base:{}", shas[0])),
            mutation_id: Some("workspace.create:workspace-tags".to_string()),
        })
        .expect("create local workspace");
        db.enable_workspace_cloud_backup("workspace-tags", "user-1", "cloud-1")
            .expect("enable backup");
        acknowledge_workspace_bootstrap(&db, "user-1", "cloud-1");
        db.upsert_local_node(
            "node-1",
            "workspace-tags",
            r#"{"id":"node-1","workspaceId":"workspace-tags","role":"assistant","content":"hello","tags":["existing"]}"#,
        )
        .expect("seed local node");

        let payload = db
            .local_first_update_node_tags(
                "workspace-tags",
                Some("user-1"),
                "node-1",
                vec!["new".to_string(), "existing".to_string()],
                "add",
            )
            .expect("add tags locally");
        let payload: JsonValue = serde_json::from_str(&payload).expect("updated payload");
        assert_eq!(
            payload.get("tags"),
            Some(&serde_json::json!(["existing", "new"]))
        );

        let event = db
            .list_due_local_sync_events_for_user_and_cloud("user-1", "cloud-1", None, 25)
            .expect("list sync events")
            .into_iter()
            .find(|event| event.entity_id == "node-1" && event.event_type == "node.tags.add")
            .expect("tag outbox event");
        let event_payload: JsonValue =
            serde_json::from_str(&event.payload_json).expect("tag event payload");
        let event_tags = event_payload
            .get("tags")
            .and_then(JsonValue::as_array)
            .expect("event tags");
        assert!(event_tags.contains(&JsonValue::String("existing".to_string())));
        assert!(event_tags.contains(&JsonValue::String("new".to_string())));
    }

    #[test]
    fn local_first_node_ui_updates_commit_payload_and_outbox_together() {
        let (_db_dir, db) = open_test_db();
        let (repo_dir, shas) = init_test_repo_with_commits(1);
        let local_path = std::fs::canonicalize(repo_dir.path())
            .expect("canonical repo")
            .to_string_lossy()
            .to_string();
        db.local_first_create_workspace(LocalWorkspaceMutationRequest {
            workspace_id: "workspace-highlights".to_string(),
            current_user_id: "user-1".to_string(),
            name: Some("Highlights".to_string()),
            local_repo_path: Some(local_path),
            base_commit_sha: Some(shas[0].clone()),
            repo_fingerprint: Some(format!("base:{}", shas[0])),
            mutation_id: Some("workspace.create:workspace-highlights".to_string()),
        })
        .expect("create local workspace");
        db.enable_workspace_cloud_backup("workspace-highlights", "user-1", "cloud-1")
            .expect("enable backup");
        acknowledge_workspace_bootstrap(&db, "user-1", "cloud-1");
        db.upsert_local_node(
            "node-1",
            "workspace-highlights",
            r#"{"id":"node-1","workspaceId":"workspace-highlights","role":"assistant","content":"hello","annotations":[]}"#,
        )
        .expect("seed local node");
        let highlight = serde_json::json!({
            "type": "highlight",
            "id": "highlight-1",
            "color": "yellow",
            "range": { "start": 0, "end": 5, "exact": "hello", "textHash": "hash" },
            "createdAt": "2026-01-01T00:00:00Z",
            "updatedAt": "2026-01-01T00:00:00Z"
        });

        let payload = db
            .local_first_update_node_highlight(
                "workspace-highlights",
                Some("user-1"),
                "node-1",
                "add",
                &highlight.to_string(),
            )
            .expect("add highlight locally");
        let payload: JsonValue = serde_json::from_str(&payload).expect("updated payload");
        assert_eq!(
            payload
                .get("annotations")
                .and_then(JsonValue::as_array)
                .and_then(|annotations| annotations.first())
                .and_then(|annotation| annotation.get("id"))
                .and_then(JsonValue::as_str),
            Some("highlight-1")
        );

        let event = db
            .list_due_local_sync_events_for_user_and_cloud("user-1", "cloud-1", None, 25)
            .expect("list sync events")
            .into_iter()
            .find(|event| event.entity_id == "node-1" && event.event_type == "node.highlight.add")
            .expect("highlight outbox event");
        assert_eq!(event.payload_json, highlight.to_string());

        let payload = db
            .local_first_set_node_collapsed("workspace-highlights", Some("user-1"), "node-1", true)
            .expect("collapse node locally");
        let payload: JsonValue = serde_json::from_str(&payload).expect("collapsed payload");
        assert_eq!(
            payload.get("collapsed").and_then(JsonValue::as_bool),
            Some(true)
        );
        let collapsed_event = db
            .list_due_local_sync_events_for_user_and_cloud("user-1", "cloud-1", None, 25)
            .expect("list collapse sync event")
            .into_iter()
            .find(|event| event.entity_id == "node-1" && event.event_type == "node.collapsed.set")
            .expect("collapse outbox event");
        assert_eq!(
            serde_json::from_str::<JsonValue>(&collapsed_event.payload_json)
                .expect("collapse event payload"),
            serde_json::json!({ "collapsed": true })
        );
    }

    #[test]
    fn server_workspace_merge_preserves_local_binding_and_dirty_name() {
        let (_db_dir, db) = open_test_db();
        let (repo_dir, shas) = init_test_repo_with_commits(1);
        let local_path = std::fs::canonicalize(repo_dir.path())
            .expect("canonical repo")
            .to_string_lossy()
            .to_string();
        db.local_first_create_workspace(LocalWorkspaceMutationRequest {
            workspace_id: "workspace-1".to_string(),
            current_user_id: "user-1".to_string(),
            name: Some("Local name".to_string()),
            local_repo_path: Some(local_path.clone()),
            base_commit_sha: Some(shas[0].clone()),
            repo_fingerprint: Some(format!("base:{}", shas[0])),
            mutation_id: Some("workspace.create:workspace-1".to_string()),
        })
        .expect("create local workspace");
        db.local_first_rename_workspace("workspace-1", "user-1", "Dirty local name")
            .expect("rename local workspace");

        let rows = db
            .merge_server_workspaces(
                "user-1",
                "cloud-1",
                vec![
                    r#"{"id":"workspace-1","name":"Stale server name","folderPath":"/server/path","repoPath":"/server/path","updatedAt":"server-v1"}"#.to_string(),
                    r#"{"id":"workspace-remote","name":"Remote only","folderPath":"/server/remote","updatedAt":"server-v1"}"#.to_string(),
                ],
            )
            .expect("merge server workspaces");

        let local = rows
            .iter()
            .find(|row| row.id == "workspace-1")
            .expect("local workspace");
        assert_eq!(local.name, "Dirty local name");
        assert_eq!(local.local_repo_path.as_deref(), Some(local_path.as_str()));
        assert_eq!(local.connection_status, "connected");
        assert!(local.name_dirty);

        let remote = rows
            .iter()
            .find(|row| row.id == "workspace-remote")
            .expect("remote workspace");
        assert_eq!(remote.connection_status, "remote_unconnected");
        assert!(remote.local_repo_path.is_none());
        assert_eq!(remote.cloud_account_id.as_deref(), Some("cloud-1"));

        let cloud_two_rows = db
            .list_local_workspaces("user-1", Some("cloud-2"))
            .expect("list workspaces for another cloud account");
        let local_for_cloud_two = cloud_two_rows
            .iter()
            .find(|row| row.id == "workspace-1")
            .expect("local workspace remains visible");
        assert!(!local_for_cloud_two.cloud_backup_enabled);
        assert!(cloud_two_rows
            .iter()
            .all(|row| row.id != "workspace-remote"));
    }

    #[test]
    fn workspace_create_ack_does_not_clear_later_dirty_name() {
        let (_db_dir, db) = open_test_db();
        let (repo_dir, shas) = init_test_repo_with_commits(1);
        let local_path = std::fs::canonicalize(repo_dir.path())
            .expect("canonical repo")
            .to_string_lossy()
            .to_string();
        db.local_first_create_workspace(LocalWorkspaceMutationRequest {
            workspace_id: "workspace-1".to_string(),
            current_user_id: "user-1".to_string(),
            name: Some("Initial local name".to_string()),
            local_repo_path: Some(local_path.clone()),
            base_commit_sha: Some(shas[0].clone()),
            repo_fingerprint: Some(format!("base:{}", shas[0])),
            mutation_id: Some("workspace.create:workspace-1".to_string()),
        })
        .expect("create local workspace");
        db.enable_workspace_cloud_backup("workspace-1", "user-1", "cloud-1")
            .expect("enable backup");
        let create_event = db
            .list_due_local_sync_events_for_user("user-1", 25)
            .expect("list sync events")
            .into_iter()
            .find(|event| event.event_type == "workspace.bootstrap")
            .expect("bootstrap event");

        db.local_first_rename_workspace("workspace-1", "user-1", "Dirty local name")
            .expect("rename local workspace");
        db.mark_local_workspace_persisted(
            &create_event,
            Some(&serde_json::json!({"updatedAt":"server-create-v1"})),
        )
        .expect("mark create persisted");

        let rows = db
            .merge_server_workspaces(
                "user-1",
                "cloud-1",
                vec![
                    r#"{"id":"workspace-1","name":"Stale server name","updatedAt":"server-v1"}"#
                        .to_string(),
                ],
            )
            .expect("merge server workspaces");
        let local = rows
            .iter()
            .find(|row| row.id == "workspace-1")
            .expect("local workspace");

        assert_eq!(local.name, "Dirty local name");
        assert!(local.name_dirty);
        assert!(!local.metadata_dirty);
    }

    #[test]
    fn local_first_rename_cloud_backed_workspace_updates_and_enqueues_atomically() {
        let (_db_dir, db) = open_test_db();
        let (repo_dir, shas) = init_test_repo_with_commits(1);
        let local_path = std::fs::canonicalize(repo_dir.path())
            .expect("canonical repo")
            .to_string_lossy()
            .to_string();
        db.local_first_create_workspace(LocalWorkspaceMutationRequest {
            workspace_id: "workspace-cloud".to_string(),
            current_user_id: "user-1".to_string(),
            name: Some("Initial name".to_string()),
            local_repo_path: Some(local_path),
            base_commit_sha: Some(shas[0].clone()),
            repo_fingerprint: Some(format!("base:{}", shas[0])),
            mutation_id: Some("workspace.create:workspace-cloud".to_string()),
        })
        .expect("create local workspace");
        db.enable_workspace_cloud_backup("workspace-cloud", "user-1", "cloud-account-1")
            .expect("enable cloud backup");
        acknowledge_workspace_bootstrap(&db, "user-1", "cloud-account-1");

        let renamed = db
            .local_first_rename_workspace("workspace-cloud", "user-1", "Renamed locally")
            .expect("rename cloud-backed workspace");

        assert_eq!(renamed.name, "Renamed locally");
        assert_eq!(renamed.cloud_account_id.as_deref(), Some("cloud-account-1"));
        assert_eq!(renamed.sync_status, "sync_pending");
        let update = db
            .list_due_local_sync_events_for_user_and_cloud("user-1", "cloud-account-1", None, 25)
            .expect("list cloud sync events")
            .into_iter()
            .find(|event| {
                event.entity_id == "workspace-cloud" && event.event_type == "workspace.update"
            })
            .expect("workspace update event");
        let payload: JsonValue =
            serde_json::from_str(&update.payload_json).expect("workspace update payload");
        assert_eq!(
            payload.get("name").and_then(JsonValue::as_str),
            Some("Renamed locally")
        );
    }

    #[test]
    fn enabling_backup_queues_current_workspace_snapshot() {
        let (_db_dir, db) = open_test_db();
        let (repo_dir, shas) = init_test_repo_with_commits(1);
        let local_path = std::fs::canonicalize(repo_dir.path())
            .expect("canonical repo")
            .to_string_lossy()
            .to_string();
        db.local_first_create_workspace(LocalWorkspaceMutationRequest {
            workspace_id: "workspace-1".to_string(),
            current_user_id: "user-1".to_string(),
            name: Some("Local workspace".to_string()),
            local_repo_path: Some(local_path.clone()),
            base_commit_sha: Some(shas[0].clone()),
            repo_fingerprint: Some(format!("base:{}", shas[0])),
            mutation_id: Some("workspace.create:workspace-1".to_string()),
        })
        .expect("create local workspace");
        db.upsert_local_node(
            "user-node-1",
            "workspace-1",
            &serde_json::json!({
                "id": "user-node-1",
                "workspaceId": "workspace-1",
                "role": "user",
                "content": "Build locally first",
                "createdAt": "2026-01-01T00:00:00Z",
                "updatedAt": "2026-01-01T00:00:00Z"
            })
            .to_string(),
        )
        .expect("upsert user node");
        db.upsert_local_node(
            "assistant-node-1",
            "workspace-1",
            &serde_json::json!({
                "id": "assistant-node-1",
                "workspaceId": "workspace-1",
                "parentId": "user-node-1",
                "role": "assistant",
                "content": "Done",
                "status": "completed",
                "execution_data": { "current_run_id": "run-1", "timeline": [] },
                "promptTokens": 1,
                "completionTokens": 2,
                "totalTokens": 3,
                "outputCommitSha": shas[0],
                "createdAt": "2026-01-01T00:00:01Z",
                "updatedAt": "2026-01-01T00:00:02Z"
            })
            .to_string(),
        )
        .expect("upsert assistant node");
        db.upsert_local_insight_payload_for_user(
            "workspace-1",
            Some("user-1"),
            "insight-1",
            &serde_json::json!({
                "id": "insight-1",
                "content": "Current local insight",
                "agentType": "hypothesis",
                "parentNodeId": "assistant-node-1",
                "createdAt": "2026-01-01T00:00:03Z"
            })
            .to_string(),
            Some("insight-before-backup"),
        )
        .expect("upsert local-only insight");
        db.import_local_commits(
            "workspace-1",
            vec![LocalCommitImport {
                sha: "child-sha".to_string(),
                parents: vec![shas[0].clone()],
                subject: Some("Generated local commit".to_string()),
                author_name: Some("Agentree".to_string()),
                author_email: None,
                authored_at: Some("2026-01-01T00:00:04Z".to_string()),
                committed_at: Some("2026-01-01T00:00:05Z".to_string()),
                source_kind: Some("agent".to_string()),
                produced_by_node_id: Some("assistant-node-1".to_string()),
                files_changed_count: Some(1),
                total_additions: Some(2),
                total_deletions: Some(0),
            }],
            Some("agentree/assistant-node-1"),
        )
        .expect("import local commit graph");

        db.enable_workspace_cloud_backup("workspace-1", "user-1", "cloud-1")
            .expect("enable backup");

        let events = db
            .list_due_local_sync_events_for_user_and_cloud("user-1", "cloud-1", None, 25)
            .expect("list cloud-scoped events");
        assert_eq!(events.len(), 1, "initial backup must use one durable event");
        let bootstrap = &events[0];
        assert_eq!(bootstrap.event_type, "workspace.bootstrap");
        assert_eq!(bootstrap.entity_id, "workspace-1");
        let payload = serde_json::from_str::<JsonValue>(&bootstrap.payload_json)
            .expect("workspace bootstrap payload");
        assert_eq!(
            payload.get("schemaVersion").and_then(JsonValue::as_i64),
            Some(1)
        );
        assert_eq!(
            payload
                .pointer("/workspace/name")
                .and_then(JsonValue::as_str),
            Some("Local workspace")
        );
        assert!(payload.pointer("/workspace/folderPath").is_none());
        assert!(payload.pointer("/workspace/repoPath").is_none());
        assert!(!bootstrap.payload_json.contains(&local_path));
        assert_eq!(
            payload
                .get("nodePairs")
                .and_then(JsonValue::as_array)
                .map(Vec::len),
            Some(1)
        );
        assert_eq!(
            payload
                .get("insights")
                .and_then(JsonValue::as_array)
                .map(Vec::len),
            Some(1)
        );
        let commits = payload
            .pointer("/commitGraph/commits")
            .and_then(|commits| commits.as_array())
            .expect("commit graph commits");
        assert!(commits
            .iter()
            .any(|commit| { commit.get("sha").and_then(|sha| sha.as_str()) == Some("child-sha") }));
        assert_eq!(bootstrap.cloud_account_id.as_deref(), Some("cloud-1"));

        db.enable_workspace_cloud_backup("workspace-1", "user-1", "cloud-1")
            .expect("re-enable backup idempotently");
        let replay_events = db
            .list_due_local_sync_events_for_user_and_cloud("user-1", "cloud-1", None, 25)
            .expect("list events after idempotent enable");
        assert_eq!(
            replay_events.len(),
            1,
            "retries must reuse the same snapshot"
        );

        db.upsert_local_insight_payload_for_user(
            "workspace-1",
            Some("user-1"),
            "insight-2",
            &serde_json::json!({
                "id": "insight-2",
                "content": "Created after the snapshot boundary",
                "parentNodeId": "assistant-node-1"
            })
            .to_string(),
            Some("insight-after-backup"),
        )
        .expect("upsert post-bootstrap insight");
        let events_with_increment = db
            .list_due_local_sync_events_for_user_and_cloud("user-1", "cloud-1", None, 25)
            .expect("list bootstrap and later increment");
        assert_eq!(events_with_increment.len(), 1);
        assert_eq!(events_with_increment[0].event_type, "workspace.bootstrap");
        db.mark_local_sync_event_synced(&events_with_increment[0].id)
            .expect("ack bootstrap event");
        let increment_after_bootstrap = db
            .list_due_local_sync_events_for_user_and_cloud("user-1", "cloud-1", None, 25)
            .expect("list later increment after bootstrap acknowledgement");
        assert_eq!(increment_after_bootstrap.len(), 1);
        assert!(increment_after_bootstrap.iter().any(|event| {
            event.event_type == "insight.upsert" && event.entity_id == "insight-2"
        }));
    }

    #[test]
    fn due_sync_query_never_delivers_events_for_local_only_workspace() {
        let (_db_dir, db) = open_test_db();
        let conn = db.conn.lock().expect("lock db");
        conn.execute(
            r#"
            INSERT INTO local_workspaces (
                id, user_id, name, connection_status, sync_status, created_at, updated_at,
                local_updated_at, cloud_backup_enabled, cloud_account_id
            ) VALUES ('workspace-local', 'user-1', 'Local', 'connected', 'local_only',
                      '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 1, 0, 'cloud-1')
            "#,
            [],
        )
        .expect("insert local-only workspace");
        conn.execute(
            r#"
            INSERT INTO local_sync_events (
                id, workspace_id, user_id, cloud_account_id, entity_type, entity_id,
                event_type, payload_json, idempotency_key, status, attempt_count,
                next_attempt_at, created_at, updated_at
            ) VALUES ('event-local', 'workspace-local', 'user-1', 'cloud-1', 'node',
                      'node-1', 'node.update_terminal', '{}', 'local-only-event',
                      'pending', 0, 1, 1, 1)
            "#,
            [],
        )
        .expect("insert stale pending event");
        drop(conn);

        let events = db
            .list_due_local_sync_events_for_user_and_cloud(
                "user-1",
                "cloud-1",
                Some("workspace-local"),
                25,
            )
            .expect("query due events");

        assert!(events.is_empty());
    }

    #[test]
    fn next_sync_retry_query_reads_only_the_deliverable_outbox_summary() {
        let (_db_dir, db) = open_test_db();
        let conn = db.conn.lock().expect("lock db");
        conn.execute(
            r#"
            INSERT INTO local_workspaces (
                id, user_id, name, connection_status, sync_status, created_at, updated_at,
                local_updated_at, cloud_backup_enabled, cloud_account_id
            ) VALUES ('workspace-cloud', 'user-1', 'Cloud', 'connected', 'sync_pending',
                      '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 1, 1, 'cloud-1')
            "#,
            [],
        )
        .expect("insert cloud workspace");
        conn.execute(
            r#"
            INSERT INTO local_sync_events (
                id, workspace_id, user_id, cloud_account_id, entity_type, entity_id,
                event_type, payload_json, idempotency_key, status, attempt_count,
                next_attempt_at, created_at, updated_at
            ) VALUES
                ('event-bootstrap', 'workspace-cloud', 'user-1', 'cloud-1', 'workspace',
                 'workspace-cloud', 'workspace.bootstrap', '{}', 'bootstrap-key',
                 'pending', 1, 2000000100, 1, 1),
                ('event-child', 'workspace-cloud', 'user-1', 'cloud-1', 'node',
                 'node-1', 'node.update_terminal', '{}', 'child-key',
                 'pending', 1, 2000000000, 1, 1),
                ('event-other-account', 'workspace-cloud', 'user-1', 'cloud-2', 'node',
                 'node-2', 'node.update_terminal', '{}', 'other-key',
                 'pending', 1, 1999999000, 1, 1)
            "#,
            [],
        )
        .expect("insert pending events");
        drop(conn);

        assert_eq!(
            db.next_local_sync_retry_at("user-1", "cloud-1")
                .expect("next bootstrap retry"),
            Some(2_000_000_100)
        );

        db.mark_local_sync_event_synced("event-bootstrap")
            .expect("ack bootstrap");
        assert_eq!(
            db.next_local_sync_retry_at("user-1", "cloud-1")
                .expect("next child retry"),
            Some(2_000_000_000)
        );
        assert_eq!(
            db.next_local_sync_retry_at("user-1", "cloud-2")
                .expect("mismatched workspace account"),
            None
        );
    }

    #[test]
    fn local_first_create_workspace_rejects_non_git_directory() {
        let (_db_dir, db) = open_test_db();
        let dir = tempfile::tempdir().expect("plain dir");
        let err = db
            .local_first_create_workspace(LocalWorkspaceMutationRequest {
                workspace_id: "workspace-1".to_string(),
                current_user_id: "user-1".to_string(),
                name: Some("Plain directory".to_string()),
                local_repo_path: Some(dir.path().to_string_lossy().to_string()),
                base_commit_sha: None,
                repo_fingerprint: None,
                mutation_id: None,
            })
            .expect_err("plain directory should be rejected");

        assert!(err.contains("not a git worktree"), "{err}");
    }

    #[test]
    fn repair_local_workspace_repo_paths_demotes_invalid_cross_machine_path() {
        let (_db_dir, db) = open_test_db();
        let now = chrono_like_now();
        let conn = db.conn.lock().expect("lock db");
        conn.execute(
            r#"
            INSERT INTO local_workspaces (
                id, user_id, name, folder_path, repo_path, local_repo_path,
                connection_status, sync_status, created_at, updated_at, local_updated_at
            )
            VALUES (
                'workspace-1', 'user-1', 'Remote path', '/home/example/work/repo',
                '/home/example/work/repo', '/home/example/work/repo',
                'connected', 'synced', ?1, ?1, ?2
            )
            "#,
            params![now, unix_timestamp()],
        )
        .expect("insert stale workspace");

        TelemetryDb::repair_local_workspace_repo_paths(&conn).expect("repair paths");
        drop(conn);

        let rows = db
            .list_local_workspaces("user-1", None)
            .expect("list workspaces");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].connection_status, "remote_unconnected");
        assert!(rows[0].local_repo_path.is_none());
    }

    #[test]
    fn repair_local_workspace_repo_paths_connects_valid_legacy_path() {
        let (_db_dir, db) = open_test_db();
        let (repo_dir, _) = init_test_repo_with_commits(1);
        let local_path = std::fs::canonicalize(repo_dir.path())
            .expect("canonical repo")
            .to_string_lossy()
            .to_string();
        let now = chrono_like_now();
        let conn = db.conn.lock().expect("lock db");
        conn.execute(
            r#"
            INSERT INTO local_workspaces (
                id, user_id, name, folder_path, repo_path, local_repo_path,
                connection_status, sync_status, created_at, updated_at, local_updated_at
            )
            VALUES (
                'workspace-1', 'user-1', 'Legacy local path', ?1,
                NULL, NULL, 'remote_unconnected', 'synced', ?2, ?2, ?3
            )
            "#,
            params![local_path, now, unix_timestamp()],
        )
        .expect("insert legacy workspace");

        TelemetryDb::repair_local_workspace_repo_paths(&conn).expect("repair paths");
        drop(conn);

        let rows = db
            .list_local_workspaces("user-1", None)
            .expect("list workspaces");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].connection_status, "connected");
        assert_eq!(
            rows[0].local_repo_path.as_deref(),
            Some(local_path.as_str())
        );
    }

    #[test]
    fn local_first_delete_workspace_tombstones_and_enqueues() {
        let (_dir, db) = open_test_db();
        let event = db
            .local_first_delete_workspace("workspace-1", None)
            .expect("delete workspace");
        assert_eq!(event.entity_type, "workspace");
        assert_eq!(event.event_type, "workspace.delete");
        assert_eq!(event.entity_id, "workspace-1");

        let deleted = db
            .list_local_deleted_workspace_ids()
            .expect("deleted workspaces");
        assert_eq!(deleted, vec!["workspace-1".to_string()]);
    }

    #[test]
    fn terminal_sync_workspace_not_found_is_permanent() {
        assert!(is_permanent_local_sync_error(
            "node.update_terminal failed with status 404 Not Found"
        ));
    }

    #[test]
    fn commit_graph_sync_workspace_not_found_is_permanent() {
        assert!(is_permanent_local_sync_error(
            "commit_graph.git_sync_ingest failed with status 404 Not Found: {\"error\":\"Workspace not found\"}"
        ));
    }

    #[test]
    fn transient_terminal_sync_error_is_retryable() {
        assert!(!is_permanent_local_sync_error(
            "node.update_terminal failed with status 500 Internal Server Error"
        ));
    }
}
