use axum::{
    extract::State,
    http::{HeaderMap, StatusCode, Uri},
    response::{IntoResponse, Response},
    routing::post,
    Json, Router,
};
use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use std::collections::{HashMap, HashSet};
use std::env;
use std::fs;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
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

    let state = Arc::new(McpState { app_handle });

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
    uri: Uri,
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
        "tools/call" => handle_tools_call(id, payload.params, headers, uri, state).await,
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
                    "description": "List prompt templates available to the orchestrator. Use this to discover #template labels before spawning orchestration runs.",
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
                    "description": "Read one prompt template by id or #label. Use this before composing an orchestration run prompt from a #template mention.",
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
                    "name": "start_orchestration_run",
                    "description": "Start one orchestration agent run. The spawned run is a normal graph run associated with the current orchestrator, not a graph child of the controller assistant.",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "orchestrator_run_id": { "type": "string" },
                            "orchestrator_node_id": { "type": "string" },
                            "decision_id": { "type": "string" },
                            "prompt": { "type": "string" },
                            "parent_node_id": {
                                "type": "string",
                                "description": "Optional visual/conversation parent for the orchestration run user node. Omit to attach first-level orchestration runs to the assistant message the user replied to, or to the thread node when this orchestration starts a new thread."
                            },
                            "context_parent_node_id": {
                                "type": "string",
                                "description": "Optional runtime context parent. Omit to inherit the orchestrator's original context parent."
                            },
                            "base_node_id": {
                                "type": "string",
                                "description": "Optional base node for runtime metadata. Omit to inherit the orchestrator's original base node."
                            },
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
                    "description": "Wait for orchestration assistant runs without tight model polling. The wait returns when the condition is satisfied or before the provider MCP timeout with checkpointElapsed=true as a neutral checkpoint. A checkpoint is not a child-run timeout.",
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
                            "timeout_ms": {
                                "type": "number",
                                "description": "Requested checkpoint wait duration in milliseconds. Agentree caps this below the provider MCP timeout."
                            }
                        },
                        "required": ["orchestrator_run_id", "orchestrator_node_id", "assistant_node_ids"]
                    }
                },
                {
                    "name": "control_run",
                    "description": "Control a running assistant node. Use action=steer with content to guide it, or action=stop to cancel it. Stopping an active run requires force=true and reason. This uses the same app runtime controls as normal user steering.",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "assistant_node_id": { "type": "string" },
                            "action": { "type": "string", "description": "steer or stop" },
                            "content": { "type": "string" },
                            "idempotency_key": { "type": "string" },
                            "force": { "type": "boolean" },
                            "reason": { "type": "string" }
                        },
                        "required": ["assistant_node_id", "action"]
                    }
                },
                {
                    "name": "complete_orchestration",
                    "description": "Mark an orchestrator run completed after orchestration run work is done.",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "orchestrator_run_id": { "type": "string" },
                            "orchestrator_node_id": { "type": "string" },
                            "terminal_orchestration_run_assistant_node_ids": {
                                "type": "array",
                                "description": "Terminal orchestration assistant node IDs.",
                                "items": { "type": "string" }
                            }
                        },
                        "required": ["orchestrator_run_id", "orchestrator_node_id"]
                    }
                },
                {
                    "name": "show_output",
                    "description": "Show a previewable output file, screenshot, generated image, PDF, HTML export, video, audio, or other result alongside the current assistant response.",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "node_id": {
                                "type": "string",
                                "description": "Optional internal override. Omit during normal agent runs; Agentree infers the current assistant node."
                            },
                            "id": { "type": "string", "description": "Optional stable artifact id. Agentree generates one when omitted." },
                            "title": { "type": "string" },
                            "caption": { "type": "string" },
                            "filename": { "type": "string" },
                            "kind": {
                                "type": "string",
                                "description": "image, screenshot, pdf, html, text, video, audio, or file"
                            },
                            "mime_type": { "type": "string" },
                            "path": {
                                "type": "string",
                                "description": "Local filesystem path to an artifact file produced by the agent."
                            },
                            "url": {
                                "type": "string",
                                "description": "Renderable URL or data URL for the artifact."
                            },
                            "thumbnail_url": { "type": "string" },
                            "width": { "type": "number" },
                            "height": { "type": "number" },
                            "size_bytes": { "type": "number" },
                            "isPrimary": { "type": "boolean" },
                            "public_safe": {
                                "type": "boolean",
                                "description": "Whether this artifact may be included in public share payloads. Defaults to false."
                            },
                            "source": { "type": "string" },
                            "source_commit_sha": { "type": "string" }
                        },
                        "required": []
                    }
                },
                {
                    "name": "graph_live_query",
                    "description": "Search local/projection graph state currently loaded in the app. Use this for active or recently started orchestration runs because persisted graph_query can lag local-first nodes. Results are explicitly marked as live/projection/local.",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "workspace_id": {
                                "type": "string",
                                "description": "OPTIONAL: Auto-detected from current context. Only pass if querying a different workspace."
                            },
                            "filters": { "type": "object", "description": "Filter criteria like {role: 'assistant', status: 'running'}" },
                            "node_id": { "type": "string" },
                            "limit": { "type": "number", "description": "Maximum nodes to return" },
                            "offset": { "type": "number", "description": "Pagination offset" }
                        },
                        "required": []
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
                    "description": "Read a specific graph node, including content and run metadata. Tool calls are omitted by default; pass include_tool_calls=true only when tool-call details are needed.",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "node_id": { "type": "string" },
                            "include_tool_calls": {
                                "type": "boolean",
                                "description": "Optional, defaults to false. Set true only when tool-call details are needed."
                            },
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
    _headers: HeaderMap,
    uri: Uri,
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
        Some("start_orchestration_run") => {
            let args = arguments.cloned().unwrap_or_else(|| serde_json::json!({}));
            handle_frontend_orchestration_tool(id, state, "start_orchestration_run", args).await
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
        Some("show_output") | Some("register_artifact") => {
            let args = arguments.cloned().unwrap_or_else(|| serde_json::json!({}));
            handle_show_output(id, state, args, mcp_request_node_id(&uri))
        }
        Some("graph_live_query") => {
            let args = arguments.cloned().unwrap_or_else(|| serde_json::json!({}));
            handle_frontend_orchestration_tool(id, state, "graph_live_query", args).await
        }
        Some("get_graph_overview") => {
            let workspace_id = get_workspace_id(arguments);
            if let Err(resp) = workspace_id {
                return resp.with_id(id);
            }
            handle_overview(id, state, workspace_id.unwrap()).await
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
            handle_graph_locate(id, state, node_id.unwrap(), workspace_id).await
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
            handle_graph_query(id, state, workspace_id.unwrap(), filters, limit, offset).await
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
            handle_list_thread_sessions(id, state, workspace_id.unwrap()).await
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
            "prompt": "Understand the current codebase around the request, then write an implementation plan.\n\nPrefer integrating with the existing domain model over inventing new names, helpers, or parallel abstractions. Fix the current concept unless the bug reveals a truly missing concept, new functionality, or business logic that requires it.",
            "requiresCommit": true,
            "source": "built_in"
        }),
        serde_json::json!({
            "id": "#synthesizer",
            "kind": "node",
            "label": "#synthesizer",
            "prompt": "Look at the shared commits. They may contain implementations, plans, or other outputs.\n\nCompare them and select the commit that best matches the requirement.\n\nIf other implementations contain better ideas, include those ideas and write the final changes.\n\nThe final synthesized output should combine the best ideas and feel coherent and seamless.",
            "requiresCommit": true,
            "source": "built_in"
        }),
        serde_json::json!({
            "id": "#reviewer",
            "kind": "node",
            "label": "#reviewer",
            "prompt": "Review the commit for correctness and regressions.\n\nAlso assess the result at a high level: identify major missed opportunities or significantly better, simpler, cleaner, or more elegant alternative solutions.",
            "source": "built_in"
        }),
        serde_json::json!({
            "id": "#fixer",
            "kind": "node",
            "label": "#fixer",
            "prompt": "Review the reviewer suggestions.\n\nFor each suggestion, implement it if you agree. If you disagree, explain why.",
            "requiresCommit": true,
            "source": "built_in"
        }),
        serde_json::json!({
            "id": "#implementer",
            "kind": "node",
            "label": "#implementer",
            "prompt": "Implement the plan thoroughly and correctly.\n\nYou may adjust small implementation details as you learn the codebase, but keep the functionality aligned with the user's requirement.",
            "requiresCommit": true,
            "source": "built_in"
        }),
        serde_json::json!({
            "id": "#handoff",
            "kind": "node",
            "label": "#handoff",
            "prompt": "Your job is to reduce the user's mental load because the user may not want to read full plans or test full implementations.\n\nBe brief, concrete, and selective. Do not ask broad approval questions. Ask the user for clarification only when the answer is required to avoid a wrong implementation, unsafe change, failed acceptance, or materially different product direction.\n\nWrite the response with exactly these sections:\n\n## What Matters\n- 2 to 4 bullets covering the key decision, plan, or implementation outcome in simple words.\n\n## User Attention Needed\n- Only blockers, risky assumptions, or required clarifications.\n- If there are none, write: None.\n\n## Suggested Next Step\nOne concrete sentence.\n\n## Quick Checks\n- For planning, list only clarifications that truly affect implementation.\n- For implementation, list the smallest useful things the user should test before accepting or requesting changes.",
            "source": "built_in"
        }),
        serde_json::json!({
            "id": "#parallel_planners",
            "kind": "orchestration",
            "label": "#parallel_planners",
            "prompt": "Create three parallel #planner runs named A, B, and C.\nCreate a #synthesizer sibling D to combine the plans.\nCreate a #handoff E as a child of D.\n\nShare the handoff's output with the user after finishing.",
            "source": "built_in"
        }),
        serde_json::json!({
            "id": "#parallel_implementer",
            "kind": "orchestration",
            "label": "#parallel_implementer",
            "prompt": "Create three parallel #implementer runs named A, B, and C.\nCreate a #synthesizer sibling D to combine the plans.\n\nLoop up to 3 times:\n- Create a #reviewer sibling to review the latest synthesized plan.\n- Create a #fixer child of D for the first pass, then a child of the previous fixer for later passes.\n\nRun a #handoff as a child of the final fixer.\n\nShare the handoff's output with the user after finishing.",
            "source": "built_in"
        }),
    ]
}

fn normalize_template_id(value: &str) -> Option<String> {
    let mut normalized = String::new();
    let mut last_was_separator = false;
    for ch in value
        .trim()
        .trim_start_matches(|ch| ch == '@' || ch == '#')
        .chars()
    {
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
            for template in user_templates
                .iter()
                .cloned()
                .filter_map(normalize_prompt_template)
            {
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
                    kind.as_deref()
                        .filter(|value| !value.is_empty())
                        .map_or(true, |kind| {
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

fn mcp_timestamp_string() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn read_arg_bool(args: &serde_json::Value, key: &str) -> Option<bool> {
    args.get(key).and_then(|value| value.as_bool())
}

fn read_arg_u64(args: &serde_json::Value, key: &str) -> Option<u64> {
    args.get(key).and_then(|value| value.as_u64())
}

fn mcp_request_node_id(uri: &Uri) -> Option<String> {
    uri.query()?
        .split('&')
        .filter_map(|pair| pair.split_once('='))
        .find_map(|(key, value)| {
            if key == "agentree_node_id" || key == "node_id" {
                let value = value.trim();
                if !value.is_empty() {
                    return Some(value.to_string());
                }
            }
            None
        })
}

fn mime_type_from_path(path: &str) -> Option<&'static str> {
    match Path::new(path)
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_ascii_lowercase())
        .as_deref()
    {
        Some("png") => Some("image/png"),
        Some("jpg") | Some("jpeg") => Some("image/jpeg"),
        Some("gif") => Some("image/gif"),
        Some("webp") => Some("image/webp"),
        Some("svg") => Some("image/svg+xml"),
        Some("pdf") => Some("application/pdf"),
        Some("html") | Some("htm") => Some("text/html"),
        Some("txt") | Some("md") | Some("log") => Some("text/plain"),
        Some("json") => Some("application/json"),
        Some("mp4") => Some("video/mp4"),
        Some("webm") => Some("video/webm"),
        Some("mp3") => Some("audio/mpeg"),
        Some("wav") => Some("audio/wav"),
        _ => None,
    }
}

fn artifact_kind_from_mime(mime_type: &str) -> &'static str {
    if mime_type.starts_with("image/") {
        "image"
    } else if mime_type.starts_with("video/") {
        "video"
    } else if mime_type.starts_with("audio/") {
        "audio"
    } else if mime_type == "application/pdf" {
        "pdf"
    } else if mime_type == "text/html" {
        "html"
    } else if mime_type.starts_with("text/") {
        "text"
    } else {
        "file"
    }
}

fn normalize_artifact_kind(raw: Option<String>, mime_type: &str) -> String {
    match raw.as_deref() {
        Some("image") | Some("screenshot") | Some("pdf") | Some("html") | Some("text")
        | Some("video") | Some("audio") | Some("file") => raw.unwrap(),
        _ => artifact_kind_from_mime(mime_type).to_string(),
    }
}

fn local_image_data_url(path: &str, mime_type: &str) -> Option<String> {
    const MAX_INLINE_IMAGE_BYTES: u64 = 2_000_000;
    if !mime_type.starts_with("image/") {
        return None;
    }
    let metadata = fs::metadata(path).ok()?;
    if !metadata.is_file() || metadata.len() > MAX_INLINE_IMAGE_BYTES {
        return None;
    }
    let bytes = fs::read(path).ok()?;
    Some(format!(
        "data:{};base64,{}",
        mime_type,
        BASE64_STANDARD.encode(bytes)
    ))
}

fn safe_artifact_filename(value: &str) -> String {
    let sanitized = value
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '-' | '_') {
                ch
            } else {
                '-'
            }
        })
        .collect::<String>()
        .trim_matches('-')
        .to_string();
    if sanitized.is_empty() {
        "artifact".to_string()
    } else {
        sanitized
    }
}

fn durable_artifact_path(
    app_handle: &AppHandle,
    node_id: &str,
    artifact_id: &str,
    source_path: &str,
    filename: Option<&str>,
) -> Result<PathBuf, String> {
    let artifacts_root = app_handle
        .path()
        .app_data_dir()
        .map_err(|error| format!("Could not resolve app data dir: {}", error))?
        .join("artifacts");
    durable_artifact_path_in_dir(artifacts_root, node_id, artifact_id, source_path, filename)
}

fn durable_artifact_path_in_dir(
    artifacts_root: PathBuf,
    node_id: &str,
    artifact_id: &str,
    source_path: &str,
    filename: Option<&str>,
) -> Result<PathBuf, String> {
    let source = Path::new(source_path);
    let metadata = fs::metadata(source).map_err(|error| {
        format!(
            "Could not read artifact file {}: {}",
            source.display(),
            error
        )
    })?;
    if !metadata.is_file() {
        return Err(format!("Artifact path is not a file: {}", source.display()));
    }

    let artifact_suffix = artifact_id
        .rsplit(':')
        .next()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("artifact");
    let source_filename = filename
        .or_else(|| source.file_name().and_then(|value| value.to_str()))
        .unwrap_or("artifact");
    let safe_name = format!(
        "{}-{}",
        safe_artifact_filename(artifact_suffix),
        safe_artifact_filename(source_filename)
    );
    let artifacts_dir = artifacts_root.join(safe_artifact_filename(node_id));
    fs::create_dir_all(&artifacts_dir).map_err(|error| {
        format!(
            "Could not create artifact directory {}: {}",
            artifacts_dir.display(),
            error
        )
    })?;
    let destination = artifacts_dir.join(safe_name);
    if source != destination {
        fs::copy(source, &destination).map_err(|error| {
            format!(
                "Could not copy artifact file {} to {}: {}",
                source.display(),
                destination.display(),
                error
            )
        })?;
    }
    Ok(destination)
}

fn handle_show_output(
    id: serde_json::Value,
    state: Arc<McpState>,
    args: serde_json::Value,
    request_node_id: Option<String>,
) -> JsonRpcResponse {
    let Some(node_id) = request_node_id
        .or_else(|| read_arg_string(&args, "node_id"))
        .or_else(|| read_arg_string(&args, "nodeId"))
    else {
        return missing_args_response(id, "current assistant node could not be inferred");
    };

    let telemetry = state.app_handle.state::<crate::db::TelemetryDb>();
    let payload_json = match telemetry.get_local_node_payload(&node_id) {
        Ok(Some(payload)) => payload,
        Ok(None) => {
            return JsonRpcResponse {
                jsonrpc: "2.0",
                id,
                result: None,
                error: Some(JsonRpcError {
                    code: -32602,
                    message: format!("Unknown local node {}", node_id),
                }),
            };
        }
        Err(err) => {
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
    };

    let mut payload: JsonValue = match serde_json::from_str(&payload_json) {
        Ok(value) => value,
        Err(err) => {
            return JsonRpcResponse {
                jsonrpc: "2.0",
                id,
                result: None,
                error: Some(JsonRpcError {
                    code: -32001,
                    message: format!("Failed to parse local node payload: {}", err),
                }),
            };
        }
    };

    let workspace_id = payload
        .get("workspaceId")
        .or_else(|| payload.get("workspace_id"))
        .and_then(|value| value.as_str())
        .map(|value| value.to_string())
        .or_else(|| read_arg_string(&args, "workspace_id"))
        .or_else(|| MCP_WORKSPACE_ID.lock().ok().and_then(|guard| guard.clone()));
    let Some(workspace_id) = workspace_id else {
        return missing_args_response(id, "workspace_id could not be inferred for node");
    };

    let path = read_arg_string(&args, "path");
    let url = read_arg_string(&args, "url");
    if path.is_none() && url.is_none() {
        return missing_args_response(id, "path or url is required");
    }

    let mime_type = read_arg_string(&args, "mime_type")
        .or_else(|| read_arg_string(&args, "mimeType"))
        .or_else(|| {
            path.as_deref()
                .and_then(mime_type_from_path)
                .map(|value| value.to_string())
        })
        .unwrap_or_else(|| "application/octet-stream".to_string());
    let kind = normalize_artifact_kind(read_arg_string(&args, "kind"), &mime_type);
    let artifact_id = read_arg_string(&args, "id")
        .unwrap_or_else(|| format!("{}:artifact:{}", node_id, uuid::Uuid::new_v4()));
    let title = read_arg_string(&args, "title")
        .or_else(|| read_arg_string(&args, "filename"))
        .or_else(|| {
            path.as_deref()
                .and_then(|value| Path::new(value).file_name())
                .and_then(|value| value.to_str())
                .map(|value| value.to_string())
        })
        .unwrap_or_else(|| kind.clone());
    let filename = read_arg_string(&args, "filename").or_else(|| {
        path.as_deref()
            .and_then(|value| Path::new(value).file_name())
            .and_then(|value| value.to_str())
            .map(|value| value.to_string())
    });
    let public_safe = read_arg_bool(&args, "public_safe")
        .or_else(|| read_arg_bool(&args, "publicSafe"))
        .unwrap_or(false);
    let durable_path = if let Some(path_value) = path.as_deref() {
        match durable_artifact_path(
            &state.app_handle,
            &node_id,
            &artifact_id,
            path_value,
            filename.as_deref(),
        ) {
            Ok(value) => Some(value),
            Err(err) => {
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
        }
    } else {
        None
    };
    let storage_path = durable_path
        .as_ref()
        .map(|value| value.to_string_lossy().to_string())
        .or_else(|| path.clone());
    let data_url = storage_path
        .as_deref()
        .and_then(|value| local_image_data_url(value, &mime_type));
    let thumbnail_url = read_arg_string(&args, "thumbnail_url")
        .or_else(|| read_arg_string(&args, "thumbnailUrl"))
        .or_else(|| data_url.clone())
        .or_else(|| url.clone().filter(|_| mime_type.starts_with("image/")));
    let size_bytes = read_arg_u64(&args, "size_bytes")
        .or_else(|| read_arg_u64(&args, "sizeBytes"))
        .or_else(|| {
            storage_path
                .as_deref()
                .and_then(|value| fs::metadata(value).ok())
                .map(|metadata| metadata.len())
        });
    let is_primary =
        read_arg_bool(&args, "isPrimary").or_else(|| read_arg_bool(&args, "is_primary"));

    let storage_backend = if url
        .as_deref()
        .map(|value| value.starts_with("data:"))
        .unwrap_or(false)
    {
        "inline"
    } else if url.is_some() {
        "remote"
    } else {
        "local"
    };
    let mut storage = serde_json::json!({
        "backend": storage_backend,
    });
    if let Some(path_value) = storage_path.clone() {
        storage["path"] = serde_json::json!(path_value);
    }
    if let Some(url_value) = url.clone() {
        storage["url"] = serde_json::json!(url_value);
    }

    let mut artifact = serde_json::json!({
        "id": artifact_id,
        "nodeId": node_id,
        "role": "output",
        "kind": kind,
        "mimeType": mime_type,
        "title": title,
        "storage": storage,
        "publicSafe": public_safe,
        "source": read_arg_string(&args, "source").unwrap_or_else(|| "agent_file".to_string()),
        "createdAt": mcp_timestamp_string(),
    });
    if let Some(caption) = read_arg_string(&args, "caption") {
        artifact["caption"] = serde_json::json!(caption);
    }
    if let Some(filename_value) = filename {
        artifact["filename"] = serde_json::json!(filename_value);
    }
    if let Some(width) = read_arg_u64(&args, "width") {
        artifact["width"] = serde_json::json!(width);
    }
    if let Some(height) = read_arg_u64(&args, "height") {
        artifact["height"] = serde_json::json!(height);
    }
    if let Some(size) = size_bytes {
        artifact["sizeBytes"] = serde_json::json!(size);
    }
    if let Some(primary) = is_primary {
        artifact["isPrimary"] = serde_json::json!(primary);
    }
    if let Some(source_commit_sha) = read_arg_string(&args, "source_commit_sha")
        .or_else(|| read_arg_string(&args, "sourceCommitSha"))
    {
        artifact["sourceCommitSha"] = serde_json::json!(source_commit_sha);
    }
    if let Some(thumbnail) = thumbnail_url {
        artifact["thumbnail"] = serde_json::json!({
            "url": thumbnail,
            "width": read_arg_u64(&args, "width"),
            "height": read_arg_u64(&args, "height"),
        });
    }

    if !payload
        .get("execution_data")
        .map(|value| value.is_object())
        .unwrap_or(false)
    {
        payload["execution_data"] = serde_json::json!({});
    }
    let (artifacts, artifact) = crate::artifacts::upsert_artifact_in_execution_data(
        &mut payload["execution_data"],
        artifact,
    );
    payload["artifacts"] = JsonValue::Array(artifacts);
    payload["updatedAt"] = serde_json::json!(mcp_timestamp_string());

    let serialized = match serde_json::to_string(&payload) {
        Ok(value) => value,
        Err(err) => {
            return JsonRpcResponse {
                jsonrpc: "2.0",
                id,
                result: None,
                error: Some(JsonRpcError {
                    code: -32001,
                    message: format!("Failed to serialize updated node payload: {}", err),
                }),
            };
        }
    };
    if let Err(err) = telemetry.upsert_local_node(&node_id, &workspace_id, &serialized) {
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

    crate::agents::apply_and_emit_agent_event(
        &state.app_handle,
        &node_id,
        &serde_json::json!({
            "type": "artifact_registered",
            "artifact": artifact,
        }),
    );

    tool_text_response(
        id,
        serde_json::to_string_pretty(&serde_json::json!({
            "shown": true,
            "artifact": artifact,
        }))
        .unwrap_or_else(|_| "{\"shown\":true}".to_string()),
    )
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
    let terminal_orchestration_run_assistant_node_ids =
        read_arg_string_array(&args, "terminal_orchestration_run_assistant_node_ids");
    let payload = serde_json::json!({
        "terminalOrchestrationRunAssistantNodeIds": terminal_orchestration_run_assistant_node_ids,
        "terminalOrchestrationRunCount": terminal_orchestration_run_assistant_node_ids.len(),
    });
    let telemetry = state.app_handle.state::<crate::db::TelemetryDb>();
    match telemetry.record_orchestration_event(
        &run_id,
        &orchestrator_node_id,
        "orchestration:completed",
        &payload.to_string(),
    ) {
        Ok(seq) => tool_text_response(
            id,
            serde_json::json!({
                "completed": true,
                "seq": seq,
                "terminalOrchestrationRunAssistantNodeIds": terminal_orchestration_run_assistant_node_ids,
            })
            .to_string(),
        ),
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

const ORCHESTRATION_MCP_DEFAULT_WAIT_TIMEOUT_MS: u64 = 5 * 60 * 1000;
const ORCHESTRATION_MCP_MAX_WAIT_TIMEOUT_MS: u64 = 5 * 60 * 1000;
const ORCHESTRATION_MCP_MIN_WAIT_TIMEOUT_MS: u64 = 1_000;
const ORCHESTRATION_MCP_WAIT_BACKEND_GRACE_MS: u64 = 5_000;
const ORCHESTRATION_MCP_NON_WAIT_TIMEOUT_MS: u64 = 110_000;

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
    if let Err(err) = state
        .app_handle
        .emit("agentree://orchestration-mcp-request", payload)
    {
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
            .unwrap_or(ORCHESTRATION_MCP_DEFAULT_WAIT_TIMEOUT_MS)
            .clamp(
                ORCHESTRATION_MCP_MIN_WAIT_TIMEOUT_MS,
                ORCHESTRATION_MCP_MAX_WAIT_TIMEOUT_MS,
            );
        Duration::from_millis(timeout_ms + ORCHESTRATION_MCP_WAIT_BACKEND_GRACE_MS)
    } else {
        Duration::from_millis(ORCHESTRATION_MCP_NON_WAIT_TIMEOUT_MS)
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
    fn durable_artifact_path_copies_local_file_to_artifact_storage() {
        let temp = tempfile::tempdir().expect("tempdir");
        let source = temp.path().join("source image.png");
        fs::write(&source, b"png-bytes").expect("source file");

        let durable = durable_artifact_path_in_dir(
            temp.path().join("artifacts"),
            "node:with/slashes",
            "node:artifact:artifact-id",
            source.to_str().expect("source path"),
            Some("source image.png"),
        )
        .expect("durable path");

        assert_ne!(durable, source);
        assert!(durable.exists());
        assert_eq!(fs::read(&durable).expect("durable bytes"), b"png-bytes");
        assert!(durable
            .to_string_lossy()
            .contains("node-with-slashes/artifact-id-source-image.png"));
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
        assert!(names.contains(&"start_orchestration_run"));
        assert!(names.contains(&"wait_for_runs"));
        assert!(names.contains(&"control_run"));
        assert!(names.contains(&"complete_orchestration"));
        assert!(names.contains(&"show_output"));
        assert!(names.contains(&"list_thread_sessions"));
        assert!(names.contains(&"read_thread"));
        assert!(names.contains(&"query_commits"));

        let serialized = serde_json::to_string(&result).expect("tools result should serialize");
        assert!(!serialized.contains("project_id"));
        assert!(!serialized.contains("messages"));
        assert!(!serialized.contains("workspace tree"));
    }

    #[test]
    fn default_prompt_templates_match_edited_builtin_set() {
        let ids: Vec<String> = default_prompt_templates()
            .into_iter()
            .filter_map(|template| {
                template
                    .get("id")
                    .and_then(|id| id.as_str())
                    .map(str::to_string)
            })
            .collect();

        assert_eq!(
            ids,
            vec![
                "#planner",
                "#synthesizer",
                "#reviewer",
                "#fixer",
                "#implementer",
                "#handoff",
                "#parallel_planners",
                "#parallel_implementer",
            ]
        );
    }

    #[test]
    fn set_mcp_current_context_seeds_fallback_workspace() {
        set_mcp_current_context("token-1", Some("workspace-1")).expect("context should set");

        assert_eq!(
            get_workspace_id(None).expect("workspace should come from fallback"),
            "workspace-1"
        );

        set_mcp_current_context("", Some("")).expect("blank context should clear");

        assert!(get_workspace_id(None).is_err());
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

fn text_result(id: serde_json::Value, output: String) -> JsonRpcResponse {
    JsonRpcResponse {
        jsonrpc: "2.0",
        id,
        result: Some(serde_json::json!({
            "content": [{ "type": "text", "text": output }]
        })),
        error: None,
    }
}

fn local_data_error(id: serde_json::Value, message: impl Into<String>) -> JsonRpcResponse {
    JsonRpcResponse {
        jsonrpc: "2.0",
        id,
        result: None,
        error: Some(JsonRpcError {
            code: -32006,
            message: message.into(),
        }),
    }
}

#[derive(Debug, Clone)]
struct LocalGraphNode {
    row: crate::db::LocalNodeRow,
    payload: JsonValue,
}

fn parse_node_payload(node_id: &str, payload: &str) -> Result<JsonValue, JsonRpcError> {
    serde_json::from_str::<JsonValue>(payload).map_err(|err| JsonRpcError {
        code: -32004,
        message: format!("Invalid local payload for node {}: {}", node_id, err),
    })
}

fn node_string<'a>(payload: &'a JsonValue, keys: &[&str]) -> Option<&'a str> {
    for key in keys {
        if let Some(value) = payload.get(*key).and_then(|value| value.as_str()) {
            if !value.trim().is_empty() {
                return Some(value);
            }
        }
    }
    None
}

fn execution_string<'a>(payload: &'a JsonValue, keys: &[&str]) -> Option<&'a str> {
    let execution_data = payload.get("execution_data")?;
    for key in keys {
        if let Some(value) = execution_data.get(*key).and_then(|value| value.as_str()) {
            if !value.trim().is_empty() {
                return Some(value);
            }
        }
    }
    None
}

fn node_parent_id(payload: &JsonValue) -> Option<&str> {
    node_string(payload, &["parentId", "parent_id"])
}

fn node_workspace_id(payload: &JsonValue) -> Option<&str> {
    node_string(payload, &["workspaceId", "workspace_id"])
}

fn node_thread_id(payload: &JsonValue) -> Option<&str> {
    node_string(payload, &["threadId", "thread_id"])
}

fn node_content(payload: &JsonValue) -> &str {
    payload
        .get("content")
        .and_then(|value| value.as_str())
        .unwrap_or("")
}

fn truncate_chars(value: &str, max_chars: Option<u32>) -> String {
    let Some(max_chars) = max_chars else {
        return value.to_string();
    };
    let max_chars = max_chars as usize;
    if value.chars().count() <= max_chars {
        return value.to_string();
    }
    let mut truncated = value.chars().take(max_chars).collect::<String>();
    truncated.push_str("\n...[truncated]");
    truncated
}

fn sanitize_node_payload(mut payload: JsonValue, include_tool_calls: bool) -> JsonValue {
    if include_tool_calls {
        return payload;
    }
    if let Some(execution_data) = payload
        .get_mut("execution_data")
        .and_then(|value| value.as_object_mut())
    {
        if let Some(timeline) = execution_data
            .get_mut("timeline")
            .and_then(|value| value.as_array_mut())
        {
            timeline.retain(|event| {
                event
                    .get("type")
                    .and_then(|value| value.as_str())
                    .map(|event_type| !event_type.to_ascii_lowercase().contains("tool"))
                    .unwrap_or(true)
            });
        }
        execution_data.remove("tool_calls");
        execution_data.remove("toolCalls");
    }
    if let Some(object) = payload.as_object_mut() {
        object.remove("tool_calls");
        object.remove("toolCalls");
    }
    payload
}

fn node_summary(node: &LocalGraphNode) -> String {
    let payload = &node.payload;
    let role = node_string(payload, &["role"]).unwrap_or("unknown");
    let status = node_string(payload, &["status"]).unwrap_or("unknown");
    let parent = node_parent_id(payload).unwrap_or("-");
    let thread = node_thread_id(payload).unwrap_or("-");
    let commit = node_string(
        payload,
        &["output_commit_sha", "git_commit_sha", "gitCommitSha"],
    )
    .unwrap_or("-");
    let content = node_content(payload).replace('\n', " ");
    let preview = truncate_chars(content.trim(), Some(140));
    format!(
        "- {} role={} status={} parent={} thread={} commit={} content={}",
        node.row.node_id, role, status, parent, thread, commit, preview
    )
}

fn telemetry_db(state: &Arc<McpState>) -> tauri::State<'_, crate::db::TelemetryDb> {
    state.app_handle.state::<crate::db::TelemetryDb>()
}

fn local_nodes_for_workspace(
    state: &Arc<McpState>,
    workspace_id: &str,
) -> Result<Vec<LocalGraphNode>, JsonRpcError> {
    telemetry_db(state)
        .list_local_nodes_for_workspace(workspace_id)
        .map_err(|err| JsonRpcError {
            code: -32006,
            message: format!("Failed to read local graph nodes: {}", err),
        })?
        .into_iter()
        .map(|row| {
            let payload = parse_node_payload(&row.node_id, &row.payload)?;
            Ok(LocalGraphNode { row, payload })
        })
        .collect()
}

fn local_node_payload(state: &Arc<McpState>, node_id: &str) -> Result<JsonValue, JsonRpcError> {
    let raw_payload = telemetry_db(state)
        .get_local_node_payload(node_id)
        .map_err(|err| JsonRpcError {
            code: -32006,
            message: format!("Failed to read local node {}: {}", node_id, err),
        })?
        .ok_or_else(|| JsonRpcError {
            code: -32006,
            message: format!(
                "Node {} was not found in the local Agentree database.",
                node_id
            ),
        })?;
    let mut payload = parse_node_payload(node_id, &raw_payload)?;
    if let Some(workspace_id) = node_workspace_id(&payload).map(str::to_string) {
        if let Ok(nodes) = local_nodes_for_workspace(state, &workspace_id) {
            if let Some(node) = nodes.into_iter().find(|node| node.row.node_id == node_id) {
                payload = node.payload;
            }
        }
    }
    Ok(payload)
}

fn local_node_metadata(state: &Arc<McpState>, node_id: &str) -> Result<JsonValue, JsonRpcError> {
    let mut payload = local_node_payload(state, node_id)?;
    let repo_path = resolve_repo_path_for_node(state, &payload);
    if let Some(repo_path) = repo_path {
        if let Some(object) = payload.as_object_mut() {
            object.insert("git_repo_path".to_string(), JsonValue::String(repo_path));
        }
    }
    Ok(payload)
}

fn resolve_repo_path_for_node(state: &Arc<McpState>, payload: &JsonValue) -> Option<String> {
    node_string(payload, &["git_repo_path", "repo_path", "local_repo_path"])
        .or_else(|| execution_string(payload, &["git_repo_path", "repo_path", "worktree_path"]))
        .map(str::to_string)
        .or_else(|| {
            let workspace_id = node_workspace_id(payload)?;
            telemetry_db(state)
                .get_local_workspace_by_id(workspace_id)
                .ok()
                .flatten()
                .and_then(|workspace| {
                    workspace
                        .local_repo_path
                        .or(workspace.folder_path)
                        .or(workspace.repo_path)
                })
        })
}

fn node_commit(payload: &JsonValue) -> Option<String> {
    node_string(
        payload,
        &[
            "output_commit_sha",
            "git_commit_sha",
            "gitCommitSha",
            "commit_sha",
            "base_commit_sha",
            "baseCommitSha",
        ],
    )
    .map(str::to_string)
}

fn filter_value_matches(actual: &JsonValue, expected: &JsonValue) -> bool {
    match (actual, expected) {
        (_, JsonValue::Null) => true,
        (JsonValue::String(actual), JsonValue::String(expected)) => actual == expected,
        (JsonValue::Bool(actual), JsonValue::Bool(expected)) => actual == expected,
        (JsonValue::Number(actual), JsonValue::Number(expected)) => actual == expected,
        (JsonValue::Array(actual), _) => actual
            .iter()
            .any(|value| filter_value_matches(value, expected)),
        _ => actual == expected,
    }
}

fn payload_filter_value<'a>(payload: &'a JsonValue, key: &str) -> Option<&'a JsonValue> {
    match key {
        "node_id" | "nodeId" => payload.get("id").or_else(|| payload.get("node_id")),
        "parent_id" | "parentId" => payload.get("parentId").or_else(|| payload.get("parent_id")),
        "workspace_id" | "workspaceId" => payload
            .get("workspaceId")
            .or_else(|| payload.get("workspace_id")),
        "thread_id" | "threadId" => payload.get("threadId").or_else(|| payload.get("thread_id")),
        "controlled_by_node_id" | "controlledByNodeId" => payload
            .get("controlled_by_node_id")
            .or_else(|| payload.get("controlledByNodeId")),
        _ => payload
            .get(key)
            .or_else(|| {
                payload
                    .get("execution_data")
                    .and_then(|value| value.get(key))
            })
            .or_else(|| {
                payload
                    .get("execution_data")
                    .and_then(|value| value.get("meta"))
                    .and_then(|value| value.get(key))
            }),
    }
}

fn node_matches_filters(node: &LocalGraphNode, filters: Option<&JsonValue>) -> bool {
    let Some(filters) = filters.and_then(|value| value.as_object()) else {
        return true;
    };
    filters.iter().all(|(key, expected)| {
        payload_filter_value(&node.payload, key)
            .map(|actual| filter_value_matches(actual, expected))
            .unwrap_or(false)
    })
}

fn commit_filter_value<'a>(commit: &'a JsonValue, key: &str) -> Option<&'a JsonValue> {
    match key {
        "source_kind" | "sourceKind" => commit.get("sourceKind"),
        "produced_by_node_id" | "producedByNodeId" => commit.get("producedByNodeId"),
        "first_parent_sha" | "firstParentSha" => commit.get("firstParentSha"),
        "files_changed_count" | "filesChangedCount" => commit.get("filesChangedCount"),
        "total_additions" | "totalAdditions" => commit.get("totalAdditions"),
        "total_deletions" | "totalDeletions" => commit.get("totalDeletions"),
        _ => commit.get(key),
    }
}

fn commit_matches_filters(commit: &JsonValue, filters: Option<&JsonValue>) -> bool {
    let Some(filters) = filters.and_then(|value| value.as_object()) else {
        return true;
    };
    filters.iter().all(|(key, expected)| {
        commit_filter_value(commit, key)
            .map(|actual| filter_value_matches(actual, expected))
            .unwrap_or(false)
    })
}

fn paged<T: Clone>(items: &[T], limit: Option<u32>, offset: Option<u32>) -> Vec<T> {
    let offset = offset.unwrap_or(0) as usize;
    let limit = limit.unwrap_or(50) as usize;
    items.iter().skip(offset).take(limit).cloned().collect()
}

async fn handle_overview(
    id: serde_json::Value,
    state: Arc<McpState>,
    workspace_id: String,
) -> JsonRpcResponse {
    let nodes = match local_nodes_for_workspace(&state, &workspace_id) {
        Ok(nodes) => nodes,
        Err(err) => {
            return JsonRpcResponse {
                jsonrpc: "2.0",
                id,
                result: None,
                error: Some(err),
            }
        }
    };

    let mut role_counts: HashMap<String, usize> = HashMap::new();
    let mut status_counts: HashMap<String, usize> = HashMap::new();
    let mut threads: HashSet<String> = HashSet::new();
    for node in &nodes {
        let role = node_string(&node.payload, &["role"]).unwrap_or("unknown");
        *role_counts.entry(role.to_string()).or_default() += 1;
        let status = node_string(&node.payload, &["status"]).unwrap_or("unknown");
        *status_counts.entry(status.to_string()).or_default() += 1;
        if let Some(thread_id) = node_thread_id(&node.payload) {
            threads.insert(thread_id.to_string());
        }
    }

    let node_ids: HashSet<&str> = nodes.iter().map(|node| node.row.node_id.as_str()).collect();
    let roots: Vec<&LocalGraphNode> = nodes
        .iter()
        .filter(|node| {
            node_parent_id(&node.payload)
                .map(|parent_id| !node_ids.contains(parent_id))
                .unwrap_or(true)
        })
        .collect();

    let mut output = String::new();
    output.push_str("Source: local Agentree database\n");
    output.push_str(&format!("Workspace: {}\n", workspace_id));
    output.push_str(&format!("Nodes: {}\n", nodes.len()));
    output.push_str(&format!("Threads: {}\n", threads.len()));
    output.push_str(&format!("Roles: {:?}\n", role_counts));
    output.push_str(&format!("Statuses: {:?}\n", status_counts));
    output.push_str("\nRoot nodes:\n");
    for node in roots.iter().take(20) {
        output.push_str(&format!("{}\n", node_summary(node)));
    }
    if roots.len() > 20 {
        output.push_str("... (truncated)\n");
    }
    output.push_str("\nRecent nodes:\n");
    for node in nodes.iter().rev().take(20).rev() {
        output.push_str(&format!("{}\n", node_summary(node)));
    }

    text_result(id, output)
}

async fn handle_graph_locate(
    id: serde_json::Value,
    state: Arc<McpState>,
    node_id: String,
    workspace_id: Option<String>,
) -> JsonRpcResponse {
    let payload = match local_node_payload(&state, &node_id) {
        Ok(payload) => payload,
        Err(err) => {
            return JsonRpcResponse {
                jsonrpc: "2.0",
                id,
                result: None,
                error: Some(err),
            }
        }
    };
    let workspace_id = workspace_id
        .or_else(|| node_workspace_id(&payload).map(str::to_string))
        .ok_or_else(|| PendingError {
            code: -32602,
            message: "Missing workspace_id".to_string(),
        });
    let workspace_id = match workspace_id {
        Ok(value) => value,
        Err(err) => return err.with_id(id),
    };
    let nodes = match local_nodes_for_workspace(&state, &workspace_id) {
        Ok(nodes) => nodes,
        Err(err) => {
            return JsonRpcResponse {
                jsonrpc: "2.0",
                id,
                result: None,
                error: Some(err),
            }
        }
    };
    let by_id: HashMap<String, LocalGraphNode> = nodes
        .iter()
        .cloned()
        .map(|node| (node.row.node_id.clone(), node))
        .collect();
    let Some(current) = by_id.get(&node_id) else {
        return local_data_error(
            id,
            format!(
                "Node {} was not found in local workspace {}.",
                node_id, workspace_id
            ),
        );
    };
    let parent_id = node_parent_id(&current.payload).map(str::to_string);
    let mut path = Vec::new();
    let mut cursor = Some(node_id.as_str());
    while let Some(cursor_id) = cursor {
        path.push(cursor_id.to_string());
        cursor = by_id
            .get(cursor_id)
            .and_then(|node| node_parent_id(&node.payload));
    }
    path.reverse();
    let children: Vec<&LocalGraphNode> = nodes
        .iter()
        .filter(|node| node_parent_id(&node.payload) == Some(node_id.as_str()))
        .collect();
    let siblings: Vec<&LocalGraphNode> = nodes
        .iter()
        .filter(|node| {
            node.row.node_id != node_id && node_parent_id(&node.payload) == parent_id.as_deref()
        })
        .collect();

    let mut output = String::new();
    output.push_str("Source: local Agentree database\n");
    output.push_str(&format!("Node: {}\n", node_id));
    output.push_str(&format!("Workspace: {}\n", workspace_id));
    output.push_str(&format!("Depth: {}\n", path.len().saturating_sub(1)));
    output.push_str(&format!("Path: {}\n", path.join(" -> ")));
    output.push_str(&format!(
        "Parent: {}\n",
        parent_id.as_deref().unwrap_or("-")
    ));
    output.push_str(&format!("Children: {}\n", children.len()));
    output.push_str(&format!("Siblings: {}\n", siblings.len()));
    output.push_str(&format!("Summary: {}\n", node_summary(current)));
    output.push_str("\nChildren:\n");
    for child in children.iter().take(20) {
        output.push_str(&format!("{}\n", node_summary(child)));
    }
    output.push_str("\nSiblings:\n");
    for sibling in siblings.iter().take(20) {
        output.push_str(&format!("{}\n", node_summary(sibling)));
    }

    text_result(id, output)
}

async fn handle_graph_query(
    id: serde_json::Value,
    state: Arc<McpState>,
    workspace_id: String,
    filters: Option<serde_json::Value>,
    limit: Option<u32>,
    offset: Option<u32>,
) -> JsonRpcResponse {
    let nodes = match local_nodes_for_workspace(&state, &workspace_id) {
        Ok(nodes) => nodes,
        Err(err) => {
            return JsonRpcResponse {
                jsonrpc: "2.0",
                id,
                result: None,
                error: Some(err),
            }
        }
    };
    let matches: Vec<LocalGraphNode> = nodes
        .into_iter()
        .filter(|node| node_matches_filters(node, filters.as_ref()))
        .collect();
    let page = paged(&matches, limit, offset);

    let mut output = String::new();
    output.push_str("Source: local Agentree database\n");
    output.push_str(&format!("Workspace: {}\n", workspace_id));
    output.push_str(&format!("Matched nodes: {}\n", matches.len()));
    output.push_str(&format!(
        "Returned nodes: {} (offset={}, limit={})\n\n",
        page.len(),
        offset.unwrap_or(0),
        limit.unwrap_or(50)
    ));
    for node in &page {
        output.push_str(&format!("{}\n", node_summary(node)));
    }

    text_result(id, output)
}

async fn handle_graph_read_node(
    id: serde_json::Value,
    state: Arc<McpState>,
    node_id: String,
    include_tool_calls: Option<bool>,
    max_content_length: Option<u32>,
) -> JsonRpcResponse {
    let payload = match local_node_payload(&state, &node_id) {
        Ok(payload) => payload,
        Err(err) => {
            return JsonRpcResponse {
                jsonrpc: "2.0",
                id,
                result: None,
                error: Some(err),
            }
        }
    };
    let include_tool_calls = include_tool_calls.unwrap_or(false);
    let sanitized = sanitize_node_payload(payload.clone(), include_tool_calls);
    let content = truncate_chars(node_content(&payload), max_content_length);
    let mut output = String::new();
    output.push_str("Source: local Agentree database\n");
    output.push_str(&format!("Node: {}\n", node_id));
    output.push_str(&format!(
        "Workspace: {}\n",
        node_workspace_id(&payload).unwrap_or("-")
    ));
    output.push_str(&format!(
        "Role: {}\n",
        node_string(&payload, &["role"]).unwrap_or("unknown")
    ));
    output.push_str(&format!(
        "Status: {}\n",
        node_string(&payload, &["status"]).unwrap_or("unknown")
    ));
    output.push_str(&format!(
        "Parent: {}\n",
        node_parent_id(&payload).unwrap_or("-")
    ));
    output.push_str(&format!(
        "Thread: {}\n",
        node_thread_id(&payload).unwrap_or("-")
    ));
    output.push_str(&format!(
        "Output commit: {}\n",
        node_string(
            &payload,
            &["output_commit_sha", "git_commit_sha", "gitCommitSha"]
        )
        .unwrap_or("-")
    ));
    output.push_str("\nContent:\n");
    output.push_str(&content);
    output.push_str("\n\nLocal payload:\n");
    output.push_str(&serde_json::to_string_pretty(&sanitized).unwrap_or_else(|_| "{}".to_string()));

    JsonRpcResponse {
        jsonrpc: "2.0",
        id,
        result: Some(serde_json::json!({
            "content": [{ "type": "text", "text": output }],
            "metadata": { "node": sanitized }
        })),
        error: None,
    }
}

async fn handle_list_thread_sessions(
    id: serde_json::Value,
    state: Arc<McpState>,
    workspace_id: String,
) -> JsonRpcResponse {
    let sessions = match telemetry_db(&state).list_thread_sessions_for_workspace(&workspace_id) {
        Ok(sessions) => sessions,
        Err(err) => {
            return local_data_error(id, format!("Failed to read local thread sessions: {}", err))
        }
    };
    let nodes = match local_nodes_for_workspace(&state, &workspace_id) {
        Ok(nodes) => nodes,
        Err(err) => {
            return JsonRpcResponse {
                jsonrpc: "2.0",
                id,
                result: None,
                error: Some(err),
            }
        }
    };
    let mut counts: HashMap<String, usize> = HashMap::new();
    for node in &nodes {
        if let Some(thread_id) = node_thread_id(&node.payload) {
            *counts.entry(thread_id.to_string()).or_default() += 1;
        }
    }

    let mut output = String::new();
    output.push_str("Source: local Agentree database\n");
    output.push_str(&format!("Workspace: {}\n", workspace_id));
    output.push_str(&format!("Thread sessions: {}\n\n", sessions.len()));
    for session in &sessions {
        output.push_str(&format!(
            "- {} status={} source={} nodes={} title={}\n",
            session.id,
            session.status,
            session.source,
            counts.get(&session.id).copied().unwrap_or(0),
            session.title.as_deref().unwrap_or("-")
        ));
    }

    text_result(id, output)
}

async fn handle_read_thread(
    id: serde_json::Value,
    state: Arc<McpState>,
    workspace_id: String,
    thread_id: String,
    max_nodes: Option<u32>,
) -> JsonRpcResponse {
    let sessions = match telemetry_db(&state).list_thread_sessions_for_workspace(&workspace_id) {
        Ok(sessions) => sessions,
        Err(err) => {
            return local_data_error(id, format!("Failed to read local thread sessions: {}", err))
        }
    };
    let session = sessions.iter().find(|session| session.id == thread_id);
    let mut nodes: Vec<LocalGraphNode> = match local_nodes_for_workspace(&state, &workspace_id) {
        Ok(nodes) => nodes
            .into_iter()
            .filter(|node| node_thread_id(&node.payload) == Some(thread_id.as_str()))
            .collect(),
        Err(err) => {
            return JsonRpcResponse {
                jsonrpc: "2.0",
                id,
                result: None,
                error: Some(err),
            }
        }
    };
    nodes.sort_by_key(|node| node.row.finalized_at);
    let page = paged(&nodes, max_nodes, Some(0));

    let mut output = String::new();
    output.push_str("Source: local Agentree database\n");
    output.push_str(&format!("Workspace: {}\n", workspace_id));
    output.push_str(&format!("Thread: {}\n", thread_id));
    if let Some(session) = session {
        output.push_str(&format!(
            "Session status: {} source={} title={}\n",
            session.status,
            session.source,
            session.title.as_deref().unwrap_or("-")
        ));
    } else {
        output.push_str(
            "Session: not found in local thread_sessions table; showing matching nodes only.\n",
        );
    }
    output.push_str(&format!(
        "Nodes: {} returned={}\n\n",
        nodes.len(),
        page.len()
    ));
    for node in &page {
        output.push_str(&format!("{}\n", node_summary(node)));
    }

    text_result(id, output)
}

#[allow(clippy::too_many_arguments)]
async fn handle_query_commits(
    id: serde_json::Value,
    state: Arc<McpState>,
    workspace_id: String,
    filters: Option<serde_json::Value>,
    limit: Option<u32>,
    offset: Option<u32>,
    include_parents: Option<bool>,
    include_observations: Option<bool>,
) -> JsonRpcResponse {
    let graph = match telemetry_db(&state).list_local_commit_graph(&workspace_id) {
        Ok(graph) => graph,
        Err(err) => return local_data_error(id, format!("Failed to read local commits: {}", err)),
    };
    let mut commits: Vec<JsonValue> = graph
        .commits
        .iter()
        .filter_map(|commit| serde_json::to_value(commit).ok())
        .filter(|commit| commit_matches_filters(commit, filters.as_ref()))
        .collect();
    commits.sort_by(|left, right| {
        left.get("committedAt")
            .and_then(|value| value.as_str())
            .cmp(&right.get("committedAt").and_then(|value| value.as_str()))
    });
    let page = paged(&commits, limit, offset);

    let mut output = String::new();
    output.push_str("Source: local Agentree database\n");
    output.push_str(&format!("Workspace: {}\n", workspace_id));
    output.push_str(&format!("Matched commits: {}\n", commits.len()));
    output.push_str(&format!(
        "Returned commits: {} (offset={}, limit={})\n\n",
        page.len(),
        offset.unwrap_or(0),
        limit.unwrap_or(50)
    ));
    for commit in &page {
        let sha = commit
            .get("sha")
            .and_then(|value| value.as_str())
            .unwrap_or("-");
        let subject = commit
            .get("subject")
            .and_then(|value| value.as_str())
            .unwrap_or("-");
        let source_kind = commit
            .get("sourceKind")
            .and_then(|value| value.as_str())
            .unwrap_or("-");
        let node = commit
            .get("producedByNodeId")
            .and_then(|value| value.as_str())
            .unwrap_or("-");
        output.push_str(&format!(
            "- {} source={} node={} subject={}\n",
            sha, source_kind, node, subject
        ));
    }

    let mut metadata = serde_json::json!({ "commits": page });
    if include_parents.unwrap_or(false) {
        metadata["parents"] =
            serde_json::to_value(&graph.commit_parents).unwrap_or_else(|_| serde_json::json!([]));
    }
    if include_observations.unwrap_or(false) {
        metadata["observations"] = serde_json::to_value(&graph.commit_observations)
            .unwrap_or_else(|_| serde_json::json!([]));
    }

    JsonRpcResponse {
        jsonrpc: "2.0",
        id,
        result: Some(serde_json::json!({
            "content": [{ "type": "text", "text": output }],
            "metadata": metadata
        })),
        error: None,
    }
}

async fn handle_graph_blame(
    id: serde_json::Value,
    state: Arc<McpState>,
    node_id: String,
    file_path: String,
    _include_context: bool,
    _include_content: bool,
) -> JsonRpcResponse {
    let node_meta = match local_node_metadata(&state, &node_id) {
        Ok(payload) => payload,
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
    let commit = node_commit(&node_meta);
    let Some(commit) = commit else {
        return JsonRpcResponse {
            jsonrpc: "2.0",
            id,
            result: None,
            error: Some(JsonRpcError {
                code: -32006,
                message: "This node does not have a finalized git commit.".to_string(),
            }),
        };
    };

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
    state: Arc<McpState>,
    from_node_id: String,
    to_node_id: String,
    file_path: Option<String>,
    include_content: bool,
) -> JsonRpcResponse {
    let from_meta = match local_node_metadata(&state, &from_node_id) {
        Ok(payload) => payload,
        Err(err) => {
            return JsonRpcResponse {
                jsonrpc: "2.0",
                id,
                result: None,
                error: Some(err),
            }
        }
    };
    let to_meta = match local_node_metadata(&state, &to_node_id) {
        Ok(payload) => payload,
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
    let from_commit = node_commit(&from_meta).unwrap_or_default();
    let to_commit = node_commit(&to_meta).unwrap_or_default();

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
