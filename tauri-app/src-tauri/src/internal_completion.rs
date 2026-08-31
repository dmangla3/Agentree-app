use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use std::fs;
use std::io::{BufRead, BufReader};
use std::process::{Command, Output, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, State};
use uuid::Uuid;

const INTERNAL_COMPLETION_TIMEOUT: Duration = Duration::from_secs(300);
static INTERNAL_COMPLETION_CANCEL_FLAGS: once_cell::sync::Lazy<
    Mutex<std::collections::HashMap<String, Arc<AtomicBool>>>,
> = once_cell::sync::Lazy::new(|| Mutex::new(std::collections::HashMap::new()));

#[derive(Debug, Clone, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct InternalCompletionRequest {
    pub purpose: String,
    pub provider: String,
    pub model: String,
    #[serde(default)]
    pub reasoning_effort: Option<String>,
    #[serde(default, rename = "loginProfileId")]
    pub login_profile_id: Option<String>,
    #[serde(default, rename = "requestId")]
    pub request_id: Option<String>,
    pub prompt: String,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct InternalCompletionResponse {
    pub text: String,
    pub provider: String,
    pub model: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[specta(type = specta_typescript::Unknown)]
    pub usage: Option<JsonValue>,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct InternalCompletionEvent {
    pub request_id: String,
    pub stream: String,
    pub line: String,
}

#[specta::specta]
#[tauri::command]
pub async fn complete_internal_prompt(
    app: AppHandle,
    db: State<'_, crate::db::TelemetryDb>,
    request: InternalCompletionRequest,
) -> Result<InternalCompletionResponse, String> {
    let purpose = request.purpose.trim();
    if purpose != "flow_authoring" {
        return Err(format!(
            "Unsupported internal completion purpose: {}.",
            if purpose.is_empty() { "empty" } else { purpose }
        ));
    }
    let provider = request.provider.trim().to_ascii_lowercase();
    if provider != "codex" && provider != "claude" {
        return Err(format!(
            "Internal completion supports Codex and Claude only, not {}.",
            request.provider
        ));
    }
    let model = request.model.trim();
    if model.is_empty() {
        return Err("Internal completion requires a model.".to_string());
    }
    let prompt = request.prompt.trim();
    if prompt.is_empty() {
        return Err("Internal completion prompt cannot be empty.".to_string());
    }
    let request_id = request
        .request_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());

    crate::app_log!(
        "[INTERNAL_COMPLETION] event=start purpose={} provider={} model={}",
        purpose,
        provider,
        model
    );
    let profile = select_login_profile(&db, &provider, request.login_profile_id.as_deref())?;
    crate::app_log!(
        "[INTERNAL_COMPLETION] event=profile_selected provider={} profile_id={} auth_type={} status={}",
        provider,
        profile.id,
        profile.auth_type,
        profile.status
    );
    let app_cache_dir = app
        .path()
        .app_cache_dir()
        .map_err(|error| format!("Could not resolve app cache dir: {}", error))?;
    let materialized = crate::login_profiles::resolve_runtime_credentials(
        &db,
        &crate::login_profiles::KeyringCredentialVault,
        &profile.id,
        app_cache_dir,
    )?;
    if materialized.provider != provider {
        return Err(format!(
            "Login profile {} is for {}, not {}.",
            profile.id, materialized.provider, provider
        ));
    }

    let cwd = std::env::temp_dir().join(format!("agentree-internal-completion-{}", Uuid::new_v4()));
    fs::create_dir_all(&cwd)
        .map_err(|error| format!("failed to create internal completion temp dir: {}", error))?;

    let cancel_flag = request_id.map(|id| {
        let flag = Arc::new(AtomicBool::new(false));
        if let Ok(mut flags) = INTERNAL_COMPLETION_CANCEL_FLAGS.lock() {
            flags.insert(id.to_string(), Arc::clone(&flag));
        }
        flag
    });
    let result = if provider == "codex" {
        run_codex_completion(&app, &request, &materialized, &cwd, cancel_flag.clone())
    } else {
        run_claude_completion(&app, &request, &materialized, &cwd, cancel_flag.clone())
    };

    if let Some(id) = request_id {
        if let Ok(mut flags) = INTERNAL_COMPLETION_CANCEL_FLAGS.lock() {
            flags.remove(id);
        }
    }
    let _ = fs::remove_dir_all(&cwd);

    if let Some(codex_home) = materialized.codex_home.as_deref() {
        let _ = crate::login_profiles::persist_codex_auth_state(
            &db,
            &crate::login_profiles::KeyringCredentialVault,
            &materialized.profile_id,
            codex_home,
        );
    }
    if let Some(claude_config_dir) = materialized.claude_config_dir.as_deref() {
        let _ = crate::login_profiles::persist_claude_oauth_state(
            &db,
            &crate::login_profiles::KeyringCredentialVault,
            &materialized.profile_id,
            claude_config_dir,
        );
        crate::login_profiles::release_claude_oauth_activation(&materialized.profile_id);
    }

    let output = match result {
        Ok(output) => output,
        Err(error) => {
            crate::app_log!(
                "[INTERNAL_COMPLETION] event=process_failed provider={} model={} error={}",
                provider,
                model,
                concise_log_message(&error)
            );
            return Err(error);
        }
    };
    let parsed = match parse_internal_completion_output(&output) {
        Ok(parsed) => parsed,
        Err(error) => {
            crate::app_log!(
                "[INTERNAL_COMPLETION] event=parse_failed provider={} model={} status={} error={}",
                provider,
                model,
                output.status,
                concise_log_message(&error)
            );
            return Err(error);
        }
    };
    crate::app_log!(
        "[INTERNAL_COMPLETION] event=completed provider={} model={} output_chars={}",
        provider,
        model,
        parsed.text.chars().count()
    );
    Ok(InternalCompletionResponse {
        text: parsed.text,
        provider,
        model: model.to_string(),
        usage: parsed.usage,
    })
}

#[specta::specta]
#[tauri::command]
pub async fn cancel_internal_completion(request_id: String) -> Result<(), String> {
    let request_id = request_id.trim();
    if request_id.is_empty() {
        return Err("Internal completion cancel requires a request id.".to_string());
    }
    let flag = INTERNAL_COMPLETION_CANCEL_FLAGS
        .lock()
        .ok()
        .and_then(|flags| flags.get(request_id).cloned());
    if let Some(flag) = flag {
        flag.store(true, Ordering::SeqCst);
    }
    Ok(())
}

fn concise_log_message(message: &str) -> String {
    let mut rendered = message.replace('\n', "\\n");
    if rendered.len() > 500 {
        rendered.truncate(500);
        rendered.push_str("...");
    }
    rendered
}

fn select_login_profile(
    db: &crate::db::TelemetryDb,
    provider: &str,
    requested_profile_id: Option<&str>,
) -> Result<crate::login_profiles::LoginProfile, String> {
    if let Some(profile_id) = requested_profile_id.filter(|value| !value.trim().is_empty()) {
        let profile = db.get_login_profile(profile_id)?;
        if profile.provider != provider {
            return Err(format!(
                "Login profile {} is for {}, not {}.",
                profile.id, profile.provider, provider
            ));
        }
        if profile.status != "ready" {
            return Err(profile.status_message.unwrap_or_else(|| {
                format!(
                    "{} login profile {} is not ready.",
                    provider, profile.display_name
                )
            }));
        }
        return Ok(profile);
    }

    let profiles = db.list_login_profiles()?;
    let compatible: Vec<_> = profiles
        .into_iter()
        .filter(|profile| profile.provider == provider)
        .collect();
    let selected = compatible
        .iter()
        .find(|profile| profile.is_default)
        .or_else(|| compatible.first())
        .cloned()
        .ok_or_else(|| format!("Add or connect a ready {} account in Logins.", provider))?;
    if selected.status != "ready" {
        return Err(selected.status_message.clone().unwrap_or_else(|| {
            format!(
                "{} needs a ready active login profile before internal completion can run.",
                provider
            )
        }));
    }
    Ok(selected)
}

fn run_codex_completion(
    app: &AppHandle,
    request: &InternalCompletionRequest,
    materialized: &crate::login_profiles::MaterializedRuntimeCredentials,
    cwd: &std::path::Path,
    cancel_flag: Option<Arc<AtomicBool>>,
) -> Result<Output, String> {
    let adapter = crate::runtime_scripts::codex_adapter_command(app)?;
    let mut command = Command::new(adapter.program);
    command
        .args(adapter.args_prefix)
        .arg("--model")
        .arg(request.model.trim())
        .arg("--cwd")
        .arg(cwd)
        .arg("--permission-mode")
        .arg("read-only")
        .env("PATH", crate::cli_path::build_tool_path());
    if let Some(reasoning_effort) = request
        .reasoning_effort
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        command
            .arg("--reasoning-effort")
            .arg(reasoning_effort.trim());
    }
    for (key, value) in &materialized.env {
        command.env(key, value);
    }
    command.arg(&request.prompt);
    command_output_with_timeout(
        &mut command,
        INTERNAL_COMPLETION_TIMEOUT,
        request.request_id.as_deref(),
        cancel_flag,
        app,
    )
}

fn run_claude_completion(
    app: &AppHandle,
    request: &InternalCompletionRequest,
    materialized: &crate::login_profiles::MaterializedRuntimeCredentials,
    cwd: &std::path::Path,
    cancel_flag: Option<Arc<AtomicBool>>,
) -> Result<Output, String> {
    let script = crate::runtime_scripts::runtime_script_path(app, "claude-agent-sdk-adapter.mjs")?;
    let node = crate::cli_path::find_on_tool_path("node").unwrap_or_else(|| "node".to_string());
    let mut command = Command::new(node);
    command
        .arg(script)
        .arg("--deny-tools")
        .arg("--model")
        .arg(request.model.trim())
        .current_dir(cwd)
        .env("PATH", crate::cli_path::build_tool_path());
    if let Some(reasoning_effort) = request
        .reasoning_effort
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        command.arg("--effort").arg(reasoning_effort.trim());
    }
    if materialized.auth_type == "claude_oauth" {
        if let Some(claude_config_dir) = materialized.claude_config_dir.as_deref() {
            crate::login_profiles::apply_claude_oauth_command_env(&mut command, claude_config_dir);
        }
    }
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
        if materialized.auth_type == "claude_oauth" {
            command.env_remove(key);
        }
    }
    for (key, value) in &materialized.env {
        command.env(key, value);
    }
    command.arg(&request.prompt);
    command_output_with_timeout(
        &mut command,
        INTERNAL_COMPLETION_TIMEOUT,
        request.request_id.as_deref(),
        cancel_flag,
        app,
    )
}

fn command_output_with_timeout(
    command: &mut Command,
    timeout: Duration,
    request_id: Option<&str>,
    cancel_flag: Option<Arc<AtomicBool>>,
    app: &AppHandle,
) -> Result<Output, String> {
    let mut child = command
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("failed to start internal completion: {}", error))?;
    let started_at = Instant::now();
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "failed to capture internal completion stdout".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "failed to capture internal completion stderr".to_string())?;
    let stdout_buffer = Arc::new(Mutex::new(Vec::new()));
    let stderr_buffer = Arc::new(Mutex::new(Vec::new()));
    let stdout_reader = spawn_output_reader(
        app.clone(),
        request_id.map(ToOwned::to_owned),
        "stdout",
        stdout,
        Arc::clone(&stdout_buffer),
    );
    let stderr_reader = spawn_output_reader(
        app.clone(),
        request_id.map(ToOwned::to_owned),
        "stderr",
        stderr,
        Arc::clone(&stderr_buffer),
    );

    let status = loop {
        match child.try_wait() {
            Ok(Some(_status)) => {
                break child.wait().map_err(|error| {
                    format!("failed to wait for internal completion: {}", error)
                })?;
            }
            Ok(None) => {
                if cancel_flag
                    .as_ref()
                    .is_some_and(|flag| flag.load(Ordering::SeqCst))
                {
                    let _ = child.kill();
                    let status = child.wait().map_err(|error| {
                        format!(
                            "failed to wait for cancelled internal completion: {}",
                            error
                        )
                    })?;
                    let output = collect_command_output(
                        status,
                        stdout_buffer,
                        stderr_buffer,
                        stdout_reader,
                        stderr_reader,
                    );
                    return Err(format_cancelled_message(&output));
                }
                if started_at.elapsed() >= timeout {
                    let _ = child.kill();
                    let status = child.wait().map_err(|error| {
                        format!(
                            "failed to wait for timed out internal completion: {}",
                            error
                        )
                    })?;
                    let output = collect_command_output(
                        status,
                        stdout_buffer,
                        stderr_buffer,
                        stdout_reader,
                        stderr_reader,
                    );
                    return Err(format_timeout_message(&output, timeout));
                }
                thread::sleep(Duration::from_millis(50));
            }
            Err(error) => {
                let _ = child.kill();
                return Err(format!(
                    "failed while waiting for internal completion: {}",
                    error
                ));
            }
        }
    };

    Ok(collect_command_output(
        status,
        stdout_buffer,
        stderr_buffer,
        stdout_reader,
        stderr_reader,
    ))
}

fn spawn_output_reader<R: std::io::Read + Send + 'static>(
    app: AppHandle,
    request_id: Option<String>,
    stream: &'static str,
    reader: R,
    buffer: Arc<Mutex<Vec<u8>>>,
) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        let mut reader = BufReader::new(reader);
        let mut line = Vec::new();
        loop {
            line.clear();
            let Ok(bytes_read) = reader.read_until(b'\n', &mut line) else {
                break;
            };
            if bytes_read == 0 {
                break;
            }
            if let Ok(mut output) = buffer.lock() {
                output.extend_from_slice(&line);
            }
            if let Some(request_id) = request_id.as_deref() {
                let rendered = String::from_utf8_lossy(&line)
                    .trim_end_matches(['\r', '\n'])
                    .to_string();
                let _ = app.emit(
                    "internal-completion:event",
                    InternalCompletionEvent {
                        request_id: request_id.to_string(),
                        stream: stream.to_string(),
                        line: rendered,
                    },
                );
            }
        }
    })
}

fn collect_command_output(
    status: std::process::ExitStatus,
    stdout_buffer: Arc<Mutex<Vec<u8>>>,
    stderr_buffer: Arc<Mutex<Vec<u8>>>,
    stdout_reader: thread::JoinHandle<()>,
    stderr_reader: thread::JoinHandle<()>,
) -> Output {
    let _ = stdout_reader.join();
    let _ = stderr_reader.join();
    Output {
        status,
        stdout: stdout_buffer
            .lock()
            .map(|buffer| buffer.clone())
            .unwrap_or_default(),
        stderr: stderr_buffer
            .lock()
            .map(|buffer| buffer.clone())
            .unwrap_or_default(),
    }
}

fn format_cancelled_message(output: &Output) -> String {
    let mut message = "Internal completion was cancelled.".to_string();
    if let Some(detail) = completion_output_error_message(output) {
        message.push_str(" Last provider output: ");
        message.push_str(&detail);
    }
    message
}

fn format_timeout_message(output: &Output, timeout: Duration) -> String {
    let mut message = format!(
        "Internal completion timed out after {}s before the provider finished.",
        timeout.as_secs()
    );
    if let Some(detail) = completion_output_error_message(output) {
        message.push_str(" Last provider output: ");
        message.push_str(&detail);
    }
    message
}

struct ParsedCompletionOutput {
    text: String,
    usage: Option<JsonValue>,
}

fn parse_internal_completion_output(output: &Output) -> Result<ParsedCompletionOutput, String> {
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let mut completed = false;
    let mut final_content: Option<String> = None;
    let mut message_completed: Option<String> = None;
    let mut usage: Option<JsonValue> = None;
    let mut error_content: Option<String> = None;

    for line in stdout.lines() {
        let Ok(value) = serde_json::from_str::<JsonValue>(line.trim()) else {
            continue;
        };
        match value.get("type").and_then(|field| field.as_str()) {
            Some("message_completed") => {
                message_completed = value
                    .get("content")
                    .and_then(|field| field.as_str())
                    .map(ToOwned::to_owned);
            }
            Some("provider_stop") => {
                completed = value
                    .get("provider_status")
                    .and_then(|field| field.as_str())
                    == Some("completed");
                final_content = value
                    .get("final_content")
                    .and_then(|field| field.as_str())
                    .map(ToOwned::to_owned);
                usage = value.get("usage").cloned();
            }
            Some("error") => {
                error_content = value
                    .get("content")
                    .and_then(|field| field.as_str())
                    .map(ToOwned::to_owned);
            }
            _ => {}
        }
    }

    let text = final_content
        .filter(|value| !value.trim().is_empty())
        .or_else(|| message_completed.filter(|value| !value.trim().is_empty()));
    if output.status.success() && completed {
        if let Some(text) = text {
            return Ok(ParsedCompletionOutput { text, usage });
        }
    }

    let mut message = error_content
        .or_else(|| completion_output_error_message(output))
        .unwrap_or_else(|| format!("Internal completion exited with {}.", output.status));
    if message.len() > 800 {
        message.truncate(800);
        message.push('…');
    }
    Err(message)
}

fn completion_output_error_message(output: &Output) -> Option<String> {
    let stdout = String::from_utf8_lossy(&output.stdout);
    for line in stdout.lines() {
        let Ok(value) = serde_json::from_str::<JsonValue>(line.trim()) else {
            continue;
        };
        if value.get("type").and_then(|field| field.as_str()) == Some("error") {
            if let Some(content) = value
                .get("content")
                .and_then(|field| field.as_str())
                .filter(|value| !value.trim().is_empty())
            {
                return Some(content.trim().to_string());
            }
        }
    }

    String::from_utf8_lossy(&output.stderr)
        .lines()
        .rev()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(ToOwned::to_owned)
        .or_else(|| {
            stdout
                .lines()
                .rev()
                .map(str::trim)
                .find(|line| !line.is_empty())
                .map(ToOwned::to_owned)
        })
}

#[cfg(test)]
mod tests {
    use super::{format_timeout_message, parse_internal_completion_output};
    use std::process::{ExitStatus, Output};

    #[cfg(unix)]
    fn success_status() -> ExitStatus {
        use std::os::unix::process::ExitStatusExt;
        ExitStatus::from_raw(0)
    }

    #[test]
    fn parses_provider_stop_final_content() {
        let output = Output {
            status: success_status(),
            stdout: br#"{"type":"message_completed","content":"draft"}
{"type":"provider_stop","provider_status":"completed","final_content":"final yaml","usage":{"input_tokens":1}}
"#
            .to_vec(),
            stderr: Vec::new(),
        };

        let parsed = parse_internal_completion_output(&output).expect("parsed output");
        assert_eq!(parsed.text, "final yaml");
        assert!(parsed.usage.is_some());
    }

    #[test]
    fn timeout_message_includes_last_provider_error() {
        let output = Output {
            status: success_status(),
            stdout: br#"{"type":"error","content":"Provider queue is saturated."}
"#
            .to_vec(),
            stderr: b"adapter stderr\n".to_vec(),
        };

        let message = format_timeout_message(&output, std::time::Duration::from_secs(300));
        assert_eq!(
            message,
            "Internal completion timed out after 300s before the provider finished. Last provider output: Provider queue is saturated."
        );
    }

    #[test]
    fn timeout_message_falls_back_to_stderr() {
        let output = Output {
            status: success_status(),
            stdout: Vec::new(),
            stderr: b"first\nlast stderr\n".to_vec(),
        };

        let message = format_timeout_message(&output, std::time::Duration::from_secs(300));
        assert_eq!(
            message,
            "Internal completion timed out after 300s before the provider finished. Last provider output: last stderr"
        );
    }
}
