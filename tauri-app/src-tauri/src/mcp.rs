use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::post,
    Json, Router,
};
use once_cell::sync::Lazy;
use reqwest::Url;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::env;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, AtomicU16, Ordering};
use std::sync::Arc;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

static MCP_STARTED: AtomicBool = AtomicBool::new(false);
static MCP_AUTH_TOKEN: Lazy<Mutex<Option<String>>> = Lazy::new(|| Mutex::new(None));
static MCP_WORKSPACE_ID: Lazy<Mutex<Option<String>>> = Lazy::new(|| Mutex::new(None));
static MCP_ORCHESTRATION_PENDING: Lazy<
    Mutex<HashMap<String, tokio::sync::oneshot::Sender<Result<serde_json::Value, String>>>>,
> = Lazy::new(|| Mutex::new(HashMap::new()));
/// Port the MCP server actually bound to (0 until the server is up). When no
/// explicit port override is configured the server binds to an OS-assigned free
/// port, and this is how the rest of the app learns which one it got.
static MCP_ACTUAL_PORT: AtomicU16 = AtomicU16::new(0);

fn configured_mcp_bind_addr() -> String {
    env::var("AGENTREE_MCP_BIND").unwrap_or_else(|_| "127.0.0.1".to_string())
}

fn configured_mcp_port_string() -> Option<String> {
    env::var("AGENTREE_MCP_PORT")
        .or_else(|_| env::var("MCP_PORT"))
        .ok()
}

fn mcp_server_url_from_parts(bind_addr: Option<&str>, port: Option<&str>) -> String {
    let bind_addr = bind_addr.unwrap_or("127.0.0.1");
    let port = port
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(61337);
    format!("http://{}:{}/mcp", bind_addr, port)
}

/// Port string the rest of the app should connect to: an explicit override wins,
/// otherwise the port we actually bound. `None` only before the server is up.
fn resolved_mcp_port_string() -> Option<String> {
    if let Some(port) = configured_mcp_port_string() {
        return Some(port);
    }
    let actual = MCP_ACTUAL_PORT.load(Ordering::SeqCst);
    if actual != 0 {
        Some(actual.to_string())
    } else {
        None
    }
}

pub fn mcp_server_url() -> String {
    let bind_addr = configured_mcp_bind_addr();
    let Some(port) = resolved_mcp_port_string() else {
        return String::new();
    };
    mcp_server_url_from_parts(Some(bind_addr.as_str()), Some(port.as_str()))
}

#[derive(Clone)]
struct McpState {
    app_handle: AppHandle,
    server_base_url: String,
    http: reqwest::Client,
}

#[derive(Debug, Deserialize)]
struct JsonRpcRequest {
    #[serde(rename = "jsonrpc")]
    _jsonrpc: Option<String>,
    #[serde(default)]
    id: Option<serde_json::Value>,
    method: String,
    params: Option<serde_json::Value>,
}

#[derive(Debug, Serialize)]
struct JsonRpcError {
    code: i64,
    message: String,
}

#[derive(Debug, Serialize)]
struct JsonRpcResponse {
    jsonrpc: &'static str,
    id: serde_json::Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<JsonRpcError>,
}

pub fn start_mcp_server(app_handle: AppHandle) {
    if MCP_STARTED.swap(true, Ordering::SeqCst) {
        return;
    }

    let bind_addr = configured_mcp_bind_addr();
    // An explicit port override is honored; otherwise bind to port 0 so the OS
    // assigns a free port. This lets multiple Agentree builds (e.g. dev +
    // release) run at once instead of colliding on one hardcoded port.
    let requested_port = configured_mcp_port_string()
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(0);

    let addr: SocketAddr = match format!("{}:{}", bind_addr, requested_port).parse() {
        Ok(addr) => addr,
        Err(err) => {
            MCP_STARTED.store(false, Ordering::SeqCst);
            crate::app_log!(
                "[MCP] Invalid MCP bind address {}:{}: {}",
                bind_addr,
                requested_port,
                err
            );
            return;
        }
    };

    // Bind synchronously so the actual port is known before this function
    // returns. Adapters spawned later read it via mcp_server_url().
    let std_listener = match bind_mcp_listener(addr) {
        Ok(listener) => listener,
        Err(err) => {
            MCP_STARTED.store(false, Ordering::SeqCst);
            crate::app_log!("[MCP] Failed to bind MCP server on {}: {}", addr, err);
            return;
        }
    };
    let actual_port = std_listener
        .local_addr()
        .map(|addr| addr.port())
        .unwrap_or(requested_port);
    MCP_ACTUAL_PORT.store(actual_port, Ordering::SeqCst);

    let server_base_url = crate::config::server_base_url();
    let state = Arc::new(McpState {
        app_handle,
        server_base_url,
        http: reqwest::Client::new(),
    });

    let app = Router::new()
        .route("/mcp", post(handle_rpc).get(handle_sse))
        .with_state(state);

    tauri::async_runtime::spawn(async move {
        crate::app_log!(
            "[MCP] Starting MCP server on http://{}:{}",
            bind_addr,
            actual_port
        );
        let listener = match tokio::net::TcpListener::from_std(std_listener) {
            Ok(listener) => listener,
            Err(err) => {
                MCP_ACTUAL_PORT.store(0, Ordering::SeqCst);
                MCP_STARTED.store(false, Ordering::SeqCst);
                crate::app_log!("[MCP] Failed to adopt MCP listener: {}", err);
                return;
            }
        };
        if let Err(err) = axum::serve(listener, app).await {
            crate::app_log!("[MCP] Server error: {}", err);
        }
        MCP_ACTUAL_PORT.store(0, Ordering::SeqCst);
        MCP_STARTED.store(false, Ordering::SeqCst);
    });
}

/// Bind the MCP listener. `set_nonblocking` is required so the std listener can
/// later be adopted by tokio via `TcpListener::from_std`.
fn bind_mcp_listener(addr: SocketAddr) -> std::io::Result<std::net::TcpListener> {
    let listener = std::net::TcpListener::bind(addr)?;
    listener.set_nonblocking(true)?;
    Ok(listener)
}

#[tauri::command]
#[specta::specta]
pub fn set_mcp_auth_token(token: String) -> Result<(), String> {
    let mut guard = MCP_AUTH_TOKEN.lock().map_err(|e| e.to_string())?;
    if token.trim().is_empty() {
        *guard = None;
    } else {
        *guard = Some(token);
    }
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn set_mcp_workspace_id(workspace_id: String) -> Result<(), String> {
    let mut guard = MCP_WORKSPACE_ID.lock().map_err(|e| e.to_string())?;
    if workspace_id.trim().is_empty() {
        *guard = None;
    } else {
        *guard = Some(workspace_id);
    }
    Ok(())
}

pub(crate) fn set_mcp_current_context(
    auth_token: &str,
    workspace_id: Option<&str>,
) -> Result<(), String> {
    let mut auth_guard = MCP_AUTH_TOKEN.lock().map_err(|e| e.to_string())?;
    let mut workspace_guard = MCP_WORKSPACE_ID.lock().map_err(|e| e.to_string())?;

    if auth_token.trim().is_empty() {
        *auth_guard = None;
    } else {
        *auth_guard = Some(auth_token.to_string());
    }

    if let Some(workspace_id) = workspace_id.filter(|value| !value.trim().is_empty()) {
        *workspace_guard = Some(workspace_id.to_string());
    } else {
        *workspace_guard = None;
    }

    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn get_mcp_server_url() -> String {
    mcp_server_url()
}

#[tauri::command]
#[specta::specta]
pub fn resolve_orchestration_mcp_request(
    request_id: String,
    response_json: Option<String>,
    error: Option<String>,
) -> Result<(), String> {
    let sender = MCP_ORCHESTRATION_PENDING
        .lock()
        .map_err(|e| e.to_string())?
        .remove(&request_id)
        .ok_or_else(|| format!("Unknown orchestration MCP request {}", request_id))?;

    let result = if let Some(error) = error.filter(|value| !value.trim().is_empty()) {
        Err(error)
    } else {
        let parsed = response_json
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .map(|value| serde_json::from_str::<serde_json::Value>(value))
            .transpose()
            .map_err(|e| e.to_string())?
            .unwrap_or_else(|| serde_json::json!({}));
        Ok(parsed)
    };
    sender
        .send(result)
        .map_err(|_| "Orchestration MCP requester is no longer waiting.".to_string())
}

async fn handle_rpc(
    State(state): State<Arc<McpState>>,
    headers: HeaderMap,
    Json(payload): Json<JsonRpcRequest>,
) -> Response {
    crate::app_log!(
        "[MCP] POST request: method={} id={:?}",
        payload.method,
        payload.id
    );
    crate::app_log!("[MCP] Headers: {:?}", headers.keys().collect::<Vec<_>>());

    // Check if this is a notification (no id) - return 202 Accepted immediately
    if payload.id.is_none() {
        crate::app_log!("[MCP] Notification received: {}", payload.method);
        return (StatusCode::ACCEPTED, "").into_response();
    }

    let id = payload.id.unwrap_or(serde_json::Value::Null);

    let response = match payload.method.as_str() {
        "initialize" => handle_initialize(id),
        "tools/list" => handle_tools_list(id),
        "tools/call" => handle_tools_call(id, payload.params, headers, state).await,
        _ => JsonRpcResponse {
            jsonrpc: "2.0",
            id,
            result: None,
            error: Some(JsonRpcError {
                code: -32601,
                message: "Method not found".to_string(),
            }),
        },
    };

    crate::app_log!("[MCP] Response: {:?}", serde_json::to_string(&response));
    Json(response).into_response()
}

fn handle_initialize(id: serde_json::Value) -> JsonRpcResponse {
    JsonRpcResponse {
        jsonrpc: "2.0",
        id,
        result: Some(serde_json::json!({
            "protocolVersion": "2024-11-05",
            "serverInfo": {
                "name": "Agentree MCP",
                "version": "0.1.0"
            },
            "capabilities": {
                "tools": {
                    "listChanged": false
                }
            }
        })),
        error: None,
    }
}

/// Handle SSE GET requests for MCP Streamable HTTP transport.
/// According to MCP spec, the server MUST return Content-Type: text/event-stream
/// or HTTP 405 to indicate SSE capability. This allows Claude to verify connectivity.
async fn handle_sse(headers: HeaderMap) -> Response {
    crate::app_log!("[MCP] GET SSE request received");
    crate::app_log!(
        "[MCP] GET Headers: {:?}",
        headers.keys().collect::<Vec<_>>()
    );

    // Check Accept header
    let accept = headers.get("accept").and_then(|v| v.to_str().ok());
    crate::app_log!("[MCP] Accept header: {:?}", accept);

    let accepts_sse = accept
        .map(|v| v.contains("text/event-stream"))
        .unwrap_or(false);

    if !accepts_sse {
        crate::app_log!("[MCP] Rejecting - no SSE accept header");
        // Return 405 Method Not Allowed if client doesn't accept SSE
        return (
            StatusCode::METHOD_NOT_ALLOWED,
            "SSE stream requires Accept: text/event-stream",
        )
            .into_response();
    }

    crate::app_log!("[MCP] Returning SSE response");
    // Return a minimal SSE response that closes immediately
    // This is enough to show Claude that SSE is supported
    let sse_content = ": heartbeat\n\n";
    Response::builder()
        .status(StatusCode::OK)
        .header("Content-Type", "text/event-stream")
        .header("Cache-Control", "no-cache")
        .header("Connection", "keep-alive")
        .body(axum::body::Body::from(sse_content))
        .unwrap()
}

fn handle_tools_list(id: serde_json::Value) -> JsonRpcResponse {
    JsonRpcResponse {
        jsonrpc: "2.0",
        id,
        result: Some(serde_json::json!({
            "tools": [
                {
                    "name": "list_prompt_templates",
                    "description": "List prompt templates available to the orchestrator. Use this to discover #template labels before spawning child runs.",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "kind": {
                                "type": "string",
                                "description": "Optional filter: node or orchestration"
                            }
                        },
                        "required": []
                    }
                },
                {
                    "name": "get_prompt_template",
                    "description": "Read one prompt template by id or #label. Use this before composing a child run prompt from a #template mention.",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "template_id": {
                                "type": "string",
                                "description": "Template id or label, for example #planner or @planner"
                            }
                        },
                        "required": ["template_id"]
                    }
                },
                {
                    "name": "start_orchestration_child",
                    "description": "Start one child agent run controlled by the current orchestrator. This delegates to Agentree's composer/control-plane launch path so graph nodes, local cache, runtime metadata, and orchestration journal events stay consistent.",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "orchestrator_run_id": { "type": "string" },
                            "orchestrator_node_id": { "type": "string" },
                            "decision_id": { "type": "string" },
                            "prompt": { "type": "string" },
                            "parent_node_id": { "type": "string" },
                            "template_id": { "type": "string" },
                            "agent_id": { "type": "string" },
                            "agent_type": { "type": "string" },
                            "agent_name": { "type": "string" },
                            "model": { "type": "string" },
                            "cli_args": { "type": "string" },
                            "prompt_flag": { "type": "string" },
                            "permission_mode": { "type": "string" },
                            "login_profile_id": { "type": "string" }
                        },
                        "required": ["orchestrator_run_id", "orchestrator_node_id", "decision_id", "prompt"]
                    }
                },
                {
                    "name": "wait_for_runs",
                    "description": "Wait for child assistant runs without polling from the model. Agentree records wait_started, resolves this tool when the app observes the requested condition, then records wait_completed.",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "orchestrator_run_id": { "type": "string" },
                            "orchestrator_node_id": { "type": "string" },
                            "wait_group_id": { "type": "string" },
                            "assistant_node_ids": {
                                "type": "array",
                                "items": { "type": "string" }
                            },
                            "decision_ids": {
                                "type": "array",
                                "items": { "type": "string" }
                            },
                            "condition": {
                                "type": "string",
                                "description": "terminal, all, any, completed, failed, commit_available, any_terminal, or any_failed"
                            },
                            "timeout_ms": { "type": "number" }
                        },
                        "required": ["orchestrator_run_id", "orchestrator_node_id", "assistant_node_ids"]
                    }
                },
                {
                    "name": "control_run",
                    "description": "Control a running assistant node. Use action=steer with content to guide it, or action=stop to cancel it. This uses the same app runtime controls as normal user steering.",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "assistant_node_id": { "type": "string" },
                            "action": { "type": "string", "description": "steer or stop" },
                            "content": { "type": "string" },
                            "idempotency_key": { "type": "string" }
                        },
                        "required": ["assistant_node_id", "action"]
                    }
                },
                {
                    "name": "complete_orchestration",
                    "description": "Mark an orchestrator run completed after child work is done.",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "orchestrator_run_id": { "type": "string" },
                            "orchestrator_node_id": { "type": "string" },
                            "terminal_child_assistant_node_ids": {
                                "type": "array",
                                "items": { "type": "string" }
                            }
                        },
                        "required": ["orchestrator_run_id", "orchestrator_node_id"]
                    }
                },
                {
                    "name": "get_graph_overview",
                    "description": "Get a visual overview of the current workspace node graph with thread and branch statistics. The workspace_id is auto-detected from current context; do not pass it unless querying a different workspace.",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "workspace_id": {
                                "type": "string",
                                "description": "OPTIONAL: Auto-detected from context. Only pass if querying a different workspace."
                            }
                        },
                        "required": []
                    }
                },
                {
                    "name": "graph_locate",
                    "description": "Locate a node in the current graph. Returns depth, parent, path, siblings, children, agent, and status details.",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "node_id": {
                                "type": "string",
                                "description": "The current node ID"
                            },
                            "workspace_id": {
                                "type": "string",
                                "description": "The workspace ID"
                            }
                        },
                        "required": ["node_id"]
                    }
                },
                {
                    "name": "graph_query",
                    "description": "Search and filter graph nodes. The workspace_id is auto-detected from current context; do not pass it unless querying a different workspace.",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "workspace_id": {
                                "type": "string",
                                "description": "OPTIONAL: Auto-detected from context. Only pass if querying a different workspace."
                            },
                            "filters": { "type": "object", "description": "Filter criteria like {role: 'assistant', status: 'completed'}" },
                            "limit": { "type": "number", "description": "Maximum nodes to return" },
                            "offset": { "type": "number", "description": "Pagination offset" }
                        },
                        "required": []
                    }
                },
                {
                    "name": "graph_read_node",
                    "description": "Read a specific graph node, including content, run metadata, and tool calls.",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "node_id": { "type": "string" },
                            "include_tool_calls": { "type": "boolean" },
                            "max_content_length": { "type": "number" }
                        },
                        "required": ["node_id"]
                    }
                },
                {
                    "name": "graph_blame",
                    "description": "Get line-by-line attribution for a file at an assistant node's resolved git commit.",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "node_id": { "type": "string", "description": "Must be an assistant node ID (not a user node)." },
                            "file_path": { "type": "string" },
                            "include_context": { "type": "boolean" },
                            "include_content": { "type": "boolean" }
                        },
                        "required": ["node_id", "file_path"]
                    }
                },
                {
                    "name": "graph_diff",
                    "description": "Compare the committed git states for two assistant nodes.",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "from_node_id": { "type": "string", "description": "Must be an assistant node ID." },
                            "to_node_id": { "type": "string", "description": "Must be an assistant node ID." },
                            "file_path": { "type": "string" },
                            "include_content": { "type": "boolean" }
                        },
                        "required": ["from_node_id", "to_node_id"]
                    }
                },
                {
                    "name": "list_thread_sessions",
                    "description": "List active thread sessions in the current workspace, including status, source, base commit, first node, and node count. The workspace_id is auto-detected from current context; do not pass it unless querying a different workspace.",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "workspace_id": {
                                "type": "string",
                                "description": "OPTIONAL: Auto-detected from context. Only pass if querying a different workspace."
                            }
                        },
                        "required": []
                    }
                },
                {
                    "name": "read_thread",
                    "description": "Read a thread session and its ordered graph nodes.",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "workspace_id": {
                                "type": "string",
                                "description": "OPTIONAL: Auto-detected from context. Only pass if querying a different workspace."
                            },
                            "thread_id": { "type": "string" },
                            "max_nodes": { "type": "number", "description": "Maximum nodes to include" }
                        },
                        "required": ["thread_id"]
                    }
                },
                {
                    "name": "query_commits",
                    "description": "Search and filter the persisted workspace commit graph. The workspace_id is auto-detected from current context; do not pass it unless querying a different workspace.",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "workspace_id": {
                                "type": "string",
                                "description": "OPTIONAL: Auto-detected from context. Only pass if querying a different workspace."
                            },
                            "filters": {
                                "type": "object",
                                "description": "Filter criteria like {source_kind: 'agent', produced_by_node_id: 'node-id', sha: 'abc123'}"
                            },
                            "limit": { "type": "number", "description": "Maximum commits to return" },
                            "offset": { "type": "number", "description": "Pagination offset" },
                            "include_parents": { "type": "boolean" },
                            "include_observations": { "type": "boolean" }
                        },
                        "required": []
                    }
                }
            ]
        })),
        error: None,
    }
}

async fn handle_tools_call(
    id: serde_json::Value,
    params: Option<serde_json::Value>,
    headers: HeaderMap,
    state: Arc<McpState>,
) -> JsonRpcResponse {
    let params = params.unwrap_or_else(|| serde_json::json!({}));
    let name = params.get("name").and_then(|value| value.as_str());
    let arguments = params.get("arguments");

    match name {
        Some("list_prompt_templates") => {
            let kind = arguments
                .and_then(|args| args.get("kind"))
                .and_then(|value| value.as_str())
                .map(|value| value.to_string());
            handle_list_prompt_templates(id, state, kind)
        }
        Some("get_prompt_template") => {
            let template_id = arguments
                .and_then(|args| args.get("template_id"))
                .and_then(|value| value.as_str())
                .map(|value| value.to_string());
            if template_id.is_none() {
                return JsonRpcResponse {
                    jsonrpc: "2.0",
                    id,
                    result: None,
                    error: Some(JsonRpcError {
                        code: -32602,
                        message: "Missing template_id".to_string(),
                    }),
                };
            }
            handle_get_prompt_template(id, state, template_id.unwrap())
        }
        Some("start_orchestration_child") => {
            let args = arguments.cloned().unwrap_or_else(|| serde_json::json!({}));
            handle_frontend_orchestration_tool(id, state, "start_orchestration_child", args).await
        }
        Some("wait_for_runs") => {
            let args = arguments.cloned().unwrap_or_else(|| serde_json::json!({}));
            handle_frontend_orchestration_tool(id, state, "wait_for_runs", args).await
        }
        Some("control_run") => {
            let args = arguments.cloned().unwrap_or_else(|| serde_json::json!({}));
            handle_frontend_orchestration_tool(id, state, "control_run", args).await
        }
        Some("complete_orchestration") => {
            let args = arguments.cloned().unwrap_or_else(|| serde_json::json!({}));
            handle_complete_orchestration(id, state, args)
        }
        Some("get_graph_overview") => {
            let workspace_id = get_workspace_id(arguments);
            if let Err(resp) = workspace_id {
                return resp.with_id(id);
            }
            handle_overview(id, headers, state, workspace_id.unwrap()).await
        }
        Some("graph_locate") => {
            let node_id = arguments
                .and_then(|args| args.get("node_id"))
                .and_then(|value| value.as_str())
                .map(|value| value.to_string());
            if node_id.is_none() {
                return JsonRpcResponse {
                    jsonrpc: "2.0",
                    id,
                    result: None,
                    error: Some(JsonRpcError {
                        code: -32602,
                        message: "Missing node_id".to_string(),
                    }),
                };
            }
            let workspace_id = arguments
                .and_then(|args| args.get("workspace_id"))
                .and_then(|value| value.as_str())
                .map(|value| value.to_string())
                .or_else(|| MCP_WORKSPACE_ID.lock().ok().and_then(|guard| guard.clone()));
            handle_graph_locate(id, headers, state, node_id.unwrap(), workspace_id).await
        }
        Some("graph_query") => {
            let workspace_id = get_workspace_id(arguments);
            if let Err(resp) = workspace_id {
                return resp.with_id(id);
            }
            let filters = arguments.and_then(|args| args.get("filters")).cloned();
            let limit = arguments
                .and_then(|args| args.get("limit"))
                .and_then(|value| value.as_u64())
                .map(|value| value as u32);
            let offset = arguments
                .and_then(|args| args.get("offset"))
                .and_then(|value| value.as_u64())
                .map(|value| value as u32);
            handle_graph_query(
                id,
                headers,
                state,
                workspace_id.unwrap(),
                filters,
                limit,
                offset,
            )
            .await
        }
        Some("graph_read_node") => {
            let node_id = arguments
                .and_then(|args| args.get("node_id"))
                .and_then(|value| value.as_str())
                .map(|value| value.to_string());
            if node_id.is_none() {
                return JsonRpcResponse {
                    jsonrpc: "2.0",
                    id,
                    result: None,
                    error: Some(JsonRpcError {
                        code: -32602,
                        message: "Missing node_id".to_string(),
                    }),
                };
            }
            let include_tool_calls = arguments
                .and_then(|args| args.get("include_tool_calls"))
                .and_then(|value| value.as_bool());
            let max_content_length = arguments
                .and_then(|args| args.get("max_content_length"))
                .and_then(|value| value.as_u64())
                .map(|value| value as u32);
            handle_graph_read_node(
                id,
                headers,
                state,
                node_id.unwrap(),
                include_tool_calls,
                max_content_length,
            )
            .await
        }
        Some("graph_blame") => {
            let args = arguments.cloned().unwrap_or_else(|| serde_json::json!({}));
            let node_id = args
                .get("node_id")
                .and_then(|value| value.as_str())
                .map(|value| value.to_string());
            let file_path = args
                .get("file_path")
                .and_then(|value| value.as_str())
                .map(|value| value.to_string());
            if node_id.is_none() || file_path.is_none() {
                return JsonRpcResponse {
                    jsonrpc: "2.0",
                    id,
                    result: None,
                    error: Some(JsonRpcError {
                        code: -32602,
                        message: "node_id and file_path are required".to_string(),
                    }),
                };
            }
            let include_context = args
                .get("include_context")
                .and_then(|value| value.as_bool())
                .unwrap_or(false);
            let include_content = args
                .get("include_content")
                .and_then(|value| value.as_bool())
                .unwrap_or(false);
            handle_graph_blame(
                id,
                headers,
                state,
                node_id.unwrap(),
                file_path.unwrap(),
                include_context,
                include_content,
            )
            .await
        }
        Some("graph_diff") => {
            let args = arguments.cloned().unwrap_or_else(|| serde_json::json!({}));
            let from_node_id = args
                .get("from_node_id")
                .and_then(|value| value.as_str())
                .map(|value| value.to_string());
            let to_node_id = args
                .get("to_node_id")
                .and_then(|value| value.as_str())
                .map(|value| value.to_string());
            if from_node_id.is_none() || to_node_id.is_none() {
                return JsonRpcResponse {
                    jsonrpc: "2.0",
                    id,
                    result: None,
                    error: Some(JsonRpcError {
                        code: -32602,
                        message: "from_node_id and to_node_id are required".to_string(),
                    }),
                };
            }
            let file_path = args
                .get("file_path")
                .and_then(|value| value.as_str())
                .map(|value| value.to_string());
            let include_content = args
                .get("include_content")
                .and_then(|value| value.as_bool())
                .unwrap_or(false);
            handle_graph_diff(
                id,
                headers,
                state,
                from_node_id.unwrap(),
                to_node_id.unwrap(),
                file_path,
                include_content,
            )
            .await
        }
        Some("list_thread_sessions") => {
            let workspace_id = get_workspace_id(arguments);
            if let Err(resp) = workspace_id {
                return resp.with_id(id);
            }
            handle_list_thread_sessions(id, headers, state, workspace_id.unwrap()).await
        }
        Some("read_thread") => {
            let workspace_id = get_workspace_id(arguments);
            if let Err(resp) = workspace_id {
                return resp.with_id(id);
            }
            let args = arguments.cloned().unwrap_or_else(|| serde_json::json!({}));
            let thread_id = args
                .get("thread_id")
                .and_then(|value| value.as_str())
                .map(|value| value.to_string());
            if thread_id.is_none() {
                return JsonRpcResponse {
                    jsonrpc: "2.0",
                    id,
                    result: None,
                    error: Some(JsonRpcError {
                        code: -32602,
                        message: "thread_id is required".to_string(),
                    }),
                };
            }
            let max_nodes = args
                .get("max_nodes")
                .and_then(|value| value.as_u64())
                .map(|value| value as u32);
            handle_read_thread(
                id,
                headers,
                state,
                workspace_id.unwrap(),
                thread_id.unwrap(),
                max_nodes,
            )
            .await
        }
        Some("query_commits") => {
            let workspace_id = get_workspace_id(arguments);
            if let Err(resp) = workspace_id {
                return resp.with_id(id);
            }
            let filters = arguments.and_then(|args| args.get("filters")).cloned();
            let limit = arguments
                .and_then(|args| args.get("limit"))
                .and_then(|value| value.as_u64())
                .map(|value| value as u32);
            let offset = arguments
                .and_then(|args| args.get("offset"))
                .and_then(|value| value.as_u64())
                .map(|value| value as u32);
            let include_parents = arguments
                .and_then(|args| args.get("include_parents"))
                .and_then(|value| value.as_bool());
            let include_observations = arguments
                .and_then(|args| args.get("include_observations"))
                .and_then(|value| value.as_bool());
            handle_query_commits(
                id,
                headers,
                state,
                workspace_id.unwrap(),
                filters,
                limit,
                offset,
                include_parents,
                include_observations,
            )
            .await
        }
        _ => JsonRpcResponse {
            jsonrpc: "2.0",
            id,
            result: None,
            error: Some(JsonRpcError {
                code: -32602,
                message: "Unknown tool".to_string(),
            }),
        },
    }
}

fn tool_text_response(id: serde_json::Value, text: String) -> JsonRpcResponse {
    JsonRpcResponse {
        jsonrpc: "2.0",
        id,
        result: Some(serde_json::json!({ "content": [ { "type": "text", "text": text } ] })),
        error: None,
    }
}

fn default_prompt_templates() -> Vec<serde_json::Value> {
    vec![
        serde_json::json!({
            "id": "#planner",
            "kind": "node",
            "label": "#planner",
            "prompt": "Create a concrete implementation plan for {{request}}. Include validation steps and key risks.",
            "source": "built_in"
        }),
        serde_json::json!({
            "id": "#synthesizer",
            "kind": "node",
            "label": "#synthesizer",
            "prompt": "Synthesize the relevant prior node outputs into one clear recommendation for {{request}}.",
            "source": "built_in"
        }),
        serde_json::json!({
            "id": "#reviewer",
            "kind": "node",
            "label": "#reviewer",
            "prompt": "Review the current result for correctness, regressions, missing tests, and unclear assumptions.",
            "source": "built_in"
        }),
        serde_json::json!({
            "id": "#fixer",
            "kind": "node",
            "label": "#fixer",
            "prompt": "Apply focused fixes for the reviewed issues while preserving the requested behavior.",
            "requiresCommit": true,
            "source": "built_in"
        }),
        serde_json::json!({
            "id": "#security_reviewer",
            "kind": "node",
            "label": "#security_reviewer",
            "prompt": "Review the change for plausible security issues, privilege boundaries, and unsafe data handling.",
            "source": "built_in"
        }),
        serde_json::json!({
            "id": "#ui_polish_reviewer",
            "kind": "node",
            "label": "#ui_polish_reviewer",
            "prompt": "Review the UI for layout, responsiveness, visual clarity, and interaction polish.",
            "source": "built_in"
        }),
        serde_json::json!({
            "id": "#parallel_planners",
            "kind": "orchestration",
            "label": "#parallel_planners",
            "prompt": "Create three parallel #planner for {{request}}. Create a #synthesizer sibling to combine the plans.",
            "source": "built_in"
        }),
        serde_json::json!({
            "id": "#review_fix_chain",
            "kind": "orchestration",
            "label": "#review_fix_chain",
            "prompt": "Create a #reviewer for {{request}}. Create a #fixer as child of reviewer to apply focused fixes.",
            "source": "built_in"
        }),
    ]
}

fn normalize_template_id(value: &str) -> Option<String> {
    let mut normalized = String::new();
    let mut last_was_separator = false;
    for ch in value.trim().trim_start_matches(|ch| ch == '@' || ch == '#').chars() {
        let lower = ch.to_ascii_lowercase();
        if lower.is_ascii_alphanumeric() || lower == '-' || lower == '_' {
            normalized.push(lower);
            last_was_separator = false;
        } else if !last_was_separator {
            normalized.push('_');
            last_was_separator = true;
        }
    }
    let normalized = normalized.trim_matches('_').to_string();
    if normalized.is_empty() {
        None
    } else {
        Some(format!("@{}", normalized))
    }
}

fn normalize_prompt_template(value: serde_json::Value) -> Option<serde_json::Value> {
    let object = value.as_object()?;
    let kind = object
        .get("kind")
        .and_then(|value| value.as_str())
        .filter(|value| *value == "node" || *value == "orchestration")?;
    let prompt = object.get("prompt")?.as_str()?.trim();
    if prompt.is_empty() {
        return None;
    }
    let id_source = object
        .get("id")
        .and_then(|value| value.as_str())
        .or_else(|| object.get("label").and_then(|value| value.as_str()))?;
    let id = normalize_template_id(id_source)?;
    let label = object
        .get("label")
        .and_then(|value| value.as_str())
        .map(|value| {
            let trimmed = value.trim();
            if trimmed.starts_with('#') {
                trimmed.to_string()
            } else {
                format!("#{}", trimmed.trim_start_matches('@'))
            }
        })
        .unwrap_or_else(|| format!("#{}", id.trim_start_matches('@')));

    let mut normalized = serde_json::Map::new();
    normalized.insert("id".to_string(), serde_json::json!(id));
    normalized.insert("kind".to_string(), serde_json::json!(kind));
    normalized.insert("label".to_string(), serde_json::json!(label));
    normalized.insert("prompt".to_string(), serde_json::json!(prompt));
    for key in [
        "requiresCommit",
        "defaultAgentId",
        "defaultModel",
        "source",
        "updatedAt",
    ] {
        if let Some(field_value) = object.get(key) {
            normalized.insert(key.to_string(), field_value.clone());
        }
    }
    Some(serde_json::Value::Object(normalized))
}

fn load_prompt_templates(state: &McpState) -> Result<Vec<serde_json::Value>, String> {
    let mut templates: Vec<serde_json::Value> = default_prompt_templates()
        .into_iter()
        .filter_map(normalize_prompt_template)
        .collect();
    let mut index_by_id: HashMap<String, usize> = templates
        .iter()
        .enumerate()
        .filter_map(|(index, template)| {
            template
                .get("id")
                .and_then(|value| value.as_str())
                .map(|id| (id.to_string(), index))
        })
        .collect();

    let telemetry = state.app_handle.state::<crate::db::TelemetryDb>();
    if let Some(raw) = telemetry.local_app_kv_get("orchestration_user_templates")? {
        let parsed: serde_json::Value = serde_json::from_str(&raw)
            .map_err(|e| format!("Failed to parse orchestration user templates: {}", e))?;
        if let Some(user_templates) = parsed.as_array() {
            for template in user_templates.iter().cloned().filter_map(normalize_prompt_template) {
                let Some(id) = template.get("id").and_then(|value| value.as_str()) else {
                    continue;
                };
                if let Some(index) = index_by_id.get(id).copied() {
                    templates[index] = template;
                } else {
                    index_by_id.insert(id.to_string(), templates.len());
                    templates.push(template);
                }
            }
        }
    }

    Ok(templates)
}

fn handle_list_prompt_templates(
    id: serde_json::Value,
    state: Arc<McpState>,
    kind: Option<String>,
) -> JsonRpcResponse {
    let kind = kind.map(|value| value.trim().to_ascii_lowercase());
    if let Some(kind) = kind.as_deref() {
        if kind != "node" && kind != "orchestration" && !kind.is_empty() {
            return JsonRpcResponse {
                jsonrpc: "2.0",
                id,
                result: None,
                error: Some(JsonRpcError {
                    code: -32602,
                    message: "kind must be node or orchestration".to_string(),
                }),
            };
        }
    }

    match load_prompt_templates(&state) {
        Ok(templates) => {
            let templates: Vec<serde_json::Value> = templates
                .into_iter()
                .filter(|template| {
                    kind.as_deref().filter(|value| !value.is_empty()).map_or(true, |kind| {
                        template.get("kind").and_then(|value| value.as_str()) == Some(kind)
                    })
                })
                .collect();
            let body = serde_json::json!({
                "count": templates.len(),
                "templates": templates,
            });
            tool_text_response(
                id,
                serde_json::to_string_pretty(&body).unwrap_or_else(|_| body.to_string()),
            )
        }
        Err(err) => JsonRpcResponse {
            jsonrpc: "2.0",
            id,
            result: None,
            error: Some(JsonRpcError {
                code: -32001,
                message: err,
            }),
        },
    }
}

fn handle_get_prompt_template(
    id: serde_json::Value,
    state: Arc<McpState>,
    template_id: String,
) -> JsonRpcResponse {
    let Some(normalized_id) = normalize_template_id(&template_id) else {
        return JsonRpcResponse {
            jsonrpc: "2.0",
            id,
            result: None,
            error: Some(JsonRpcError {
                code: -32602,
                message: "template_id is invalid".to_string(),
            }),
        };
    };

    match load_prompt_templates(&state) {
        Ok(templates) => {
            if let Some(template) = templates.into_iter().find(|template| {
                template.get("id").and_then(|value| value.as_str()) == Some(normalized_id.as_str())
            }) {
                let body = serde_json::json!({ "template": template });
                return tool_text_response(
                    id,
                    serde_json::to_string_pretty(&body).unwrap_or_else(|_| body.to_string()),
                );
            }
            JsonRpcResponse {
                jsonrpc: "2.0",
                id,
                result: None,
                error: Some(JsonRpcError {
                    code: -32602,
                    message: format!("Unknown template {}", template_id),
                }),
            }
        }
        Err(err) => JsonRpcResponse {
            jsonrpc: "2.0",
            id,
            result: None,
            error: Some(JsonRpcError {
                code: -32001,
                message: err,
            }),
        },
    }
}

fn read_arg_string(args: &serde_json::Value, key: &str) -> Option<String> {
    args.get(key)
        .and_then(|value| value.as_str())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn read_arg_string_array(args: &serde_json::Value, key: &str) -> Vec<String> {
    args.get(key)
        .and_then(|value| value.as_array())
        .map(|values| {
            values
                .iter()
                .filter_map(|value| value.as_str())
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
                .collect()
        })
        .unwrap_or_default()
}

fn missing_args_response(id: serde_json::Value, message: &str) -> JsonRpcResponse {
    JsonRpcResponse {
        jsonrpc: "2.0",
        id,
        result: None,
        error: Some(JsonRpcError {
            code: -32602,
            message: message.to_string(),
        }),
    }
}

fn handle_complete_orchestration(
    id: serde_json::Value,
    state: Arc<McpState>,
    args: serde_json::Value,
) -> JsonRpcResponse {
    let Some(run_id) = read_arg_string(&args, "orchestrator_run_id") else {
        return missing_args_response(id, "orchestrator_run_id is required");
    };
    let Some(orchestrator_node_id) = read_arg_string(&args, "orchestrator_node_id") else {
        return missing_args_response(id, "orchestrator_node_id is required");
    };
    let terminal_child_assistant_node_ids =
        read_arg_string_array(&args, "terminal_child_assistant_node_ids");
    let payload = serde_json::json!({
        "terminalChildAssistantNodeIds": terminal_child_assistant_node_ids,
        "terminalChildRunCount": terminal_child_assistant_node_ids.len(),
    });
    let telemetry = state.app_handle.state::<crate::db::TelemetryDb>();
    match telemetry.record_orchestration_event(
        &run_id,
        &orchestrator_node_id,
        "orchestration:completed",
        &payload.to_string(),
    ) {
        Ok(seq) => tool_text_response(id, serde_json::json!({
            "completed": true,
            "seq": seq,
            "terminalChildAssistantNodeIds": terminal_child_assistant_node_ids,
        }).to_string()),
        Err(err) => JsonRpcResponse {
            jsonrpc: "2.0",
            id,
            result: None,
            error: Some(JsonRpcError {
                code: -32001,
                message: err,
            }),
        },
    }
}

async fn handle_frontend_orchestration_tool(
    id: serde_json::Value,
    state: Arc<McpState>,
    tool_name: &str,
    arguments: serde_json::Value,
) -> JsonRpcResponse {
    let request_id = uuid::Uuid::new_v4().to_string();
    let (sender, receiver) = tokio::sync::oneshot::channel();
    if let Err(err) = MCP_ORCHESTRATION_PENDING
        .lock()
        .map_err(|e| e.to_string())
        .map(|mut pending| pending.insert(request_id.clone(), sender))
    {
        return JsonRpcResponse {
            jsonrpc: "2.0",
            id,
            result: None,
            error: Some(JsonRpcError {
                code: -32001,
                message: err,
            }),
        };
    }

    let payload = serde_json::json!({
        "requestId": request_id,
        "toolName": tool_name,
        "arguments": arguments.clone(),
    });
    if let Err(err) = state.app_handle.emit("agentree://orchestration-mcp-request", payload) {
        let _ = MCP_ORCHESTRATION_PENDING
            .lock()
            .map(|mut pending| pending.remove(&request_id));
        return JsonRpcResponse {
            jsonrpc: "2.0",
            id,
            result: None,
            error: Some(JsonRpcError {
                code: -32002,
                message: format!("Failed to dispatch orchestration request to app: {}", err),
            }),
        };
    }

    let timeout = if tool_name == "wait_for_runs" {
        let timeout_ms = arguments
            .get("timeout_ms")
            .and_then(|value| value.as_u64())
            .unwrap_or(10 * 60 * 1000)
            .clamp(1_000, 30 * 60 * 1000);
        Duration::from_millis(timeout_ms + 5_000)
    } else {
        Duration::from_secs(120)
    };

    match tokio::time::timeout(timeout, receiver).await {
        Ok(Ok(Ok(value))) => tool_text_response(
            id,
            serde_json::to_string_pretty(&value).unwrap_or_else(|_| value.to_string()),
        ),
        Ok(Ok(Err(err))) => JsonRpcResponse {
            jsonrpc: "2.0",
            id,
            result: None,
            error: Some(JsonRpcError {
                code: -32003,
                message: err,
            }),
        },
        Ok(Err(_)) => JsonRpcResponse {
            jsonrpc: "2.0",
            id,
            result: None,
            error: Some(JsonRpcError {
                code: -32004,
                message: "Orchestration request responder was dropped.".to_string(),
            }),
        },
        Err(_) => {
            let _ = MCP_ORCHESTRATION_PENDING
                .lock()
                .map(|mut pending| pending.remove(&request_id));
            JsonRpcResponse {
                jsonrpc: "2.0",
                id,
                result: None,
                error: Some(JsonRpcError {
                    code: -32005,
                    message: "Timed out waiting for Agentree app to handle orchestration request."
                        .to_string(),
                }),
            }
        }
    }
}

#[derive(Debug)]
struct PendingError {
    code: i64,
    message: String,
}

impl PendingError {
    fn with_id(self, id: serde_json::Value) -> JsonRpcResponse {
        JsonRpcResponse {
            jsonrpc: "2.0",
            id,
            result: None,
            error: Some(JsonRpcError {
                code: self.code,
                message: self.message,
            }),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    static MCP_TEST_LOCK: Lazy<Mutex<()>> = Lazy::new(|| Mutex::new(()));

    #[test]
    fn bind_mcp_listener_returns_error_when_address_is_in_use() {
        let occupied =
            std::net::TcpListener::bind("127.0.0.1:0").expect("test listener should bind");
        let addr = occupied
            .local_addr()
            .expect("test listener should have a local address");

        let result = bind_mcp_listener(addr);

        assert!(
            result.is_err(),
            "binding an already occupied MCP address should return an error"
        );
    }

    #[test]
    fn bind_mcp_listener_assigns_free_port_for_port_zero() {
        let listener = bind_mcp_listener("127.0.0.1:0".parse().expect("addr parses"))
            .expect("binding to port 0 should succeed");
        let port = listener
            .local_addr()
            .expect("listener should have a local address")
            .port();
        assert_ne!(port, 0, "OS should assign a concrete free port");
    }

    #[test]
    fn resolved_port_reports_actual_bound_port_without_override() {
        let _guard = MCP_TEST_LOCK.lock().expect("mcp test lock");
        // Only meaningful when the environment sets no explicit port override.
        if configured_mcp_port_string().is_some() {
            return;
        }
        MCP_ACTUAL_PORT.store(54321, Ordering::SeqCst);
        assert_eq!(resolved_mcp_port_string().as_deref(), Some("54321"));
        assert_eq!(mcp_server_url(), "http://127.0.0.1:54321/mcp");
        MCP_ACTUAL_PORT.store(0, Ordering::SeqCst);
    }

    #[test]
    fn mcp_server_url_is_empty_before_dynamic_port_is_bound() {
        let _guard = MCP_TEST_LOCK.lock().expect("mcp test lock");
        if configured_mcp_port_string().is_some() {
            return;
        }
        MCP_ACTUAL_PORT.store(0, Ordering::SeqCst);
        assert_eq!(mcp_server_url(), "");
    }

    #[test]
    fn mcp_server_url_uses_default_bind_and_port() {
        assert_eq!(
            mcp_server_url_from_parts(None, None),
            "http://127.0.0.1:61337/mcp"
        );
    }

    #[test]
    fn mcp_server_url_uses_configured_bind_and_port() {
        assert_eq!(
            mcp_server_url_from_parts(Some("0.0.0.0"), Some("61234")),
            "http://0.0.0.0:61234/mcp"
        );
    }

    #[test]
    fn tools_list_exposes_current_graph_tools_without_project_id() {
        let response = handle_tools_list(serde_json::json!(1));
        let result = response.result.expect("tools/list should return result");
        let tools = result
            .get("tools")
            .and_then(|value| value.as_array())
            .expect("tools should be an array");
        let names: Vec<&str> = tools
            .iter()
            .filter_map(|tool| tool.get("name").and_then(|name| name.as_str()))
            .collect();

        assert!(names.contains(&"list_prompt_templates"));
        assert!(names.contains(&"get_prompt_template"));
        assert!(names.contains(&"start_orchestration_child"));
        assert!(names.contains(&"wait_for_runs"));
        assert!(names.contains(&"control_run"));
        assert!(names.contains(&"complete_orchestration"));
        assert!(names.contains(&"list_thread_sessions"));
        assert!(names.contains(&"read_thread"));
        assert!(names.contains(&"query_commits"));

        let serialized = serde_json::to_string(&result).expect("tools result should serialize");
        assert!(!serialized.contains("project_id"));
        assert!(!serialized.contains("messages"));
        assert!(!serialized.contains("workspace tree"));
    }

    #[test]
    fn set_mcp_current_context_seeds_fallback_workspace_and_auth() {
        set_mcp_current_context("token-1", Some("workspace-1")).expect("context should set");

        assert_eq!(
            get_workspace_id(None).expect("workspace should come from fallback"),
            "workspace-1"
        );
        assert_eq!(
            get_auth_header(HeaderMap::new()).expect("auth should come from fallback"),
            "Bearer token-1"
        );

        set_mcp_current_context("", Some("")).expect("blank context should clear");

        assert!(get_workspace_id(None).is_err());
        assert!(get_auth_header(HeaderMap::new()).is_err());
    }
}

fn get_workspace_id(arguments: Option<&serde_json::Value>) -> Result<String, PendingError> {
    if let Some(workspace_id) = arguments
        .and_then(|args| args.get("workspace_id"))
        .and_then(|value| value.as_str())
    {
        crate::app_log!("[MCP] workspace_id from arguments: {}", workspace_id);
        return Ok(workspace_id.to_string());
    }

    if let Ok(guard) = MCP_WORKSPACE_ID.lock() {
        if let Some(workspace_id) = guard.clone() {
            crate::app_log!("[MCP] workspace_id from MCP_WORKSPACE_ID: {}", workspace_id);
            return Ok(workspace_id);
        } else {
            crate::app_log!("[MCP] MCP_WORKSPACE_ID is None!");
        }
    } else {
        crate::app_log!("[MCP] Failed to lock MCP_WORKSPACE_ID!");
    }

    crate::app_log!("[MCP] No workspace_id available!");
    Err(PendingError {
        code: -32602,
        message: "Missing workspace_id".to_string(),
    })
}

fn get_auth_header(headers: HeaderMap) -> Result<String, PendingError> {
    // Check if auth header was provided in the request
    if let Some(header_value) = headers.get("authorization").and_then(|v| v.to_str().ok()) {
        let truncated = if header_value.len() > 20 {
            format!("{}...", &header_value[..20])
        } else {
            header_value.to_string()
        };
        crate::app_log!("[MCP] Auth from request header: {}", truncated);
        return Ok(header_value.to_string());
    }

    // Fall back to stored MCP_AUTH_TOKEN
    if let Ok(guard) = MCP_AUTH_TOKEN.lock() {
        if let Some(token) = guard.clone() {
            let truncated = if token.len() > 20 {
                format!("{}...", &token[..20])
            } else {
                token.clone()
            };
            crate::app_log!("[MCP] Auth from MCP_AUTH_TOKEN: {}", truncated);
            return Ok(format!("Bearer {}", token));
        } else {
            crate::app_log!("[MCP] MCP_AUTH_TOKEN is None!");
        }
    } else {
        crate::app_log!("[MCP] Failed to lock MCP_AUTH_TOKEN!");
    }

    crate::app_log!("[MCP] No auth token available!");
    Err(PendingError {
        code: -32001,
        message: "Missing Authorization header".to_string(),
    })
}

async fn handle_overview(
    id: serde_json::Value,
    headers: HeaderMap,
    state: Arc<McpState>,
    workspace_id: String,
) -> JsonRpcResponse {
    let auth_header = match get_auth_header(headers) {
        Ok(value) => value,
        Err(err) => return err.with_id(id),
    };

    let mut url = match Url::parse(&format!("{}/api/graph/overview", state.server_base_url)) {
        Ok(url) => url,
        Err(err) => {
            return JsonRpcResponse {
                jsonrpc: "2.0",
                id,
                result: None,
                error: Some(JsonRpcError {
                    code: -32002,
                    message: format!("Invalid server URL: {}", err),
                }),
            }
        }
    };
    url.query_pairs_mut()
        .append_pair("workspace_id", workspace_id.as_str());

    let request = state.http.get(url).header("Authorization", auth_header);
    match request.send().await {
        Ok(response) => {
            let status = response.status();
            match response.json::<serde_json::Value>().await {
                Ok(body) => {
                    if !status.is_success() {
                        let message = body
                            .get("error")
                            .and_then(|value| value.as_str())
                            .unwrap_or("Graph overview failed")
                            .to_string();
                        return JsonRpcResponse {
                            jsonrpc: "2.0",
                            id,
                            result: None,
                            error: Some(JsonRpcError {
                                code: -32003,
                                message,
                            }),
                        };
                    }
                    let output = body
                        .get("output")
                        .and_then(|value| value.as_str())
                        .unwrap_or("")
                        .to_string();
                    let node_mapping = body.get("nodeMapping").cloned();
                    JsonRpcResponse {
                        jsonrpc: "2.0",
                        id,
                        result: Some(serde_json::json!({
                            "content": [
                                { "type": "text", "text": output }
                            ],
                            "metadata": { "nodeMapping": node_mapping }
                        })),
                        error: None,
                    }
                }
                Err(err) => JsonRpcResponse {
                    jsonrpc: "2.0",
                    id,
                    result: None,
                    error: Some(JsonRpcError {
                        code: -32004,
                        message: format!("Invalid response body: {}", err),
                    }),
                },
            }
        }
        Err(err) => JsonRpcResponse {
            jsonrpc: "2.0",
            id,
            result: None,
            error: Some(JsonRpcError {
                code: -32005,
                message: format!("Request failed: {}", err),
            }),
        },
    }
}

async fn handle_graph_locate(
    id: serde_json::Value,
    headers: HeaderMap,
    state: Arc<McpState>,
    node_id: String,
    workspace_id: Option<String>,
) -> JsonRpcResponse {
    let auth_header = match get_auth_header(headers) {
        Ok(value) => value,
        Err(err) => return err.with_id(id),
    };
    let mut url = match Url::parse(&format!("{}/api/graph/locate", state.server_base_url)) {
        Ok(url) => url,
        Err(err) => {
            return JsonRpcResponse {
                jsonrpc: "2.0",
                id,
                result: None,
                error: Some(JsonRpcError {
                    code: -32002,
                    message: format!("Invalid server URL: {}", err),
                }),
            }
        }
    };
    url.query_pairs_mut()
        .append_pair("node_id", node_id.as_str());
    if let Some(workspace_id) = workspace_id {
        url.query_pairs_mut()
            .append_pair("workspace_id", workspace_id.as_str());
    }

    let request = state.http.get(url).header("Authorization", auth_header);
    match request.send().await {
        Ok(response) => {
            let status = response.status();
            match response.json::<serde_json::Value>().await {
                Ok(body) => {
                    if !status.is_success() {
                        let message = body
                            .get("error")
                            .and_then(|value| value.as_str())
                            .unwrap_or("Graph locate failed")
                            .to_string();
                        return JsonRpcResponse {
                            jsonrpc: "2.0",
                            id,
                            result: None,
                            error: Some(JsonRpcError {
                                code: -32003,
                                message,
                            }),
                        };
                    }
                    let output = body
                        .get("output")
                        .and_then(|value| value.as_str())
                        .unwrap_or("")
                        .to_string();
                    JsonRpcResponse {
                        jsonrpc: "2.0",
                        id,
                        result: Some(
                            serde_json::json!({ "content": [ { "type": "text", "text": output } ] }),
                        ),
                        error: None,
                    }
                }
                Err(err) => JsonRpcResponse {
                    jsonrpc: "2.0",
                    id,
                    result: None,
                    error: Some(JsonRpcError {
                        code: -32004,
                        message: format!("Invalid response body: {}", err),
                    }),
                },
            }
        }
        Err(err) => JsonRpcResponse {
            jsonrpc: "2.0",
            id,
            result: None,
            error: Some(JsonRpcError {
                code: -32005,
                message: format!("Request failed: {}", err),
            }),
        },
    }
}

async fn handle_graph_query(
    id: serde_json::Value,
    headers: HeaderMap,
    state: Arc<McpState>,
    workspace_id: String,
    filters: Option<serde_json::Value>,
    limit: Option<u32>,
    offset: Option<u32>,
) -> JsonRpcResponse {
    let auth_header = match get_auth_header(headers) {
        Ok(value) => value,
        Err(err) => return err.with_id(id),
    };

    let url = match Url::parse(&format!("{}/api/graph/query", state.server_base_url)) {
        Ok(url) => url,
        Err(err) => {
            return JsonRpcResponse {
                jsonrpc: "2.0",
                id,
                result: None,
                error: Some(JsonRpcError {
                    code: -32002,
                    message: format!("Invalid server URL: {}", err),
                }),
            };
        }
    };

    let mut body = serde_json::Map::new();
    body.insert(
        "workspace_id".to_string(),
        serde_json::Value::String(workspace_id),
    );
    body.insert(
        "filters".to_string(),
        filters.unwrap_or_else(|| serde_json::json!({})),
    );
    if let Some(limit) = limit {
        body.insert("limit".to_string(), serde_json::Value::Number(limit.into()));
    }
    if let Some(offset) = offset {
        body.insert(
            "offset".to_string(),
            serde_json::Value::Number(offset.into()),
        );
    }

    let request = state
        .http
        .post(url)
        .header("Authorization", auth_header)
        .json(&body);
    match request.send().await {
        Ok(response) => {
            let status = response.status();
            match response.json::<serde_json::Value>().await {
                Ok(body) => {
                    if !status.is_success() {
                        let message = body
                            .get("error")
                            .and_then(|value| value.as_str())
                            .unwrap_or("Graph query failed")
                            .to_string();
                        return JsonRpcResponse {
                            jsonrpc: "2.0",
                            id,
                            result: None,
                            error: Some(JsonRpcError {
                                code: -32003,
                                message,
                            }),
                        };
                    }
                    let output = body
                        .get("output")
                        .and_then(|value| value.as_str())
                        .unwrap_or("")
                        .to_string();
                    JsonRpcResponse {
                        jsonrpc: "2.0",
                        id,
                        result: Some(
                            serde_json::json!({ "content": [ { "type": "text", "text": output } ] }),
                        ),
                        error: None,
                    }
                }
                Err(err) => JsonRpcResponse {
                    jsonrpc: "2.0",
                    id,
                    result: None,
                    error: Some(JsonRpcError {
                        code: -32004,
                        message: format!("Invalid response body: {}", err),
                    }),
                },
            }
        }
        Err(err) => JsonRpcResponse {
            jsonrpc: "2.0",
            id,
            result: None,
            error: Some(JsonRpcError {
                code: -32005,
                message: format!("Request failed: {}", err),
            }),
        },
    }
}

async fn handle_graph_read_node(
    id: serde_json::Value,
    headers: HeaderMap,
    state: Arc<McpState>,
    node_id: String,
    include_tool_calls: Option<bool>,
    max_content_length: Option<u32>,
) -> JsonRpcResponse {
    let auth_header = match get_auth_header(headers) {
        Ok(value) => value,
        Err(err) => return err.with_id(id),
    };

    let mut url = match Url::parse(&format!("{}/api/graph/read-node", state.server_base_url)) {
        Ok(url) => url,
        Err(err) => {
            return JsonRpcResponse {
                jsonrpc: "2.0",
                id,
                result: None,
                error: Some(JsonRpcError {
                    code: -32002,
                    message: format!("Invalid server URL: {}", err),
                }),
            };
        }
    };
    url.query_pairs_mut()
        .append_pair("node_id", node_id.as_str());
    if let Some(include_tool_calls) = include_tool_calls {
        url.query_pairs_mut()
            .append_pair("include_tool_calls", &include_tool_calls.to_string());
    }
    if let Some(max_content_length) = max_content_length {
        url.query_pairs_mut()
            .append_pair("max_content_length", &max_content_length.to_string());
    }

    let request = state.http.get(url).header("Authorization", auth_header);
    match request.send().await {
        Ok(response) => {
            let status = response.status();
            match response.json::<serde_json::Value>().await {
                Ok(body) => {
                    if !status.is_success() {
                        let message = body
                            .get("error")
                            .and_then(|value| value.as_str())
                            .unwrap_or("Graph read node failed")
                            .to_string();
                        return JsonRpcResponse {
                            jsonrpc: "2.0",
                            id,
                            result: None,
                            error: Some(JsonRpcError {
                                code: -32003,
                                message,
                            }),
                        };
                    }
                    let output = body
                        .get("output")
                        .and_then(|value| value.as_str())
                        .unwrap_or("")
                        .to_string();
                    JsonRpcResponse {
                        jsonrpc: "2.0",
                        id,
                        result: Some(
                            serde_json::json!({ "content": [ { "type": "text", "text": output } ] }),
                        ),
                        error: None,
                    }
                }
                Err(err) => JsonRpcResponse {
                    jsonrpc: "2.0",
                    id,
                    result: None,
                    error: Some(JsonRpcError {
                        code: -32004,
                        message: format!("Invalid response body: {}", err),
                    }),
                },
            }
        }
        Err(err) => JsonRpcResponse {
            jsonrpc: "2.0",
            id,
            result: None,
            error: Some(JsonRpcError {
                code: -32005,
                message: format!("Request failed: {}", err),
            }),
        },
    }
}

async fn handle_list_thread_sessions(
    id: serde_json::Value,
    headers: HeaderMap,
    state: Arc<McpState>,
    workspace_id: String,
) -> JsonRpcResponse {
    let auth_header = match get_auth_header(headers) {
        Ok(value) => value,
        Err(err) => return err.with_id(id),
    };

    let mut url = match Url::parse(&format!(
        "{}/api/graph/thread-sessions",
        state.server_base_url
    )) {
        Ok(url) => url,
        Err(err) => {
            return JsonRpcResponse {
                jsonrpc: "2.0",
                id,
                result: None,
                error: Some(JsonRpcError {
                    code: -32002,
                    message: format!("Invalid server URL: {}", err),
                }),
            };
        }
    };
    url.query_pairs_mut()
        .append_pair("workspace_id", workspace_id.as_str());

    let request = state.http.get(url).header("Authorization", auth_header);
    text_output_response(id, request, "Thread session listing failed").await
}

async fn handle_read_thread(
    id: serde_json::Value,
    headers: HeaderMap,
    state: Arc<McpState>,
    workspace_id: String,
    thread_id: String,
    max_nodes: Option<u32>,
) -> JsonRpcResponse {
    let auth_header = match get_auth_header(headers) {
        Ok(value) => value,
        Err(err) => return err.with_id(id),
    };

    let mut url = match Url::parse(&format!("{}/api/graph/read-thread", state.server_base_url)) {
        Ok(url) => url,
        Err(err) => {
            return JsonRpcResponse {
                jsonrpc: "2.0",
                id,
                result: None,
                error: Some(JsonRpcError {
                    code: -32002,
                    message: format!("Invalid server URL: {}", err),
                }),
            };
        }
    };
    url.query_pairs_mut()
        .append_pair("workspace_id", workspace_id.as_str())
        .append_pair("thread_id", thread_id.as_str());
    if let Some(max_nodes) = max_nodes {
        url.query_pairs_mut()
            .append_pair("max_nodes", &max_nodes.to_string());
    }

    let request = state.http.get(url).header("Authorization", auth_header);
    text_output_response(id, request, "Thread read failed").await
}

#[allow(clippy::too_many_arguments)]
async fn handle_query_commits(
    id: serde_json::Value,
    headers: HeaderMap,
    state: Arc<McpState>,
    workspace_id: String,
    filters: Option<serde_json::Value>,
    limit: Option<u32>,
    offset: Option<u32>,
    include_parents: Option<bool>,
    include_observations: Option<bool>,
) -> JsonRpcResponse {
    let auth_header = match get_auth_header(headers) {
        Ok(value) => value,
        Err(err) => return err.with_id(id),
    };

    let url = match Url::parse(&format!(
        "{}/api/graph/query-commits",
        state.server_base_url
    )) {
        Ok(url) => url,
        Err(err) => {
            return JsonRpcResponse {
                jsonrpc: "2.0",
                id,
                result: None,
                error: Some(JsonRpcError {
                    code: -32002,
                    message: format!("Invalid server URL: {}", err),
                }),
            };
        }
    };

    let mut body = serde_json::Map::new();
    body.insert(
        "workspace_id".to_string(),
        serde_json::Value::String(workspace_id),
    );
    body.insert(
        "filters".to_string(),
        filters.unwrap_or_else(|| serde_json::json!({})),
    );
    if let Some(limit) = limit {
        body.insert("limit".to_string(), serde_json::Value::Number(limit.into()));
    }
    if let Some(offset) = offset {
        body.insert(
            "offset".to_string(),
            serde_json::Value::Number(offset.into()),
        );
    }
    if let Some(include_parents) = include_parents {
        body.insert(
            "include_parents".to_string(),
            serde_json::Value::Bool(include_parents),
        );
    }
    if let Some(include_observations) = include_observations {
        body.insert(
            "include_observations".to_string(),
            serde_json::Value::Bool(include_observations),
        );
    }

    let request = state
        .http
        .post(url)
        .header("Authorization", auth_header)
        .json(&body);
    text_output_response(id, request, "Commit query failed").await
}

async fn text_output_response(
    id: serde_json::Value,
    request: reqwest::RequestBuilder,
    fallback_error: &str,
) -> JsonRpcResponse {
    match request.send().await {
        Ok(response) => {
            let status = response.status();
            match response.json::<serde_json::Value>().await {
                Ok(body) => {
                    if !status.is_success() {
                        let message = body
                            .get("error")
                            .and_then(|value| value.as_str())
                            .unwrap_or(fallback_error)
                            .to_string();
                        return JsonRpcResponse {
                            jsonrpc: "2.0",
                            id,
                            result: None,
                            error: Some(JsonRpcError {
                                code: -32003,
                                message,
                            }),
                        };
                    }
                    let output = body
                        .get("output")
                        .and_then(|value| value.as_str())
                        .unwrap_or("")
                        .to_string();
                    JsonRpcResponse {
                        jsonrpc: "2.0",
                        id,
                        result: Some(
                            serde_json::json!({ "content": [ { "type": "text", "text": output } ] }),
                        ),
                        error: None,
                    }
                }
                Err(err) => JsonRpcResponse {
                    jsonrpc: "2.0",
                    id,
                    result: None,
                    error: Some(JsonRpcError {
                        code: -32004,
                        message: format!("Invalid response body: {}", err),
                    }),
                },
            }
        }
        Err(err) => JsonRpcResponse {
            jsonrpc: "2.0",
            id,
            result: None,
            error: Some(JsonRpcError {
                code: -32005,
                message: format!("Request failed: {}", err),
            }),
        },
    }
}

async fn fetch_graph_node_metadata(
    state: &Arc<McpState>,
    auth_header: &str,
    node_id: &str,
) -> Result<serde_json::Value, JsonRpcError> {
    let mut url =
        Url::parse(&format!("{}/api/graph/read-node", state.server_base_url)).map_err(|err| {
            JsonRpcError {
                code: -32002,
                message: format!("Invalid server URL: {}", err),
            }
        })?;
    url.query_pairs_mut().append_pair("node_id", node_id);

    let response = state
        .http
        .get(url)
        .header("Authorization", auth_header)
        .send()
        .await
        .map_err(|err| JsonRpcError {
            code: -32005,
            message: format!("Request failed: {}", err),
        })?;

    let status = response.status();
    let body = response
        .json::<serde_json::Value>()
        .await
        .map_err(|err| JsonRpcError {
            code: -32004,
            message: format!("Invalid response body: {}", err),
        })?;

    if !status.is_success() {
        let message = body
            .get("error")
            .and_then(|value| value.as_str())
            .unwrap_or("Graph read node failed")
            .to_string();
        return Err(JsonRpcError {
            code: -32003,
            message,
        });
    }

    Ok(body)
}

async fn handle_graph_blame(
    id: serde_json::Value,
    headers: HeaderMap,
    state: Arc<McpState>,
    node_id: String,
    file_path: String,
    _include_context: bool,
    _include_content: bool,
) -> JsonRpcResponse {
    let auth_header = match get_auth_header(headers) {
        Ok(value) => value,
        Err(err) => return err.with_id(id),
    };

    let node_meta = match fetch_graph_node_metadata(&state, &auth_header, &node_id).await {
        Ok(body) => body,
        Err(err) => {
            return JsonRpcResponse {
                jsonrpc: "2.0",
                id,
                result: None,
                error: Some(err),
            }
        }
    };

    let repo_path = match node_meta
        .get("git_repo_path")
        .and_then(|value| value.as_str())
    {
        Some(value) if !value.is_empty() => value.to_string(),
        _ => {
            return JsonRpcResponse {
                jsonrpc: "2.0",
                id,
                result: None,
                error: Some(JsonRpcError {
                    code: -32006,
                    message: "Could not resolve git repository path for this node.".to_string(),
                }),
            };
        }
    };
    let commit = node_meta
        .get("output_commit_sha")
        .and_then(|value| value.as_str())
        .or_else(|| {
            node_meta
                .get("base_commit_sha")
                .and_then(|value| value.as_str())
        })
        .unwrap_or("")
        .to_string();
    if commit.is_empty() {
        return JsonRpcResponse {
            jsonrpc: "2.0",
            id,
            result: None,
            error: Some(JsonRpcError {
                code: -32006,
                message: "This node does not have a finalized git commit.".to_string(),
            }),
        };
    }

    match crate::git_workspace::git_compute_blame(repo_path, commit.clone(), file_path.clone())
        .await
    {
        Ok(result) => {
            let mut summary = String::new();
            summary.push_str(&format!("Blame for {} (node {})\n", file_path, node_id));
            summary.push_str(&format!("Commit: {}\n", commit));
            summary.push_str(&format!("Total lines: {}\n", result.total_lines));
            summary.push_str(&format!("Entries: {}\n", result.entries.len()));
            for entry in result.entries.iter().take(10) {
                summary.push_str(&format!(
                    "- lines {}-{}: {}{}\n",
                    entry.line_start,
                    entry.line_end,
                    entry.author_node_id,
                    if entry.is_base { " (base)" } else { "" }
                ));
            }
            if result.entries.len() > 10 {
                summary.push_str("... (truncated)\n");
            }

            let output = serde_json::json!({
                "node": node_meta,
                "blame": result
            });
            JsonRpcResponse {
                jsonrpc: "2.0",
                id,
                result: Some(serde_json::json!({
                    "content": [
                        { "type": "text", "text": summary }
                    ],
                    "metadata": output
                })),
                error: None,
            }
        }
        Err(err) => JsonRpcResponse {
            jsonrpc: "2.0",
            id,
            result: None,
            error: Some(JsonRpcError {
                code: -32006,
                message: err,
            }),
        },
    }
}

async fn handle_graph_diff(
    id: serde_json::Value,
    headers: HeaderMap,
    state: Arc<McpState>,
    from_node_id: String,
    to_node_id: String,
    file_path: Option<String>,
    include_content: bool,
) -> JsonRpcResponse {
    let auth_header = match get_auth_header(headers) {
        Ok(value) => value,
        Err(err) => return err.with_id(id),
    };

    let from_meta = match fetch_graph_node_metadata(&state, &auth_header, &from_node_id).await {
        Ok(body) => body,
        Err(err) => {
            return JsonRpcResponse {
                jsonrpc: "2.0",
                id,
                result: None,
                error: Some(err),
            }
        }
    };
    let to_meta = match fetch_graph_node_metadata(&state, &auth_header, &to_node_id).await {
        Ok(body) => body,
        Err(err) => {
            return JsonRpcResponse {
                jsonrpc: "2.0",
                id,
                result: None,
                error: Some(err),
            }
        }
    };

    let repo_path = match to_meta
        .get("git_repo_path")
        .and_then(|value| value.as_str())
    {
        Some(value) if !value.is_empty() => value.to_string(),
        _ => {
            return JsonRpcResponse {
                jsonrpc: "2.0",
                id,
                result: None,
                error: Some(JsonRpcError {
                    code: -32006,
                    message: "Could not resolve git repository path for diff.".to_string(),
                }),
            };
        }
    };
    let from_commit = from_meta
        .get("output_commit_sha")
        .and_then(|value| value.as_str())
        .or_else(|| {
            from_meta
                .get("base_commit_sha")
                .and_then(|value| value.as_str())
        })
        .unwrap_or("")
        .to_string();
    let to_commit = to_meta
        .get("output_commit_sha")
        .and_then(|value| value.as_str())
        .or_else(|| {
            to_meta
                .get("base_commit_sha")
                .and_then(|value| value.as_str())
        })
        .unwrap_or("")
        .to_string();

    if from_commit.is_empty() || to_commit.is_empty() {
        return JsonRpcResponse {
            jsonrpc: "2.0",
            id,
            result: None,
            error: Some(JsonRpcError {
                code: -32006,
                message: "Both nodes must resolve to git commits before diffing.".to_string(),
            }),
        };
    }

    let result = if let Some(path) = file_path {
        crate::git_workspace::diff_file_between_commits(
            repo_path,
            from_commit.clone(),
            to_commit.clone(),
            path,
        )
        .await
        .map(|diff| serde_json::to_value(diff).unwrap_or_else(|_| serde_json::json!({})))
    } else {
        crate::git_workspace::diff_commits(
            repo_path,
            from_commit.clone(),
            to_commit.clone(),
            include_content,
        )
        .await
        .map(|diff| serde_json::to_value(diff).unwrap_or_else(|_| serde_json::json!({})))
    };

    match result {
        Ok(diff) => {
            let mut summary = String::new();
            summary.push_str(&format!("From commit: {}\n", from_commit));
            summary.push_str(&format!("To commit: {}\n", to_commit));
            if let Some(stats) = diff.get("stats") {
                let added = stats
                    .get("files_added")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0);
                let modified = stats
                    .get("files_modified")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0);
                let deleted = stats
                    .get("files_deleted")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0);
                summary.push_str(&format!("Files: +{} ~{} -{}\n", added, modified, deleted));
            }
            if let Some(files) = diff.get("files").and_then(|v| v.as_array()) {
                for file in files.iter().take(20) {
                    let path = file.get("path").and_then(|v| v.as_str()).unwrap_or("");
                    let status = file.get("status").and_then(|v| v.as_str()).unwrap_or("");
                    summary.push_str(&format!("- {} ({})\n", path, status));
                }
                if files.len() > 20 {
                    summary.push_str("... (truncated)\n");
                }
            }

            JsonRpcResponse {
                jsonrpc: "2.0",
                id,
                result: Some(serde_json::json!({
                    "content": [
                        { "type": "text", "text": summary }
                    ],
                    "metadata": {
                        "from": from_meta,
                        "to": to_meta,
                        "diff": diff
                    }
                })),
                error: None,
            }
        }
        Err(err) => JsonRpcResponse {
            jsonrpc: "2.0",
            id,
            result: None,
            error: Some(JsonRpcError {
                code: -32007,
                message: err,
            }),
        },
    }
}
