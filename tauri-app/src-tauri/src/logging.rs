use once_cell::sync::{Lazy, OnceCell};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::ffi::OsStr;
use std::fs::{create_dir_all, read_dir, read_to_string, write, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

static LOG_DIR: OnceCell<PathBuf> = OnceCell::new();
static WRITE_LOCK: Lazy<Mutex<()>> = Lazy::new(|| Mutex::new(()));
static METRIC_KIT_FILE_COUNTER: AtomicU64 = AtomicU64::new(0);
const MAX_ACTIVE_LOG_BYTES: u64 = 8 * 1024 * 1024;
const MAX_LOG_LINE_BYTES: usize = 64 * 1024;
const ROTATED_LOG_FILE_COUNT: usize = 2;

#[derive(Serialize, specta::Type)]
pub struct LogPaths {
    pub log_dir: String,
    pub frontend_log: String,
    pub backend_log: String,
}

#[derive(Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticsLogBundle {
    pub log_paths: LogPaths,
    pub frontend_excerpt: String,
    pub backend_excerpt: String,
    pub metric_kit_excerpt: String,
    pub metric_kit_diagnostic_files: Vec<String>,
    pub max_lines_per_log: usize,
}

#[derive(Deserialize, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PerfCaptureExportSession {
    pub id: String,
    pub label: String,
    pub started_at: String,
}

#[derive(Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PerfCaptureExportRequest {
    pub session: PerfCaptureExportSession,
    pub stopped_at: String,
    pub started_at_ms: i64,
    pub stopped_at_ms: i64,
    #[specta(type = Vec<specta_typescript::Unknown>)]
    pub perf_events: Vec<Value>,
    #[specta(type = specta_typescript::Unknown)]
    pub send_flow_report: Value,
}

#[derive(Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PerfCaptureExportResult {
    pub export_dir: String,
    pub files: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MetricKitPayloadSummary {
    pub payload_bytes: usize,
    pub hang_diagnostics_count: usize,
    pub crash_diagnostics_count: usize,
    pub cpu_exception_diagnostics_count: usize,
    pub disk_write_exception_diagnostics_count: usize,
}

#[derive(Debug, Clone)]
pub struct MetricKitPersistedDiagnostic {
    pub path: String,
    pub summary: MetricKitPayloadSummary,
}

fn now_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

fn resolve_dev_log_dir() -> Option<PathBuf> {
    let cwd = std::env::current_dir().ok()?;
    if cwd.file_name() == Some(OsStr::new("src-tauri")) {
        return cwd.parent().map(|parent| parent.join("runtime-logs"));
    }
    if cwd.file_name() == Some(OsStr::new("tauri-app")) {
        return Some(cwd.join("runtime-logs"));
    }
    None
}

fn resolve_log_dir(app: &AppHandle) -> Result<PathBuf, String> {
    if let Ok(path) = std::env::var("AGENTREE_TAURI_LOG_DIR") {
        return Ok(PathBuf::from(path));
    }
    if let Some(path) = resolve_dev_log_dir() {
        return Ok(path);
    }
    app.path()
        .app_data_dir()
        .map(|dir| dir.join("logs"))
        .map_err(|err| err.to_string())
}

fn ensure_log_dir(app: &AppHandle) -> Result<&'static PathBuf, String> {
    LOG_DIR.get_or_try_init(|| {
        let dir = resolve_log_dir(app)?;
        create_dir_all(&dir).map_err(|err| err.to_string())?;
        Ok(dir)
    })
}

fn backend_log_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(ensure_log_dir(app)?.join("backend.log"))
}

fn frontend_log_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(ensure_log_dir(app)?.join("frontend.log"))
}

fn perf_capture_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(ensure_log_dir(app)?.join("perf-captures"))
}

fn metric_kit_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(ensure_log_dir(app)?.join("metric-kit"))
}

fn metric_kit_log_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(metric_kit_dir(app)?.join("metric-kit.log"))
}

fn backend_log_path_without_app() -> Option<PathBuf> {
    LOG_DIR.get().map(|dir| dir.join("backend.log"))
}

fn rotated_log_path(path: &Path, index: usize) -> PathBuf {
    let file_name = path
        .file_name()
        .and_then(OsStr::to_str)
        .unwrap_or("agentree.log");
    path.with_file_name(format!("{file_name}.{index}"))
}

fn truncate_log_line(line: &str, max_bytes: usize) -> String {
    if line.len() <= max_bytes {
        return line.to_string();
    }
    let notice = format!(" [truncated from {} bytes]", line.len());
    let mut end = max_bytes.saturating_sub(notice.len());
    while !line.is_char_boundary(end) {
        end = end.saturating_sub(1);
    }
    format!("{}{}", &line[..end], notice)
}

fn bounded_log_lines(lines: &[String], max_file_bytes: u64) -> Vec<String> {
    let mut kept = Vec::new();
    let mut kept_bytes = 0u64;
    let line_limit = MAX_LOG_LINE_BYTES.min(max_file_bytes.saturating_sub(1) as usize);
    for line in lines.iter().rev() {
        let line = truncate_log_line(line, line_limit);
        let line_bytes = line.len() as u64 + 1;
        if kept_bytes + line_bytes > max_file_bytes {
            continue;
        }
        kept_bytes += line_bytes;
        kept.push(line);
    }
    kept.reverse();
    kept
}

fn remove_file_if_present(path: &Path) -> Result<(), String> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

fn rotate_log_if_needed(
    path: &Path,
    incoming_bytes: u64,
    max_file_bytes: u64,
    rotated_file_count: usize,
) -> Result<(), String> {
    for index in 1..=rotated_file_count {
        let rotated = rotated_log_path(path, index);
        if std::fs::metadata(&rotated)
            .map(|metadata| metadata.len() > max_file_bytes)
            .unwrap_or(false)
        {
            remove_file_if_present(&rotated)?;
        }
    }

    let current_bytes = match std::fs::metadata(path) {
        Ok(metadata) => metadata.len(),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.to_string()),
    };
    if current_bytes > max_file_bytes {
        return remove_file_if_present(path);
    }
    if current_bytes + incoming_bytes <= max_file_bytes {
        return Ok(());
    }
    if rotated_file_count == 0 {
        return remove_file_if_present(path);
    }

    remove_file_if_present(&rotated_log_path(path, rotated_file_count))?;
    for index in (1..rotated_file_count).rev() {
        let source = rotated_log_path(path, index);
        let destination = rotated_log_path(path, index + 1);
        match std::fs::rename(&source, &destination) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.to_string()),
        }
    }
    std::fs::rename(path, rotated_log_path(path, 1)).map_err(|error| error.to_string())
}

fn append_lines_with_limits(
    path: &Path,
    lines: &[String],
    max_file_bytes: u64,
    rotated_file_count: usize,
) -> Result<(), String> {
    let _guard = WRITE_LOCK
        .lock()
        .map_err(|_| "log write lock poisoned".to_string())?;
    let lines = bounded_log_lines(lines, max_file_bytes);
    let incoming_bytes = lines.iter().map(|line| line.len() as u64 + 1).sum::<u64>();
    rotate_log_if_needed(path, incoming_bytes, max_file_bytes, rotated_file_count)?;
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|err| err.to_string())?;
    for line in &lines {
        writeln!(file, "{line}").map_err(|err| err.to_string())?;
    }
    Ok(())
}

fn append_lines(path: &Path, lines: &[String]) -> Result<(), String> {
    append_lines_with_limits(path, lines, MAX_ACTIVE_LOG_BYTES, ROTATED_LOG_FILE_COUNT)
}

fn live_check_log_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(ensure_log_dir(app)?.join("live-checks.log"))
}

/// Appends the full stdout/stderr of a provider live-check/smoke-check run so
/// failures can be diagnosed from the log even when the UI shows a short message.
/// Returns the log path for referencing in user-facing errors.
pub fn append_live_check_capture(
    app: &AppHandle,
    label: &str,
    stdout: &str,
    stderr: &str,
) -> Result<PathBuf, String> {
    let path = live_check_log_path(app)?;
    let mut lines = vec![format!("[{}] ===== {} =====", now_millis(), label)];
    if !stdout.trim().is_empty() {
        lines.push("--- stdout ---".to_string());
        lines.extend(stdout.lines().map(ToOwned::to_owned));
    }
    if !stderr.trim().is_empty() {
        lines.push("--- stderr ---".to_string());
        lines.extend(stderr.lines().map(ToOwned::to_owned));
    }
    append_lines(&path, &lines)?;
    Ok(path)
}

fn extract_bracket_value(line: &str) -> Option<&str> {
    let end = line.find(']')?;
    if !line.starts_with('[') {
        return None;
    }
    Some(&line[1..end])
}

fn slice_frontend_logs(contents: &str, start_iso: &str, stop_iso: &str) -> String {
    contents
        .lines()
        .filter(|line| {
            let value = extract_bracket_value(line);
            matches!(value, Some(ts) if ts >= start_iso && ts <= stop_iso)
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn slice_backend_logs(contents: &str, start_ms: i64, stop_ms: i64) -> String {
    contents
        .lines()
        .filter(|line| {
            extract_bracket_value(line)
                .and_then(|value| value.parse::<i64>().ok())
                .map(|ts| ts >= start_ms && ts <= stop_ms)
                .unwrap_or(false)
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn read_log_slice(
    path: &PathBuf,
    start_iso: &str,
    stop_iso: &str,
    start_ms: i64,
    stop_ms: i64,
    is_frontend: bool,
) -> String {
    match read_to_string(path) {
        Ok(contents) => {
            if is_frontend {
                slice_frontend_logs(&contents, start_iso, stop_iso)
            } else {
                slice_backend_logs(&contents, start_ms, stop_ms)
            }
        }
        Err(error) => format!("log_unavailable: {}", error),
    }
}

fn tail_log(path: &PathBuf, max_lines: usize) -> String {
    match read_to_string(path) {
        Ok(contents) => {
            let lines = contents.lines().collect::<Vec<_>>();
            let start = lines.len().saturating_sub(max_lines);
            lines[start..].join("\n")
        }
        Err(error) => format!("log_unavailable: {}", error),
    }
}

fn count_diagnostic_entries(value: &Value, key: &str) -> usize {
    match value {
        Value::Object(map) => map
            .iter()
            .map(|(current_key, current_value)| {
                let current_count = if current_key == key {
                    current_value
                        .as_array()
                        .map(|items| items.len())
                        .unwrap_or(0)
                } else {
                    0
                };
                current_count + count_diagnostic_entries(current_value, key)
            })
            .sum(),
        Value::Array(items) => items
            .iter()
            .map(|item| count_diagnostic_entries(item, key))
            .sum(),
        _ => 0,
    }
}

pub fn summarize_metric_kit_payload(payload_json: &str) -> MetricKitPayloadSummary {
    let parsed = serde_json::from_str::<Value>(payload_json).ok();
    MetricKitPayloadSummary {
        payload_bytes: payload_json.len(),
        hang_diagnostics_count: parsed
            .as_ref()
            .map(|value| count_diagnostic_entries(value, "hangDiagnostics"))
            .unwrap_or(0),
        crash_diagnostics_count: parsed
            .as_ref()
            .map(|value| count_diagnostic_entries(value, "crashDiagnostics"))
            .unwrap_or(0),
        cpu_exception_diagnostics_count: parsed
            .as_ref()
            .map(|value| count_diagnostic_entries(value, "cpuExceptionDiagnostics"))
            .unwrap_or(0),
        disk_write_exception_diagnostics_count: parsed
            .as_ref()
            .map(|value| count_diagnostic_entries(value, "diskWriteExceptionDiagnostics"))
            .unwrap_or(0),
    }
}

fn metric_kit_payload_document(
    payload_json: &str,
    received_at_ms: u128,
    summary: &MetricKitPayloadSummary,
) -> Value {
    json!({
        "receivedAtMs": received_at_ms,
        "summary": {
            "payloadBytes": summary.payload_bytes,
            "hangDiagnosticsCount": summary.hang_diagnostics_count,
            "crashDiagnosticsCount": summary.crash_diagnostics_count,
            "cpuExceptionDiagnosticsCount": summary.cpu_exception_diagnostics_count,
            "diskWriteExceptionDiagnosticsCount": summary.disk_write_exception_diagnostics_count,
        },
        "payload": serde_json::from_str::<Value>(payload_json)
            .unwrap_or_else(|_| Value::String(payload_json.to_string())),
    })
}

fn list_metric_kit_diagnostic_files(
    app: &AppHandle,
    max_files: usize,
) -> Result<Vec<String>, String> {
    let dir = metric_kit_dir(app)?;
    let entries = match read_dir(&dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error.to_string()),
    };

    let mut files = entries
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            let name = path.file_name()?.to_string_lossy();
            if !name.starts_with("diagnostic-") || path.extension()? != "json" {
                return None;
            }
            let modified = entry
                .metadata()
                .and_then(|metadata| metadata.modified())
                .ok();
            Some((modified, path.display().to_string()))
        })
        .collect::<Vec<_>>();

    files.sort_by(|left, right| right.0.cmp(&left.0));
    Ok(files
        .into_iter()
        .take(max_files)
        .map(|(_, path)| path)
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn summarizes_metric_kit_hang_diagnostics_from_payload_json() {
        let payload = r#"{
            "diagnostics": {
                "hangDiagnostics": [
                    { "diagnosticMetaData": { "exceptionType": "hang" } },
                    { "diagnosticMetaData": { "exceptionType": "hang" } }
                ],
                "crashDiagnostics": [
                    { "diagnosticMetaData": { "exceptionType": "crash" } }
                ]
            }
        }"#;

        let summary = summarize_metric_kit_payload(payload);

        assert_eq!(summary.hang_diagnostics_count, 2);
        assert_eq!(summary.crash_diagnostics_count, 1);
        assert!(summary.payload_bytes > 0);
    }

    #[test]
    fn rotates_active_logs_and_keeps_a_bounded_history() {
        let directory = tempfile::tempdir().expect("log tempdir");
        let path = directory.path().join("frontend.log");

        append_lines_with_limits(&path, &["first-aaaaaaaa".to_string()], 24, 2)
            .expect("append first");
        append_lines_with_limits(&path, &["second-bbbbbbbb".to_string()], 24, 2)
            .expect("append second");
        append_lines_with_limits(&path, &["third-cccccccc".to_string()], 24, 2)
            .expect("append third");
        append_lines_with_limits(&path, &["fourth-ddddddd".to_string()], 24, 2)
            .expect("append fourth");

        assert_eq!(
            read_to_string(&path).expect("active log"),
            "fourth-ddddddd\n"
        );
        assert_eq!(
            read_to_string(rotated_log_path(&path, 1)).expect("first rotated log"),
            "third-cccccccc\n"
        );
        assert_eq!(
            read_to_string(rotated_log_path(&path, 2)).expect("second rotated log"),
            "second-bbbbbbbb\n"
        );
        assert!(!rotated_log_path(&path, 3).exists());
    }

    #[test]
    fn discards_a_preexisting_oversized_log_before_appending() {
        let directory = tempfile::tempdir().expect("log tempdir");
        let path = directory.path().join("backend.log");
        write(&path, "x".repeat(80)).expect("write oversized log");

        append_lines_with_limits(&path, &["fresh".to_string()], 32, 2)
            .expect("append after oversized log");

        assert_eq!(read_to_string(&path).expect("active log"), "fresh\n");
        assert!(!rotated_log_path(&path, 1).exists());
    }

    #[test]
    fn truncates_log_lines_at_a_utf8_boundary() {
        let line = format!("{}tail", "🙂".repeat(20_000));
        let truncated = truncate_log_line(&line, MAX_LOG_LINE_BYTES);

        assert!(truncated.is_char_boundary(truncated.len()));
        assert!(truncated.contains("[truncated from "));
        assert!(truncated.len() <= MAX_LOG_LINE_BYTES);
        assert!(truncated.len() < line.len());
    }
}

pub fn init_logging(app: &AppHandle) -> Result<LogPaths, String> {
    let log_dir = ensure_log_dir(app)?.clone();
    let paths = LogPaths {
        log_dir: log_dir.display().to_string(),
        frontend_log: frontend_log_path(app)?.display().to_string(),
        backend_log: backend_log_path(app)?.display().to_string(),
    };
    append_backend_line(
        app,
        &format!("[{}] [BOOT] Logging initialized", now_millis()),
    )?;
    Ok(paths)
}

pub fn append_backend_line(app: &AppHandle, message: &str) -> Result<(), String> {
    append_lines(
        &backend_log_path(app)?,
        &[format!("[{}] {}", now_millis(), message)],
    )
}

pub fn append_backend_line_without_app(message: &str) -> Result<(), String> {
    let path = backend_log_path_without_app()
        .ok_or_else(|| "logging has not been initialized".to_string())?;
    append_lines(&path, &[format!("[{}] {}", now_millis(), message)])
}

pub fn persist_metric_kit_diagnostic_payload(
    app: &AppHandle,
    payload_json: &str,
) -> Result<MetricKitPersistedDiagnostic, String> {
    let received_at_ms = now_millis();
    let summary = summarize_metric_kit_payload(payload_json);
    let dir = metric_kit_dir(app)?;
    create_dir_all(&dir).map_err(|err| err.to_string())?;

    let sequence = METRIC_KIT_FILE_COUNTER.fetch_add(1, Ordering::Relaxed);
    let path = dir.join(format!("diagnostic-{received_at_ms}-{sequence}.json"));
    let document = metric_kit_payload_document(payload_json, received_at_ms, &summary);
    let contents = serde_json::to_string_pretty(&document).map_err(|err| err.to_string())?;
    write(&path, contents).map_err(|err| err.to_string())?;

    let persisted = MetricKitPersistedDiagnostic {
        path: path.display().to_string(),
        summary,
    };
    let line = format!(
        "[{}] [METRICKIT] event=diagnostic_payload_received path={} payloadBytes={} hangDiagnostics={} crashDiagnostics={} cpuExceptionDiagnostics={} diskWriteExceptionDiagnostics={}",
        received_at_ms,
        persisted.path,
        persisted.summary.payload_bytes,
        persisted.summary.hang_diagnostics_count,
        persisted.summary.crash_diagnostics_count,
        persisted.summary.cpu_exception_diagnostics_count,
        persisted.summary.disk_write_exception_diagnostics_count,
    );
    append_lines(&metric_kit_log_path(app)?, &[line])?;

    Ok(persisted)
}

#[tauri::command]
#[specta::specta]
pub fn append_frontend_logs(app: AppHandle, lines: Vec<String>) -> Result<(), String> {
    if lines.is_empty() {
        return Ok(());
    }
    append_lines(&frontend_log_path(&app)?, &lines)
}

#[tauri::command]
#[specta::specta]
pub fn get_log_paths(app: AppHandle) -> Result<LogPaths, String> {
    let log_dir = ensure_log_dir(&app)?.clone();
    Ok(LogPaths {
        log_dir: log_dir.display().to_string(),
        frontend_log: frontend_log_path(&app)?.display().to_string(),
        backend_log: backend_log_path(&app)?.display().to_string(),
    })
}

#[tauri::command]
#[specta::specta]
pub fn get_diagnostics_logs(
    app: AppHandle,
    max_lines_per_log: Option<usize>,
) -> Result<DiagnosticsLogBundle, String> {
    let requested_lines = max_lines_per_log.unwrap_or(200);
    let max_lines = requested_lines.clamp(20, 400);
    let log_paths = get_log_paths(app.clone())?;
    let frontend_path = frontend_log_path(&app)?;
    let backend_path = backend_log_path(&app)?;

    Ok(DiagnosticsLogBundle {
        log_paths,
        frontend_excerpt: tail_log(&frontend_path, max_lines),
        backend_excerpt: tail_log(&backend_path, max_lines),
        metric_kit_excerpt: tail_log(&metric_kit_log_path(&app)?, max_lines),
        metric_kit_diagnostic_files: list_metric_kit_diagnostic_files(&app, 10)?,
        max_lines_per_log: max_lines,
    })
}

#[tauri::command]
#[specta::specta]
pub fn export_perf_capture_bundle(
    app: AppHandle,
    request: PerfCaptureExportRequest,
) -> Result<PerfCaptureExportResult, String> {
    let capture_root = perf_capture_dir(&app)?;
    create_dir_all(&capture_root).map_err(|err| err.to_string())?;
    let export_dir = capture_root.join(&request.session.id);
    create_dir_all(&export_dir).map_err(|err| err.to_string())?;

    let perf_events_json =
        serde_json::to_string_pretty(&request.perf_events).map_err(|err| err.to_string())?;
    let send_flow_json =
        serde_json::to_string_pretty(&request.send_flow_report).map_err(|err| err.to_string())?;
    let findings_json = serde_json::to_string_pretty(
        request
            .send_flow_report
            .get("findings")
            .unwrap_or(&Value::Array(Vec::new())),
    )
    .map_err(|err| err.to_string())?;

    let capture_json = serde_json::to_string_pretty(&serde_json::json!({
        "session": request.session,
        "stoppedAt": request.stopped_at,
        "startedAtMs": request.started_at_ms,
        "stoppedAtMs": request.stopped_at_ms,
        "perfEventCount": request.perf_events.len(),
        "frontendLog": frontend_log_path(&app)?.display().to_string(),
        "backendLog": backend_log_path(&app)?.display().to_string(),
    }))
    .map_err(|err| err.to_string())?;

    let frontend_slice = read_log_slice(
        &frontend_log_path(&app)?,
        &request.session.started_at,
        &request.stopped_at,
        request.started_at_ms,
        request.stopped_at_ms,
        true,
    );
    let backend_slice = read_log_slice(
        &backend_log_path(&app)?,
        &request.session.started_at,
        &request.stopped_at,
        request.started_at_ms,
        request.stopped_at_ms,
        false,
    );

    let files = vec![
        ("capture.json", capture_json),
        ("perf-events.json", perf_events_json),
        ("send-flow-summary.json", send_flow_json),
        ("validator-findings.json", findings_json),
        ("frontend.log", frontend_slice),
        ("backend.log", backend_slice),
    ];

    let mut written_files = Vec::new();
    for (name, contents) in files {
        let path = export_dir.join(name);
        write(&path, contents).map_err(|err| err.to_string())?;
        written_files.push(path.display().to_string());
    }

    Ok(PerfCaptureExportResult {
        export_dir: export_dir.display().to_string(),
        files: written_files,
    })
}
