use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use serde_json::{json, Map as JsonMap, Value as JsonValue};
use std::collections::{HashSet, VecDeque};
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use uuid::Uuid;

const HELPER_ARG: &str = "--agentree-codex-adapter";
const MANAGED_CODEX_BIN_ARG: &str = "--agentree-managed-codex-bin";
const AI_LABEL_PROMPT: &str = include_str!("../scripts/ai-label-prompt.txt");
const CODEX_VERSION_PROBE_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Debug, Clone)]
struct AdapterArgs {
    model: String,
    cwd: String,
    reasoning_effort: Option<String>,
    permission_mode: Option<String>,
    provider_thread_id: Option<String>,
    provider_thread_strategy: Option<String>,
    source_provider_thread_id: Option<String>,
    source_provider_lineage_id: Option<String>,
    target_provider_turn_id: Option<String>,
    target_node_id: Option<String>,
    node_id: Option<String>,
    raw_events: bool,
    readiness_check: bool,
    rate_limits_read: bool,
    list_models: bool,
    prompt: String,
    input_artifacts: Vec<JsonValue>,
}

#[derive(Debug)]
struct AdapterError {
    message: String,
    code: &'static str,
}

impl AdapterError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

impl std::fmt::Display for AdapterError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for AdapterError {}

struct JsonRpcClient {
    child: Child,
    stdin: Arc<Mutex<ChildStdin>>,
    stdout: BufReader<std::process::ChildStdout>,
    pending: VecDeque<JsonRpcNotification>,
    stderr_lines: Arc<Mutex<VecDeque<String>>>,
}

#[derive(Debug, Clone)]
struct JsonRpcNotification {
    method: String,
    params: JsonValue,
}

#[derive(Default)]
struct StructuredOutput {
    final_response: Option<String>,
    commit_subject: Option<String>,
    commit_body: Option<String>,
    ai_label: Option<String>,
    thread_title: Option<String>,
}

struct TurnState {
    node_id: Option<String>,
    active_thread_id: Option<String>,
    active_turn_id: Option<String>,
    active_message_item_id: Option<String>,
    cumulative_text: String,
    last_structured_text_buffer: String,
    structured_output: StructuredOutput,
    structured_text_by_item: JsonMap<String, JsonValue>,
    visible_text_by_item: JsonMap<String, JsonValue>,
    output_delta_by_item: JsonMap<String, JsonValue>,
    raw_methods: HashSet<String>,
    last_usage: Option<JsonValue>,
    last_provider_error: Option<JsonValue>,
    first_provider_event_emitted: bool,
    first_delta_emitted: bool,
    first_delta_ts: Option<i64>,
    delta_count: i64,
}

impl TurnState {
    fn new(node_id: Option<String>) -> Self {
        Self {
            node_id,
            active_thread_id: None,
            active_turn_id: None,
            active_message_item_id: None,
            cumulative_text: String::new(),
            last_structured_text_buffer: String::new(),
            structured_output: StructuredOutput::default(),
            structured_text_by_item: JsonMap::new(),
            visible_text_by_item: JsonMap::new(),
            output_delta_by_item: JsonMap::new(),
            raw_methods: HashSet::new(),
            last_usage: None,
            last_provider_error: None,
            first_provider_event_emitted: false,
            first_delta_emitted: false,
            first_delta_ts: None,
            delta_count: 0,
        }
    }
}

pub fn maybe_run_from_process_args() -> Option<i32> {
    let mut args = std::env::args().collect::<Vec<_>>();
    if args.get(1).map(String::as_str) != Some(HELPER_ARG) {
        return None;
    }
    args.remove(1);
    let managed_codex_bin = if args.get(1).map(String::as_str) == Some(MANAGED_CODEX_BIN_ARG) {
        if args.len() > 2 {
            let path = args.remove(2);
            args.remove(1);
            Ok(path)
        } else {
            Err(AdapterError::new(
                "codex_cli_missing",
                "Agentree did not provide its managed Codex runtime path.",
            ))
        }
    } else {
        Err(AdapterError::new(
            "codex_cli_missing",
            "Agentree did not provide its managed Codex runtime path.",
        ))
    };
    let code = match managed_codex_bin
        .and_then(|managed_codex_bin| run(args.into_iter().skip(1).collect(), &managed_codex_bin))
    {
        Ok(code) => code,
        Err(error) => {
            emit(json!({
                "type": "error",
                "content": format!("Codex adapter failed: {}", error),
                "timestamp": now_ms(),
                "provider_error_code": error.code,
            }));
            emit(json!({
                "type": "provider_stop",
                "provider_stop_reason": "error",
                "provider_status": "failed",
                "final_content": "",
                "provider_thread_id": null,
                "provider_turn_id": null,
                "timestamp": now_ms(),
            }));
            1
        }
    };
    Some(code)
}

pub fn helper_arg() -> &'static str {
    HELPER_ARG
}

pub fn managed_codex_bin_arg() -> &'static str {
    MANAGED_CODEX_BIN_ARG
}

fn run(argv: Vec<String>, managed_codex_bin: &str) -> Result<i32, AdapterError> {
    let args = parse_args(argv)?;
    if args.readiness_check {
        return Ok(emit_readiness_check(managed_codex_bin));
    }
    if args.rate_limits_read {
        return Ok(emit_rate_limits_read(managed_codex_bin));
    }
    if args.list_models {
        return emit_model_catalog(managed_codex_bin);
    }
    run_turn(args, managed_codex_bin)
}

fn parse_args(argv: Vec<String>) -> Result<AdapterArgs, AdapterError> {
    let mut args = AdapterArgs {
        model: "gpt-5.4".to_string(),
        cwd: std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .to_string_lossy()
            .into_owned(),
        reasoning_effort: None,
        permission_mode: None,
        provider_thread_id: None,
        provider_thread_strategy: None,
        source_provider_thread_id: None,
        source_provider_lineage_id: None,
        target_provider_turn_id: None,
        target_node_id: None,
        node_id: None,
        raw_events: false,
        readiness_check: false,
        rate_limits_read: false,
        list_models: false,
        prompt: String::new(),
        input_artifacts: Vec::new(),
    };

    let mut index = 0;
    while index < argv.len() {
        let arg = &argv[index];
        let take_value = |index: &mut usize| -> Result<String, AdapterError> {
            *index += 1;
            argv.get(*index)
                .cloned()
                .ok_or_else(|| AdapterError::new("bad_args", format!("Missing value for {arg}")))
        };
        match arg.as_str() {
            "--model" => args.model = take_value(&mut index)?,
            "--cwd" => args.cwd = take_value(&mut index)?,
            "--reasoning-effort" => args.reasoning_effort = Some(take_value(&mut index)?),
            "--permission-mode" => args.permission_mode = Some(take_value(&mut index)?),
            "--provider-thread-id" => args.provider_thread_id = Some(take_value(&mut index)?),
            "--provider-thread-strategy" => {
                args.provider_thread_strategy = Some(take_value(&mut index)?)
            }
            "--source-provider-thread-id" => {
                args.source_provider_thread_id = Some(take_value(&mut index)?)
            }
            "--source-provider-lineage-id" => {
                args.source_provider_lineage_id = Some(take_value(&mut index)?)
            }
            "--target-provider-turn-id" => {
                args.target_provider_turn_id = Some(take_value(&mut index)?)
            }
            "--target-node-id" => args.target_node_id = Some(take_value(&mut index)?),
            "--node-id" => args.node_id = Some(take_value(&mut index)?),
            "--input-artifacts-json" => {
                args.input_artifacts = parse_input_artifacts_json(&take_value(&mut index)?)?
            }
            "--raw-events" => args.raw_events = true,
            "--readiness-check" => args.readiness_check = true,
            "--rate-limits-read" => args.rate_limits_read = true,
            "--list-models" => args.list_models = true,
            value if value.starts_with("--") => {}
            value => {
                args.prompt = value.to_string();
                if index + 1 < argv.len() {
                    args.prompt = argv[index..].join(" ");
                    break;
                }
            }
        }
        index += 1;
    }

    Ok(args)
}

fn parse_input_artifacts_json(raw: &str) -> Result<Vec<JsonValue>, AdapterError> {
    let parsed = serde_json::from_str::<JsonValue>(raw).map_err(|error| {
        AdapterError::new(
            "bad_args",
            format!("Invalid --input-artifacts-json value: {error}"),
        )
    })?;
    Ok(parsed.as_array().cloned().unwrap_or_default())
}

fn json_string(value: &JsonValue, path: &[&str]) -> Option<String> {
    value_at(value, path)
        .and_then(JsonValue::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn artifact_is_image(artifact: &JsonValue) -> bool {
    json_string(artifact, &["mimeType"])
        .or_else(|| json_string(artifact, &["mime_type"]))
        .is_some_and(|mime| mime.starts_with("image/"))
        || matches!(
            json_string(artifact, &["kind"]).as_deref(),
            Some("image") | Some("screenshot")
        )
}

fn usable_image_url(value: Option<String>) -> Option<String> {
    let value = value?;
    if value.starts_with("http://") || value.starts_with("https://") || value.starts_with("data:") {
        return Some(value);
    }
    None
}

fn local_artifact_path(artifact: &JsonValue, cwd: &str) -> Option<PathBuf> {
    let raw_path =
        json_string(artifact, &["storage", "path"]).or_else(|| json_string(artifact, &["path"]))?;
    if raw_path.starts_with("data:") {
        return None;
    }
    let path = PathBuf::from(raw_path);
    Some(if path.is_absolute() {
        path
    } else {
        Path::new(cwd).join(path)
    })
}

fn artifact_image_url(artifact: &JsonValue, cwd: &str) -> Option<String> {
    usable_image_url(
        json_string(artifact, &["storage", "url"])
            .or_else(|| json_string(artifact, &["url"]))
            .or_else(|| json_string(artifact, &["publicUrl"]))
            .or_else(|| json_string(artifact, &["thumbnail", "url"])),
    )
    .or_else(|| {
        let path = local_artifact_path(artifact, cwd)?;
        let bytes = fs::read(path).ok()?;
        let mime = json_string(artifact, &["mimeType"])
            .or_else(|| json_string(artifact, &["mime_type"]))
            .filter(|mime| mime.starts_with("image/"))
            .unwrap_or_else(|| "image/png".to_string());
        Some(format!(
            "data:{};base64,{}",
            mime,
            BASE64_STANDARD.encode(bytes)
        ))
    })
}

#[derive(Debug)]
struct PreparedTurnInput {
    input: Vec<JsonValue>,
    skipped_image_artifacts: Vec<JsonValue>,
}

fn artifact_warning_label(artifact: &JsonValue) -> String {
    json_string(artifact, &["title"])
        .or_else(|| json_string(artifact, &["filename"]))
        .or_else(|| json_string(artifact, &["id"]))
        .unwrap_or_else(|| "selected image artifact".to_string())
}

fn skipped_image_artifact_warning(artifact: &JsonValue) -> JsonValue {
    json!({
        "id": json_string(artifact, &["id"]),
        "label": artifact_warning_label(artifact),
        "mimeType": json_string(artifact, &["mimeType"]).or_else(|| json_string(artifact, &["mime_type"])),
        "path": json_string(artifact, &["storage", "path"]).or_else(|| json_string(artifact, &["path"])),
        "url": json_string(artifact, &["storage", "url"])
            .or_else(|| json_string(artifact, &["url"]))
            .or_else(|| json_string(artifact, &["publicUrl"]))
            .or_else(|| json_string(artifact, &["thumbnail", "url"])),
    })
}

fn prepare_turn_input(prompt: &str, input_artifacts: &[JsonValue], cwd: &str) -> PreparedTurnInput {
    let mut input = vec![json!({ "type": "text", "text": prompt })];
    let mut skipped_image_artifacts = Vec::new();
    for artifact in input_artifacts {
        if !artifact_is_image(artifact) {
            continue;
        }
        let Some(image_url) = artifact_image_url(artifact, cwd) else {
            skipped_image_artifacts.push(skipped_image_artifact_warning(artifact));
            continue;
        };
        input.push(json!({
            "type": "input_image",
            "image_url": image_url,
            "detail": "auto",
        }));
    }
    PreparedTurnInput {
        input,
        skipped_image_artifacts,
    }
}

fn model_uses_structured_text_output(model: &str) -> bool {
    model != "gpt-image-2"
}

fn run_turn(args: AdapterArgs, managed_codex_bin: &str) -> Result<i32, AdapterError> {
    let mut state = TurnState::new(args.node_id.clone());
    emit_trace(
        "adapter_started",
        json!({ "node_id": args.node_id, "cwd": args.cwd }),
    );

    let codex_bin = resolve_codex_bin(managed_codex_bin)?;
    let codex_home = resolve_codex_home();
    emit_trace(
        "codex_environment",
        codex_environment_detail(&codex_bin, &codex_home),
    );

    let mut client = start_codex_app_server(
        &codex_bin,
        &args.cwd,
        &codex_home,
        "agentree_codex_adapter",
        "Agentree Codex Adapter",
        app_server_config_overrides(&codex_home, true),
    )?;
    ensure_codex_auth(&mut client, &codex_bin, &codex_home)?;

    let requested_strategy = normalize_strategy(args.provider_thread_strategy.as_deref());
    let source_thread_id = args
        .source_provider_thread_id
        .clone()
        .or_else(|| args.provider_thread_id.clone());
    let mut forked_provider_thread_id: Option<String> = None;
    let mut thread_strategy = "fresh_thread".to_string();

    let permission_mode = normalize_permission_mode(args.permission_mode.as_deref());
    let sandbox_policy = codex_sandbox_policy(&args.cwd, permission_mode);
    let mut thread_params = json!({
        "model": args.model,
        "cwd": args.cwd,
        "sandbox": codex_sandbox_name(permission_mode),
    });
    if let Some(effort) = args.reasoning_effort.as_deref() {
        thread_params["config"] = json!({ "model_reasoning_effort": effort });
    }

    let thread_id = match requested_strategy.as_str() {
        "resume" | "fork_at_turn" if source_thread_id.is_none() => {
            return Ok(fail_provider_thread_reuse(
                &mut state,
                "provider_source_thread_missing",
                &format!(
                    "Codex could not {} the provider thread because Agentree did not have a source provider thread id for the parent node.",
                    requested_strategy
                ),
                &requested_strategy,
                source_thread_id.as_deref(),
                args.target_provider_turn_id.as_deref(),
                json!({}),
            ));
        }
        "resume" => {
            let source = source_thread_id.clone().unwrap_or_default();
            let response = client.request(
                "thread/resume",
                merge_object(json!({ "threadId": source }), thread_params.clone()),
            )?;
            thread_strategy = "resume".to_string();
            extract_thread_id(&response)?
        }
        "fork_at_turn" => {
            let source = source_thread_id.clone().unwrap_or_default();
            let Some(target_turn_id) = args.target_provider_turn_id.as_deref() else {
                return Ok(fail_provider_thread_reuse(
                    &mut state,
                    "provider_target_turn_missing",
                    "Codex could not fork at the selected branch point because Agentree did not have its provider turn id.",
                    &requested_strategy,
                    source_thread_id.as_deref(),
                    None,
                    json!({}),
                ));
            };
            let fork = client.request(
                "thread/fork",
                build_fork_at_turn_params(&source, target_turn_id, thread_params.clone()),
            )?;
            let forked = extract_thread_id(&fork)?;
            forked_provider_thread_id = Some(forked.clone());
            thread_strategy = "fork_at_turn".to_string();
            forked
        }
        _ => {
            let response = client.request("thread/start", thread_params)?;
            extract_thread_id(&response)?
        }
    };

    state.active_thread_id = Some(thread_id.clone());
    let provider_lineage_id = args
        .source_provider_lineage_id
        .clone()
        .or_else(|| source_thread_id.clone())
        .unwrap_or_else(|| thread_id.clone());

    emit(json!({
        "type": "provider_meta",
        "meta": {
            "provider": "codex",
            "transport": "app_server",
            "provider_client": "agentree_rust",
            "provider_thread_id": thread_id,
            "provider_source_thread_id": source_thread_id,
            "provider_lineage_id": provider_lineage_id,
            "provider_thread_strategy": thread_strategy,
            "provider_initial_strategy_selected": requested_strategy,
            "provider_fallback_strategy_selected": null,
            "provider_fallback_reason_code": null,
            "provider_forked_thread_id": forked_provider_thread_id,
            "provider_branch_target_node_id": args.target_node_id,
            "provider_target_turn_id": args.target_provider_turn_id,
            "provider_model": args.model,
            "provider_reasoning_effort": args.reasoning_effort,
            "provider_run_mode": args.permission_mode,
            "provider_thread_resume_enabled": thread_strategy == "resume",
        }
    }));
    emit(json!({
        "type": "session",
        "session_id": state.active_thread_id,
        "provider": "codex",
        "transport": "app_server",
    }));
    emit_trace(
        "thread_ready",
        json!({ "provider_thread_id": state.active_thread_id, "strategy": thread_strategy }),
    );

    let prepared_turn_input = prepare_turn_input(&args.prompt, &args.input_artifacts, &args.cwd);
    emit_trace(
        "turn_input_prepared",
        json!({
            "image_input_count": prepared_turn_input.input.len().saturating_sub(1),
            "skipped_image_input_count": prepared_turn_input.skipped_image_artifacts.len(),
        }),
    );
    let skipped_image_input_count = prepared_turn_input.skipped_image_artifacts.len();
    if skipped_image_input_count > 0 {
        emit_trace(
            "image_input_artifacts_skipped",
            json!({
                "count": skipped_image_input_count,
                "artifacts": prepared_turn_input.skipped_image_artifacts.clone(),
            }),
        );
        emit(json!({
            "type": "tool_result",
            "toolName": "image_context",
            "toolOutput": format!(
                "{} selected image artifact{} could not be attached as model input.",
                skipped_image_input_count,
                if skipped_image_input_count == 1 { "" } else { "s" }
            ),
            "isError": false,
            "toolUseId": "image_context_skipped",
            "timestamp": now_ms(),
        }));
    }

    let mut turn_start_params = json!({
        "threadId": state.active_thread_id,
        "input": prepared_turn_input.input,
        "model": args.model,
        "cwd": args.cwd,
        "sandboxPolicy": sandbox_policy,
    });
    if model_uses_structured_text_output(&args.model) {
        turn_start_params["outputSchema"] = final_result_schema();
    }
    let turn_response = client.request("turn/start", turn_start_params)?;
    state.active_turn_id = extract_turn_id(&turn_response);

    let stdin_writer = client.stdin.clone();
    let thread_id_for_steer = state.active_thread_id.clone();
    let turn_id_for_steer = state.active_turn_id.clone();
    thread::spawn(move || read_control_stdin(stdin_writer, thread_id_for_steer, turn_id_for_steer));

    loop {
        let notification = client.next_notification()?;
        let method = notification.method.clone();
        let payload = notification.params.clone();
        state.raw_methods.insert(method.clone());
        if !state.first_provider_event_emitted {
            state.first_provider_event_emitted = true;
            emit_trace("first_provider_event", json!({ "method": method }));
        }

        if method == "turn/started" {
            if let Some(turn_id) = value_at(&payload, &["turn", "id"]).and_then(JsonValue::as_str) {
                state.active_turn_id = Some(turn_id.to_string());
                emit(json!({ "type": "provider_meta", "meta": { "provider_turn_id": turn_id } }));
            }
            continue;
        }
        if method == "item/agentMessage/delta" {
            handle_message_delta(&mut state, &payload);
            continue;
        }
        if method == "item/started" {
            if let Some(mapped) = map_tool_event(
                item_from_payload(&payload),
                false,
                &state.output_delta_by_item,
            ) {
                emit(with_timestamp(mapped));
            }
            continue;
        }
        if method == "item/commandExecution/outputDelta" || method == "item/fileChange/outputDelta"
        {
            handle_tool_output_delta(&mut state, &payload);
            continue;
        }
        if method == "item/completed" {
            handle_item_completed(&mut state, &payload);
            continue;
        }
        if matches!(
            method.as_str(),
            "item/reasoningSummaryText/delta"
                | "item/reasoningText/delta"
                | "item/reasoning/summaryTextDelta"
                | "item/reasoning/textDelta"
                | "item/plan/delta"
        ) {
            if let Some(delta) = payload.get("delta").and_then(JsonValue::as_str) {
                if !delta.is_empty() {
                    emit(
                        json!({ "type": "thinking", "content": delta, "is_delta": true, "timestamp": now_ms() }),
                    );
                }
            }
            continue;
        }
        if method == "thread/tokenUsage/updated" {
            let usage = map_usage(
                payload
                    .get("tokenUsage")
                    .or_else(|| payload.get("token_usage"))
                    .unwrap_or(&JsonValue::Null),
            );
            state.last_usage = Some(usage.clone());
            emit(json!({
                "type": "usage",
                "usage": usage,
                "provider_thread_id": get_string(&payload, "threadId").or_else(|| get_string(&payload, "thread_id")),
                "provider_turn_id": get_string(&payload, "turnId").or_else(|| get_string(&payload, "turn_id")),
                "timestamp": now_ms(),
            }));
            continue;
        }
        if method == "account/rateLimits/updated" {
            let limits = payload
                .get("rateLimits")
                .or_else(|| payload.get("rate_limits"))
                .map(map_rate_limits)
                .unwrap_or(JsonValue::Null);
            if !limits.is_null() {
                emit(json!({
                    "type": "provider_meta",
                    "meta": { "provider": "codex", "provider_limits": limits },
                    "timestamp": now_ms(),
                }));
            }
            continue;
        }
        if method == "error" {
            let message = payload
                .get("message")
                .and_then(JsonValue::as_str)
                .map(str::to_string)
                .unwrap_or_else(|| payload.to_string());
            let classified = classify_provider_error(&message);
            state.last_provider_error = Some(classified.clone());
            emit(json!({ "type": "provider_meta", "meta": classified, "timestamp": now_ms() }));
            emit(json!({ "type": "error", "content": message, "timestamp": now_ms() }));
            continue;
        }
        if args.raw_events {
            emit(json!({
                "type": "codex_event",
                "method": method,
                "payload": payload,
                "timestamp": now_ms(),
            }));
        }
        if method == "turn/completed" {
            return Ok(handle_turn_completed(
                &mut state,
                &payload,
                forked_provider_thread_id,
                source_thread_id,
                thread_strategy,
                provider_lineage_id,
            ));
        }
    }
}

fn emit_readiness_check(managed_codex_bin: &str) -> i32 {
    let codex_home = resolve_codex_home();
    let mut base = json!({
        "status": "unknown_error",
        "codexHome": codex_home,
        "hasAuthJson": path_exists(Path::new(&codex_home).join("auth.json")),
        "hasOpenaiApiKey": has_env_value("OPENAI_API_KEY"),
        "hasCodexApiKey": has_env_value("CODEX_API_KEY"),
        "recommendedCommand": recommended_file_auth_command(&codex_home),
        "message": "Codex readiness could not be determined.",
    });
    let codex_bin = match resolve_codex_bin(managed_codex_bin) {
        Ok(path) => path,
        Err(error) => {
            base["status"] = json!("cli_missing");
            base["message"] = json!(error.message);
            emit(base);
            return 0;
        }
    };
    let version_probe = run_codex_probe(
        &codex_bin,
        &["--version"],
        &codex_home,
        CODEX_VERSION_PROBE_TIMEOUT,
    );
    base["codexBin"] = json!(codex_bin);
    base["codexBinExists"] = json!(path_exists(&codex_bin));
    base["codexVersion"] = if version_probe.get("ok").and_then(JsonValue::as_bool) == Some(true) {
        version_probe
            .get("output_excerpt")
            .cloned()
            .unwrap_or(JsonValue::Null)
    } else {
        JsonValue::Null
    };
    base["versionError"] = version_probe
        .get("output_excerpt")
        .or_else(|| version_probe.get("error_type"))
        .cloned()
        .unwrap_or(JsonValue::Null);
    if version_probe.get("ok").and_then(JsonValue::as_bool) != Some(true) {
        base["status"] = json!("cli_not_executable");
        base["message"] = json!("Codex CLI was found but could not be executed.");
        emit(base);
        return 0;
    }
    let mut client = match start_codex_app_server(
        &codex_bin,
        ".",
        &codex_home,
        "agentree_codex_readiness",
        "Agentree Codex Readiness",
        app_server_config_overrides(&codex_home, false),
    ) {
        Ok(client) => client,
        Err(error) => {
            base["status"] = json!("unknown_error");
            base["loginStatus"] = run_codex_probe(
                &codex_bin,
                &["login", "status"],
                &codex_home,
                Duration::from_secs(10),
            );
            base["message"] = json!(format!(
                "Codex app-server readiness check failed: {}.",
                error
            ));
            emit(base);
            return 0;
        }
    };
    // account/read is the app-server's non-generative auth probe. Asking it to
    // refresh verifies an expired session without creating a model turn.
    let response = match client.request("account/read", json!({ "refreshToken": true })) {
        Ok(response) => response,
        Err(error) => {
            base["status"] = json!("unknown_error");
            base["loginStatus"] = run_codex_probe(
                &codex_bin,
                &["login", "status"],
                &codex_home,
                Duration::from_secs(10),
            );
            base["message"] = json!(format!(
                "Codex app-server readiness check failed: {}.",
                error
            ));
            emit(base);
            return 0;
        }
    };
    if let Some(account) = sanitize_account(response.get("account").unwrap_or(&JsonValue::Null)) {
        base["status"] = json!("ready");
        base["authMode"] = account.get("type").cloned().unwrap_or(JsonValue::Null);
        base["planType"] = account.get("planType").cloned().unwrap_or(JsonValue::Null);
        base["account"] = account;
        base["message"] = json!("Codex is ready for Agentree.");
        base["recommendedCommand"] = JsonValue::Null;
        emit(base);
        return 0;
    }
    let has_auth = base
        .get("hasAuthJson")
        .and_then(JsonValue::as_bool)
        .unwrap_or(false);
    base["loginStatus"] = run_codex_probe(
        &codex_bin,
        &["login", "status"],
        &codex_home,
        Duration::from_secs(10),
    );
    base["status"] = json!(if has_auth {
        "auth_missing"
    } else {
        "keychain_unavailable"
    });
    base["message"] = json!(if has_auth {
        "Codex file-backed auth exists, but Agentree could not use it. Re-run the file-backed Codex login command."
    } else {
        "Codex is not available to Agentree. Terminal keychain login can fail from the desktop app, so use file-backed Codex login."
    });
    emit(base);
    0
}

fn emit_rate_limits_read(managed_codex_bin: &str) -> i32 {
    let result = (|| -> Result<JsonValue, AdapterError> {
        let codex_bin = resolve_codex_bin(managed_codex_bin)?;
        let codex_home = resolve_codex_home();
        let mut client = start_codex_app_server(
            &codex_bin,
            ".",
            &codex_home,
            "agentree_codex_limits",
            "Agentree Codex Limits",
            app_server_config_overrides(&codex_home, false),
        )?;
        let response = client.request("account/rateLimits/read", json!({}))?;
        Ok(response
            .get("rateLimits")
            .or_else(|| response.get("rate_limits"))
            .map(map_rate_limits)
            .unwrap_or(JsonValue::Null))
    })();
    match result {
        Ok(value) => {
            emit(value);
            0
        }
        Err(error) => {
            eprintln!("Codex rate limit refresh failed: {error}");
            1
        }
    }
}

fn emit_model_catalog(managed_codex_bin: &str) -> Result<i32, AdapterError> {
    let codex_bin = resolve_codex_bin(managed_codex_bin)?;
    let codex_home = resolve_codex_home();
    let version_probe = run_codex_probe(
        &codex_bin,
        &["--version"],
        &codex_home,
        CODEX_VERSION_PROBE_TIMEOUT,
    );
    let source_version = version_probe
        .get("output_excerpt")
        .and_then(JsonValue::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let mut client = start_codex_app_server(
        &codex_bin,
        ".",
        &codex_home,
        "agentree_codex_model_catalog",
        "Agentree Codex Model Catalog",
        app_server_config_overrides(&codex_home, false),
    )?;
    let checked_at = now_ms();
    let mut raw_models = Vec::new();
    let mut cursor: Option<String> = None;
    let mut seen_cursors = HashSet::new();

    loop {
        let response = client.request(
            "model/list",
            json!({
                "cursor": cursor,
                "includeHidden": true,
                "limit": 100,
            }),
        )?;
        let page = response
            .get("data")
            .and_then(JsonValue::as_array)
            .ok_or_else(|| {
                AdapterError::new(
                    "codex_model_catalog_invalid",
                    "Codex app-server returned a model list without a data array.",
                )
            })?;
        raw_models.extend(page.iter().cloned());

        let next_cursor = response
            .get("nextCursor")
            .and_then(JsonValue::as_str)
            .map(str::to_string)
            .filter(|value| !value.is_empty());
        let Some(next_cursor) = next_cursor else {
            break;
        };
        if !seen_cursors.insert(next_cursor.clone()) {
            return Err(AdapterError::new(
                "codex_model_catalog_invalid",
                "Codex app-server repeated a model-list cursor.",
            ));
        }
        cursor = Some(next_cursor);
    }

    let models = normalize_codex_models(&raw_models, source_version.as_deref(), checked_at);
    emit(json!({
        "type": "model_catalog",
        "provider": "codex",
        "sourceVersion": source_version,
        "checkedAt": checked_at,
        "models": models,
    }));
    Ok(0)
}

fn normalize_codex_models(
    raw_models: &[JsonValue],
    source_version: Option<&str>,
    checked_at: i64,
) -> Vec<JsonValue> {
    raw_models
        .iter()
        .filter(|model| {
            !model
                .get("hidden")
                .and_then(JsonValue::as_bool)
                .unwrap_or(false)
        })
        .filter_map(|model| {
            let cli_model_id = model.get("id")?.as_str()?.trim();
            let canonical_model_id = model
                .get("model")
                .and_then(JsonValue::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .unwrap_or(cli_model_id);
            if cli_model_id.is_empty() || canonical_model_id.is_empty() {
                return None;
            }
            let supported_reasoning_efforts = model
                .get("supportedReasoningEfforts")
                .and_then(JsonValue::as_array)
                .map(|efforts| {
                    efforts
                        .iter()
                        .filter_map(|effort| {
                            effort
                                .get("reasoningEffort")
                                .and_then(JsonValue::as_str)
                                .map(str::trim)
                                .filter(|value| !value.is_empty())
                                .map(str::to_string)
                        })
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            let input_modalities = model
                .get("inputModalities")
                .and_then(JsonValue::as_array)
                .map(|modalities| {
                    modalities
                        .iter()
                        .filter_map(JsonValue::as_str)
                        .map(str::to_string)
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            let image_output = model
                .get("modelSpecialty")
                .and_then(JsonValue::as_str)
                .is_some_and(|specialty| specialty.to_ascii_lowercase().contains("image"));
            let output_modalities = if image_output {
                vec!["image"]
            } else {
                vec!["text"]
            };
            Some(json!({
                "provider": "codex",
                "canonicalModelId": canonical_model_id,
                "cliModelId": cli_model_id,
                "name": model.get("displayName").and_then(JsonValue::as_str).unwrap_or(cli_model_id),
                "description": model.get("description").and_then(JsonValue::as_str).unwrap_or(""),
                "supportedReasoningEfforts": supported_reasoning_efforts,
                "defaultReasoningEffort": model.get("defaultReasoningEffort").cloned().unwrap_or(JsonValue::Null),
                "inputModalities": input_modalities,
                "outputModalities": output_modalities,
                "hidden": false,
                "isDefault": model.get("isDefault").and_then(JsonValue::as_bool),
                "status": "active",
                "isFree": JsonValue::Null,
                "sourceVersion": source_version,
                "checkedAt": checked_at,
            }))
        })
        .collect()
}

fn start_codex_app_server(
    codex_bin: &str,
    cwd: &str,
    codex_home: &str,
    client_name: &str,
    client_title: &str,
    config_overrides: Vec<String>,
) -> Result<JsonRpcClient, AdapterError> {
    let mut command = Command::new(codex_bin);
    for kv in config_overrides {
        command.args(["--config", &kv]);
    }
    command
        .args(["app-server", "--listen", "stdio://"])
        .current_dir(cwd)
        .env("CODEX_HOME", codex_home)
        .env("PATH", crate::cli_path::build_tool_path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command.spawn().map_err(|error| {
        AdapterError::new(
            "codex_spawn_failed",
            format!(
                "Could not start Agentree's managed Codex CLI at `{}`. Open Runtime Health and repair Codex, then retry. spawn error: {}",
                codex_bin, error
            ),
        )
    })?;
    let stdin = child.stdin.take().ok_or_else(|| {
        AdapterError::new(
            "codex_stdio_failed",
            "Codex app-server stdin was not available.",
        )
    })?;
    let stdout = child.stdout.take().ok_or_else(|| {
        AdapterError::new(
            "codex_stdio_failed",
            "Codex app-server stdout was not available.",
        )
    })?;
    let stderr = child.stderr.take().ok_or_else(|| {
        AdapterError::new(
            "codex_stdio_failed",
            "Codex app-server stderr was not available.",
        )
    })?;
    let stderr_lines = Arc::new(Mutex::new(VecDeque::with_capacity(400)));
    let stderr_lines_for_thread = stderr_lines.clone();
    thread::spawn(move || {
        let reader = BufReader::new(stderr);
        for line in reader.lines().flatten() {
            let mut lines = stderr_lines_for_thread.lock().unwrap();
            if lines.len() >= 400 {
                lines.pop_front();
            }
            lines.push_back(line);
        }
    });
    let mut client = JsonRpcClient {
        child,
        stdin: Arc::new(Mutex::new(stdin)),
        stdout: BufReader::new(stdout),
        pending: VecDeque::new(),
        stderr_lines,
    };
    let _ = client.request(
        "initialize",
        json!({
            "clientInfo": {
                "name": client_name,
                "title": client_title,
                "version": env!("CARGO_PKG_VERSION"),
            },
            "capabilities": { "experimentalApi": true },
        }),
    )?;
    client.notify("initialized", json!({}))?;
    Ok(client)
}

impl JsonRpcClient {
    fn request(&mut self, method: &str, params: JsonValue) -> Result<JsonValue, AdapterError> {
        let request_id = Uuid::new_v4().to_string();
        self.write(json!({ "id": request_id, "method": method, "params": params }))?;
        loop {
            let message = self.read_message()?;
            if message.get("method").is_some() && message.get("id").is_some() {
                self.handle_server_request(&message)?;
                continue;
            }
            if let Some(method) = message.get("method").and_then(JsonValue::as_str) {
                self.pending.push_back(JsonRpcNotification {
                    method: method.to_string(),
                    params: message.get("params").cloned().unwrap_or_else(|| json!({})),
                });
                continue;
            }
            if message.get("id").and_then(JsonValue::as_str) != Some(request_id.as_str()) {
                continue;
            }
            if let Some(error) = message.get("error") {
                return Err(AdapterError::new(
                    "codex_jsonrpc_error",
                    format!(
                        "Codex app-server {method} failed: {}",
                        format_jsonrpc_error(error)
                    ),
                ));
            }
            return Ok(message.get("result").cloned().unwrap_or(JsonValue::Null));
        }
    }

    fn notify(&mut self, method: &str, params: JsonValue) -> Result<(), AdapterError> {
        self.write(json!({ "method": method, "params": params }))
    }

    fn next_notification(&mut self) -> Result<JsonRpcNotification, AdapterError> {
        if let Some(notification) = self.pending.pop_front() {
            return Ok(notification);
        }
        loop {
            let message = self.read_message()?;
            if message.get("method").is_some() && message.get("id").is_some() {
                self.handle_server_request(&message)?;
                continue;
            }
            if let Some(method) = message.get("method").and_then(JsonValue::as_str) {
                return Ok(JsonRpcNotification {
                    method: method.to_string(),
                    params: message.get("params").cloned().unwrap_or_else(|| json!({})),
                });
            }
        }
    }

    fn write(&mut self, payload: JsonValue) -> Result<(), AdapterError> {
        let mut stdin = self.stdin.lock().unwrap();
        writeln!(stdin, "{}", payload).map_err(|error| {
            AdapterError::new(
                "codex_transport_closed",
                format!("Could not write to Codex app-server: {error}"),
            )
        })?;
        stdin.flush().map_err(|error| {
            AdapterError::new(
                "codex_transport_closed",
                format!("Could not flush Codex app-server stdin: {error}"),
            )
        })
    }

    fn write_from_thread(
        stdin: &Arc<Mutex<ChildStdin>>,
        payload: JsonValue,
    ) -> Result<(), AdapterError> {
        let mut stdin = stdin.lock().unwrap();
        writeln!(stdin, "{}", payload).map_err(|error| {
            AdapterError::new(
                "codex_transport_closed",
                format!("Could not write to Codex app-server: {error}"),
            )
        })?;
        stdin.flush().map_err(|error| {
            AdapterError::new(
                "codex_transport_closed",
                format!("Could not flush Codex app-server stdin: {error}"),
            )
        })
    }

    fn read_message(&mut self) -> Result<JsonValue, AdapterError> {
        let mut line = String::new();
        let bytes = self.stdout.read_line(&mut line).map_err(|error| {
            AdapterError::new(
                "codex_transport_closed",
                format!("Could not read Codex app-server stdout: {error}"),
            )
        })?;
        if bytes == 0 {
            return Err(AdapterError::new(
                "codex_transport_closed",
                format!(
                    "Codex app-server closed stdout. stderr_tail={}",
                    self.stderr_tail()
                ),
            ));
        }
        serde_json::from_str::<JsonValue>(&line).map_err(|error| {
            AdapterError::new(
                "codex_protocol_error",
                format!("Invalid Codex app-server JSON-RPC line: {error}: {line:?}"),
            )
        })
    }

    fn handle_server_request(&mut self, message: &JsonValue) -> Result<(), AdapterError> {
        let id = message.get("id").cloned().unwrap_or(JsonValue::Null);
        let method = message
            .get("method")
            .and_then(JsonValue::as_str)
            .unwrap_or("");
        let result = match method {
            "item/commandExecution/requestApproval" | "item/fileChange/requestApproval" => {
                json!({ "decision": "accept" })
            }
            "mcpServer/elicitation/request" => {
                let mode = value_at(message, &["params", "mode"]).and_then(JsonValue::as_str);
                if mode == Some("url") {
                    json!({ "action": "accept", "content": null })
                } else {
                    json!({ "action": "accept", "content": {} })
                }
            }
            _ => json!({}),
        };
        self.write(json!({ "id": id, "result": result }))
    }

    fn stderr_tail(&self) -> String {
        self.stderr_lines
            .lock()
            .unwrap()
            .iter()
            .rev()
            .take(40)
            .cloned()
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect::<Vec<_>>()
            .join("\n")
    }
}

impl Drop for JsonRpcClient {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn ensure_codex_auth(
    client: &mut JsonRpcClient,
    codex_bin: &str,
    codex_home: &str,
) -> Result<(), AdapterError> {
    let response = client.request("account/read", json!({}))?;
    let account = response.get("account").cloned().unwrap_or(JsonValue::Null);
    let requires_openai_auth = response
        .get("requiresOpenaiAuth")
        .or_else(|| response.get("requires_openai_auth"))
        .and_then(JsonValue::as_bool)
        .unwrap_or(true);
    emit_trace(
        "codex_account_read",
        json!({
            "requiresOpenaiAuth": requires_openai_auth,
            "account": sanitize_account(&account),
        }),
    );
    if requires_openai_auth && account.is_null() {
        let login_probe = run_codex_probe(
            codex_bin,
            &["login", "status"],
            codex_home,
            Duration::from_secs(10),
        );
        let logged_in = login_probe.get("ok").and_then(JsonValue::as_bool) == Some(true)
            && login_probe
                .get("output_excerpt")
                .and_then(JsonValue::as_str)
                .unwrap_or("")
                .contains("Logged in");
        emit_trace("codex_login_status_probe", login_probe);
        if logged_in {
            return Ok(());
        }
        return Err(AdapterError::new(
            "codex_auth_missing",
            format!(
                "Codex authentication is missing in Agentree's app-server environment. CODEX_HOME is {}, and {}/auth.json is {}. Run `{}` in a terminal to create file-backed Codex auth, then retry from Agentree.",
                codex_home,
                codex_home,
                if path_exists(Path::new(codex_home).join("auth.json")) { "present" } else { "missing" },
                recommended_file_auth_command(codex_home),
            ),
        ));
    }
    Ok(())
}

fn resolve_codex_bin(managed_codex_bin: &str) -> Result<String, AdapterError> {
    let managed_codex_bin = managed_codex_bin.trim();
    if managed_codex_bin.is_empty() || !Path::new(managed_codex_bin).is_file() {
        return Err(AdapterError::new(
            "codex_cli_missing",
            format!(
                "Agentree's managed Codex runtime is missing or invalid at `{}`. Open Runtime Health and repair Codex, then retry.",
                managed_codex_bin
            ),
        ));
    }
    Ok(managed_codex_bin.to_string())
}

fn resolve_codex_home() -> String {
    std::env::var("CODEX_HOME")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| {
            dirs::home_dir()
                .unwrap_or_else(|| PathBuf::from("."))
                .join(".codex")
                .to_string_lossy()
                .into_owned()
        })
}

fn app_server_config_overrides(codex_home: &str, include_mcp: bool) -> Vec<String> {
    let mut overrides = Vec::new();
    if path_exists(Path::new(codex_home).join("auth.json")) {
        overrides.push("cli_auth_credentials_store=\"file\"".to_string());
    }
    if include_mcp {
        if let Ok(mcp_url) =
            std::env::var("AGENTREE_MCP_URL").or_else(|_| std::env::var("MCP_SERVER_URL"))
        {
            if !mcp_url.trim().is_empty() {
                overrides.push("features.connectors=true".to_string());
                overrides.push(format!(
                    "mcp_servers.agentree.url=\"{}\"",
                    mcp_url.replace('"', "\\\"")
                ));
            }
        }
    }
    overrides
}

fn read_control_stdin(
    codex_stdin: Arc<Mutex<ChildStdin>>,
    thread_id: Option<String>,
    turn_id: Option<String>,
) {
    let reader = BufReader::new(std::io::stdin());
    for line in reader.lines().flatten() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let now = now_ms();
        let Ok(control) = serde_json::from_str::<JsonValue>(trimmed) else {
            emit(json!({
                "type": "provider_steer_failed",
                "error": "Invalid control message JSON.",
                "timestamp": now,
            }));
            continue;
        };
        if !is_steer_control(&control) {
            continue;
        }
        let content = control
            .get("content")
            .and_then(JsonValue::as_str)
            .map(str::trim)
            .unwrap_or("");
        if content.is_empty() {
            emit(json!({
                "type": "provider_steer_failed",
                "idempotency_key": control.get("idempotency_key"),
                "error": "Steering message cannot be empty.",
                "timestamp": now,
            }));
            continue;
        }
        let request = json!({
            "id": Uuid::new_v4().to_string(),
            "method": "turn/steer",
            "params": {
                "threadId": thread_id,
                "expectedTurnId": turn_id,
                "input": [{ "type": "text", "text": content }],
            },
        });
        match JsonRpcClient::write_from_thread(&codex_stdin, request) {
            Ok(()) => emit(json!({
                "type": "provider_steer_ack",
                "idempotency_key": control.get("idempotency_key"),
                "provider_thread_id": thread_id,
                "provider_turn_id": turn_id,
                "timestamp": now,
            })),
            Err(error) => emit(json!({
                "type": "provider_steer_failed",
                "idempotency_key": control.get("idempotency_key"),
                "error": error.to_string(),
                "timestamp": now,
            })),
        }
    }
}

fn is_steer_control(control: &JsonValue) -> bool {
    matches!(
        control
            .get("control_type")
            .or_else(|| control.get("type"))
            .and_then(JsonValue::as_str),
        Some("steer" | "steer_agent_run")
    )
}

fn handle_message_delta(state: &mut TurnState, payload: &JsonValue) {
    let Some(delta) = payload.get("delta").and_then(JsonValue::as_str) else {
        return;
    };
    if delta.is_empty() {
        return;
    }
    let item_id = get_string(payload, "itemId")
        .or_else(|| get_string(payload, "item_id"))
        .unwrap_or_else(|| "__unknown__".to_string());
    state.active_message_item_id = Some(item_id.clone());
    let current = state
        .structured_text_by_item
        .get(&item_id)
        .and_then(JsonValue::as_str)
        .unwrap_or("")
        .to_string()
        + delta;
    state
        .structured_text_by_item
        .insert(item_id.clone(), json!(current.clone()));
    state.last_structured_text_buffer = current.clone();
    state.delta_count += 1;
    if !state.first_delta_emitted {
        state.first_delta_emitted = true;
        state.first_delta_ts = Some(now_ms());
        emit_trace(
            "first_assistant_delta",
            json!({ "provider_turn_id": get_string(payload, "turnId").or_else(|| get_string(payload, "turn_id")) }),
        );
    }
    let Some(visible_prefix) = json_string_field_prefix(&current, "final_response") else {
        return;
    };
    let previous = state
        .visible_text_by_item
        .get(&item_id)
        .and_then(JsonValue::as_str)
        .unwrap_or("");
    let visible_delta = suffix_after_prefix(previous, &visible_prefix);
    if visible_delta.is_empty() {
        return;
    }
    state
        .visible_text_by_item
        .insert(item_id.clone(), json!(visible_prefix.clone()));
    state.cumulative_text = visible_prefix;
    emit(json!({
        "type": "message_delta",
        "delta": visible_delta,
        "provider_item_id": item_id,
        "provider_thread_id": get_string(payload, "threadId").or_else(|| get_string(payload, "thread_id")),
        "provider_turn_id": get_string(payload, "turnId").or_else(|| get_string(payload, "turn_id")),
        "timestamp": now_ms(),
    }));
}

fn handle_tool_output_delta(state: &mut TurnState, payload: &JsonValue) {
    let Some(delta) = payload.get("delta").and_then(JsonValue::as_str) else {
        return;
    };
    let Some(item_id) = get_string(payload, "itemId").or_else(|| get_string(payload, "item_id"))
    else {
        return;
    };
    if delta.is_empty() {
        return;
    }
    let current = state
        .output_delta_by_item
        .get(&item_id)
        .and_then(JsonValue::as_str)
        .unwrap_or("")
        .to_string()
        + delta;
    state
        .output_delta_by_item
        .insert(item_id.clone(), json!(current));
    emit(json!({
        "type": "tool_output_delta",
        "toolUseId": item_id,
        "delta": delta,
        "provider_item_id": item_id,
        "provider_thread_id": get_string(payload, "threadId").or_else(|| get_string(payload, "thread_id")),
        "provider_turn_id": get_string(payload, "turnId").or_else(|| get_string(payload, "turn_id")),
        "timestamp": now_ms(),
    }));
}

fn handle_item_completed(state: &mut TurnState, payload: &JsonValue) {
    let item = item_from_payload(payload);
    let item_type = item.get("type").and_then(JsonValue::as_str);
    let item_id = get_string(item, "id");
    if item_type == Some("agentMessage") {
        if let Some(id) = item_id.as_deref() {
            state.active_message_item_id = Some(id.to_string());
        }
        let text = item
            .get("text")
            .and_then(JsonValue::as_str)
            .unwrap_or("")
            .to_string();
        if !text.is_empty() {
            merge_structured_output(
                &mut state.structured_output,
                structured_output_from_text(&text),
            );
            state.last_structured_text_buffer = text.clone();
            if let Some(id) = item_id.as_deref() {
                state
                    .structured_text_by_item
                    .insert(id.to_string(), json!(text.clone()));
            }
        }
        let visible = state
            .structured_output
            .final_response
            .clone()
            .filter(|value| !value.is_empty())
            .unwrap_or(text);
        if !visible.is_empty() {
            state.cumulative_text = visible.clone();
        }
        emit(json!({
            "type": "message_completed",
            "content": visible,
            "provider_item_id": item_id,
            "provider_thread_id": get_string(payload, "threadId").or_else(|| get_string(payload, "thread_id")),
            "provider_turn_id": get_string(payload, "turnId").or_else(|| get_string(payload, "turn_id")),
            "timestamp": now_ms(),
        }));
        return;
    }
    if item_type == Some("reasoning") {
        if let Some(summary) = item.get("summary").and_then(JsonValue::as_array) {
            let text = summary
                .iter()
                .filter_map(JsonValue::as_str)
                .collect::<Vec<_>>()
                .join("\n");
            if !text.is_empty() {
                emit(json!({ "type": "thinking", "content": text, "timestamp": now_ms() }));
            }
        }
        return;
    }
    if matches!(
        item_type,
        Some("imageGeneration") | Some("image_generation_call")
    ) {
        emit_provider_image_artifacts(state, item, item_id.as_deref());
    }
    if let Some(mapped) = map_tool_event(item, true, &state.output_delta_by_item) {
        emit(with_timestamp(mapped));
    }
}

fn collect_image_urls(value: &JsonValue, urls: &mut Vec<String>) {
    match value {
        JsonValue::Object(object) => {
            for (key, nested) in object {
                let normalized_key = key.to_ascii_lowercase();
                if matches!(
                    normalized_key.as_str(),
                    "image_url"
                        | "imageurl"
                        | "url"
                        | "b64_json"
                        | "b64json"
                        | "image_base64"
                        | "imagebase64"
                ) {
                    if let Some(raw) = nested.as_str().map(str::trim).filter(|raw| !raw.is_empty())
                    {
                        if normalized_key.contains("b64") || normalized_key.contains("base64") {
                            urls.push(format!("data:image/png;base64,{raw}"));
                        } else if raw.starts_with("data:")
                            || raw.starts_with("http://")
                            || raw.starts_with("https://")
                        {
                            urls.push(raw.to_string());
                        }
                    }
                }
                collect_image_urls(nested, urls);
            }
        }
        JsonValue::Array(values) => {
            for nested in values {
                collect_image_urls(nested, urls);
            }
        }
        _ => {}
    }
}

fn mime_extension(mime_type: &str) -> &'static str {
    match mime_type {
        "image/jpeg" | "image/jpg" => "jpg",
        "image/webp" => "webp",
        "image/gif" => "gif",
        "image/svg+xml" => "svg",
        _ => "png",
    }
}

fn parse_inline_image_data_url(url: &str) -> Option<(&str, &str)> {
    let (header, data) = url.split_once(',')?;
    if !header.starts_with("data:image/") || !header.contains(";base64") {
        return None;
    }
    let mime_type = header
        .strip_prefix("data:")
        .and_then(|value| value.split(';').next())
        .unwrap_or("image/png");
    Some((mime_type, data))
}

fn provider_artifacts_dir() -> PathBuf {
    std::env::var("AGENTREE_ARTIFACTS_DIR")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| std::env::temp_dir().join("agentree-provider-images"))
}

fn materialize_provider_image_url(
    url: &str,
    artifact_id: &str,
) -> Option<(JsonValue, Option<u64>)> {
    if !url.starts_with("data:") {
        return Some((
            json!({
                "backend": "remote",
                "url": url,
            }),
            None,
        ));
    }

    let (mime_type, data) = parse_inline_image_data_url(url)?;
    let bytes = BASE64_STANDARD.decode(data).ok()?;
    let output_dir = provider_artifacts_dir();
    fs::create_dir_all(&output_dir).ok()?;
    let path = output_dir.join(format!(
        "{}.{}",
        artifact_id.replace(['/', ':'], "_"),
        mime_extension(mime_type)
    ));
    fs::write(&path, &bytes).ok()?;
    Some((
        json!({
            "backend": "local",
            "path": path.to_string_lossy(),
        }),
        Some(bytes.len() as u64),
    ))
}

fn emit_provider_image_artifacts(state: &TurnState, item: &JsonValue, item_id: Option<&str>) {
    let mut urls = Vec::new();
    collect_image_urls(item, &mut urls);
    urls.sort();
    urls.dedup();
    for (index, url) in urls.into_iter().enumerate() {
        let artifact_id = item_id
            .map(|id| format!("{id}:image:{index}"))
            .unwrap_or_else(|| format!("provider-image:{index}"));
        let Some((storage, size_bytes)) = materialize_provider_image_url(&url, &artifact_id) else {
            continue;
        };
        emit(json!({
            "type": "artifact_registered",
            "artifact": {
                "id": artifact_id,
                "nodeId": state.node_id,
                "role": "output",
                "kind": "image",
                "mimeType": "image/png",
                "title": if index == 0 { "Generated image" } else { "Generated image variant" },
                "storage": storage,
                "sizeBytes": size_bytes,
                "isPrimary": index == 0,
                "source": "provider_image_generation",
                "createdAt": now_iso_string(),
            },
            "timestamp": now_ms(),
        }));
    }
}

fn handle_turn_completed(
    state: &mut TurnState,
    payload: &JsonValue,
    forked_provider_thread_id: Option<String>,
    source_thread_id: Option<String>,
    thread_strategy: String,
    provider_lineage_id: String,
) -> i32 {
    let status = value_at(payload, &["turn", "status"])
        .and_then(JsonValue::as_str)
        .unwrap_or("completed")
        .to_string();
    if let Some(turn_id) = value_at(payload, &["turn", "id"]).and_then(JsonValue::as_str) {
        state.active_turn_id = Some(turn_id.to_string());
    }
    if state.structured_output.final_response.is_none() {
        merge_structured_output(
            &mut state.structured_output,
            structured_output_from_text(&state.last_structured_text_buffer),
        );
    }
    let visible_final_content = state
        .structured_output
        .final_response
        .clone()
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| state.cumulative_text.clone());
    let mut structured_meta = JsonMap::new();
    if let Some(value) = state.structured_output.commit_subject.clone() {
        structured_meta.insert("commit_subject".to_string(), json!(value));
    }
    if let Some(value) = state.structured_output.commit_body.clone() {
        structured_meta.insert("commit_body".to_string(), json!(value));
    }
    if let Some(value) = state.structured_output.ai_label.clone() {
        structured_meta.insert("ai_label".to_string(), json!(value));
    }
    if let Some(value) = state.structured_output.thread_title.clone() {
        structured_meta.insert("thread_title".to_string(), json!(value));
    }
    if !structured_meta.is_empty() {
        emit(json!({ "type": "provider_meta", "meta": structured_meta, "timestamp": now_ms() }));
    }
    emit_trace(
        "turn_completed",
        json!({ "status": status, "provider_turn_id": state.active_turn_id }),
    );
    let mut raw_methods = state.raw_methods.iter().cloned().collect::<Vec<_>>();
    raw_methods.sort();
    emit(json!({
        "type": "provider_meta",
        "meta": {
            "provider_notification_methods": raw_methods,
            "provider_turn_id": state.active_turn_id,
            "provider_stream": {
                "first_delta_ts": state.first_delta_ts,
                "delta_count": state.delta_count,
            },
            "provider_error_code": state.last_provider_error.as_ref().and_then(|v| v.get("provider_error_code")).cloned(),
            "provider_error_message": state.last_provider_error.as_ref().and_then(|v| v.get("provider_error_message")).cloned(),
            "provider_forked_thread_id": forked_provider_thread_id,
            "provider_source_thread_id": source_thread_id,
            "provider_thread_strategy": thread_strategy,
            "provider_lineage_id": provider_lineage_id,
        },
    }));
    let final_content = if status == "completed" {
        visible_final_content
    } else {
        state
            .last_provider_error
            .as_ref()
            .and_then(|value| value.get("provider_error_message"))
            .and_then(JsonValue::as_str)
            .unwrap_or(&state.cumulative_text)
            .to_string()
    };
    emit(json!({
        "type": "provider_stop",
        "provider_stop_reason": if status == "completed" { "end_turn" } else { "error" },
        "provider_status": status,
        "final_content": final_content,
        "provider_thread_id": state.active_thread_id,
        "provider_turn_id": state.active_turn_id,
        "provider_item_id": state.active_message_item_id,
        "usage": state.last_usage,
        "timestamp": now_ms(),
    }));
    if status == "completed" {
        0
    } else {
        1
    }
}

fn fail_provider_thread_reuse(
    state: &mut TurnState,
    reason_code: &str,
    message: &str,
    requested_strategy: &str,
    source_thread_id: Option<&str>,
    source_turn_id: Option<&str>,
    extra_meta: JsonValue,
) -> i32 {
    let mut meta = json!({
        "provider": "codex",
        "transport": "app_server",
        "provider_client": "agentree_rust",
        "provider_thread_strategy": "failed",
        "provider_initial_strategy_selected": requested_strategy,
        "provider_fallback_strategy_selected": null,
        "provider_fallback_reason_code": reason_code,
        "provider_source_thread_id": source_thread_id,
        "provider_source_turn_id": source_turn_id,
        "provider_error_code": "provider_thread_reuse_failed",
        "provider_error_message": message,
    });
    if let (Some(meta_obj), Some(extra_obj)) = (meta.as_object_mut(), extra_meta.as_object()) {
        for (key, value) in extra_obj {
            meta_obj.insert(key.clone(), value.clone());
        }
    }
    emit(json!({ "type": "provider_meta", "meta": meta, "timestamp": now_ms() }));
    emit(json!({ "type": "error", "content": message, "timestamp": now_ms() }));
    emit(json!({
        "type": "provider_stop",
        "provider_stop_reason": reason_code,
        "provider_status": "failed",
        "final_content": message,
        "provider_thread_id": state.active_thread_id,
        "provider_turn_id": state.active_turn_id,
        "timestamp": now_ms(),
    }));
    1
}

fn map_tool_event(
    item: &JsonValue,
    completed: bool,
    output_deltas_by_item_id: &JsonMap<String, JsonValue>,
) -> Option<JsonValue> {
    let item_type = item.get("type").and_then(JsonValue::as_str)?;
    let item_id = get_string(item, "id");
    let delta_output = item_id
        .as_ref()
        .and_then(|id| output_deltas_by_item_id.get(id))
        .cloned()
        .unwrap_or(JsonValue::Null);
    match item_type {
        "commandExecution" => Some(if completed {
            json!({
                "type": "tool_result",
                "toolName": "commandExecution",
                "toolUseId": item_id,
                "toolOutput": item.get("aggregatedOutput").or_else(|| item.get("aggregated_output")).cloned().filter(|v| !v.is_null()).unwrap_or(delta_output),
                "status": item.get("status"),
                "durationMs": item.get("durationMs").or_else(|| item.get("duration_ms")),
                "item_type": item_type,
                "provider_item_id": item_id,
                "provider_item": item,
            })
        } else {
            json!({
                "type": "tool_use",
                "name": "commandExecution",
                "id": item_id,
                "input": { "command": item.get("command"), "cwd": item.get("cwd") },
                "commandActions": item.get("commandActions").or_else(|| item.get("command_actions")),
                "item_type": item_type,
                "provider_item_id": item_id,
                "provider_item": item,
            })
        }),
        "mcpToolCall" => {
            let tool_name = map_mcp_tool_name(item);
            Some(if completed {
                json!({
                    "type": "tool_result",
                    "toolName": tool_name,
                    "toolUseId": item_id,
                    "toolOutput": item.get("result"),
                    "is_error": !item.get("error").unwrap_or(&JsonValue::Null).is_null() || item.get("status").and_then(JsonValue::as_str) == Some("failed"),
                    "durationMs": item.get("durationMs").or_else(|| item.get("duration_ms")),
                    "item_type": item_type,
                    "provider_item_id": item_id,
                    "provider_item": item,
                })
            } else {
                json!({
                    "type": "tool_use",
                    "name": tool_name,
                    "id": item_id,
                    "input": item.get("arguments"),
                    "item_type": item_type,
                    "provider_item_id": item_id,
                    "provider_item": item,
                })
            })
        }
        "fileChange" => Some(if completed {
            json!({
                "type": "tool_result",
                "toolName": "fileChange",
                "toolUseId": item_id,
                "toolOutput": { "status": item.get("status"), "output": delta_output },
                "is_error": item.get("status").and_then(JsonValue::as_str) == Some("failed"),
                "item_type": item_type,
                "provider_item_id": item_id,
                "provider_item": item,
            })
        } else {
            json!({
                "type": "tool_use",
                "name": "fileChange",
                "id": item_id,
                "input": { "changes": item.get("changes") },
                "item_type": item_type,
                "provider_item_id": item_id,
                "provider_item": item,
            })
        }),
        "dynamicToolCall" | "webSearch" | "imageGeneration" | "collabAgentToolCall" => {
            Some(json!({
                "type": if completed { "tool_result" } else { "tool_use" },
                "name": item.get("tool").and_then(JsonValue::as_str).unwrap_or(item_type),
                "toolName": item.get("tool").and_then(JsonValue::as_str).unwrap_or(item_type),
                "id": item_id,
                "toolUseId": item_id,
                "input": item.get("arguments").cloned().unwrap_or(JsonValue::Null),
                "toolOutput": if completed { item.clone() } else { JsonValue::Null },
                "item_type": item_type,
                "provider_item_id": item_id,
                "provider_item": item,
            }))
        }
        _ => None,
    }
}

fn map_mcp_tool_name(item: &JsonValue) -> String {
    let server = item.get("server").and_then(JsonValue::as_str).unwrap_or("");
    let tool = item.get("tool").and_then(JsonValue::as_str).unwrap_or("");
    if !server.is_empty() && !tool.is_empty() {
        format!("{server}.{tool}")
    } else if !tool.is_empty() {
        tool.to_string()
    } else {
        "mcpToolCall".to_string()
    }
}

fn item_from_payload(payload: &JsonValue) -> &JsonValue {
    let item = payload.get("item").unwrap_or(&JsonValue::Null);
    item.get("root").unwrap_or(item)
}

fn extract_thread_id(response: &JsonValue) -> Result<String, AdapterError> {
    value_at(response, &["thread", "id"])
        .and_then(JsonValue::as_str)
        .map(str::to_string)
        .ok_or_else(|| {
            AdapterError::new(
                "codex_protocol_error",
                format!("Codex response did not include thread.id: {response}"),
            )
        })
}

fn extract_turn_id(response: &JsonValue) -> Option<String> {
    value_at(response, &["turn", "id"])
        .and_then(JsonValue::as_str)
        .map(str::to_string)
}

fn normalize_strategy(value: Option<&str>) -> String {
    match value.unwrap_or("").trim().to_lowercase().as_str() {
        "resume" => "resume".to_string(),
        "fork_at_turn" => "fork_at_turn".to_string(),
        _ => "fresh_thread".to_string(),
    }
}

fn build_fork_at_turn_params(
    thread_id: &str,
    last_turn_id: &str,
    thread_params: JsonValue,
) -> JsonValue {
    merge_object(
        json!({ "threadId": thread_id, "lastTurnId": last_turn_id }),
        thread_params,
    )
}

fn merge_object(mut left: JsonValue, right: JsonValue) -> JsonValue {
    if let (Some(left), Some(right)) = (left.as_object_mut(), right.as_object()) {
        for (key, value) in right {
            left.insert(key.clone(), value.clone());
        }
    }
    left
}

fn map_usage(token_usage: &JsonValue) -> JsonValue {
    let last = token_usage.get("last").unwrap_or(&JsonValue::Null);
    let total = token_usage.get("total").unwrap_or(&JsonValue::Null);
    json!({
        "input_tokens": field(last, "input_tokens", "inputTokens"),
        "output_tokens": field(last, "output_tokens", "outputTokens"),
        "reasoning_output_tokens": field(last, "reasoning_output_tokens", "reasoningOutputTokens"),
        "cached_input_tokens": field(last, "cached_input_tokens", "cachedInputTokens"),
        "total_tokens": field(last, "total_tokens", "totalTokens"),
        "cumulative_input_tokens": field(total, "input_tokens", "inputTokens"),
        "cumulative_output_tokens": field(total, "output_tokens", "outputTokens"),
        "cumulative_reasoning_output_tokens": field(total, "reasoning_output_tokens", "reasoningOutputTokens"),
        "cumulative_cached_input_tokens": field(total, "cached_input_tokens", "cachedInputTokens"),
        "cumulative_total_tokens": field(total, "total_tokens", "totalTokens"),
        "model_context_window": field(token_usage, "model_context_window", "modelContextWindow"),
    })
}

fn map_rate_limits(rate_limits: &JsonValue) -> JsonValue {
    let credits = rate_limits.get("credits").unwrap_or(&JsonValue::Null);
    json!({
        "kind": "codex",
        "credits": if credits.is_null() {
            JsonValue::Null
        } else {
            json!({
                "balance": field(credits, "balance", "balance"),
                "hasCredits": field(credits, "has_credits", "hasCredits"),
                "unlimited": field(credits, "unlimited", "unlimited"),
            })
        },
        "limitId": field(rate_limits, "limit_id", "limitId"),
        "limitName": field(rate_limits, "limit_name", "limitName"),
        "planType": field(rate_limits, "plan_type", "planType"),
        "primary": map_rate_limit_window(rate_limits.get("primary").unwrap_or(&JsonValue::Null)),
        "secondary": map_rate_limit_window(rate_limits.get("secondary").unwrap_or(&JsonValue::Null)),
    })
}

fn map_rate_limit_window(window: &JsonValue) -> JsonValue {
    if window.is_null() {
        JsonValue::Null
    } else {
        json!({
            "resetsAt": field(window, "resets_at", "resetsAt"),
            "usedPercent": field(window, "used_percent", "usedPercent"),
            "windowDurationMins": field(window, "window_duration_mins", "windowDurationMins"),
        })
    }
}

fn field(value: &JsonValue, snake: &str, camel: &str) -> JsonValue {
    value
        .get(camel)
        .or_else(|| value.get(snake))
        .cloned()
        .unwrap_or(JsonValue::Null)
}

fn classify_provider_error(message: &str) -> JsonValue {
    let lower = message.to_lowercase();
    let code = if message.contains("usageLimitExceeded") || lower.contains("usage limit") {
        "usage_limit_exceeded"
    } else if message.contains("Unauthorized") || lower.contains("authentication") {
        "auth_error"
    } else if lower.contains("rate limit") {
        "rate_limited"
    } else {
        "provider_error"
    };
    json!({
        "provider_error_code": code,
        "provider_error_message": extract_message_field(message).unwrap_or_else(|| message.to_string()),
    })
}

fn structured_output_from_text(value: &str) -> StructuredOutput {
    let Ok(parsed) = serde_json::from_str::<JsonValue>(value) else {
        return StructuredOutput::default();
    };
    StructuredOutput {
        final_response: normalize_final_response(parsed.get("final_response")),
        commit_subject: normalize_short_field(parsed.get("commit_subject"), 72),
        commit_body: normalize_commit_body_field(parsed.get("commit_body")),
        ai_label: normalize_short_field(parsed.get("ai_label"), 80),
        thread_title: normalize_short_field(parsed.get("thread_title"), 80),
    }
}

fn merge_structured_output(current: &mut StructuredOutput, next: StructuredOutput) {
    if next.final_response.is_some() {
        current.final_response = next.final_response;
    }
    if next.commit_subject.is_some() {
        current.commit_subject = next.commit_subject;
    }
    if next.commit_body.is_some() {
        current.commit_body = next.commit_body;
    }
    if next.ai_label.is_some() {
        current.ai_label = next.ai_label;
    }
    if next.thread_title.is_some() {
        current.thread_title = next.thread_title;
    }
}

fn normalize_final_response(value: Option<&JsonValue>) -> Option<String> {
    value?
        .as_str()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn normalize_short_field(value: Option<&JsonValue>, limit: usize) -> Option<String> {
    let raw = value?.as_str()?;
    let normalized = raw
        .replace(['\n', '\r', '\t'], " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .trim_matches(|ch: char| matches!(ch, '"' | '\'' | '`' | '-' | ' ' | '.'))
        .to_string();
    if normalized.is_empty() {
        None
    } else {
        Some(normalized.chars().take(limit).collect())
    }
}

fn normalize_commit_body_field(value: Option<&JsonValue>) -> Option<String> {
    let raw = value?.as_str()?;
    let without_code_fences = strip_markdown_fences(raw);
    let normalized = without_code_fences
        .replace("\r\n", "\n")
        .replace('\r', "\n")
        .lines()
        .map(str::trim)
        .collect::<Vec<_>>()
        .join("\n")
        .split("\n\n")
        .map(|paragraph| paragraph.split_whitespace().collect::<Vec<_>>().join(" "))
        .filter(|paragraph| !paragraph.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n")
        .trim_matches(|ch: char| matches!(ch, '"' | '\'' | '`' | ' '))
        .to_string();
    if normalized.is_empty() {
        None
    } else {
        Some(
            normalized
                .chars()
                .take(1200)
                .collect::<String>()
                .trim()
                .to_string(),
        )
    }
}

fn strip_markdown_fences(value: &str) -> String {
    let mut output = String::with_capacity(value.len());
    let mut in_fence = false;
    for line in value.lines() {
        if line.trim_start().starts_with("```") {
            in_fence = !in_fence;
            output.push('\n');
            continue;
        }
        if !in_fence {
            output.push_str(line);
            output.push('\n');
        }
    }
    output
}

fn json_string_field_prefix(buffer: &str, field_name: &str) -> Option<String> {
    let needle = format!("\"{field_name}\"");
    let field_pos = buffer.find(&needle)?;
    let after_field = &buffer[field_pos + needle.len()..];
    let colon_pos = after_field.find(':')?;
    let after_colon = after_field[colon_pos + 1..].trim_start();
    if !after_colon.starts_with('"') {
        return None;
    }
    let raw = &after_colon[1..];
    let mut escaped = false;
    let mut end = raw.len();
    for (idx, ch) in raw.char_indices() {
        if escaped {
            escaped = false;
        } else if ch == '\\' {
            escaped = true;
        } else if ch == '"' {
            end = idx;
            break;
        }
    }
    Some(decode_json_string_prefix(&raw[..end]))
}

fn decode_json_string_prefix(value: &str) -> String {
    let value = trim_incomplete_json_string_escape(value);
    let wrapped = format!("\"{}\"", value);
    serde_json::from_str::<String>(&wrapped)
        .unwrap_or_else(|_| value.replace("\\n", "\n").replace("\\\"", "\""))
}

fn trim_incomplete_json_string_escape(value: &str) -> &str {
    let Some(last_escape_start) = value.rfind('\\') else {
        return value;
    };
    let trailing_backslashes = value[last_escape_start..]
        .chars()
        .take_while(|ch| *ch == '\\')
        .count();
    if trailing_backslashes > 1 {
        return value;
    }

    let escape_tail = &value[last_escape_start..];
    if escape_tail == "\\" {
        return &value[..last_escape_start];
    }
    if escape_tail.starts_with("\\u") && escape_tail.chars().count() < 6 {
        return &value[..last_escape_start];
    }
    value
}

fn suffix_after_prefix(previous: &str, current: &str) -> String {
    current
        .strip_prefix(previous)
        .unwrap_or(current)
        .to_string()
}

fn final_result_schema() -> JsonValue {
    json!({
        "type": "object",
        "additionalProperties": false,
        "required": ["final_response", "commit_subject", "commit_body", "ai_label", "thread_title"],
        "properties": {
            "final_response": {
                "type": "string",
                "description": "User-visible final assistant response. Keep the normal summary, verification, and caveats here."
            },
            "commit_subject": {
                "anyOf": [{ "type": "string" }, { "type": "null" }],
                "description": "Git commit subject for the files changed, or null if no files changed. Use Conventional Commits format: <type>(optional scope): <summary>. Choose an accurate type such as feat, fix, refactor, test, docs, chore, perf, build, or ci. Keep it under 72 characters, specific, human readable, and focused on user-visible behavior or engineering intent instead of listing files. Avoid vague subjects like update code, fix bug, or changes. No trailing period."
            },
            "commit_body": {
                "anyOf": [{ "type": "string" }, { "type": "null" }],
                "description": "Optional git commit body for the files changed. Use null when no files changed or the change is trivial. For non-trivial changes, write 1-3 short paragraphs explaining why the change was made, important tradeoffs, and any relevant files/functions changed. Do not repeat the subject. Keep it factual, specific, and readable."
            },
            "ai_label": {
                "anyOf": [{ "type": "string" }, { "type": "null" }],
                "description": AI_LABEL_PROMPT.trim()
            },
            "thread_title": {
                "anyOf": [{ "type": "string" }, { "type": "null" }],
                "description": "Concise 3-7 word title for the Agentree thread, based only on the first user request. Use null unless Agentree explicitly says this is the first user message in a new thread."
            },
        },
    })
}

fn normalize_permission_mode(mode: Option<&str>) -> &str {
    match mode {
        Some("fully-isolated") => "fully-isolated",
        Some("safe-write") => "safe-write",
        Some("full-access") => "full-access",
        Some("bypassPermissions") => "full-access",
        _ => "full-access",
    }
}

fn codex_sandbox_name(permission_mode: &str) -> &str {
    if permission_mode == "full-access" {
        "danger-full-access"
    } else {
        "workspace-write"
    }
}

fn codex_sandbox_policy(cwd: &str, permission_mode: &str) -> JsonValue {
    match permission_mode {
        "full-access" => json!({
            "type": "dangerFullAccess",
        }),
        "safe-write" => json!({
            "type": "workspaceWrite",
            "writableRoots": [cwd],
            "networkAccess": true,
            "readOnlyAccess": { "type": "fullAccess" },
        }),
        _ => json!({
            "type": "workspaceWrite",
            "writableRoots": [cwd],
            "networkAccess": false,
        }),
    }
}

fn codex_environment_detail(codex_bin: &str, codex_home: &str) -> JsonValue {
    let codex_home_path = Path::new(codex_home);
    json!({
        "codex_bin": codex_bin,
        "codex_home": codex_home,
        "codex_bin_exists": path_exists(codex_bin),
        "codex_home_exists": path_exists(codex_home),
        "codex_auth_json_exists": path_exists(codex_home_path.join("auth.json")),
        "codex_config_exists": path_exists(codex_home_path.join("config.toml")),
        "codex_state_db_exists": path_exists(codex_home_path.join("state_5.sqlite")),
        "codex_logs_db_exists": path_exists(codex_home_path.join("logs_2.sqlite")),
        "codex_version": run_codex_probe(codex_bin, &["--version"], codex_home, CODEX_VERSION_PROBE_TIMEOUT),
        "env_HOME": std::env::var("HOME").ok(),
        "env_USER": std::env::var("USER").ok(),
        "env_SHELL": std::env::var("SHELL").ok(),
        "path_entries": std::env::var("PATH").unwrap_or_default().split(':').take(12).collect::<Vec<_>>(),
        "has_OPENAI_API_KEY": has_env_value("OPENAI_API_KEY"),
        "has_CODEX_API_KEY": has_env_value("CODEX_API_KEY"),
    })
}

fn run_codex_probe(
    codex_bin: &str,
    args: &[&str],
    codex_home: &str,
    timeout: Duration,
) -> JsonValue {
    let mut child = match Command::new(codex_bin)
        .args(args)
        .env("CODEX_HOME", codex_home)
        .env("PATH", crate::cli_path::build_tool_path())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(child) => child,
        Err(error) => return json!({ "ok": false, "error_type": error.to_string() }),
    };
    let start = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if start.elapsed() < timeout => thread::sleep(Duration::from_millis(50)),
            Ok(None) => {
                let _ = child.kill();
                return json!({ "ok": false, "error_type": "timeout" });
            }
            Err(error) => return json!({ "ok": false, "error_type": error.to_string() }),
        }
    }
    let output = match child.wait_with_output() {
        Ok(output) => output,
        Err(error) => return json!({ "ok": false, "error_type": error.to_string() }),
    };
    let mut combined = String::new();
    combined.push_str(&String::from_utf8_lossy(&output.stdout));
    combined.push_str(&String::from_utf8_lossy(&output.stderr));
    json!({
        "ok": output.status.success(),
        "exit_code": output.status.code(),
        "output_excerpt": text_excerpt(&combined, 500),
    })
}

fn sanitize_account(account: &JsonValue) -> Option<JsonValue> {
    let object = account.as_object()?;
    let account_type = object.get("type")?.as_str()?;
    let mut sanitized = JsonMap::new();
    sanitized.insert("type".to_string(), json!(account_type));
    if account_type == "chatgpt" {
        if let Some(plan) = object.get("planType").or_else(|| object.get("plan_type")) {
            sanitized.insert("planType".to_string(), plan.clone());
        }
    }
    Some(JsonValue::Object(sanitized))
}

fn recommended_file_auth_command(codex_home: &str) -> String {
    format!(
        "CODEX_HOME={} codex -c 'cli_auth_credentials_store=\"file\"' login --device-auth",
        codex_home
    )
}

fn format_jsonrpc_error(error: &JsonValue) -> String {
    if let Some(message) = error.get("message").and_then(JsonValue::as_str) {
        message.to_string()
    } else {
        error.to_string()
    }
}

fn extract_message_field(message: &str) -> Option<String> {
    let marker = "message=\"";
    let start = message.find(marker)? + marker.len();
    let rest = &message[start..];
    let end = rest.find('"')?;
    Some(rest[..end].to_string())
}

fn with_timestamp(mut value: JsonValue) -> JsonValue {
    if let Some(object) = value.as_object_mut() {
        object.insert("timestamp".to_string(), json!(now_ms()));
    }
    value
}

fn emit_trace(name: &str, detail: JsonValue) {
    emit(json!({
        "type": "trace",
        "name": name,
        "source": "codex_rust_adapter",
        "ts": now_ms(),
        "detail": detail,
    }));
}

fn emit(value: JsonValue) {
    println!("{}", value);
    let _ = std::io::stdout().flush();
}

fn value_at<'a>(value: &'a JsonValue, path: &[&str]) -> Option<&'a JsonValue> {
    let mut current = value;
    for key in path {
        current = current.get(*key)?;
    }
    Some(current)
}

fn get_string(value: &JsonValue, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(JsonValue::as_str)
        .map(str::to_string)
}

fn has_env_value(name: &str) -> bool {
    std::env::var(name)
        .ok()
        .map(|value| !value.trim().is_empty())
        .unwrap_or(false)
}

fn path_exists(path: impl AsRef<Path>) -> bool {
    path.as_ref().exists()
}

fn text_excerpt(value: &str, limit: usize) -> String {
    value
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(limit)
        .collect()
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

fn now_iso_string() -> String {
    chrono::Utc::now().to_rfc3339()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_streaming_final_response_prefix() {
        let prefix = json_string_field_prefix(r#"{"final_response":"hello\nwor"#, "final_response");
        assert_eq!(prefix.as_deref(), Some("hello\nwor"));
    }

    #[test]
    fn streaming_final_response_prefix_ignores_dangling_escape() {
        let first = json_string_field_prefix(
            r#"{"final_response":"```mermaid\nflowchart TD\n    A[Read] --> B[Spawn]\"#,
            "final_response",
        );
        let second = json_string_field_prefix(
            r#"{"final_response":"```mermaid\nflowchart TD\n    A[Read] --> B[Spawn]\n    B --> C[Wait]"#,
            "final_response",
        );
        let first = first.expect("partial prefix");
        let second = second.expect("longer partial prefix");

        assert!(!first.ends_with('\\'));
        assert!(second.starts_with(&first));
        assert_eq!(suffix_after_prefix(&first, &second), "\n    B --> C[Wait]");
    }

    #[test]
    fn structured_output_includes_commit_body() {
        let output = structured_output_from_text(
            r#"{"final_response":"Done","commit_subject":"feat: add commit bodies","commit_body":"Explain why.\n\nMention changed functions.","ai_label":null,"thread_title":null}"#,
        );
        assert_eq!(
            output.commit_subject.as_deref(),
            Some("feat: add commit bodies")
        );
        assert_eq!(
            output.commit_body.as_deref(),
            Some("Explain why.\n\nMention changed functions.")
        );
    }

    #[test]
    fn final_result_schema_requires_commit_body() {
        let schema = final_result_schema();
        let required = schema
            .get("required")
            .and_then(JsonValue::as_array)
            .unwrap();
        assert!(required
            .iter()
            .any(|value| value.as_str() == Some("commit_body")));
        assert!(schema
            .pointer("/properties/commit_body/description")
            .and_then(JsonValue::as_str)
            .unwrap()
            .contains("commit body"));
    }

    #[test]
    fn model_catalog_normalizes_aliases_and_excludes_hidden_models() {
        let models = normalize_codex_models(
            &[
                json!({
                    "id": "gpt-latest",
                    "model": "gpt-6",
                    "displayName": "GPT 6",
                    "description": "Current frontier model.",
                    "hidden": false,
                    "isDefault": true,
                    "inputModalities": ["text", "image"],
                    "defaultReasoningEffort": "medium",
                    "supportedReasoningEfforts": [
                        { "reasoningEffort": "low", "description": "Fast" },
                        { "reasoningEffort": "medium", "description": "Balanced" }
                    ]
                }),
                json!({
                    "id": "gpt-old",
                    "model": "gpt-old",
                    "displayName": "GPT Old",
                    "description": "Hidden legacy model.",
                    "hidden": true,
                    "isDefault": false,
                    "supportedReasoningEfforts": []
                }),
            ],
            Some("codex-cli 1.2.3"),
            42,
        );

        assert_eq!(models.len(), 1);
        assert_eq!(models[0]["provider"], "codex");
        assert_eq!(models[0]["canonicalModelId"], "gpt-6");
        assert_eq!(models[0]["cliModelId"], "gpt-latest");
        assert_eq!(
            models[0]["supportedReasoningEfforts"],
            json!(["low", "medium"])
        );
        assert_eq!(models[0]["defaultReasoningEffort"], "medium");
        assert_eq!(models[0]["checkedAt"], 42);
    }

    #[test]
    fn build_turn_input_adds_selected_image_artifacts() {
        let input = prepare_turn_input(
            "Generate a variation.",
            &[json!({
                "kind": "screenshot",
                "mimeType": "image/png",
                "storage": {
                    "backend": "remote",
                    "url": "https://cdn.example.com/reference.png"
                }
            })],
            ".",
        )
        .input;

        assert_eq!(input.len(), 2);
        assert_eq!(
            input[0],
            json!({ "type": "text", "text": "Generate a variation." })
        );
        assert_eq!(input[1]["type"], "input_image");
        assert_eq!(
            input[1]["image_url"],
            "https://cdn.example.com/reference.png"
        );
        assert_eq!(input[1]["detail"], "auto");
    }

    #[test]
    fn build_turn_input_ignores_non_image_artifacts() {
        let input = prepare_turn_input(
            "Summarize.",
            &[json!({
                "kind": "pdf",
                "mimeType": "application/pdf",
                "storage": { "url": "https://cdn.example.com/report.pdf" }
            })],
            ".",
        )
        .input;

        assert_eq!(input, vec![json!({ "type": "text", "text": "Summarize." })]);
    }

    #[test]
    fn prepare_turn_input_reports_unattached_image_artifacts() {
        let prepared = prepare_turn_input(
            "Use this.",
            &[json!({
                "id": "artifact-1",
                "title": "Missing image",
                "kind": "image",
                "mimeType": "image/png",
                "storage": { "path": "/tmp/does-not-exist.png" }
            })],
            ".",
        );

        assert_eq!(
            prepared.input,
            vec![json!({ "type": "text", "text": "Use this." })]
        );
        assert_eq!(prepared.skipped_image_artifacts.len(), 1);
        assert_eq!(prepared.skipped_image_artifacts[0]["id"], "artifact-1");
        assert_eq!(
            prepared.skipped_image_artifacts[0]["label"],
            "Missing image"
        );
    }

    #[test]
    fn image_models_do_not_use_structured_text_output_schema() {
        assert!(!model_uses_structured_text_output("gpt-image-2"));
        assert!(model_uses_structured_text_output("gpt-5.5"));
    }

    #[test]
    fn materializes_inline_provider_image_to_local_storage() {
        let temp = tempfile::tempdir().unwrap();
        std::env::set_var("AGENTREE_ARTIFACTS_DIR", temp.path());
        let (storage, size_bytes) =
            materialize_provider_image_url("data:image/png;base64,aGVsbG8=", "item-1:image:0")
                .expect("materialized image");
        std::env::remove_var("AGENTREE_ARTIFACTS_DIR");

        assert_eq!(storage["backend"], "local");
        assert_eq!(size_bytes, Some(5));
        let path = storage["path"].as_str().expect("local path");
        assert!(!path.contains("aGVsbG8="));
        assert!(path.starts_with(temp.path().to_str().unwrap()));
        assert_eq!(fs::read(path).unwrap(), b"hello");
    }

    #[test]
    fn rejects_missing_managed_codex() {
        let temp = tempfile::tempdir().unwrap();
        let missing = temp.path().join("missing-codex");
        let err = resolve_codex_bin(missing.to_str().unwrap()).unwrap_err();
        assert_eq!(err.code, "codex_cli_missing");
    }

    #[test]
    fn uses_the_explicit_managed_codex_path() {
        let temp = tempfile::tempdir().unwrap();
        let managed = temp.path().join("managed-codex");
        fs::write(&managed, b"managed").unwrap();
        let resolved = resolve_codex_bin(managed.to_str().unwrap()).unwrap();
        assert_eq!(resolved, managed.to_string_lossy());
    }

    #[test]
    fn accepts_native_steer_control_shape() {
        assert!(is_steer_control(&json!({
            "type": "steer_agent_run",
            "control_type": "steer",
            "content": "Adjust course",
        })));
        assert!(is_steer_control(&json!({
            "type": "steer",
            "content": "Adjust course",
        })));
        assert!(!is_steer_control(&json!({
            "type": "cancel",
            "content": "Stop",
        })));
    }

    #[test]
    fn builds_exact_turn_fork_request() {
        let params = build_fork_at_turn_params(
            "thread-1",
            "turn-2",
            json!({ "model": "gpt-5.5", "cwd": "/repo" }),
        );

        assert_eq!(
            params,
            json!({
                "threadId": "thread-1",
                "lastTurnId": "turn-2",
                "model": "gpt-5.5",
                "cwd": "/repo",
            })
        );
    }
}
