use serde::{Deserialize, Serialize};
use serde_json::{json, Map as JsonMap, Value as JsonValue};
use std::collections::HashSet;
use tauri::{AppHandle, Emitter, Manager};
use uuid::Uuid;

use crate::agents::{AgentRunContext, StartAgentRunIntent, StartAgentRunResponse};
use crate::db::{AgentLaunchRequestRow, TelemetryDb};

const LAUNCH_LEASE_SECONDS: i64 = 120;
const RECOVERY_STARTUP_GRACE_SECONDS: u64 = 5;
const RECOVERY_POLL_SECONDS: u64 = 30;
const RECOVERY_BATCH_SIZE: usize = 32;
const DEFAULT_PROMPT_DEFINITIONS_JSON: &str =
    include_str!("../../src/lib/prompts/defaultPromptDefinitions.json");

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DefaultPromptDefinition {
    id: String,
    default_text: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentLaunchRequest {
    pub request_id: String,
    pub run_id: String,
    pub workspace_id: String,
    #[serde(default)]
    pub thread_id: Option<String>,
    #[serde(default)]
    pub parent_node_id: Option<String>,
    #[serde(default)]
    pub context_parent_node_id: Option<String>,
    #[serde(default)]
    pub base_node_id: Option<String>,
    pub base_commit: String,
    pub user_node_id: String,
    pub assistant_node_id: String,
    pub user_prompt: String,
    pub agent_type: String,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub reasoning_effort: Option<String>,
    #[serde(default = "default_permission_mode")]
    pub permission_mode: String,
    #[serde(default)]
    pub login_profile_id: Option<String>,
    #[serde(default)]
    pub agent_id: Option<String>,
    #[serde(default)]
    pub agent_name: Option<String>,
    #[serde(default)]
    pub agent_cli_args: Option<String>,
    #[serde(default)]
    pub agent_prompt_flag: Option<String>,
    // Authentication is supplied by the current invocation and must never be
    // written into the durable idempotency record.
    #[serde(default, skip_serializing)]
    pub auth_token: String,
    pub current_user_id: String,
    #[serde(default)]
    pub trace_id: Option<String>,
    #[serde(default = "default_context_policy")]
    pub context_policy: String,
    #[serde(default = "default_context_mode")]
    pub context_mode: String,
    #[serde(default)]
    #[specta(type = specta_typescript::Unknown)]
    pub context_manifest: JsonValue,
    #[serde(default)]
    #[specta(type = specta_typescript::Unknown)]
    pub model_capabilities: JsonValue,
    #[serde(default)]
    pub thread_title_mode: Option<String>,
    #[serde(default)]
    #[specta(type = specta_typescript::Unknown)]
    pub user_node: JsonValue,
    #[specta(type = specta_typescript::Unknown)]
    pub assistant_node: JsonValue,
}

#[derive(Debug, Clone, Deserialize, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentLaunchContext {
    pub provider_thread_strategy: String,
    pub provider_thread_strategy_requested: String,
    pub provider_context_routing_mode: String,
    pub provider_context_routing_reason: String,
    pub parent_provider: Option<String>,
    pub parent_provider_thread_id: Option<String>,
    pub parent_provider_turn_id: Option<String>,
    pub parent_provider_lineage_id: Option<String>,
    pub is_branch_from_interior: bool,
    pub agentree_context_available_chars: usize,
    pub agentree_context_injected_chars: usize,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentLaunchResponse {
    pub run_id: String,
    pub user_node_id: String,
    pub assistant_node_id: String,
    pub worktree_path: Option<String>,
    pub branch_name: Option<String>,
    pub pid: Option<i64>,
    pub initial_status: String,
    pub existing: bool,
    pub launch_context: AgentLaunchContext,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
struct LaunchPlan {
    args: Vec<String>,
    context: AgentLaunchContext,
    meta: JsonMap<String, JsonValue>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct DurableLaunchRecord {
    request: AgentLaunchRequest,
    plan: LaunchPlan,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ProviderRouting {
    strategy: &'static str,
    requested_strategy: &'static str,
    context_mode: &'static str,
    reason: &'static str,
    inject_context: bool,
}

fn default_permission_mode() -> String {
    "full-access".to_string()
}

fn default_context_policy() -> String {
    "continue".to_string()
}

fn default_context_mode() -> String {
    "active".to_string()
}

#[derive(Clone)]
pub(crate) struct AgentLaunchService {
    app: AppHandle,
}

impl AgentLaunchService {
    pub(crate) fn new(app: AppHandle) -> Self {
        Self { app }
    }

    pub(crate) async fn launch(
        &self,
        incoming_request: AgentLaunchRequest,
    ) -> Result<AgentLaunchResponse, String> {
        validate_request(&incoming_request)?;
        let existing_row = self
            .telemetry()
            .get_agent_launch_request(&incoming_request.request_id)?;
        if let Some(existing) = existing_row.as_ref() {
            validate_existing_request_identity(existing, &incoming_request)?;
            if let Some(response) = self.response_from_existing(existing)? {
                self.telemetry()
                    .reconcile_agent_launch_request_accepted(&existing.request_id)?;
                return Ok(response);
            }
        }
        let (request, stored_plan) = if let Some(existing) = existing_row {
            let (mut stored, plan) = decode_durable_record(&existing.request_json)?;
            // Authentication is deliberately refreshed while all launch identity and
            // graph fields remain fixed to the first durable request.
            stored.auth_token = incoming_request.auth_token;
            stored.current_user_id = incoming_request.current_user_id;
            stored.trace_id = incoming_request.trace_id;
            (stored, plan)
        } else {
            (incoming_request, None)
        };
        validate_request(&request)?;
        self.validate_graph_scope(&request)?;
        let plan = match stored_plan {
            Some(plan) => plan,
            None => self.build_plan(&request)?,
        };
        let lease_owner = Uuid::new_v4().to_string();
        let request_json = serde_json::to_string(&DurableLaunchRecord {
            request: request.clone(),
            plan: plan.clone(),
        })
        .map_err(|error| error.to_string())?;
        let claim = self.telemetry().claim_agent_launch_request(
            &request.request_id,
            &request.workspace_id,
            request.thread_id.as_deref(),
            &request.user_node_id,
            &request.assistant_node_id,
            &request.run_id,
            &request_json,
            &lease_owner,
            LAUNCH_LEASE_SECONDS,
        )?;

        if let Some(existing) = self.response_from_existing(&claim.row)? {
            self.telemetry()
                .reconcile_agent_launch_request_accepted(&claim.row.request_id)?;
            return Ok(existing);
        }
        if !claim.acquired {
            return Err(format!(
                "Launch request {} is already being prepared. Retry with the same requestId.",
                request.request_id
            ));
        }

        let lease_heartbeat = self.spawn_lease_heartbeat(&request.request_id, &lease_owner);
        let result = self.launch_claimed(&request, plan, &lease_owner).await;
        lease_heartbeat.abort();
        if let Err(error) = &result {
            let _ = self.mark_failed(&request, error);
            let _ = self.telemetry().update_agent_launch_request(
                &request.request_id,
                &lease_owner,
                "failed",
                Some(error),
            );
        }
        result
    }

    pub(crate) async fn resume_existing(
        &self,
        request_id: &str,
        expected_workspace_id: Option<&str>,
        expected_thread_id: Option<&str>,
        auth_token: String,
        current_user_id: String,
        trace_id: Option<String>,
    ) -> Result<Option<AgentLaunchResponse>, String> {
        let Some(row) = self.telemetry().get_agent_launch_request(request_id)? else {
            return Ok(None);
        };
        if expected_workspace_id.is_some_and(|workspace_id| row.workspace_id != workspace_id)
            || expected_thread_id
                .is_some_and(|thread_id| row.thread_id.as_deref() != Some(thread_id))
        {
            return Err(format!(
                "Launch request {request_id} belongs to a different thread."
            ));
        }
        if let Some(response) = self.response_from_existing(&row)? {
            self.telemetry()
                .reconcile_agent_launch_request_accepted(request_id)?;
            return Ok(Some(response));
        }
        if row.status == "failed" {
            return Err(row
                .failure_reason
                .unwrap_or_else(|| "The existing launch request failed.".to_string()));
        }
        let lease_active = row
            .lease_expires_at
            .is_some_and(|expires_at| expires_at > chrono::Utc::now().timestamp());
        if lease_active {
            return self.existing_snapshot(&row).map(Some);
        }

        let (mut request, _) = decode_durable_record(&row.request_json)?;
        request.auth_token = auth_token;
        request.current_user_id = current_user_id;
        request.trace_id = trace_id;
        self.launch(request).await.map(Some)
    }

    async fn recover_expired(&self) -> Result<usize, String> {
        let rows = self
            .telemetry()
            .list_expired_agent_launch_requests(RECOVERY_BATCH_SIZE)?;
        if rows.is_empty() {
            return Ok(0);
        }
        let identity = self.telemetry().get_local_identity()?;
        let auth_token = crate::mcp::current_mcp_auth_token()?.unwrap_or_default();
        let mut recovered = 0;
        for row in rows {
            match self
                .resume_existing(
                    &row.request_id,
                    Some(&row.workspace_id),
                    row.thread_id.as_deref(),
                    auth_token.clone(),
                    identity.local_user_id.clone(),
                    None,
                )
                .await
            {
                Ok(Some(_)) => recovered += 1,
                Ok(None) => {}
                Err(error) => crate::app_log!(
                    "[AGENT_LAUNCH_RECOVERY] event=request.failed request_id={} err={}",
                    row.request_id,
                    error
                ),
            }
        }
        Ok(recovered)
    }

    fn spawn_lease_heartbeat(
        &self,
        request_id: &str,
        lease_owner: &str,
    ) -> tokio::task::JoinHandle<()> {
        let app = self.app.clone();
        let request_id = request_id.to_string();
        let lease_owner = lease_owner.to_string();
        tokio::spawn(async move {
            let interval_seconds = (LAUNCH_LEASE_SECONDS / 3).max(1) as u64;
            let mut interval =
                tokio::time::interval(std::time::Duration::from_secs(interval_seconds));
            interval.tick().await;
            loop {
                interval.tick().await;
                let renewed = app.state::<TelemetryDb>().renew_agent_launch_request_lease(
                    &request_id,
                    &lease_owner,
                    LAUNCH_LEASE_SECONDS,
                );
                if !matches!(renewed, Ok(true)) {
                    break;
                }
            }
        })
    }

    async fn launch_claimed(
        &self,
        request: &AgentLaunchRequest,
        plan: LaunchPlan,
        lease_owner: &str,
    ) -> Result<AgentLaunchResponse, String> {
        let (user_node, assistant_node, execution_data) = build_persisted_nodes(request, &plan)?;
        self.telemetry().upsert_local_node(
            &request.user_node_id,
            &request.workspace_id,
            &user_node.to_string(),
        )?;
        self.telemetry().upsert_local_node(
            &request.assistant_node_id,
            &request.workspace_id,
            &assistant_node.to_string(),
        )?;
        self.telemetry().update_agent_launch_request(
            &request.request_id,
            lease_owner,
            "starting",
            None,
        )?;
        self.emit_changed(request);

        let workspace = self
            .telemetry()
            .get_local_workspace_by_id(&request.workspace_id)?
            .ok_or_else(|| format!("Workspace {} does not exist.", request.workspace_id))?;
        let repo_path = self.telemetry().resolve_trusted_local_workspace_repo_path(
            &request.workspace_id,
            &request.current_user_id,
            workspace.local_repo_path.as_deref(),
        )?;
        let intent = StartAgentRunIntent {
            run_id: request.run_id.clone(),
            assistant_node_id: request.assistant_node_id.clone(),
            workspace_id: Some(request.workspace_id.clone()),
            repo_path: repo_path.clone(),
            parent_commit: request.base_commit.clone(),
            agent_type: request.agent_type.clone(),
            args: plan.args,
            auth_token: request.auth_token.clone(),
            current_user_id: request.current_user_id.clone(),
            trace_id: request.trace_id.clone(),
            run_context: AgentRunContext {
                run_id: request.run_id.clone(),
                execution_data,
                git_branch_name: Some(format!("agentree/{}", request.assistant_node_id)),
                repo_path: Some(repo_path),
                parent_commit: Some(request.base_commit.clone()),
                author_name: request.agent_name.clone(),
                prompt_fallback: Some(request.user_prompt.clone()),
                auth_user_id: Some(request.current_user_id.clone()),
            },
            login_profile_id: request.login_profile_id.clone(),
        };
        let started = crate::agents::start_agent_run_internal(self.app.clone(), intent).await?;
        self.telemetry().update_agent_launch_request(
            &request.request_id,
            lease_owner,
            "accepted",
            None,
        )?;
        self.emit_changed(request);
        Ok(response_from_started(request, started, plan.context, false))
    }

    fn build_plan(&self, request: &AgentLaunchRequest) -> Result<LaunchPlan, String> {
        let nodes = self.workspace_nodes(&request.workspace_id)?;
        let context_parent = request
            .context_parent_node_id
            .as_deref()
            .or(request.base_node_id.as_deref())
            .and_then(|id| {
                nodes
                    .iter()
                    .find(|node| node_id(node).as_deref() == Some(id))
            });
        let parent_meta = context_parent.map(node_meta).unwrap_or(&JsonValue::Null);
        let parent_provider = value_string(context_parent, "llmProvider")
            .or_else(|| value_string(Some(parent_meta), "provider"));
        let parent_thread_id = value_string(Some(parent_meta), "provider_thread_id");
        let parent_turn_id = value_string(Some(parent_meta), "provider_turn_id");
        let parent_lineage_id = value_string(Some(parent_meta), "provider_lineage_id")
            .or_else(|| parent_thread_id.clone());
        let branch_target = request
            .context_parent_node_id
            .as_deref()
            .or(request.base_node_id.as_deref());
        let is_branch_from_interior = branch_target
            .map(|target| has_conversation_child(target, &nodes, request))
            .unwrap_or(false);
        let context_text = context_text(request, context_parent, &nodes);
        let has_context = !context_text.trim().is_empty();
        let routing = resolve_provider_routing(
            parent_provider.as_deref(),
            parent_thread_id.as_deref(),
            &request.agent_type,
            is_branch_from_interior,
            &request.context_policy,
            &request.context_mode,
            has_context,
        );
        let strategy = routing.strategy;
        let requested_strategy = routing.requested_strategy;
        let routing_mode = routing.context_mode;
        let routing_reason = routing.reason;
        let inject_context = routing.inject_context;
        let prompt = self.build_prompt(request, &context_text, inject_context)?;
        let mut provider_args = vec![
            "--provider-thread-strategy".to_string(),
            strategy.to_string(),
        ];
        if strategy == "resume" {
            if let Some(thread_id) = parent_thread_id.as_ref() {
                provider_args.extend(["--provider-thread-id".to_string(), thread_id.clone()]);
            }
        } else if strategy == "fork_at_turn" {
            if let Some(thread_id) = parent_thread_id.as_ref() {
                provider_args
                    .extend(["--source-provider-thread-id".to_string(), thread_id.clone()]);
            }
            if let Some(lineage_id) = parent_lineage_id.as_ref() {
                provider_args.extend([
                    "--source-provider-lineage-id".to_string(),
                    lineage_id.clone(),
                ]);
            }
            if let Some(turn_id) = parent_turn_id.as_ref() {
                provider_args.extend(["--target-provider-turn-id".to_string(), turn_id.clone()]);
            }
        }
        if let Some(target_id) = request.base_node_id.as_ref() {
            provider_args.extend(["--target-node-id".to_string(), target_id.clone()]);
        }
        provider_args.extend(["--node-id".to_string(), request.assistant_node_id.clone()]);
        if matches!(request.agent_type.as_str(), "codex" | "opencode") {
            if let Some(artifacts_json) = provider_image_artifacts_json(request) {
                provider_args.extend(["--input-artifacts-json".to_string(), artifacts_json]);
            }
        }
        let args = build_runtime_args(request, provider_args, &prompt);
        let source_thread_id = (strategy != "fresh_thread")
            .then(|| parent_thread_id.clone())
            .flatten();
        let source_turn_id = (strategy != "fresh_thread")
            .then(|| parent_turn_id.clone())
            .flatten();
        let source_lineage_id = (strategy != "fresh_thread")
            .then(|| parent_lineage_id.clone())
            .flatten();
        let available_chars = context_text.trim().len();
        let injected_chars = if inject_context { available_chars } else { 0 };
        let context = AgentLaunchContext {
            provider_thread_strategy: strategy.to_string(),
            provider_thread_strategy_requested: requested_strategy.to_string(),
            provider_context_routing_mode: routing_mode.to_string(),
            provider_context_routing_reason: routing_reason.to_string(),
            parent_provider: parent_provider.clone(),
            parent_provider_thread_id: parent_thread_id.clone(),
            parent_provider_turn_id: parent_turn_id.clone(),
            parent_provider_lineage_id: parent_lineage_id.clone(),
            is_branch_from_interior,
            agentree_context_available_chars: available_chars,
            agentree_context_injected_chars: injected_chars,
        };
        let mut meta = JsonMap::new();
        meta.insert("provider".to_string(), json!(request.agent_type));
        meta.insert("provider_thread_strategy".to_string(), json!(strategy));
        meta.insert(
            "provider_thread_strategy_requested".to_string(),
            json!(requested_strategy),
        );
        meta.insert(
            "provider_thread_resume_enabled".to_string(),
            json!(strategy == "resume"),
        );
        meta.insert(
            "provider_context_routing_mode".to_string(),
            json!(routing_mode),
        );
        meta.insert(
            "provider_context_routing_reason".to_string(),
            json!(routing_reason),
        );
        meta.insert(
            "provider_parent_provider".to_string(),
            json!(parent_provider),
        );
        meta.insert("provider_thread_id".to_string(), json!(source_thread_id));
        meta.insert(
            "provider_source_thread_id".to_string(),
            json!(source_thread_id),
        );
        meta.insert("provider_source_turn_id".to_string(), json!(source_turn_id));
        meta.insert("provider_lineage_id".to_string(), json!(source_lineage_id));
        meta.insert(
            "provider_parent_thread_id_available".to_string(),
            json!(parent_thread_id),
        );
        meta.insert(
            "provider_parent_turn_id_available".to_string(),
            json!(parent_turn_id),
        );
        meta.insert(
            "provider_target_turn_id".to_string(),
            if strategy == "fork_at_turn" {
                json!(parent_turn_id)
            } else {
                JsonValue::Null
            },
        );
        meta.insert(
            "agentree_context_available_chars".to_string(),
            json!(available_chars),
        );
        meta.insert(
            "agentree_context_injected_chars".to_string(),
            json!(injected_chars),
        );
        meta.insert(
            "agentree_context_injected".to_string(),
            json!(inject_context),
        );
        meta.insert("launch_request_id".to_string(), json!(request.request_id));
        if request.agent_type == "claude" {
            if let Some(session_id) = read_arg_value(&args, "--session-id") {
                meta.insert("agent_session_id".to_string(), json!(session_id));
                meta.insert("agent_session_provider".to_string(), json!("claude"));
            }
        }
        Ok(LaunchPlan {
            args,
            context,
            meta,
        })
    }

    fn validate_graph_scope(&self, request: &AgentLaunchRequest) -> Result<(), String> {
        if let Some(thread_id) = request.thread_id.as_deref() {
            let thread = self
                .telemetry()
                .get_thread_session_by_id(thread_id)?
                .ok_or_else(|| format!("Thread {thread_id} does not exist."))?;
            if thread.workspace_id != request.workspace_id {
                return Err(format!(
                    "Thread {thread_id} does not belong to workspace {}.",
                    request.workspace_id
                ));
            }
        }

        let mut checked = HashSet::new();
        for node_id in [
            request.parent_node_id.as_deref(),
            request.context_parent_node_id.as_deref(),
            request.base_node_id.as_deref(),
        ]
        .into_iter()
        .flatten()
        {
            if !checked.insert(node_id) {
                continue;
            }
            let (workspace_id, payload) = self
                .telemetry()
                .get_local_node_workspace_and_payload(node_id)?
                .ok_or_else(|| format!("Node {node_id} does not exist."))?;
            if workspace_id != request.workspace_id {
                return Err(format!(
                    "Node {node_id} does not belong to workspace {}.",
                    request.workspace_id
                ));
            }
            let payload: JsonValue = serde_json::from_str(&payload)
                .map_err(|error| format!("Node {node_id} has invalid persisted data: {error}"))?;
            if let (Some(expected), Some(actual)) = (
                request.thread_id.as_deref(),
                node_thread_id(&payload).as_deref(),
            ) {
                if actual != expected {
                    return Err(format!("Node {node_id} belongs to a different thread."));
                }
            }
        }

        Ok(())
    }

    fn build_prompt(
        &self,
        request: &AgentLaunchRequest,
        context_text: &str,
        inject_context: bool,
    ) -> Result<String, String> {
        let mut body = if inject_context {
            self.effective_prompt(
                "agentree_context_envelope",
                &[
                    ("contextText", context_text),
                    ("userPrompt", &request.user_prompt),
                ],
            )?
        } else {
            request.user_prompt.clone()
        };
        let title_prompt = match request.thread_title_mode.as_deref() {
            Some("first_thread_message") => Some("thread_title_first"),
            Some("none") => Some("thread_title_none"),
            _ => None,
        };
        if let Some(id) = title_prompt {
            body.push_str("\n\n");
            body.push_str(&self.effective_prompt(id, &[])?);
        }
        body.push_str("\n\n");
        body.push_str(&self.effective_prompt("delegation_control", &[])?);
        body.push_str("\n\n");
        body.push_str(&self.effective_prompt("rlm_loop", &[])?);
        Ok(format!(
            "{}\n\n{}\n\n{}",
            self.effective_prompt("dependency_guard", &[])?,
            self.effective_prompt("artifact_path", &[])?,
            body
        ))
    }

    fn effective_prompt(&self, id: &str, vars: &[(&str, &str)]) -> Result<String, String> {
        let definitions: Vec<DefaultPromptDefinition> =
            serde_json::from_str(DEFAULT_PROMPT_DEFINITIONS_JSON)
                .map_err(|error| format!("Invalid built-in prompt definitions: {error}"))?;
        let fallback = definitions
            .into_iter()
            .find(|definition| definition.id == id)
            .map(|definition| definition.default_text)
            .ok_or_else(|| format!("Unknown default prompt {id}."))?;
        let override_text = self
            .telemetry()
            .local_app_kv_get("default_prompt_overrides")?
            .and_then(|raw| serde_json::from_str::<Vec<JsonValue>>(&raw).ok())
            .and_then(|overrides| {
                overrides.into_iter().find_map(|value| {
                    (value_string(Some(&value), "id").as_deref() == Some(id))
                        .then(|| value_string(Some(&value), "text"))
                        .flatten()
                })
            })
            .unwrap_or(fallback);
        Ok(vars.iter().fold(override_text, |text, (key, value)| {
            text.replace(&format!("{{{{{key}}}}}"), value)
        }))
    }

    fn response_from_existing(
        &self,
        row: &AgentLaunchRequestRow,
    ) -> Result<Option<AgentLaunchResponse>, String> {
        debug_assert!(!row.request_id.is_empty());
        if let Some(ledger) = self
            .telemetry()
            .get_agent_run_ledger_by_assistant(&row.assistant_node_id)?
        {
            let (request, stored_plan) = decode_durable_record(&row.request_json)?;
            let context = match stored_plan {
                Some(plan) => plan.context,
                None => self.build_plan(&request)?.context,
            };
            return Ok(Some(AgentLaunchResponse {
                run_id: ledger.run_id,
                user_node_id: row.user_node_id.clone(),
                assistant_node_id: row.assistant_node_id.clone(),
                worktree_path: ledger.worktree_path,
                branch_name: ledger.branch_name,
                pid: ledger.pid,
                initial_status: ledger.terminal_status.unwrap_or(ledger.status),
                existing: true,
                launch_context: context,
            }));
        }
        if row.status == "failed" {
            return Err(row
                .failure_reason
                .clone()
                .unwrap_or_else(|| "The existing launch request failed.".to_string()));
        }
        Ok(None)
    }

    fn existing_snapshot(
        &self,
        row: &AgentLaunchRequestRow,
    ) -> Result<AgentLaunchResponse, String> {
        let (request, stored_plan) = decode_durable_record(&row.request_json)?;
        let context = match stored_plan {
            Some(plan) => plan.context,
            None => self.build_plan(&request)?.context,
        };
        Ok(AgentLaunchResponse {
            run_id: row.run_id.clone(),
            user_node_id: row.user_node_id.clone(),
            assistant_node_id: row.assistant_node_id.clone(),
            worktree_path: None,
            branch_name: None,
            pid: None,
            initial_status: row.status.clone(),
            existing: true,
            launch_context: context,
        })
    }

    fn mark_failed(&self, request: &AgentLaunchRequest, error: &str) -> Result<(), String> {
        if self
            .telemetry()
            .get_local_node_payload(&request.user_node_id)?
            .is_none()
        {
            let mut user = request.user_node.clone();
            strip_optimistic_ui_fields(&mut user);
            user["updatedAt"] = json!(now_iso());
            self.telemetry().upsert_local_node(
                &request.user_node_id,
                &request.workspace_id,
                &user.to_string(),
            )?;
        }
        let mut node = self
            .telemetry()
            .get_local_node_payload(&request.assistant_node_id)?
            .and_then(|raw| serde_json::from_str::<JsonValue>(&raw).ok())
            .unwrap_or_else(|| request.assistant_node.clone());
        strip_optimistic_ui_fields(&mut node);
        node["status"] = json!("failed_spawn");
        node["updatedAt"] = json!(now_iso());
        if node
            .get("execution_data")
            .and_then(JsonValue::as_object)
            .is_none()
        {
            node["execution_data"] = json!({ "meta": {} });
        }
        node["execution_data"]["last_terminal_status"] = json!("failed_spawn");
        node["execution_data"]["failure_reason"] = json!(error);
        node["execution_data"]["meta"]["launch_request_id"] = json!(request.request_id);
        self.telemetry().upsert_local_node(
            &request.assistant_node_id,
            &request.workspace_id,
            &node.to_string(),
        )
    }

    fn workspace_nodes(&self, workspace_id: &str) -> Result<Vec<JsonValue>, String> {
        Ok(self
            .telemetry()
            .list_local_nodes_for_workspace(workspace_id)?
            .into_iter()
            .filter_map(|row| serde_json::from_str::<JsonValue>(&row.payload).ok())
            .collect())
    }

    fn telemetry(&self) -> tauri::State<'_, TelemetryDb> {
        self.app.state::<TelemetryDb>()
    }

    fn emit_changed(&self, request: &AgentLaunchRequest) {
        let _ = self.app.emit(
            "thread-control:changed",
            json!({ "workspaceId": request.workspace_id, "threadId": request.thread_id }),
        );
    }
}

#[tauri::command]
#[specta::specta]
pub async fn launch_agent_message(
    app: AppHandle,
    request: AgentLaunchRequest,
) -> Result<AgentLaunchResponse, String> {
    AgentLaunchService::new(app).launch(request).await
}

pub(crate) fn start_agent_launch_recovery(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        // Give the frontend a chance to refresh the optional Agentree Cloud token.
        // Provider credentials themselves are restored from the persisted login profile.
        tokio::time::sleep(std::time::Duration::from_secs(
            RECOVERY_STARTUP_GRACE_SECONDS,
        ))
        .await;
        let mut interval =
            tokio::time::interval(std::time::Duration::from_secs(RECOVERY_POLL_SECONDS));
        loop {
            interval.tick().await;
            match AgentLaunchService::new(app.clone()).recover_expired().await {
                Ok(count) if count > 0 => crate::app_log!(
                    "[AGENT_LAUNCH_RECOVERY] event=batch.recovered count={}",
                    count
                ),
                Err(error) => {
                    crate::app_log!("[AGENT_LAUNCH_RECOVERY] event=batch.failed err={}", error)
                }
                _ => {}
            }
        }
    });
}

fn decode_durable_record(raw: &str) -> Result<(AgentLaunchRequest, Option<LaunchPlan>), String> {
    if let Ok(record) = serde_json::from_str::<DurableLaunchRecord>(raw) {
        return Ok((record.request, Some(record.plan)));
    }
    serde_json::from_str::<AgentLaunchRequest>(raw)
        .map(|request| (request, None))
        .map_err(|error| format!("Stored launch request is invalid: {error}"))
}

fn validate_existing_request_identity(
    existing: &AgentLaunchRequestRow,
    incoming: &AgentLaunchRequest,
) -> Result<(), String> {
    if existing.workspace_id != incoming.workspace_id
        || existing.thread_id != incoming.thread_id
        || existing.user_node_id != incoming.user_node_id
        || existing.assistant_node_id != incoming.assistant_node_id
        || existing.run_id != incoming.run_id
    {
        return Err(format!(
            "Launch request {} was already used with different launch parameters.",
            incoming.request_id
        ));
    }
    Ok(())
}

fn validate_request(request: &AgentLaunchRequest) -> Result<(), String> {
    for (name, value) in [
        ("requestId", request.request_id.as_str()),
        ("runId", request.run_id.as_str()),
        ("workspaceId", request.workspace_id.as_str()),
        ("baseCommit", request.base_commit.as_str()),
        ("userNodeId", request.user_node_id.as_str()),
        ("assistantNodeId", request.assistant_node_id.as_str()),
        ("userPrompt", request.user_prompt.as_str()),
        ("agentType", request.agent_type.as_str()),
        ("currentUserId", request.current_user_id.as_str()),
    ] {
        if value.trim().is_empty() {
            return Err(format!("{name} is required."));
        }
    }
    if !matches!(request.agent_type.as_str(), "codex" | "claude" | "opencode") {
        return Err("agentType must be codex, claude, or opencode.".to_string());
    }
    if node_id(&request.user_node).as_deref() != Some(request.user_node_id.as_str())
        || node_id(&request.assistant_node).as_deref() != Some(request.assistant_node_id.as_str())
    {
        return Err("Preallocated node payload IDs do not match the launch request.".to_string());
    }
    if value_string(Some(&request.user_node), "role").as_deref() != Some("user")
        || value_string(Some(&request.assistant_node), "role").as_deref() != Some("assistant")
    {
        return Err("Preallocated node payload roles do not match the launch request.".to_string());
    }
    if value_string(Some(&request.user_node), "parentId").as_deref()
        != request.parent_node_id.as_deref()
    {
        return Err("The user node parent does not match parentNodeId.".to_string());
    }
    if value_string(Some(&request.assistant_node), "parentId").as_deref()
        != Some(request.user_node_id.as_str())
    {
        return Err(
            "The assistant node must be a child of the preallocated user node.".to_string(),
        );
    }
    for (label, node) in [
        ("user", &request.user_node),
        ("assistant", &request.assistant_node),
    ] {
        if let Some(workspace_id) = value_string(Some(node), "workspaceId") {
            if workspace_id != request.workspace_id {
                return Err(format!(
                    "The {label} node belongs to a different workspace."
                ));
            }
        }
        if let (Some(expected), Some(actual)) = (
            request.thread_id.as_deref(),
            node_thread_id(node).as_deref(),
        ) {
            if actual != expected {
                return Err(format!("The {label} node belongs to a different thread."));
            }
        }
    }
    Ok(())
}

fn build_persisted_nodes(
    request: &AgentLaunchRequest,
    plan: &LaunchPlan,
) -> Result<(JsonValue, JsonValue, JsonValue), String> {
    let mut user = request.user_node.clone();
    let mut assistant = request.assistant_node.clone();
    ensure_object(&mut user)?;
    ensure_object(&mut assistant)?;
    strip_optimistic_ui_fields(&mut user);
    strip_optimistic_ui_fields(&mut assistant);
    user["workspaceId"] = json!(request.workspace_id);
    user["threadId"] = json!(request.thread_id);
    user["thread_id"] = json!(request.thread_id);
    assistant["workspaceId"] = json!(request.workspace_id);
    assistant["threadId"] = json!(request.thread_id);
    assistant["thread_id"] = json!(request.thread_id);
    assistant["status"] = json!("pending");
    assistant["base_commit_sha"] = json!(request.base_commit);
    assistant["base_selected_from_node_id"] = json!(request.base_node_id);
    let now = now_iso();
    if user.get("createdAt").and_then(JsonValue::as_str).is_none() {
        user["createdAt"] = json!(now);
    }
    if assistant
        .get("createdAt")
        .and_then(JsonValue::as_str)
        .is_none()
    {
        assistant["createdAt"] = json!(now);
    }
    user["updatedAt"] = json!(now);
    assistant["updatedAt"] = json!(now);
    merge_meta(&mut user, &plan.meta)?;
    merge_meta(&mut assistant, &plan.meta)?;
    let execution_data = {
        let execution_data = assistant
            .get_mut("execution_data")
            .and_then(JsonValue::as_object_mut)
            .ok_or_else(|| "assistantNode.execution_data must be an object.".to_string())?;
        execution_data.insert("current_run_id".to_string(), json!(request.run_id));
        execution_data.insert("workspace_id".to_string(), json!(request.workspace_id));
        execution_data.insert("parentId".to_string(), json!(request.user_node_id));
        execution_data.insert("started_at".to_string(), json!(now));
        if let Some(agent_id) = request.agent_id.as_ref() {
            execution_data.insert("agent_id".to_string(), json!(agent_id));
        }
        JsonValue::Object(execution_data.clone())
    };
    Ok((user, assistant, execution_data))
}

fn strip_optimistic_ui_fields(node: &mut JsonValue) {
    let Some(object) = node.as_object_mut() else {
        return;
    };
    for key in [
        "_optimistic",
        "_optimisticStatus",
        "_optimisticError",
        "_setupProgress",
        "_rollbackOnFail",
        "_terminalHoldUntil",
        "_terminalContentLength",
    ] {
        object.remove(key);
    }
}

fn merge_meta(node: &mut JsonValue, meta: &JsonMap<String, JsonValue>) -> Result<(), String> {
    let execution = node
        .get_mut("execution_data")
        .and_then(JsonValue::as_object_mut)
        .ok_or_else(|| "Node execution_data must be an object.".to_string())?;
    let destination = execution
        .entry("meta".to_string())
        .or_insert_with(|| json!({}))
        .as_object_mut()
        .ok_or_else(|| "Node execution_data.meta must be an object.".to_string())?;
    destination.extend(meta.clone());
    Ok(())
}

fn ensure_object(value: &mut JsonValue) -> Result<(), String> {
    value
        .as_object_mut()
        .map(|_| ())
        .ok_or_else(|| "Node payload must be an object.".to_string())
}

fn response_from_started(
    request: &AgentLaunchRequest,
    started: StartAgentRunResponse,
    context: AgentLaunchContext,
    existing: bool,
) -> AgentLaunchResponse {
    AgentLaunchResponse {
        run_id: started.run_id,
        user_node_id: request.user_node_id.clone(),
        assistant_node_id: started.assistant_node_id,
        worktree_path: Some(started.worktree_path),
        branch_name: Some(started.branch_name),
        pid: started.pid.map(i64::from),
        initial_status: started.initial_status,
        existing,
        launch_context: context,
    }
}

fn resolve_provider_routing(
    parent_provider: Option<&str>,
    parent_thread_id: Option<&str>,
    selected_provider: &str,
    is_branch_from_interior: bool,
    context_policy: &str,
    context_mode: &str,
    has_context: bool,
) -> ProviderRouting {
    if context_policy == "fresh" {
        return ProviderRouting {
            strategy: "fresh_thread",
            requested_strategy: "fresh_thread",
            context_mode: "none",
            reason: "fresh_context",
            inject_context: false,
        };
    }
    if context_mode == "none" {
        return ProviderRouting {
            strategy: "fresh_thread",
            requested_strategy: "fresh_thread",
            context_mode: "none",
            reason: "context_mode_none",
            inject_context: false,
        };
    }
    let same_provider_thread =
        parent_provider == Some(selected_provider) && parent_thread_id.is_some();
    if same_provider_thread {
        let strategy = if is_branch_from_interior {
            "fork_at_turn"
        } else {
            "resume"
        };
        return ProviderRouting {
            strategy,
            requested_strategy: strategy,
            context_mode: "provider_native_only",
            reason: "same_provider_thread_reuse",
            inject_context: false,
        };
    }
    if parent_provider.is_some() && parent_provider != Some(selected_provider) {
        return ProviderRouting {
            strategy: "fresh_thread",
            requested_strategy: "cross_provider_fresh_thread",
            context_mode: "cross_provider_packet",
            reason: "cross_provider_fresh_thread",
            inject_context: has_context,
        };
    }
    if has_context {
        return ProviderRouting {
            strategy: "fresh_thread",
            requested_strategy: "fresh_thread",
            context_mode: "agentree_context",
            reason: "fresh_thread_with_selected_context",
            inject_context: true,
        };
    }
    ProviderRouting {
        strategy: "fresh_thread",
        requested_strategy: "fresh_thread",
        context_mode: "none",
        reason: "no_selected_context",
        inject_context: false,
    }
}

fn context_text(
    request: &AgentLaunchRequest,
    context_parent: Option<&JsonValue>,
    nodes: &[JsonValue],
) -> String {
    if request.context_policy == "fresh" || request.context_mode == "none" {
        return String::new();
    }
    if let Some(text) = request
        .context_manifest
        .get("contextText")
        .and_then(JsonValue::as_str)
        .filter(|value| !value.trim().is_empty())
    {
        return text.to_string();
    }
    let Some(parent) = context_parent else {
        return String::new();
    };
    let path_ids: HashSet<String> = node_path_ids(parent).into_iter().collect();
    let mut context_nodes: Vec<&JsonValue> = nodes
        .iter()
        .filter(|node| {
            node_id(node)
                .map(|id| path_ids.contains(&id))
                .unwrap_or(false)
                && !is_commit_node(node)
        })
        .collect();
    context_nodes.sort_by_key(|node| value_string(Some(node), "createdAt").unwrap_or_default());
    context_nodes
        .into_iter()
        .filter_map(|node| {
            let content = value_string(Some(node), "content")?;
            (!content.trim().is_empty()).then(|| {
                let role =
                    value_string(Some(node), "role").unwrap_or_else(|| "assistant".to_string());
                format!(
                    "{}: {}",
                    if role == "user" { "User" } else { "Assistant" },
                    content
                )
            })
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}

fn has_conversation_child(
    parent_id: &str,
    nodes: &[JsonValue],
    request: &AgentLaunchRequest,
) -> bool {
    nodes.iter().any(|node| {
        let id = node_id(node);
        if id.as_deref() == Some(request.user_node_id.as_str())
            || id.as_deref() == Some(request.assistant_node_id.as_str())
        {
            return false;
        }
        if let (Some(expected), Some(actual)) = (
            request.thread_id.as_deref(),
            node_thread_id(node).as_deref(),
        ) {
            if actual != expected {
                return false;
            }
        }
        value_string(Some(node), "parentId").as_deref() == Some(parent_id) && !is_commit_node(node)
    })
}

fn is_commit_node(node: &JsonValue) -> bool {
    if value_string(Some(node), "role").as_deref() != Some("assistant") {
        return false;
    }
    if matches!(
        value_string(Some(node), "node_kind")
            .or_else(|| value_string(Some(node), "nodeKind"))
            .as_deref(),
        Some("commit")
    ) {
        return true;
    }
    if node
        .get("commit")
        .and_then(|commit| commit.get("sha"))
        .and_then(JsonValue::as_str)
        .is_some()
    {
        return true;
    }
    node.get("commit")
        .and_then(|commit| commit.get("source_kind"))
        .and_then(JsonValue::as_str)
        == Some("external")
        || value_string(Some(node_meta(node)), "sync_source").as_deref() == Some("external_git")
}

fn build_runtime_args(
    request: &AgentLaunchRequest,
    provider_args: Vec<String>,
    prompt: &str,
) -> Vec<String> {
    let mut args: Vec<String> = request
        .agent_cli_args
        .as_deref()
        .unwrap_or_default()
        .split_whitespace()
        .map(str::to_string)
        .collect();
    let mut cleaned = Vec::new();
    let mut index = 0;
    while index < args.len() {
        let arg = &args[index];
        if matches!(
            arg.as_str(),
            "--model" | "--reasoning-effort" | "--effort" | "--variant"
        ) {
            index += 2;
            continue;
        }
        if arg.starts_with("--model=")
            || arg.starts_with("--reasoning-effort=")
            || arg.starts_with("--effort=")
            || arg.starts_with("--variant=")
        {
            index += 1;
            continue;
        }
        if arg == "--permission-mode" {
            index += 2;
            continue;
        }
        if arg == "--dangerously-skip-permissions" {
            index += 1;
            continue;
        }
        if request.agent_type == "claude" && arg == "--output-format" {
            index += 2;
            continue;
        }
        if request.agent_type == "claude"
            && matches!(
                arg.as_str(),
                "-p" | "--print" | "--verbose" | "--no-session-persistence"
            )
        {
            index += 1;
            continue;
        }
        cleaned.push(arg.clone());
        index += 1;
    }
    args = cleaned;
    if let Some(model) = request.model.as_deref() {
        args.extend([
            "--model".to_string(),
            cli_model_alias(&request.agent_type, model),
        ]);
    }
    if let Some(effort) = request.reasoning_effort.as_ref() {
        args.extend([
            match request.agent_type.as_str() {
                "claude" => "--effort",
                "opencode" => "--variant",
                _ => "--reasoning-effort",
            }
            .to_string(),
            effort.clone(),
        ]);
    }
    if request.agent_type == "claude" && !args.iter().any(|arg| arg == "--session-id") {
        args.extend(["--session-id".to_string(), Uuid::new_v4().to_string()]);
    }
    args.extend([
        "--permission-mode".to_string(),
        provider_permission_mode(&request.agent_type, &request.permission_mode),
    ]);
    args.extend(provider_args);
    if request.agent_type != "codex" {
        if let Some(flag) = request.agent_prompt_flag.as_ref() {
            args.push(flag.clone());
        }
    }
    args.push(prompt.to_string());
    args
}

fn cli_model_alias(provider: &str, model: &str) -> String {
    match (provider, model) {
        ("claude", "claude-opus-5") => "opus".to_string(),
        ("claude", "claude-sonnet-5") => "sonnet".to_string(),
        _ => model.to_string(),
    }
}

fn read_arg_value(args: &[String], flag: &str) -> Option<String> {
    let index = args.iter().position(|arg| arg == flag)?;
    args.get(index + 1)
        .filter(|value| !value.starts_with("--"))
        .cloned()
}

fn provider_permission_mode(provider: &str, mode: &str) -> String {
    if provider != "claude" {
        return mode.to_string();
    }
    match mode {
        "fully-isolated" => "default",
        "safe-write" => "acceptEdits",
        _ => "bypassPermissions",
    }
    .to_string()
}

fn provider_image_artifacts_json(request: &AgentLaunchRequest) -> Option<String> {
    let supports_images = request
        .model_capabilities
        .get("inputModalities")
        .and_then(JsonValue::as_array)
        .map(|values| values.iter().any(|value| value.as_str() == Some("image")))
        .unwrap_or(false);
    if !supports_images {
        return None;
    }
    let artifacts = request
        .context_manifest
        .get("artifactInputs")
        .and_then(JsonValue::as_array)?;
    let images: Vec<JsonValue> = artifacts
        .iter()
        .filter(|artifact| {
            value_string(Some(artifact), "mimeType")
                .map(|mime| mime.starts_with("image/"))
                .unwrap_or(false)
                || matches!(
                    value_string(Some(artifact), "kind").as_deref(),
                    Some("image") | Some("screenshot")
                )
        })
        .map(sanitize_provider_artifact)
        .collect();
    (!images.is_empty())
        .then(|| serde_json::to_string(&images).ok())
        .flatten()
}

fn sanitize_provider_artifact(artifact: &JsonValue) -> JsonValue {
    let mut sanitized = JsonMap::new();
    for key in [
        "id",
        "nodeId",
        "role",
        "kind",
        "mimeType",
        "title",
        "filename",
        "width",
        "height",
        "sizeBytes",
    ] {
        if let Some(value) = artifact.get(key).filter(|value| !value.is_null()) {
            sanitized.insert(key.to_string(), value.clone());
        }
    }

    if let Some(storage) = artifact.get("storage").and_then(JsonValue::as_object) {
        let mut sanitized_storage = JsonMap::new();
        for key in ["backend", "path", "key"] {
            if let Some(value) = storage.get(key).filter(|value| !value.is_null()) {
                sanitized_storage.insert(key.to_string(), value.clone());
            }
        }
        if let Some(url) = storage
            .get("url")
            .and_then(JsonValue::as_str)
            .filter(|url| !url.starts_with("data:"))
        {
            sanitized_storage.insert("url".to_string(), json!(url));
        }
        sanitized.insert("storage".to_string(), JsonValue::Object(sanitized_storage));
    }

    if let Some(thumbnail) = artifact.get("thumbnail") {
        let has_safe_url = thumbnail
            .get("url")
            .and_then(JsonValue::as_str)
            .is_some_and(|url| !url.starts_with("data:"));
        if has_safe_url {
            sanitized.insert("thumbnail".to_string(), thumbnail.clone());
        }
    }

    JsonValue::Object(sanitized)
}

fn node_id(node: &JsonValue) -> Option<String> {
    value_string(Some(node), "id")
}

fn node_thread_id(node: &JsonValue) -> Option<String> {
    value_string(Some(node), "threadId").or_else(|| value_string(Some(node), "thread_id"))
}

fn node_meta(node: &JsonValue) -> &JsonValue {
    node.get("execution_data")
        .and_then(|value| value.get("meta"))
        .unwrap_or(&JsonValue::Null)
}

fn node_path_ids(node: &JsonValue) -> Vec<String> {
    node.get("path_ids")
        .and_then(JsonValue::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(JsonValue::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

fn value_string(value: Option<&JsonValue>, key: &str) -> Option<String> {
    value?
        .get(key)
        .and_then(JsonValue::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plan() -> LaunchPlan {
        LaunchPlan {
            args: Vec::new(),
            context: AgentLaunchContext {
                provider_thread_strategy: "fresh_thread".to_string(),
                provider_thread_strategy_requested: "fresh_thread".to_string(),
                provider_context_routing_mode: "none".to_string(),
                provider_context_routing_reason: "fresh_context".to_string(),
                parent_provider: None,
                parent_provider_thread_id: None,
                parent_provider_turn_id: None,
                parent_provider_lineage_id: None,
                is_branch_from_interior: false,
                agentree_context_available_chars: 0,
                agentree_context_injected_chars: 0,
            },
            meta: JsonMap::new(),
        }
    }

    fn request(provider: &str) -> AgentLaunchRequest {
        AgentLaunchRequest {
            request_id: "request-1".to_string(),
            run_id: "run-1".to_string(),
            workspace_id: "workspace-1".to_string(),
            thread_id: Some("thread-1".to_string()),
            parent_node_id: Some("parent".to_string()),
            context_parent_node_id: Some("parent".to_string()),
            base_node_id: Some("parent".to_string()),
            base_commit: "abc123".to_string(),
            user_node_id: "user-1".to_string(),
            assistant_node_id: "assistant-1".to_string(),
            user_prompt: "Ship it".to_string(),
            agent_type: provider.to_string(),
            model: Some("model".to_string()),
            reasoning_effort: None,
            permission_mode: "safe-write".to_string(),
            login_profile_id: Some("profile".to_string()),
            agent_id: Some("agent".to_string()),
            agent_name: Some("Agent".to_string()),
            agent_cli_args: Some("--model model --permission-mode plan".to_string()),
            agent_prompt_flag: Some("-p".to_string()),
            auth_token: "token".to_string(),
            current_user_id: "user".to_string(),
            trace_id: None,
            context_policy: "continue".to_string(),
            context_mode: "active".to_string(),
            context_manifest: json!({}),
            model_capabilities: json!({}),
            thread_title_mode: Some("none".to_string()),
            user_node: json!({"id":"user-1","role":"user","parentId":"parent","workspaceId":"workspace-1","threadId":"thread-1","execution_data":{"meta":{}}}),
            assistant_node: json!({"id":"assistant-1","role":"assistant","parentId":"user-1","workspaceId":"workspace-1","threadId":"thread-1","execution_data":{"meta":{}}}),
        }
    }

    #[test]
    fn runtime_args_preserve_cli_config_and_replace_permissions() {
        let args = build_runtime_args(
            &request("codex"),
            vec![
                "--provider-thread-strategy".to_string(),
                "fresh_thread".to_string(),
            ],
            "prompt",
        );
        assert!(args
            .windows(2)
            .any(|pair| pair == ["--permission-mode", "safe-write"]));
        assert_eq!(args.last().map(String::as_str), Some("prompt"));
    }

    #[test]
    fn opencode_runtime_args_use_variants_and_replace_stale_effort_flags() {
        let mut opencode_request = request("opencode");
        opencode_request.model = Some("anthropic/claude-sonnet-4-5".to_string());
        opencode_request.reasoning_effort = Some("high".to_string());
        opencode_request.agent_cli_args =
            Some("--model stale/model --reasoning-effort low --variant minimal".to_string());

        let args = build_runtime_args(&opencode_request, Vec::new(), "prompt");
        assert!(args
            .windows(2)
            .any(|pair| { pair == ["--model", "anthropic/claude-sonnet-4-5"] }));
        assert!(args.windows(2).any(|pair| pair == ["--variant", "high"]));
        assert!(!args.iter().any(|arg| arg == "--reasoning-effort"));
        assert_eq!(args.iter().filter(|arg| *arg == "--variant").count(), 1);
    }

    #[test]
    fn current_claude_models_use_current_cli_aliases() {
        assert_eq!(cli_model_alias("claude", "claude-opus-5"), "opus");
        assert_eq!(cli_model_alias("claude", "claude-sonnet-5"), "sonnet");
        assert_eq!(
            cli_model_alias("claude", "claude-opus-4-8"),
            "claude-opus-4-8"
        );
    }

    #[test]
    fn durable_request_json_excludes_authentication() {
        let encoded = serde_json::to_string(&request("codex")).expect("serialize request");
        assert!(!encoded.contains("token"));
        let decoded: AgentLaunchRequest =
            serde_json::from_str(&encoded).expect("deserialize durable request");
        assert!(decoded.auth_token.is_empty());
    }

    #[test]
    fn durable_nodes_exclude_composer_optimistic_state() {
        let mut node = json!({
            "id": "user-1",
            "_optimistic": true,
            "_optimisticStatus": "pending",
            "_setupProgress": "Sending"
        });
        strip_optimistic_ui_fields(&mut node);
        assert!(node.get("_optimistic").is_none());
        assert!(node.get("_optimisticStatus").is_none());
        assert!(node.get("_setupProgress").is_none());
    }

    #[test]
    fn durable_execution_data_preserves_requested_agent_identity() {
        let request = request("codex");
        let (_, assistant, execution_data) =
            build_persisted_nodes(&request, &plan()).expect("persisted nodes");

        assert_eq!(execution_data["agent_id"], "agent");
        assert_eq!(assistant["execution_data"]["agent_id"], "agent");
    }

    #[test]
    fn provider_artifacts_drop_inline_data_and_unknown_fields() {
        let mut request = request("codex");
        request.model_capabilities = json!({ "inputModalities": ["text", "image"] });
        request.context_manifest = json!({
            "artifactInputs": [{
                "id": "image-1",
                "nodeId": "parent",
                "role": "user",
                "kind": "screenshot",
                "mimeType": "image/png",
                "title": "Screenshot",
                "filename": "screen.png",
                "storage": {
                    "backend": "local",
                    "path": "/tmp/screen.png",
                    "url": "data:image/png;base64,very-large-payload"
                },
                "thumbnail": { "url": "data:image/png;base64,thumbnail" },
                "unexpected": "do-not-forward"
            }]
        });

        let encoded = provider_image_artifacts_json(&request).expect("image args");
        let artifacts: Vec<JsonValue> = serde_json::from_str(&encoded).expect("valid json");
        let artifact = &artifacts[0];
        assert_eq!(artifact["storage"]["path"], "/tmp/screen.png");
        assert!(artifact["storage"].get("url").is_none());
        assert!(artifact.get("thumbnail").is_none());
        assert!(artifact.get("unexpected").is_none());
        assert!(!encoded.contains("base64"));
    }

    #[test]
    fn branch_detection_ignores_preallocated_nodes_and_commit_children() {
        let request = request("codex");
        let nodes = vec![
            json!({"id":"commit","parentId":"parent","role":"assistant","node_kind":"commit"}),
            json!({"id":"user-1","parentId":"parent"}),
        ];
        assert!(!has_conversation_child("parent", &nodes, &request));
        let nodes = vec![json!({"id":"existing-child","parentId":"parent","role":"user"})];
        assert!(has_conversation_child("parent", &nodes, &request));
    }

    #[test]
    fn provider_routing_forks_interior_same_provider_turns() {
        let routing = resolve_provider_routing(
            Some("codex"),
            Some("provider-thread"),
            "codex",
            true,
            "continue",
            "active",
            true,
        );
        assert_eq!(routing.strategy, "fork_at_turn");
        assert_eq!(routing.context_mode, "provider_native_only");
        assert!(!routing.inject_context);
    }

    #[test]
    fn provider_routing_resumes_leaf_and_packets_cross_provider_context() {
        let leaf = resolve_provider_routing(
            Some("claude"),
            Some("provider-thread"),
            "claude",
            false,
            "continue",
            "active",
            true,
        );
        assert_eq!(leaf.strategy, "resume");

        let cross_provider = resolve_provider_routing(
            Some("claude"),
            Some("provider-thread"),
            "codex",
            false,
            "continue",
            "active",
            true,
        );
        assert_eq!(cross_provider.strategy, "fresh_thread");
        assert_eq!(
            cross_provider.requested_strategy,
            "cross_provider_fresh_thread"
        );
        assert_eq!(cross_provider.context_mode, "cross_provider_packet");
        assert!(cross_provider.inject_context);
    }
}
