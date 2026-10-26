use serde::Serialize;
use serde_json::{json, Map as JsonMap, Value as JsonValue};
use std::collections::{HashMap, HashSet};
use tauri::{AppHandle, Emitter, Manager};
use uuid::Uuid;

use crate::agent_launch::{AgentLaunchRequest, AgentLaunchResponse, AgentLaunchService};
use crate::agents::AgentState;
use crate::db::{LocalWorkspaceRow, TelemetryDb, ThreadSessionPayload};
use crate::git_workspace::{GitLocalRefInfo, GitRefSnapshot};

const MAIN_GIT_REF: &str = "refs/heads/main";

fn launch_response_json(started: AgentLaunchResponse) -> JsonValue {
    json!({
        "runId": started.run_id,
        "userNodeId": started.user_node_id,
        "assistantNodeId": started.assistant_node_id,
        "initialStatus": started.initial_status,
        "existing": started.existing
    })
}
#[derive(Clone)]
pub(crate) struct ThreadControlService {
    app: AppHandle,
}

#[derive(Debug, Clone)]
struct AuthorizedNode {
    workspace_id: String,
    payload: JsonValue,
}

#[derive(Debug, Clone)]
struct RuntimeConfig {
    provider: String,
    model: String,
    reasoning_effort: Option<String>,
    permission_mode: String,
    login_profile_id: String,
    agent_id: String,
    agent_name: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RunStatus {
    assistant_node_id: String,
    status: String,
    running: bool,
    failure_reason: Option<String>,
}

impl ThreadControlService {
    pub(crate) fn new(app: AppHandle) -> Self {
        Self { app }
    }

    pub(crate) async fn call(
        &self,
        tool_name: &str,
        arguments: JsonValue,
        caller_node_id: Option<String>,
        call_id: String,
    ) -> Result<JsonValue, String> {
        let caller_node_id = caller_node_id
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| {
                "This thread-control tool requires an Agentree caller node.".to_string()
            })?;
        let caller = self.authorized_node(&caller_node_id)?;
        crate::agents::session_auth_token(&self.agent_state(), &caller_node_id).map_err(|_| {
            "The caller is not an active authorized Agentree agent session.".to_string()
        })?;
        let args = arguments.as_object().cloned().unwrap_or_default();

        match tool_name {
            "spawn_thread" => {
                self.spawn_thread(&caller_node_id, &caller, &args, &call_id)
                    .await
            }
            "send_message" => {
                self.send_message(&caller_node_id, &caller, &args, &call_id)
                    .await
            }
            "wait_for_agents" => self.wait_for_agents(&caller_node_id, &args).await,
            "show_thread" => self.show_thread(&caller, &args),
            "stop_agent" => self.stop_agent(&caller_node_id, &args),
            _ => Err(format!("Unsupported thread-control tool: {tool_name}")),
        }
    }

    fn telemetry(&self) -> tauri::State<'_, TelemetryDb> {
        self.app.state::<TelemetryDb>()
    }

    fn agent_state(&self) -> tauri::State<'_, AgentState> {
        self.app.state::<AgentState>()
    }

    fn authorized_workspace(
        &self,
        workspace_id: &str,
    ) -> Result<crate::db::LocalWorkspaceRow, String> {
        let telemetry = self.telemetry();
        let identity = telemetry.get_local_identity()?;
        telemetry
            .get_local_workspace_for_user(workspace_id, &identity.local_user_id)?
            .filter(|workspace| workspace.deleted_at.is_none())
            .ok_or_else(|| "Workspace is not available to the active local user.".to_string())
    }

    fn authorized_node(&self, node_id: &str) -> Result<AuthorizedNode, String> {
        let telemetry = self.telemetry();
        let (workspace_id, payload) = telemetry
            .get_local_node_workspace_and_payload(node_id)?
            .ok_or_else(|| format!("Node {node_id} does not exist."))?;
        self.authorized_workspace(&workspace_id)?;
        Ok(AuthorizedNode {
            workspace_id,
            payload: serde_json::from_str(&payload)
                .map_err(|error| format!("Node {node_id} has invalid persisted data: {error}"))?,
        })
    }

    fn authorized_thread(&self, thread_id: &str) -> Result<ThreadSessionPayload, String> {
        let thread = self
            .telemetry()
            .get_thread_session_by_id(thread_id)?
            .ok_or_else(|| format!("Thread {thread_id} does not exist."))?;
        self.authorized_workspace(&thread.workspace_id)?;
        Ok(thread)
    }

    fn resolve_target_thread(
        &self,
        caller: &AuthorizedNode,
        args: &JsonMap<String, JsonValue>,
        parent: Option<&AuthorizedNode>,
    ) -> Result<ThreadSessionPayload, String> {
        let requested_thread_id = read_string(args, "thread_id");
        let parent_thread_id = parent.and_then(|node| node_thread_id(&node.payload));
        let caller_thread_id = node_thread_id(&caller.payload);
        let thread_id = select_target_thread_id(
            caller_thread_id.as_deref(),
            requested_thread_id.as_deref(),
            parent_thread_id.as_deref(),
        )?;
        let thread = self.authorized_thread(&thread_id)?;
        if let Some(parent) = parent {
            if parent.workspace_id != thread.workspace_id {
                return Err("parent_node_id must belong to the target thread.".to_string());
            }
        }
        Ok(thread)
    }

    fn completed_assistant_node(&self, node_id: &str) -> Result<AuthorizedNode, String> {
        let node = self.authorized_node(node_id)?;
        if node_role(&node.payload) != "assistant"
            || self.run_status(node_id)?.status != "completed"
        {
            return Err("parent_node_id must be a completed assistant node.".to_string());
        }
        if node_thread_id(&node.payload).is_none() {
            return Err("parent_node_id is not attached to a persisted thread.".to_string());
        }
        Ok(node)
    }

    async fn spawn_thread(
        &self,
        caller_node_id: &str,
        caller: &AuthorizedNode,
        args: &JsonMap<String, JsonValue>,
        call_id: &str,
    ) -> Result<JsonValue, String> {
        let requested_parent_node_id = read_string(args, "parent_node_id");
        let parent = requested_parent_node_id
            .as_deref()
            .map(|node_id| self.completed_assistant_node(node_id))
            .transpose()?;
        let parent_node_id = requested_parent_node_id
            .as_deref()
            .unwrap_or(caller_node_id);
        let parent_payload = parent
            .as_ref()
            .map(|node| &node.payload)
            .unwrap_or(&caller.payload);
        let parent_workspace_id = parent
            .as_ref()
            .map(|node| node.workspace_id.as_str())
            .unwrap_or(caller.workspace_id.as_str());
        let parent_thread_id = node_thread_id(parent_payload)
            .ok_or_else(|| "The parent node is not attached to a persisted thread.".to_string())?;
        let parent_thread = self.authorized_thread(&parent_thread_id)?;
        if parent_thread.workspace_id != parent_workspace_id {
            return Err(
                "The parent node and parent thread belong to different workspaces.".to_string(),
            );
        }
        let workspace = self.authorized_workspace(parent_workspace_id)?;
        let request_id = format!("{caller_node_id}\u{1f}{call_id}");
        if let Some(existing) = self.find_thread_by_request(parent_workspace_id, &request_id)? {
            return Ok(existing);
        }

        let base_commit = self
            .resolve_child_thread_base_commit(parent_payload, &parent_thread, &workspace)
            .await?
            .ok_or_else(|| "Could not resolve a base commit for the child thread.".to_string())?;
        let child_thread_id = Uuid::new_v4().to_string();
        let title = read_string(args, "title");
        let link_title = title
            .clone()
            .unwrap_or_else(|| "Delegated work".to_string());
        let now = now_iso();
        let child_thread = ThreadSessionPayload {
            id: child_thread_id.clone(),
            workspace_id: parent_workspace_id.to_string(),
            title: title.clone(),
            status: "active".to_string(),
            created_at: Some(now.clone()),
            updated_at: Some(now.clone()),
            base_commit_sha: Some(base_commit.clone()),
            first_message_id: None,
            parent_thread_id: Some(parent_thread_id.clone()),
            source: "delegation".to_string(),
            anchor_node_id: None,
        };
        let local_user_id = self.telemetry().get_local_identity()?.local_user_id;
        self.telemetry()
            .local_first_create_thread_session(Some(&local_user_id), child_thread)?;

        let link_node_id = format!("thread-link:{child_thread_id}");
        let mut link_paths = node_path_ids(parent_payload);
        link_paths.push(link_node_id.clone());
        let link = json!({
            "id": link_node_id,
            "role": "user",
            "content": link_title,
            "parentId": parent_node_id,
            "workspaceId": parent_workspace_id,
            "createdAt": now,
            "updatedAt": now,
            "aiLabel": "Delegated work",
            "status": "completed",
            "threadId": parent_thread_id,
            "thread_id": parent_thread_id,
            "path_ids": link_paths,
            "execution_data": { "meta": {
                "node_kind": "subgraph_thread_link",
                "target_thread_root_id": child_thread_id,
                "delegation_request_id": request_id,
                "controlled_by_node_id": caller_node_id
            }}
        });
        if let Err(error) = self.persist_node(parent_workspace_id, &link) {
            let _ = self.telemetry().local_first_archive_thread_session(
                Some(&local_user_id),
                parent_workspace_id,
                &child_thread_id,
            );
            return Err(error);
        }
        self.emit_changed(parent_workspace_id, Some(&parent_thread_id));
        Ok(json!({
            "threadId": child_thread_id,
            "title": title,
            "parentThreadId": parent_thread_id,
            "parentNodeId": parent_node_id,
            "baseCommitSha": base_commit,
            "created": true
        }))
    }

    async fn send_message(
        &self,
        caller_node_id: &str,
        caller: &AuthorizedNode,
        args: &JsonMap<String, JsonValue>,
        call_id: &str,
    ) -> Result<JsonValue, String> {
        let request_id = format!("{caller_node_id}\u{1f}{call_id}");
        let message = required_string(args, "message")?;
        let requested_parent_node_id = read_string(args, "parent_node_id");
        let parent = requested_parent_node_id
            .as_deref()
            .map(|node_id| self.completed_assistant_node(node_id))
            .transpose()?;
        let thread = self.resolve_target_thread(caller, args, parent.as_ref())?;

        if self
            .telemetry()
            .get_agent_launch_request(&request_id)?
            .is_some()
        {
            let identity = self.telemetry().get_local_identity()?;
            let auth_token =
                crate::agents::session_auth_token(&self.agent_state(), caller_node_id)?;
            if let Some(started) = AgentLaunchService::new(self.app.clone())
                .resume_existing(
                    &request_id,
                    Some(&thread.workspace_id),
                    Some(&thread.id),
                    auth_token,
                    identity.local_user_id,
                    None,
                )
                .await?
            {
                return Ok(launch_response_json(started));
            }
        }

        let base_commit = parent
            .as_ref()
            .and_then(|node| {
                node_output_commit(&node.payload).or_else(|| node_base_commit(&node.payload))
            })
            .or_else(|| thread.base_commit_sha.clone())
            .or_else(|| {
                self.authorized_workspace(&thread.workspace_id)
                    .ok()?
                    .base_commit_sha
            })
            .ok_or_else(|| "Could not resolve a base commit for this message.".to_string())?;
        let user_node_id = Uuid::new_v4().to_string();
        let assistant_node_id = Uuid::new_v4().to_string();
        if parent.is_none() {
            self.telemetry().claim_thread_first_message(
                &thread.workspace_id,
                &thread.id,
                &user_node_id,
            )?;
        }
        let launch_input = LaunchMessageInput {
            caller_node_id,
            request_id: &request_id,
            message: &message,
            thread_id: &thread.id,
            workspace_id: &thread.workspace_id,
            parent_node: parent
                .as_ref()
                .zip(requested_parent_node_id.as_deref())
                .map(|(node, node_id)| (node_id, &node.payload)),
            base_commit: &base_commit,
            user_node_id: &user_node_id,
            assistant_node_id: &assistant_node_id,
            args,
        };
        self.launch_message(launch_input).await
    }

    async fn launch_message(&self, input: LaunchMessageInput<'_>) -> Result<JsonValue, String> {
        let caller = self.authorized_node(input.caller_node_id)?;
        let runtime = self.resolve_runtime(&caller.payload, input.args)?;
        let identity = self.telemetry().get_local_identity()?;
        let auth_token =
            crate::agents::session_auth_token(&self.agent_state(), input.caller_node_id)?;
        let now = now_iso();
        let run_id = Uuid::new_v4().to_string();
        let parent_id = input.parent_node.map(|(id, _)| id.to_string());
        let mut user_paths = input
            .parent_node
            .map(|(_, payload)| node_path_ids(payload))
            .unwrap_or_default();
        user_paths.push(input.user_node_id.to_string());
        let controlled_by = input.caller_node_id;
        let meta = json!({
            "context_parent_node_id": parent_id,
            "context_base_node_id": parent_id,
            "agent_id": runtime.agent_id,
            "node_kind": "normal",
            "controlled_by_node_id": controlled_by,
            "launch_request_id": input.request_id,
            "provider": runtime.provider,
            "provider_model": runtime.model,
            "provider_reasoning_effort": runtime.reasoning_effort,
            "provider_run_mode": runtime.permission_mode,
            "composer_permission_mode": runtime.permission_mode,
            "login_profile_id": runtime.login_profile_id,
            "base_commit_sha": input.base_commit
        });
        let user = json!({
            "id": input.user_node_id,
            "role": "user",
            "content": input.message,
            "parentId": parent_id,
            "workspaceId": input.workspace_id,
            "controlled_by_node_id": controlled_by,
            "controlledByNodeId": controlled_by,
            "attachments": [],
            "createdAt": now,
            "updatedAt": now,
            "path_ids": user_paths,
            "threadId": input.thread_id,
            "thread_id": input.thread_id,
            "execution_data": {
                "meta": meta,
                "context_profile": {
                    "context_parent_node_id": parent_id,
                    "base_node_id": parent_id,
                    "inherited_from_node_id": parent_id
                }
            }
        });
        let mut assistant_paths = node_path_ids(&user);
        assistant_paths.push(input.assistant_node_id.to_string());
        let execution_data = json!({
            "current_run_id": run_id,
            "workspace_id": input.workspace_id,
            "agent_id": runtime.agent_id,
            "parentId": input.user_node_id,
            "started_at": now,
            "meta": meta,
            "context_profile": {
                "context_parent_node_id": parent_id,
                "base_node_id": parent_id,
                "inherited_from_node_id": input.user_node_id
            }
        });
        let assistant = json!({
            "id": input.assistant_node_id,
            "role": "assistant",
            "content": "",
            "parentId": input.user_node_id,
            "workspaceId": input.workspace_id,
            "controlled_by_node_id": controlled_by,
            "controlledByNodeId": controlled_by,
            "attachments": [],
            "createdAt": now,
            "updatedAt": now,
            "llmProvider": runtime.provider,
            "llmModel": runtime.model,
            "agent_id": runtime.agent_id,
            "status": "pending",
            "path_ids": assistant_paths,
            "threadId": input.thread_id,
            "thread_id": input.thread_id,
            "base_commit_sha": input.base_commit,
            "base_selected_from_node_id": parent_id,
            "execution_data": execution_data
        });
        let request = AgentLaunchRequest {
            request_id: input.request_id.to_string(),
            run_id: run_id.clone(),
            workspace_id: input.workspace_id.to_string(),
            thread_id: Some(input.thread_id.to_string()),
            parent_node_id: parent_id.clone(),
            context_parent_node_id: parent_id.clone(),
            base_node_id: parent_id,
            base_commit: input.base_commit.to_string(),
            user_node_id: input.user_node_id.to_string(),
            assistant_node_id: input.assistant_node_id.to_string(),
            user_prompt: input.message.to_string(),
            agent_type: runtime.provider,
            model: Some(runtime.model),
            reasoning_effort: runtime.reasoning_effort,
            permission_mode: runtime.permission_mode,
            login_profile_id: Some(runtime.login_profile_id),
            agent_id: Some(runtime.agent_id),
            agent_name: Some(runtime.agent_name),
            agent_cli_args: None,
            agent_prompt_flag: None,
            auth_token,
            current_user_id: identity.local_user_id,
            trace_id: None,
            context_policy: if input.parent_node.is_some() {
                "continue"
            } else {
                "fresh"
            }
            .to_string(),
            context_mode: if input.parent_node.is_some() {
                "active"
            } else {
                "none"
            }
            .to_string(),
            context_manifest: json!({}),
            model_capabilities: json!({}),
            thread_title_mode: Some("none".to_string()),
            user_node: user,
            assistant_node: assistant,
        };
        let started = AgentLaunchService::new(self.app.clone())
            .launch(request)
            .await?;
        Ok(launch_response_json(started))
    }

    fn resolve_runtime(
        &self,
        caller: &JsonValue,
        args: &JsonMap<String, JsonValue>,
    ) -> Result<RuntimeConfig, String> {
        let caller_meta = node_meta(caller);
        let inherited_provider = value_string(caller, "llmProvider")
            .or_else(|| value_string(caller_meta, "provider"))
            .ok_or_else(|| "Could not infer the caller's runtime provider.".to_string())?;
        let provider =
            read_string(args, "agent_type").unwrap_or_else(|| inherited_provider.clone());
        if !matches!(provider.as_str(), "codex" | "claude" | "opencode") {
            return Err("agent_type must be codex, claude, or opencode.".to_string());
        }
        let requested_model = read_string(args, "model");
        if provider != inherited_provider && requested_model.is_none() {
            return Err("model is required when agent_type switches providers.".to_string());
        }
        let model = requested_model
            .or_else(|| value_string(caller, "llmModel"))
            .or_else(|| value_string(caller_meta, "provider_model"))
            .ok_or_else(|| "Could not infer a model. Pass model explicitly.".to_string())?;
        let reasoning_effort = read_string(args, "reasoning_effort")
            .or_else(|| value_string(caller_meta, "provider_reasoning_effort"))
            .or_else(|| (provider != "opencode").then(|| "high".to_string()));
        let permission_mode = value_string(caller_meta, "composer_permission_mode")
            .unwrap_or_else(|| "full-access".to_string());
        let inherited_profile = value_string(caller_meta, "login_profile_id");
        let profiles = self.telemetry().list_login_profiles()?;
        let selected_profile = inherited_profile
            .as_deref()
            .and_then(|profile_id| {
                profiles.iter().find(|profile| {
                    profile.id == profile_id
                        && profile.provider == provider
                        && profile.status == "ready"
                })
            })
            .or_else(|| {
                profiles.iter().find(|profile| {
                    profile.provider == provider && profile.status == "ready" && profile.is_default
                })
            })
            .or_else(|| {
                profiles
                    .iter()
                    .find(|profile| profile.provider == provider && profile.status == "ready")
            })
            .ok_or_else(|| crate::login_profiles::provider_login_required_message(&provider))?;
        validate_model_for_profile(&provider, &model, &selected_profile.auth_type)?;
        let label = model_label(&provider, &model);
        Ok(RuntimeConfig {
            provider: provider.clone(),
            model: model.clone(),
            reasoning_effort: reasoning_effort.clone(),
            permission_mode,
            login_profile_id: selected_profile.id.clone(),
            agent_id: format!(
                "{}:{}:{}",
                provider,
                model,
                reasoning_effort.as_deref().unwrap_or("default")
            ),
            agent_name: label,
        })
    }

    fn stop_agent(
        &self,
        caller_node_id: &str,
        args: &JsonMap<String, JsonValue>,
    ) -> Result<JsonValue, String> {
        let assistant_node_id = required_string(args, "assistant_node_id")?;
        let reason = required_string(args, "reason")?;
        self.ensure_directly_controlled(caller_node_id, &assistant_node_id)?;
        let previous = self.run_status(&assistant_node_id)?;
        crate::agents::apply_and_emit_agent_event(
            &self.app,
            &assistant_node_id,
            &json!({
                "type": "controller_stop_requested",
                "controlled_by_node_id": caller_node_id,
                "stop_reason": reason,
            }),
        );
        let stopped = crate::agents::stop_agent_with_descendants(
            &self.app,
            &self.agent_state(),
            &assistant_node_id,
        )?;
        Ok(json!({
            "controlled": true,
            "action": "stop",
            "assistantNodeId": assistant_node_id,
            "previousStatus": previous.status,
            "requestedStatus": "cancelled",
            "reason": reason,
            "stoppedAssistantNodeIds": stopped
        }))
    }

    async fn wait_for_agents(
        &self,
        caller_node_id: &str,
        args: &JsonMap<String, JsonValue>,
    ) -> Result<JsonValue, String> {
        let ids = read_string_array(args, "assistant_node_ids");
        if ids.is_empty() {
            return Err("assistant_node_ids must contain at least one node.".to_string());
        }
        for id in &ids {
            self.ensure_directly_controlled(caller_node_id, id)?;
        }
        let condition = read_string(args, "condition").unwrap_or_else(|| "all_done".to_string());
        if !matches!(condition.as_str(), "all_done" | "any_done" | "any_failed") {
            return Err("condition must be all_done, any_done, or any_failed.".to_string());
        }
        let state = self.agent_state();
        let mut activity = state.subscribe_activity();
        let initial_steer_epoch = state.user_steer_epoch(caller_node_id)?;
        loop {
            let statuses = ids
                .iter()
                .map(|id| self.run_status(id))
                .collect::<Result<Vec<_>, _>>()?;
            if state.user_steer_epoch(caller_node_id)? != initial_steer_epoch {
                return Ok(json!({
                    "completed": false,
                    "interrupted": true,
                    "reason": "caller_steered",
                    "condition": condition,
                    "agents": statuses
                }));
            }
            if wait_condition_satisfied(&condition, &statuses) {
                return Ok(
                    json!({ "completed": true, "condition": condition, "agents": statuses }),
                );
            }
            activity
                .changed()
                .await
                .map_err(|_| "Agent lifecycle notification channel closed.".to_string())?;
        }
    }

    fn ensure_directly_controlled(
        &self,
        caller_node_id: &str,
        assistant_node_id: &str,
    ) -> Result<(), String> {
        self.authorized_node(caller_node_id)?;
        let target = self.authorized_node(assistant_node_id)?;
        if node_role(&target.payload) != "assistant" {
            return Err("assistant_node_id must identify an assistant node.".to_string());
        }
        let controllers = self
            .telemetry()
            .list_local_nodes_for_workspace(&target.workspace_id)?
            .into_iter()
            .filter_map(|row| {
                row.controlled_by_node_id
                    .map(|controller| (row.node_id, controller))
            })
            .collect::<HashMap<_, _>>();
        if !is_directly_controlled(caller_node_id, assistant_node_id, &controllers) {
            return Err(format!(
                "Agent {assistant_node_id} was not created by caller {caller_node_id}."
            ));
        }
        Ok(())
    }

    fn show_thread(
        &self,
        caller: &AuthorizedNode,
        args: &JsonMap<String, JsonValue>,
    ) -> Result<JsonValue, String> {
        let thread = self.resolve_target_thread(caller, args, None)?;
        let mut nodes: Vec<JsonValue> = self
            .telemetry()
            .list_local_nodes_for_workspace(&thread.workspace_id)?
            .into_iter()
            .filter_map(|row| serde_json::from_str::<JsonValue>(&row.payload).ok())
            .filter(|node| node_thread_id(node).as_deref() == Some(thread.id.as_str()))
            .collect();
        nodes.sort_by_key(|node| value_string(node, "createdAt").unwrap_or_default());
        let ids: HashSet<String> = nodes.iter().filter_map(node_id).collect();
        let mut children: HashMap<Option<String>, Vec<JsonValue>> = HashMap::new();
        for node in nodes {
            let parent = value_string(&node, "parentId").filter(|parent| ids.contains(parent));
            children.entry(parent).or_default().push(node);
        }
        let mut lines = Vec::new();
        let mut structured = Vec::new();
        for root in children.remove(&None).unwrap_or_default() {
            structured.push(self.thread_tree_node(root, &mut children, 0, &mut lines)?);
        }
        Ok(json!({
            "threadId": thread.id,
            "workspaceId": thread.workspace_id,
            "title": thread.title,
            "nodeCount": ids.len(),
            "tree": lines.join("\n"),
            "nodes": structured
        }))
    }

    fn thread_tree_node(
        &self,
        node: JsonValue,
        children: &mut HashMap<Option<String>, Vec<JsonValue>>,
        depth: usize,
        lines: &mut Vec<String>,
    ) -> Result<JsonValue, String> {
        let id = node_id(&node).unwrap_or_default();
        let role = node_role(&node);
        let status = if role == "assistant" {
            self.run_status(&id)?.status
        } else {
            value_string(&node, "status").unwrap_or_else(|| "completed".to_string())
        };
        let text = if role == "user" {
            preview(&value_string(&node, "content").unwrap_or_default(), 96)
        } else {
            value_string(&node, "aiLabel")
                .or_else(|| value_string(&node, "ai_label"))
                .unwrap_or_else(|| preview(&value_string(&node, "content").unwrap_or_default(), 96))
        };
        let label = if role == "user" { "User" } else { "Agent" };
        let status_suffix = if role == "assistant" {
            format!(" [{status}]")
        } else {
            String::new()
        };
        lines.push(format!(
            "{}{}: {}{} ({})",
            "  ".repeat(depth),
            label,
            text,
            status_suffix,
            id
        ));
        let child_values = children.remove(&Some(id.clone())).unwrap_or_default();
        let mut nested = Vec::new();
        for child in child_values {
            nested.push(self.thread_tree_node(child, children, depth + 1, lines)?);
        }
        Ok(
            json!({ "nodeId": id, "role": role, "text": text, "status": status, "children": nested }),
        )
    }

    fn run_status(&self, assistant_node_id: &str) -> Result<RunStatus, String> {
        let running =
            crate::agents::is_agent_session_running(&self.agent_state(), assistant_node_id)?;
        let ledger = self
            .telemetry()
            .get_agent_run_ledger_by_assistant(assistant_node_id)?;
        let payload = self
            .telemetry()
            .get_local_node_payload(assistant_node_id)?
            .and_then(|payload| serde_json::from_str::<JsonValue>(&payload).ok());
        let status = if running {
            "running".to_string()
        } else {
            ledger
                .as_ref()
                .and_then(|ledger| ledger.terminal_status.clone())
                .or_else(|| ledger.as_ref().map(|ledger| ledger.status.clone()))
                .or_else(|| {
                    payload
                        .as_ref()
                        .and_then(|payload| value_string(payload, "status"))
                })
                .unwrap_or_else(|| "unknown".to_string())
        };
        let failure_reason = ledger
            .as_ref()
            .and_then(|ledger| clean_string(ledger.failure_reason.as_deref()))
            .or_else(|| payload.as_ref().and_then(failure_reason_from_payload));
        Ok(RunStatus {
            assistant_node_id: assistant_node_id.to_string(),
            status,
            running,
            failure_reason,
        })
    }

    fn find_thread_by_request(
        &self,
        workspace_id: &str,
        request_id: &str,
    ) -> Result<Option<JsonValue>, String> {
        for row in self
            .telemetry()
            .list_local_nodes_for_workspace(workspace_id)?
        {
            let Ok(payload) = serde_json::from_str::<JsonValue>(&row.payload) else {
                continue;
            };
            let meta = node_meta(&payload);
            if value_string(meta, "node_kind").as_deref() != Some("subgraph_thread_link")
                || value_string(meta, "delegation_request_id").as_deref() != Some(request_id)
            {
                continue;
            }
            let Some(thread_id) = value_string(meta, "target_thread_root_id") else {
                continue;
            };
            let Some(thread) = self.telemetry().get_thread_session_by_id(&thread_id)? else {
                continue;
            };
            if thread.workspace_id != workspace_id {
                continue;
            }
            return Ok(Some(json!({
                "threadId": thread.id,
                "title": thread.title,
                "parentThreadId": thread.parent_thread_id,
                "parentNodeId": value_string(&payload, "parentId"),
                "baseCommitSha": thread.base_commit_sha,
                "created": false,
                "existing": true
            })));
        }
        Ok(None)
    }

    fn persist_node(&self, workspace_id: &str, node: &JsonValue) -> Result<(), String> {
        let node_id = node_id(node).ok_or_else(|| "Node payload is missing id.".to_string())?;
        self.telemetry()
            .upsert_local_node(&node_id, workspace_id, &node.to_string())
    }

    fn emit_changed(&self, workspace_id: &str, thread_id: Option<&str>) {
        let _ = self.app.emit(
            "thread-control:changed",
            json!({ "workspaceId": workspace_id, "threadId": thread_id }),
        );
    }

    async fn resolve_child_thread_base_commit(
        &self,
        caller: &JsonValue,
        parent_thread: &ThreadSessionPayload,
        workspace: &LocalWorkspaceRow,
    ) -> Result<Option<String>, String> {
        if let Some(base) = node_output_commit(caller).or_else(|| node_base_commit(caller)) {
            return Ok(Some(base));
        }

        if let Some(base) = self
            .resolve_new_thread_default_base_commit(workspace)
            .await?
        {
            return Ok(Some(base));
        }

        Ok(parent_thread
            .base_commit_sha
            .clone()
            .or_else(|| workspace.base_commit_sha.clone()))
    }

    async fn resolve_new_thread_default_base_commit(
        &self,
        workspace: &LocalWorkspaceRow,
    ) -> Result<Option<String>, String> {
        let repo_path = workspace
            .local_repo_path
            .as_deref()
            .or(workspace.repo_path.as_deref())
            .map(str::trim)
            .filter(|value| !value.is_empty());
        let Some(repo_path) = repo_path else {
            return Ok(None);
        };

        let refs = crate::git_workspace::list_local_refs(repo_path.to_string())
            .await
            .unwrap_or_default();
        let snapshot = crate::git_workspace::snapshot_git_refs(
            repo_path.to_string(),
            vec![MAIN_GIT_REF.to_string()],
        )
        .await
        .unwrap_or(GitRefSnapshot {
            head_sha: None,
            current_branch_ref: None,
            refs: Vec::new(),
        });

        Ok(resolve_default_new_thread_base_from_refs(
            &refs,
            &snapshot,
            workspace.base_commit_sha.as_deref(),
        ))
    }
}

#[derive(Clone, Copy)]
struct LaunchMessageInput<'a> {
    caller_node_id: &'a str,
    request_id: &'a str,
    message: &'a str,
    thread_id: &'a str,
    workspace_id: &'a str,
    parent_node: Option<(&'a str, &'a JsonValue)>,
    base_commit: &'a str,
    user_node_id: &'a str,
    assistant_node_id: &'a str,
    args: &'a JsonMap<String, JsonValue>,
}

fn model_label(provider: &str, model: &str) -> String {
    let provider_label = match provider {
        "claude" => "Claude",
        "opencode" => "OpenCode",
        _ => "Codex",
    };
    format!("{} {}", provider_label, model)
}

fn validate_model_for_profile(provider: &str, model: &str, auth_type: &str) -> Result<(), String> {
    if provider == "codex"
        && auth_type == "codex_chatgpt_session"
        && !crate::agents::codex_chatgpt_session_supports_model(Some(model))
    {
        return Err(format!(
            "{model} is not available through the selected Codex ChatGPT subscription. Choose a model from Agentree's current Codex catalog."
        ));
    }
    Ok(())
}

fn node_meta(node: &JsonValue) -> &JsonValue {
    node.get("execution_data")
        .and_then(|value| value.get("meta"))
        .unwrap_or(&JsonValue::Null)
}

fn node_id(node: &JsonValue) -> Option<String> {
    value_string(node, "id")
}

fn node_role(node: &JsonValue) -> &str {
    node.get("role")
        .and_then(JsonValue::as_str)
        .unwrap_or("assistant")
}

fn node_thread_id(node: &JsonValue) -> Option<String> {
    value_string(node, "threadId").or_else(|| value_string(node, "thread_id"))
}

fn node_base_commit(node: &JsonValue) -> Option<String> {
    value_string(node, "base_commit_sha")
        .or_else(|| value_string(node, "baseCommitSha"))
        .or_else(|| value_string(node_meta(node), "base_commit_sha"))
}

fn node_output_commit(node: &JsonValue) -> Option<String> {
    value_string(node, "output_commit_sha").or_else(|| value_string(node, "outputCommitSha"))
}

fn resolve_default_new_thread_base_from_refs(
    refs: &[GitLocalRefInfo],
    snapshot: &GitRefSnapshot,
    workspace_base_commit_sha: Option<&str>,
) -> Option<String> {
    snapshot
        .refs
        .iter()
        .find(|reference| reference.git_ref.trim() == MAIN_GIT_REF)
        .and_then(|reference| {
            reference
                .commit_sha
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
        })
        .or_else(|| {
            refs.iter().find_map(|reference| {
                let git_ref = reference.git_ref.trim();
                let short_name = reference.short_name.trim();
                if git_ref != MAIN_GIT_REF && short_name != "main" {
                    return None;
                }
                let commit_sha = reference.commit_sha.trim();
                if commit_sha.is_empty() {
                    None
                } else {
                    Some(commit_sha.to_string())
                }
            })
        })
        .or_else(|| {
            snapshot
                .head_sha
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
        })
        .or_else(|| {
            workspace_base_commit_sha
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
        })
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
        .unwrap_or_else(|| node_id(node).into_iter().collect())
}

fn value_string(value: &JsonValue, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(JsonValue::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn clean_string(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn failure_reason_from_payload(payload: &JsonValue) -> Option<String> {
    let execution = payload.get("execution_data")?;
    [
        execution.get("failure_reason"),
        execution.get("setup_error"),
        execution.get("stop_reason"),
        execution.pointer("/meta/failure_reason"),
        execution.pointer("/meta/provider_error_message"),
    ]
    .into_iter()
    .flatten()
    .find_map(|value| clean_string(value.as_str()))
}

fn read_string(args: &JsonMap<String, JsonValue>, key: &str) -> Option<String> {
    args.get(key)
        .and_then(JsonValue::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn required_string(args: &JsonMap<String, JsonValue>, key: &str) -> Result<String, String> {
    read_string(args, key).ok_or_else(|| format!("{key} is required."))
}

fn read_string_array(args: &JsonMap<String, JsonValue>, key: &str) -> Vec<String> {
    args.get(key)
        .and_then(JsonValue::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(JsonValue::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

fn preview(value: &str, max_chars: usize) -> String {
    let compact = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if compact.chars().count() <= max_chars {
        compact
    } else {
        format!(
            "{}…",
            compact
                .chars()
                .take(max_chars.saturating_sub(1))
                .collect::<String>()
        )
    }
}

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn wait_condition_satisfied(condition: &str, statuses: &[RunStatus]) -> bool {
    match condition {
        "all_done" => statuses
            .iter()
            .all(|status| !status.running && is_terminal(&status.status)),
        "any_done" => statuses
            .iter()
            .any(|status| !status.running && is_terminal(&status.status)),
        "any_failed" => statuses.iter().any(|status| is_failure(&status.status)),
        _ => false,
    }
}

fn select_target_thread_id(
    caller_thread_id: Option<&str>,
    requested_thread_id: Option<&str>,
    parent_thread_id: Option<&str>,
) -> Result<String, String> {
    if let Some(parent_thread_id) = parent_thread_id {
        if requested_thread_id.is_some_and(|requested| requested != parent_thread_id) {
            return Err(
                "thread_id conflicts with the thread inferred from parent_node_id.".to_string(),
            );
        }
        return Ok(parent_thread_id.to_string());
    }
    requested_thread_id
        .or(caller_thread_id)
        .map(str::to_string)
        .ok_or_else(|| "Could not infer a thread. Pass thread_id explicitly.".to_string())
}

fn is_directly_controlled(
    caller_node_id: &str,
    target_node_id: &str,
    controllers: &HashMap<String, String>,
) -> bool {
    controllers.get(target_node_id).map(String::as_str) == Some(caller_node_id)
}

fn is_terminal(status: &str) -> bool {
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

fn is_failure(status: &str) -> bool {
    status == "failed" || status == "error" || status.starts_with("failed_")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn git_ref(git_ref: &str, short_name: &str, commit_sha: &str) -> GitLocalRefInfo {
        GitLocalRefInfo {
            git_ref: git_ref.to_string(),
            short_name: short_name.to_string(),
            commit_sha: commit_sha.to_string(),
            committed_at: None,
        }
    }

    fn snapshot(head_sha: Option<&str>, refs: Vec<(&str, Option<&str>)>) -> GitRefSnapshot {
        GitRefSnapshot {
            head_sha: head_sha.map(str::to_string),
            current_branch_ref: None,
            refs: refs
                .into_iter()
                .map(
                    |(git_ref, commit_sha)| crate::git_workspace::GitRefTipInfo {
                        git_ref: git_ref.to_string(),
                        commit_sha: commit_sha.map(str::to_string),
                        error: None,
                    },
                )
                .collect(),
        }
    }

    #[test]
    fn failure_statuses_are_terminal() {
        assert!(is_terminal("failed_spawn"));
        assert!(is_failure("failed_runtime"));
        assert!(!is_terminal("running"));
    }

    #[test]
    fn wait_conditions_require_terminal_non_running_agents() {
        let running = RunStatus {
            assistant_node_id: "running".to_string(),
            status: "running".to_string(),
            running: true,
            failure_reason: None,
        };
        let completed = RunStatus {
            assistant_node_id: "completed".to_string(),
            status: "completed".to_string(),
            running: false,
            failure_reason: None,
        };
        let failed = RunStatus {
            assistant_node_id: "failed".to_string(),
            status: "failed_runtime".to_string(),
            running: false,
            failure_reason: Some("provider failed".to_string()),
        };

        assert!(!wait_condition_satisfied(
            "all_done",
            &[running.clone(), completed.clone()]
        ));
        assert!(wait_condition_satisfied(
            "any_done",
            &[running.clone(), completed.clone()]
        ));
        assert!(wait_condition_satisfied(
            "all_done",
            &[completed, failed.clone()]
        ));
        assert!(wait_condition_satisfied("any_failed", &[running, failed]));
    }

    #[test]
    fn parent_node_infers_target_thread_and_rejects_conflicts() {
        assert_eq!(
            select_target_thread_id(Some("caller-thread"), None, Some("parent-thread"))
                .expect("parent thread"),
            "parent-thread"
        );
        assert_eq!(
            select_target_thread_id(
                Some("caller-thread"),
                Some("parent-thread"),
                Some("parent-thread")
            )
            .expect("matching explicit thread"),
            "parent-thread"
        );
        assert_eq!(
            select_target_thread_id(Some("caller-thread"), Some("target-thread"), None)
                .expect("explicit thread"),
            "target-thread"
        );
        assert!(select_target_thread_id(
            Some("caller-thread"),
            Some("other-thread"),
            Some("parent-thread")
        )
        .is_err());
    }

    #[test]
    fn control_authority_is_limited_to_direct_creator() {
        let controllers = HashMap::from([
            ("child".to_string(), "caller".to_string()),
            ("grandchild".to_string(), "child".to_string()),
            ("sibling".to_string(), "other".to_string()),
        ]);

        assert!(is_directly_controlled("caller", "child", &controllers));
        assert!(!is_directly_controlled(
            "caller",
            "grandchild",
            &controllers
        ));
        assert!(!is_directly_controlled("caller", "caller", &controllers));
        assert!(!is_directly_controlled("caller", "sibling", &controllers));
    }

    #[test]
    fn persisted_node_failure_reason_survives_without_a_run_ledger() {
        let payload = json!({
            "execution_data": {
                "failure_reason": "  provider rejected the model  ",
                "meta": { "provider_error_message": "fallback" }
            }
        });

        assert_eq!(
            failure_reason_from_payload(&payload).as_deref(),
            Some("provider rejected the model")
        );
    }

    #[test]
    fn orchestration_rejects_unsupported_subscription_model_before_launch() {
        let error = validate_model_for_profile("codex", "gpt-5-nano", "codex_chatgpt_session")
            .expect_err("unsupported subscription model");

        assert!(error.contains("not available"));
        assert!(
            validate_model_for_profile("codex", "gpt-5.6-luna", "codex_chatgpt_session").is_ok()
        );
        assert!(validate_model_for_profile("codex", "custom-model", "codex_api_key").is_ok());
    }

    #[test]
    fn default_new_thread_base_prefers_live_main_ref() {
        let refs = vec![git_ref(MAIN_GIT_REF, "main", "stale-main")];
        let snapshot = snapshot(Some("head-tip"), vec![(MAIN_GIT_REF, Some("live-main"))]);

        assert_eq!(
            resolve_default_new_thread_base_from_refs(&refs, &snapshot, Some("workspace-base"))
                .as_deref(),
            Some("live-main")
        );
    }

    #[test]
    fn default_new_thread_base_uses_head_before_workspace_base() {
        let refs = vec![git_ref("refs/heads/feature", "feature", "feature-tip")];
        let snapshot = snapshot(Some("head-tip"), vec![(MAIN_GIT_REF, None)]);

        assert_eq!(
            resolve_default_new_thread_base_from_refs(&refs, &snapshot, Some("workspace-base"))
                .as_deref(),
            Some("head-tip")
        );
    }

    #[test]
    fn default_new_thread_base_falls_back_to_workspace_base() {
        let snapshot = snapshot(None, vec![(MAIN_GIT_REF, None)]);

        assert_eq!(
            resolve_default_new_thread_base_from_refs(&[], &snapshot, Some("workspace-base"))
                .as_deref(),
            Some("workspace-base")
        );
    }
}
