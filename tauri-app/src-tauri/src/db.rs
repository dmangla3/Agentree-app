use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager, State};

const LOCAL_COMMIT_PARENT_CLOSURE_LIMIT: usize = 5_000;

fn unix_timestamp() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("Time went backwards")
        .as_secs() as i64
}

fn is_structured_timeline_event_type(event_type: &str) -> bool {
    matches!(
        event_type,
        "tool_use" | "tool_result" | "tool_output_delta" | "thinking" | "error" | "stderr"
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
                JsonValue::String(format!("{}{}", existing, delta)),
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
        "error" | "stderr" => Some(serde_json::json!({
            "type": "error",
            "timestamp": timestamp,
            "content": event.get("content").cloned()
                .or_else(|| event.get("data").cloned())
                .unwrap_or(JsonValue::Null),
        })),
        _ => None,
    }
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
    pub payload: String,
    pub sync_status: String,
    pub finalized_at: i64,
    pub server_ack_at: Option<i64>,
    pub retry_attempt: i64,
    pub next_retry_at: Option<i64>,
    pub last_upload_error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct LocalSyncEventRow {
    pub id: String,
    pub workspace_id: Option<String>,
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
pub struct LocalDeletedNodeRoot {
    pub workspace_id: String,
    pub node_id: String,
    pub deleted_at: i64,
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
                cleanup_completed INTEGER NOT NULL DEFAULT 0
            );
            CREATE INDEX IF NOT EXISTS idx_agent_run_ledger_assistant ON agent_run_ledger(assistant_node_id);
            CREATE INDEX IF NOT EXISTS idx_agent_run_ledger_status ON agent_run_ledger(status);
            CREATE INDEX IF NOT EXISTS idx_agent_run_ledger_repo ON agent_run_ledger(repo_path);

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
                scope_id TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                deleted_at TEXT,
                local_updated_at INTEGER NOT NULL,
                server_ack_at TEXT,
                server_version TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_local_nodes_workspace ON local_nodes(workspace_id, deleted_at, created_at);
            CREATE INDEX IF NOT EXISTS idx_local_nodes_parent ON local_nodes(parent_id);

            CREATE TABLE IF NOT EXISTS local_workspaces (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                folder_path TEXT,
                repo_path TEXT,
                base_commit_sha TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                deleted_at TEXT,
                local_updated_at INTEGER NOT NULL,
                server_ack_at TEXT,
                server_version TEXT
            );

            CREATE TABLE IF NOT EXISTS local_sync_events (
                id TEXT PRIMARY KEY,
                workspace_id TEXT,
                entity_type TEXT NOT NULL,
                entity_id TEXT NOT NULL,
                event_type TEXT NOT NULL,
                payload_json TEXT NOT NULL,
                idempotency_key TEXT NOT NULL UNIQUE,
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
        let _ = conn.execute("ALTER TABLE local_nodes ADD COLUMN payload_json TEXT", []);
        let _ = conn.execute(
            "ALTER TABLE agent_run_ledger ADD COLUMN output_commit_sha TEXT",
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
                id, workspace_id, parent_id, role, content, status,
                execution_data_json, payload_json, prompt_tokens, completion_tokens, total_tokens,
                base_commit_sha, output_commit_sha, base_selected_from_node_id, git_branch_name, scope_id, created_at, updated_at,
                deleted_at, local_updated_at, server_ack_at
            )
            SELECT
                node_id,
                workspace_id,
                json_extract(payload, '$.parentId'),
                COALESCE(json_extract(payload, '$.role'), 'assistant'),
                COALESCE(json_extract(payload, '$.content'), ''),
                json_extract(payload, '$.status'),
                json_extract(payload, '$.execution_data'),
                payload,
                json_extract(payload, '$.promptTokens'),
                json_extract(payload, '$.completionTokens'),
                json_extract(payload, '$.totalTokens'),
                json_extract(payload, '$.base_commit_sha'),
                json_extract(payload, '$.output_commit_sha'),
                json_extract(payload, '$.base_selected_from_node_id'),
                json_extract(payload, '$.git_branch_name'),
                json_extract(payload, '$.scope_id'),
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
                status, phase, started_at, updated_at
            )
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?13)
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
            ],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
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
                needs_user_action_reason = NULL,
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
                needs_user_action_reason, cleanup_completed
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
                })
            },
        )
        .optional()
        .map_err(|e| e.to_string())
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
        let rows = stmt
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
        let Ok(existing_execution_data) = serde_json::from_str::<JsonValue>(&existing) else {
            return Ok(None);
        };
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
                  AND event_type IN ('thinking', 'tool_use', 'tool_result', 'tool_output_delta', 'error', 'stderr')
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
        let role = payload_value
            .get("role")
            .and_then(|value| value.as_str())
            .unwrap_or("assistant");
        let content = payload_value
            .get("content")
            .and_then(|value| value.as_str())
            .unwrap_or("");
        let status = payload_value.get("status").and_then(|value| value.as_str());
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
        let scope_id = payload_value
            .get("scope_id")
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
                id, workspace_id, parent_id, role, content, status,
                execution_data_json, payload_json, prompt_tokens, completion_tokens, total_tokens,
                base_commit_sha, output_commit_sha, base_selected_from_node_id, git_branch_name, scope_id, created_at, updated_at,
                deleted_at, local_updated_at
            )
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, NULL, ?19)
            ON CONFLICT(id) DO UPDATE SET
                workspace_id = excluded.workspace_id,
                parent_id = excluded.parent_id,
                role = excluded.role,
                content = excluded.content,
                status = excluded.status,
                execution_data_json = excluded.execution_data_json,
                payload_json = excluded.payload_json,
                prompt_tokens = excluded.prompt_tokens,
                completion_tokens = excluded.completion_tokens,
                total_tokens = excluded.total_tokens,
                base_commit_sha = excluded.base_commit_sha,
                output_commit_sha = COALESCE(excluded.output_commit_sha, local_nodes.output_commit_sha),
                base_selected_from_node_id = excluded.base_selected_from_node_id,
                git_branch_name = excluded.git_branch_name,
                scope_id = excluded.scope_id,
                updated_at = excluded.updated_at,
                deleted_at = local_nodes.deleted_at,
                local_updated_at = excluded.local_updated_at
            "#,
            params![
                node_id,
                workspace_id,
                parent_id,
                role,
                content,
                status,
                execution_data_json,
                payload,
                prompt_tokens,
                completion_tokens,
                total_tokens,
                base_commit_sha,
                output_commit_sha,
                base_selected_from_node_id,
                git_branch_name,
                scope_id,
                created_at,
                updated_at,
                now
            ],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
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
            let payload_value =
                serde_json::from_str::<JsonValue>(&payload).unwrap_or(JsonValue::Null);
            let Some(node_id) = payload_value.get("id").and_then(|value| value.as_str()) else {
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

            let parent_id = payload_value
                .get("parentId")
                .and_then(|value| value.as_str());
            let role = payload_value
                .get("role")
                .and_then(|value| value.as_str())
                .unwrap_or("assistant");
            let content = payload_value
                .get("content")
                .and_then(|value| value.as_str())
                .unwrap_or("");
            let status = payload_value.get("status").and_then(|value| value.as_str());
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
            let scope_id = payload_value
                .get("scope_id")
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
                    id, workspace_id, parent_id, role, content, status,
                    execution_data_json, payload_json, prompt_tokens, completion_tokens, total_tokens,
                    base_commit_sha, output_commit_sha, base_selected_from_node_id, git_branch_name, scope_id, created_at, updated_at,
                    deleted_at, local_updated_at, server_ack_at
                )
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, NULL, ?19, ?20)
                ON CONFLICT(id) DO NOTHING
                "#,
                params![
                    node_id,
                    workspace_id,
                    parent_id,
                    role,
                    content,
                    status,
                    execution_data_json,
                    payload,
                    prompt_tokens,
                    completion_tokens,
                    total_tokens,
                    base_commit_sha,
                    output_commit_sha,
                    base_selected_from_node_id,
                    git_branch_name,
                    scope_id,
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

    pub fn list_local_nodes_for_workspace(
        &self,
        workspace_id: &str,
    ) -> Result<Vec<LocalNodeRow>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                r#"
                SELECT
                    n.id,
                    n.workspace_id,
                    CASE
                        WHEN n.output_commit_sha IS NOT NULL THEN json_set(
                            COALESCE(n.payload_json, json_object(
                                'id', n.id,
                                'role', n.role,
                                'workspaceId', n.workspace_id,
                                'parentId', n.parent_id,
                                'content', n.content,
                                'status', n.status,
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
                                'scope_id', n.scope_id,
                                'createdAt', n.created_at,
                                'updatedAt', n.updated_at
                            )),
                            '$.output_commit_sha',
                            n.output_commit_sha
                        )
                        ELSE COALESCE(n.payload_json, json_object(
                        'id', n.id,
                        'role', n.role,
                        'workspaceId', n.workspace_id,
                        'parentId', n.parent_id,
                        'content', n.content,
                        'status', n.status,
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
                        'scope_id', n.scope_id,
                        'createdAt', n.created_at,
                        'updatedAt', n.updated_at
                        ))
                    END AS payload,
                    CASE
                        WHEN EXISTS (
                            SELECT 1
                            FROM local_sync_events e
                            WHERE e.entity_type = 'node'
                              AND e.entity_id = n.id
                              AND e.status IN ('pending', 'in_flight', 'dead')
                        ) THEN 'local_only'
                        WHEN n.server_ack_at IS NULL THEN 'local_only'
                        ELSE 'persisted'
                    END AS sync_status,
                    n.local_updated_at,
                    CASE
                        WHEN n.server_ack_at IS NULL THEN NULL
                        WHEN n.server_ack_at GLOB '[0-9]*' THEN CAST(n.server_ack_at AS INTEGER)
                        ELSE NULL
                    END AS server_ack_at,
                    COALESCE((
                        SELECT MAX(e.attempt_count)
                        FROM local_sync_events e
                        WHERE e.entity_type = 'node'
                          AND e.entity_id = n.id
                          AND e.status IN ('pending', 'in_flight', 'dead')
                    ), 0) AS retry_attempt,
                    (
                        SELECT MIN(e.next_attempt_at)
                        FROM local_sync_events e
                        WHERE e.entity_type = 'node'
                          AND e.entity_id = n.id
                          AND e.status IN ('pending', 'in_flight')
                    ) AS next_retry_at,
                    (
                        SELECT e.last_error
                        FROM local_sync_events e
                        WHERE e.entity_type = 'node'
                          AND e.entity_id = n.id
                          AND e.status IN ('pending', 'in_flight', 'dead')
                          AND e.last_error IS NOT NULL
                        ORDER BY e.updated_at DESC
                        LIMIT 1
                    ) AS last_upload_error
                FROM local_nodes n
                WHERE n.workspace_id = ?1
                  AND n.deleted_at IS NULL
                ORDER BY n.local_updated_at ASC
                "#,
            )
            .map_err(|e| e.to_string())?;
        let mut rows = stmt
            .query_map(params![workspace_id], |row| {
                Ok(LocalNodeRow {
                    node_id: row.get(0)?,
                    workspace_id: row.get(1)?,
                    payload: row.get(2)?,
                    sync_status: row.get(3)?,
                    finalized_at: row.get(4)?,
                    server_ack_at: row.get(5)?,
                    retry_attempt: row.get(6)?,
                    next_retry_at: row.get(7)?,
                    last_upload_error: row.get(8)?,
                })
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        drop(stmt);
        for row in rows.iter_mut() {
            let Ok(mut payload) = serde_json::from_str::<JsonValue>(&row.payload) else {
                continue;
            };
            if payload_has_structured_timeline(&payload) {
                continue;
            }
            Self::repair_payload_timeline_if_needed(&conn, &row.node_id, &mut payload)?;
            if payload_has_structured_timeline(&payload) {
                row.payload = serde_json::to_string(&payload).map_err(|e| e.to_string())?;
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
                    params![row.node_id, row.payload, execution_data_json],
                )
                .map_err(|e| e.to_string())?;
            }
        }
        rows.sort_by_key(|row| row.finalized_at);
        Ok(rows)
    }

    pub fn get_local_node_payload(&self, node_id: &str) -> Result<Option<String>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.query_row(
            "SELECT payload_json FROM local_nodes WHERE id = ?1 AND deleted_at IS NULL",
            params![node_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()
        .map(|value| value.flatten())
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
                        WHEN local_commits.source_kind = 'agent' THEN local_commits.source_kind
                        ELSE excluded.source_kind
                    END,
                    produced_by_node_id = COALESCE(excluded.produced_by_node_id, local_commits.produced_by_node_id),
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

    pub fn enqueue_local_sync_event(
        &self,
        workspace_id: Option<&str>,
        entity_type: &str,
        entity_id: &str,
        event_type: &str,
        payload_json: &str,
        mutation_id: Option<&str>,
    ) -> Result<LocalSyncEventRow, String> {
        let now = unix_timestamp();
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let device_id = Self::local_device_id_locked(&conn, now)?;
        let mutation_id = mutation_id
            .map(|value| value.to_string())
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        let idempotency_key = format!("{device_id}:{event_type}:{entity_id}:{mutation_id}");
        let id = uuid::Uuid::new_v4().to_string();
        conn.execute(
            r#"
            INSERT INTO local_sync_events (
                id, workspace_id, entity_type, entity_id, event_type, payload_json,
                idempotency_key, status, attempt_count, next_attempt_at, created_at, updated_at
            )
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'pending', 0, ?8, ?8, ?8)
            ON CONFLICT(idempotency_key) DO UPDATE SET
                workspace_id = excluded.workspace_id,
                payload_json = excluded.payload_json,
                status = CASE
                    WHEN local_sync_events.status = 'synced' THEN 'synced'
                    ELSE 'pending'
                END,
                next_attempt_at = CASE
                    WHEN local_sync_events.status = 'synced' THEN local_sync_events.next_attempt_at
                    ELSE ?8
                END,
                updated_at = ?8
            "#,
            params![
                id,
                workspace_id,
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

    pub fn enqueue_local_commit_graph_sync(
        &self,
        workspace_id: &str,
        payload_json: &str,
        mutation_id: Option<&str>,
    ) -> Result<LocalSyncEventRow, String> {
        self.enqueue_local_sync_event(
            Some(workspace_id),
            "commit_graph",
            workspace_id,
            "commit_graph.git_sync_ingest",
            payload_json,
            mutation_id,
        )
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
            SELECT id, workspace_id, entity_type, entity_id, event_type, payload_json,
                   idempotency_key, status, attempt_count, next_attempt_at, last_error,
                   created_at, updated_at
            FROM local_sync_events
            WHERE id = ?1
            "#,
            params![id],
            |row| {
                Ok(LocalSyncEventRow {
                    id: row.get(0)?,
                    workspace_id: row.get(1)?,
                    entity_type: row.get(2)?,
                    entity_id: row.get(3)?,
                    event_type: row.get(4)?,
                    payload_json: row.get(5)?,
                    idempotency_key: row.get(6)?,
                    status: row.get(7)?,
                    attempt_count: row.get(8)?,
                    next_attempt_at: row.get(9)?,
                    last_error: row.get(10)?,
                    created_at: row.get(11)?,
                    updated_at: row.get(12)?,
                })
            },
        )
        .optional()
        .map_err(|e| e.to_string())
    }

    pub fn get_local_sync_event_by_idempotency_key(
        &self,
        idempotency_key: &str,
    ) -> Result<Option<LocalSyncEventRow>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.query_row(
            r#"
            SELECT id, workspace_id, entity_type, entity_id, event_type, payload_json,
                   idempotency_key, status, attempt_count, next_attempt_at, last_error,
                   created_at, updated_at
            FROM local_sync_events
            WHERE idempotency_key = ?1
            "#,
            params![idempotency_key],
            |row| {
                Ok(LocalSyncEventRow {
                    id: row.get(0)?,
                    workspace_id: row.get(1)?,
                    entity_type: row.get(2)?,
                    entity_id: row.get(3)?,
                    event_type: row.get(4)?,
                    payload_json: row.get(5)?,
                    idempotency_key: row.get(6)?,
                    status: row.get(7)?,
                    attempt_count: row.get(8)?,
                    next_attempt_at: row.get(9)?,
                    last_error: row.get(10)?,
                    created_at: row.get(11)?,
                    updated_at: row.get(12)?,
                })
            },
        )
        .optional()
        .map_err(|e| e.to_string())
    }

    pub fn list_due_local_sync_events(&self, limit: i64) -> Result<Vec<LocalSyncEventRow>, String> {
        let now = unix_timestamp();
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                r#"
                SELECT id, workspace_id, entity_type, entity_id, event_type, payload_json,
                       idempotency_key, status, attempt_count, next_attempt_at, last_error,
                       created_at, updated_at
                FROM local_sync_events
                WHERE status = 'pending'
                  AND (next_attempt_at IS NULL OR next_attempt_at <= ?1)
                ORDER BY created_at ASC
                LIMIT ?2
                "#,
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![now, limit], |row| {
                Ok(LocalSyncEventRow {
                    id: row.get(0)?,
                    workspace_id: row.get(1)?,
                    entity_type: row.get(2)?,
                    entity_id: row.get(3)?,
                    event_type: row.get(4)?,
                    payload_json: row.get(5)?,
                    idempotency_key: row.get(6)?,
                    status: row.get(7)?,
                    attempt_count: row.get(8)?,
                    next_attempt_at: row.get(9)?,
                    last_error: row.get(10)?,
                    created_at: row.get(11)?,
                    updated_at: row.get(12)?,
                })
            })
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
            SET status = 'dead', last_error = ?2, updated_at = ?3
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
        self.enqueue_local_sync_event(
            Some(workspace_id),
            "node",
            root_node_id,
            "node.delete",
            &serde_json::to_string(&payload).map_err(|e| e.to_string())?,
            None,
        )
    }

    pub fn local_first_delete_workspace(
        &self,
        workspace_id: &str,
    ) -> Result<LocalSyncEventRow, String> {
        let now = unix_timestamp();
        let deleted_at = chrono_like_now();
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            r#"
            INSERT INTO local_workspaces (
                id, name, created_at, updated_at, deleted_at, local_updated_at
            )
            VALUES (?1, '', ?2, ?2, ?2, ?3)
            ON CONFLICT(id) DO UPDATE SET
                deleted_at = excluded.deleted_at,
                local_updated_at = excluded.local_updated_at
            "#,
            params![workspace_id, deleted_at, now],
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
        self.enqueue_local_sync_event(
            Some(workspace_id),
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
    telemetry.list_local_nodes_for_workspace(&workspace_id)
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
    telemetry.list_local_commit_graph(&workspace_id)
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
    payload_json: String,
    mutation_id: Option<String>,
) -> Result<LocalSyncEventRow, String> {
    telemetry.enqueue_local_commit_graph_sync(&workspace_id, &payload_json, mutation_id.as_deref())
}

#[tauri::command]
#[specta::specta]
pub fn local_first_delete_branch(
    telemetry: State<TelemetryDb>,
    workspace_id: String,
    root_node_id: String,
) -> Result<LocalSyncEventRow, String> {
    telemetry.local_first_delete_branch(&workspace_id, &root_node_id)
}

#[tauri::command]
#[specta::specta]
pub fn local_first_delete_workspace(
    telemetry: State<TelemetryDb>,
    workspace_id: String,
) -> Result<LocalSyncEventRow, String> {
    telemetry.local_first_delete_workspace(&workspace_id)
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

fn sync_event(
    client: &reqwest::blocking::Client,
    auth_token: &str,
    event: &LocalSyncEventRow,
) -> Result<Option<JsonValue>, String> {
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
            .post(format!("{}/{}", crate::config::server_base_url(), endpoint))
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
        return Err(format!(
            "{} failed with status {}",
            event.event_type,
            response.status()
        ));
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
                    crate::config::server_base_url(),
                    workspace_id
                ))
                .header("Authorization", format!("Bearer {}", auth_token))
                .header("Idempotency-Key", &event.idempotency_key)
                .json(&payload)
                .send()
                .map_err(|err| format!("{} transport error: {}", event.event_type, err))?;
            if response.status().is_success() {
                return Ok(None);
            }
            return Err(format!(
                "{} failed with status {}",
                event.event_type,
                response.status()
            ));
        }
        ("node", "node.delete") => format!(
            "{}/messages/{}/branch",
            crate::config::server_base_url(),
            event.entity_id
        ),
        ("workspace", "workspace.delete") => {
            format!(
                "{}/workspaces/{}",
                crate::config::server_base_url(),
                event.entity_id
            )
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
        Err(format!(
            "{} failed with status {}",
            event.event_type,
            response.status()
        ))
    }
}

#[tauri::command]
#[specta::specta]
pub fn process_local_sync_events(
    telemetry: State<TelemetryDb>,
    auth_token: String,
    limit: Option<i64>,
) -> Result<usize, String> {
    let events = telemetry.list_due_local_sync_events(limit.unwrap_or(25).clamp(1, 100))?;
    let client = reqwest::blocking::Client::new();
    let mut synced = 0usize;
    for event in events {
        if !telemetry.mark_local_sync_event_in_flight(&event.id)? {
            continue;
        }
        let result = sync_event(&client, &auth_token, &event);
        match result {
            Ok(response_body) => {
                if event.entity_type == "node" && event.event_type == "node.update_terminal" {
                    let _ = telemetry.mark_local_node_persisted(&event.entity_id);
                    if let Ok(payload) = serde_json::from_str::<JsonValue>(&event.payload_json) {
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
                        let response_output_commit_sha = response_body.as_ref().and_then(|body| {
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
                if err.starts_with("No sync handler") {
                    let _ = telemetry.mark_local_sync_event_dead(&event.id, &err);
                } else {
                    let _ = telemetry.mark_local_sync_event_retry(&event.id, &err);
                }
                crate::app_log!(
                    "[LOCAL_SYNC] event={} entity_type={} entity_id={} status=retry err={}",
                    event.event_type,
                    event.entity_type,
                    event.entity_id,
                    err
                );
            }
        }
    }
    Ok(synced)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn open_test_db() -> (tempfile::TempDir, TelemetryDb) {
        let dir = tempfile::tempdir().expect("tempdir");
        let db = TelemetryDb::open(dir.path()).expect("open telemetry db");
        (dir, db)
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
        })
        .expect("upsert run");
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
        assert_eq!(timeline.len(), 3);
        assert_eq!(timeline[0]["type"], "message");
        assert_eq!(timeline[1]["type"], "tool_use");
        assert_eq!(timeline[1]["toolName"], "commandExecution");
        assert_eq!(timeline[1]["toolOutput"], "partial ");
        assert_eq!(timeline[2]["type"], "tool_result");
        assert_eq!(timeline[2]["toolOutput"], "{\"name\":\"agentree\"}");
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
    fn list_local_nodes_repairs_existing_summary_timeline_from_journal() {
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
        assert_eq!(timeline.len(), 3);
        assert_eq!(timeline[0]["type"], "message");
        assert_eq!(timeline[1]["type"], "tool_use");
        assert_eq!(timeline[2]["type"], "tool_result");

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
        assert_eq!(persisted_timeline.len(), 3);
        assert_eq!(persisted_timeline[1]["type"], "tool_use");
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
    fn local_node_upsert_does_not_clear_tombstone() {
        let (_dir, db) = open_test_db();
        db.local_first_delete_branch("workspace-1", "node-1")
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
            .local_first_delete_branch("workspace-1", "node-1")
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
    fn local_first_delete_workspace_tombstones_and_enqueues() {
        let (_dir, db) = open_test_db();
        let event = db
            .local_first_delete_workspace("workspace-1")
            .expect("delete workspace");
        assert_eq!(event.entity_type, "workspace");
        assert_eq!(event.event_type, "workspace.delete");
        assert_eq!(event.entity_id, "workspace-1");

        let deleted = db
            .list_local_deleted_workspace_ids()
            .expect("deleted workspaces");
        assert_eq!(deleted, vec!["workspace-1".to_string()]);
    }
}
