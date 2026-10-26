use crate::git_workspace::{
    cleanup_terminal_worktree, prepare_terminal_worktree, resolve_terminal_worktree_identity,
    TerminalWorktreeCleanup, TerminalWorktreeInfo,
};
use base64::Engine;
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::{HashMap, HashSet, VecDeque};
use std::io::{Read, Write};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tauri::ipc::Channel;
use tauri::State;
use uuid::Uuid;

const MAX_UNACKNOWLEDGED_OUTPUT_BYTES: usize = 256 * 1024;
const OUTPUT_CHUNK_BYTES: usize = 16 * 1024;
const MAX_INPUT_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSessionInfo {
    pub session_id: String,
    pub repo_path: String,
    pub commit_sha: String,
    pub worktree_path: String,
    pub process_id: Option<u32>,
    pub reused_worktree: bool,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum TerminalEvent {
    Output {
        sequence: u64,
        data_base64: String,
        byte_length: u32,
    },
    Exit {
        exit_code: Option<u32>,
        signal: Option<String>,
        worktree_disposition: String,
        cleanup_message: Option<String>,
    },
}

#[derive(Debug)]
struct OutputWindowState {
    closed: bool,
    next_sequence: u64,
    unacknowledged_bytes: usize,
    chunks: VecDeque<(u64, usize)>,
}

#[derive(Debug)]
struct OutputWindow {
    state: Mutex<OutputWindowState>,
    changed: Condvar,
}

impl OutputWindow {
    fn new() -> Self {
        Self {
            state: Mutex::new(OutputWindowState {
                closed: false,
                next_sequence: 1,
                unacknowledged_bytes: 0,
                chunks: VecDeque::new(),
            }),
            changed: Condvar::new(),
        }
    }

    fn reserve(&self, byte_length: usize) -> Option<u64> {
        let mut state = self.state.lock().ok()?;
        while !state.closed
            && !state.chunks.is_empty()
            && state.unacknowledged_bytes.saturating_add(byte_length)
                > MAX_UNACKNOWLEDGED_OUTPUT_BYTES
        {
            state = self.changed.wait(state).ok()?;
        }
        if state.closed {
            return None;
        }

        let sequence = state.next_sequence;
        state.next_sequence = state.next_sequence.saturating_add(1);
        state.unacknowledged_bytes = state.unacknowledged_bytes.saturating_add(byte_length);
        state.chunks.push_back((sequence, byte_length));
        Some(sequence)
    }

    fn acknowledge(&self, sequence: u64) {
        let Ok(mut state) = self.state.lock() else {
            return;
        };
        while state
            .chunks
            .front()
            .is_some_and(|(chunk_sequence, _)| *chunk_sequence <= sequence)
        {
            if let Some((_, byte_length)) = state.chunks.pop_front() {
                state.unacknowledged_bytes = state.unacknowledged_bytes.saturating_sub(byte_length);
            }
        }
        self.changed.notify_all();
    }

    fn close(&self) {
        if let Ok(mut state) = self.state.lock() {
            state.closed = true;
            self.changed.notify_all();
        }
    }
}

struct TerminalSession {
    workspace_key: String,
    writer: Mutex<Box<dyn Write + Send>>,
    master: Mutex<Box<dyn MasterPty + Send>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    process_group_id: Option<i32>,
    output_window: Arc<OutputWindow>,
    events: Channel<TerminalEvent>,
    close_requested: AtomicBool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum WorkspaceStatus {
    Creating,
    Ready,
    Removing,
}

struct TerminalWorkspace {
    status: WorkspaceStatus,
    info: Option<TerminalWorktreeInfo>,
    reservations: usize,
    session_ids: HashSet<String>,
}

#[derive(Default)]
struct TerminalRegistry {
    workspaces: HashMap<String, TerminalWorkspace>,
    sessions: HashMap<String, Arc<TerminalSession>>,
}

struct TerminalManagerInner {
    registry: Mutex<TerminalRegistry>,
    changed: Condvar,
}

pub struct TerminalState {
    inner: Arc<TerminalManagerInner>,
}

impl TerminalState {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(TerminalManagerInner {
                registry: Mutex::new(TerminalRegistry::default()),
                changed: Condvar::new(),
            }),
        }
    }
}

impl Drop for TerminalState {
    fn drop(&mut self) {
        let sessions = self
            .inner
            .registry
            .lock()
            .map(|registry| {
                registry
                    .sessions
                    .iter()
                    .map(|(id, session)| (id.clone(), session.clone()))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        for (session_id, session) in sessions {
            if self.inner.request_close(&session_id).is_err() {
                session.output_window.close();
                if let Ok(mut killer) = session.killer.lock() {
                    let _ = killer.kill();
                }
            }
        }

        // Give PTY waiters time to observe process exit and run the same safe
        // last-attachment cleanup used by an explicit tab close.
        let deadline = Instant::now() + Duration::from_secs(3);
        if let Ok(mut registry) = self.inner.registry.lock() {
            loop {
                let lifecycle_active = !registry.sessions.is_empty()
                    || registry.workspaces.values().any(|workspace| {
                        workspace.reservations > 0
                            || matches!(
                                workspace.status,
                                WorkspaceStatus::Creating | WorkspaceStatus::Removing
                            )
                    });
                let remaining = deadline.saturating_duration_since(Instant::now());
                if !lifecycle_active || remaining.is_zero() {
                    break;
                }
                match self.inner.changed.wait_timeout(registry, remaining) {
                    Ok((next_registry, _)) => registry = next_registry,
                    Err(_) => break,
                }
            }
        }
    }
}

#[derive(Clone)]
struct WorkspaceReservation {
    key: String,
    info: TerminalWorktreeInfo,
}

struct CleanupRequest {
    key: String,
    info: TerminalWorktreeInfo,
}

#[derive(Debug)]
struct CleanupReport {
    disposition: String,
    message: Option<String>,
}

impl CleanupReport {
    fn shared() -> Self {
        Self {
            disposition: "shared".to_string(),
            message: None,
        }
    }
}

fn workspace_key(repo_path: &str, commit_sha: &str) -> String {
    format!("{}\0{}", repo_path, commit_sha)
}

impl TerminalManagerInner {
    fn reserve_workspace(
        self: &Arc<Self>,
        repo_path: &str,
        requested_commit: &str,
    ) -> Result<WorkspaceReservation, String> {
        let (repo_path, commit_sha) =
            resolve_terminal_worktree_identity(repo_path, requested_commit)?;
        let key = workspace_key(&repo_path, &commit_sha);

        loop {
            let mut registry = self.registry.lock().map_err(|error| error.to_string())?;
            match registry.workspaces.get_mut(&key) {
                Some(workspace) if workspace.status == WorkspaceStatus::Ready => {
                    let info = workspace.info.as_ref().ok_or_else(|| {
                        "Ready terminal workspace is missing its path.".to_string()
                    })?;
                    if !Path::new(&info.worktree_path).exists() {
                        if workspace.session_ids.is_empty() && workspace.reservations == 0 {
                            workspace.status = WorkspaceStatus::Creating;
                            workspace.info = None;
                            workspace.reservations = 1;
                            drop(registry);
                            return self.finish_workspace_creation(key, repo_path, commit_sha);
                        }
                        return Err(
                            "Terminal worktree disappeared while a shell was attached.".to_string()
                        );
                    }
                    workspace.reservations = workspace.reservations.saturating_add(1);
                    return Ok(WorkspaceReservation {
                        key,
                        info: info.clone(),
                    });
                }
                Some(_) => {
                    registry = self
                        .changed
                        .wait(registry)
                        .map_err(|error| error.to_string())?;
                    drop(registry);
                }
                None => {
                    registry.workspaces.insert(
                        key.clone(),
                        TerminalWorkspace {
                            status: WorkspaceStatus::Creating,
                            info: None,
                            reservations: 1,
                            session_ids: HashSet::new(),
                        },
                    );
                    drop(registry);
                    return self.finish_workspace_creation(key, repo_path, commit_sha);
                }
            }
        }
    }

    fn finish_workspace_creation(
        self: &Arc<Self>,
        key: String,
        repo_path: String,
        commit_sha: String,
    ) -> Result<WorkspaceReservation, String> {
        let created = prepare_terminal_worktree(&repo_path, &commit_sha);
        let mut registry = self.registry.lock().map_err(|error| error.to_string())?;
        match created {
            Ok(info) => {
                let workspace = registry
                    .workspaces
                    .get_mut(&key)
                    .ok_or_else(|| "Terminal workspace reservation disappeared.".to_string())?;
                workspace.status = WorkspaceStatus::Ready;
                workspace.info = Some(info.clone());
                self.changed.notify_all();
                Ok(WorkspaceReservation { key, info })
            }
            Err(error) => {
                registry.workspaces.remove(&key);
                self.changed.notify_all();
                Err(error)
            }
        }
    }

    fn attach_session(
        &self,
        reservation: &WorkspaceReservation,
        session_id: &str,
        session: Arc<TerminalSession>,
    ) -> Result<(), String> {
        let mut registry = self.registry.lock().map_err(|error| error.to_string())?;
        let workspace = registry
            .workspaces
            .get_mut(&reservation.key)
            .ok_or_else(|| "Terminal workspace reservation disappeared.".to_string())?;
        if workspace.status != WorkspaceStatus::Ready || workspace.reservations == 0 {
            return Err("Terminal workspace was not ready for attachment.".to_string());
        }
        workspace.reservations -= 1;
        workspace.session_ids.insert(session_id.to_string());
        registry.sessions.insert(session_id.to_string(), session);
        Ok(())
    }

    fn release_reservation(self: &Arc<Self>, reservation: &WorkspaceReservation) {
        let cleanup = {
            let Ok(mut registry) = self.registry.lock() else {
                return;
            };
            let Some(workspace) = registry.workspaces.get_mut(&reservation.key) else {
                return;
            };
            workspace.reservations = workspace.reservations.saturating_sub(1);
            cleanup_request_if_unused(&reservation.key, workspace)
        };
        if let Some(cleanup) = cleanup {
            let _ = self.perform_cleanup(cleanup);
        }
    }

    fn session(&self, session_id: &str) -> Result<Arc<TerminalSession>, String> {
        self.registry
            .lock()
            .map_err(|error| error.to_string())?
            .sessions
            .get(session_id)
            .cloned()
            .ok_or_else(|| format!("Terminal session is no longer active: {session_id}"))
    }

    fn finish_session(
        self: &Arc<Self>,
        session_id: &str,
        exit_code: Option<u32>,
        signal: Option<String>,
    ) {
        let (session, cleanup) = {
            let Ok(mut registry) = self.registry.lock() else {
                return;
            };
            let Some(session) = registry.sessions.remove(session_id) else {
                return;
            };
            let cleanup = registry
                .workspaces
                .get_mut(&session.workspace_key)
                .and_then(|workspace| {
                    workspace.session_ids.remove(session_id);
                    cleanup_request_if_unused(&session.workspace_key, workspace)
                });
            (session, cleanup)
        };

        session.output_window.close();
        let report = cleanup
            .map(|request| self.perform_cleanup(request))
            .unwrap_or_else(CleanupReport::shared);
        let _ = session.events.send(TerminalEvent::Exit {
            exit_code,
            signal,
            worktree_disposition: report.disposition,
            cleanup_message: report.message,
        });
    }

    fn perform_cleanup(self: &Arc<Self>, request: CleanupRequest) -> CleanupReport {
        let result = cleanup_terminal_worktree(
            &request.info.repo_path,
            &request.info.commit_sha,
            &request.info.worktree_path,
        );

        let report = match &result {
            Ok(TerminalWorktreeCleanup::Removed) => CleanupReport {
                disposition: "removed".to_string(),
                message: None,
            },
            Ok(TerminalWorktreeCleanup::RetainedDirty { changed_files }) => CleanupReport {
                disposition: "retainedDirty".to_string(),
                message: Some(format!(
                    "Terminal worktree was kept because it has uncommitted changes: {}",
                    changed_files.join(", ")
                )),
            },
            Err(error) => CleanupReport {
                disposition: "retainedError".to_string(),
                message: Some(format!("Terminal worktree could not be removed: {error}")),
            },
        };

        if let Ok(mut registry) = self.registry.lock() {
            match result {
                Ok(TerminalWorktreeCleanup::Removed) => {
                    registry.workspaces.remove(&request.key);
                }
                Ok(TerminalWorktreeCleanup::RetainedDirty { .. }) | Err(_) => {
                    if let Some(workspace) = registry.workspaces.get_mut(&request.key) {
                        workspace.status = WorkspaceStatus::Ready;
                        workspace.info = Some(request.info);
                    }
                }
            }
            self.changed.notify_all();
        }

        report
    }

    fn request_close(self: &Arc<Self>, session_id: &str) -> Result<(), String> {
        let session = self.session(session_id)?;
        if session.close_requested.swap(true, Ordering::AcqRel) {
            return Ok(());
        }

        let mut delivered = false;
        #[cfg(unix)]
        if let Some(process_group_id) = session.process_group_id {
            // Negative PID addresses the PTY process group, including foreground children.
            delivered = unsafe { libc::kill(-process_group_id, libc::SIGHUP) } == 0;
        }

        let killer_result = session
            .killer
            .lock()
            .map_err(|error| error.to_string())?
            .kill();
        if killer_result.is_ok() {
            delivered = true;
        }
        if !delivered {
            session.close_requested.store(false, Ordering::Release);
            return Err(killer_result
                .err()
                .map(|error| error.to_string())
                .unwrap_or_else(|| "Failed to signal terminal process.".to_string()));
        }

        session.output_window.close();
        #[cfg(unix)]
        if let Some(process_group_id) = session.process_group_id {
            let manager = self.clone();
            let session_id = session_id.to_string();
            thread::spawn(move || {
                thread::sleep(Duration::from_millis(750));
                let still_running = manager
                    .registry
                    .lock()
                    .map(|registry| registry.sessions.contains_key(&session_id))
                    .unwrap_or(false);
                if still_running {
                    unsafe {
                        libc::kill(-process_group_id, libc::SIGKILL);
                    }
                }
            });
        }
        Ok(())
    }
}

fn cleanup_request_if_unused(
    key: &str,
    workspace: &mut TerminalWorkspace,
) -> Option<CleanupRequest> {
    if workspace.status != WorkspaceStatus::Ready
        || workspace.reservations > 0
        || !workspace.session_ids.is_empty()
    {
        return None;
    }
    let info = workspace.info.clone()?;
    workspace.status = WorkspaceStatus::Removing;
    Some(CleanupRequest {
        key: key.to_string(),
        info,
    })
}

fn normalized_pty_size(cols: u16, rows: u16) -> PtySize {
    PtySize {
        rows: rows.clamp(2, 500),
        cols: cols.clamp(2, 500),
        pixel_width: 0,
        pixel_height: 0,
    }
}

fn spawn_terminal_session(
    manager: Arc<TerminalManagerInner>,
    repo_path: String,
    commit_sha: String,
    cols: u16,
    rows: u16,
    events: Channel<TerminalEvent>,
) -> Result<TerminalSessionInfo, String> {
    let reservation = manager.reserve_workspace(&repo_path, &commit_sha)?;
    let spawn_result = (|| {
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(normalized_pty_size(cols, rows))
            .map_err(|error| format!("Failed to open terminal PTY: {error}"))?;
        let reader = pair
            .master
            .try_clone_reader()
            .map_err(|error| format!("Failed to read terminal output: {error}"))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|error| format!("Failed to open terminal input: {error}"))?;
        let mut command = CommandBuilder::new_default_prog();
        command.cwd(&reservation.info.worktree_path);
        command.env("TERM", "xterm-256color");
        command.env("COLORTERM", "truecolor");
        command.env("TERM_PROGRAM", "Agentree");

        let mut child = pair
            .slave
            .spawn_command(command)
            .map_err(|error| format!("Failed to start the terminal shell: {error}"))?;
        drop(pair.slave);
        let process_id = child.process_id();
        #[cfg(unix)]
        let process_group_id = pair.master.process_group_leader();
        #[cfg(not(unix))]
        let process_group_id = None;
        let killer = child.clone_killer();
        let session_id = Uuid::new_v4().to_string();
        let output_window = Arc::new(OutputWindow::new());
        let session = Arc::new(TerminalSession {
            workspace_key: reservation.key.clone(),
            writer: Mutex::new(writer),
            master: Mutex::new(pair.master),
            killer: Mutex::new(killer),
            process_group_id,
            output_window: output_window.clone(),
            events: events.clone(),
            close_requested: AtomicBool::new(false),
        });
        if let Err(error) = manager.attach_session(&reservation, &session_id, session.clone()) {
            output_window.close();
            #[cfg(unix)]
            if let Some(process_group_id) = process_group_id {
                unsafe {
                    libc::kill(-process_group_id, libc::SIGKILL);
                }
            }
            if let Ok(mut killer) = session.killer.lock() {
                let _ = killer.kill();
            }
            let _ = child.wait();
            return Err(error);
        }

        let reader_manager = manager.clone();
        let reader_session_id = session_id.clone();
        let reader_thread = thread::spawn(move || {
            stream_terminal_output(
                reader,
                output_window,
                events,
                reader_manager,
                reader_session_id,
            );
        });

        let waiter_manager = manager.clone();
        let waiter_session_id = session_id.clone();
        thread::spawn(move || {
            let exit = child.wait();
            // Drain the PTY before publishing exit so the final prompt or command
            // output cannot arrive after the renderer sees the session as closed.
            let _ = reader_thread.join();
            match exit {
                Ok(status) => waiter_manager.finish_session(
                    &waiter_session_id,
                    Some(status.exit_code()),
                    status.signal().map(str::to_string),
                ),
                Err(error) => waiter_manager.finish_session(
                    &waiter_session_id,
                    None,
                    Some(format!("wait failed: {error}")),
                ),
            }
        });

        Ok(TerminalSessionInfo {
            session_id,
            repo_path: reservation.info.repo_path.clone(),
            commit_sha: reservation.info.commit_sha.clone(),
            worktree_path: reservation.info.worktree_path.clone(),
            process_id,
            reused_worktree: reservation.info.reused,
        })
    })();

    if spawn_result.is_err() {
        manager.release_reservation(&reservation);
    }
    spawn_result
}

fn stream_terminal_output(
    mut reader: Box<dyn Read + Send>,
    output_window: Arc<OutputWindow>,
    events: Channel<TerminalEvent>,
    manager: Arc<TerminalManagerInner>,
    session_id: String,
) {
    let mut buffer = vec![0u8; OUTPUT_CHUNK_BYTES];
    loop {
        let byte_length = match reader.read(&mut buffer) {
            Ok(0) => break,
            Ok(byte_length) => byte_length,
            Err(_) => break,
        };
        let Some(sequence) = output_window.reserve(byte_length) else {
            break;
        };
        let event = TerminalEvent::Output {
            sequence,
            data_base64: base64::engine::general_purpose::STANDARD.encode(&buffer[..byte_length]),
            byte_length: byte_length as u32,
        };
        if events.send(event).is_err() {
            output_window.close();
            let _ = manager.request_close(&session_id);
            break;
        }
    }
}

#[tauri::command]
#[specta::specta]
pub async fn create_terminal_session(
    state: State<'_, TerminalState>,
    repo_path: String,
    commit_sha: String,
    cols: u16,
    rows: u16,
    on_event: Channel<TerminalEvent>,
) -> Result<TerminalSessionInfo, String> {
    let manager = state.inner.clone();
    tauri::async_runtime::spawn_blocking(move || {
        spawn_terminal_session(manager, repo_path, commit_sha, cols, rows, on_event)
    })
    .await
    .map_err(|error| format!("Terminal creation task failed: {error}"))?
}

#[tauri::command]
#[specta::specta]
pub async fn write_terminal_session(
    state: State<'_, TerminalState>,
    session_id: String,
    data_base64: String,
) -> Result<(), String> {
    let data = base64::engine::general_purpose::STANDARD
        .decode(data_base64)
        .map_err(|error| format!("Invalid terminal input encoding: {error}"))?;
    if data.len() > MAX_INPUT_BYTES {
        return Err(format!(
            "Terminal input exceeds the {MAX_INPUT_BYTES}-byte command limit."
        ));
    }
    let session = state.inner.session(&session_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut writer = session.writer.lock().map_err(|error| error.to_string())?;
        writer
            .write_all(&data)
            .and_then(|_| writer.flush())
            .map_err(|error| format!("Failed to write terminal input: {error}"))
    })
    .await
    .map_err(|error| format!("Terminal input task failed: {error}"))?
}

#[tauri::command]
#[specta::specta]
pub async fn resize_terminal_session(
    state: State<'_, TerminalState>,
    session_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let session = state.inner.session(&session_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        session
            .master
            .lock()
            .map_err(|error| error.to_string())?
            .resize(normalized_pty_size(cols, rows))
            .map_err(|error| format!("Failed to resize terminal: {error}"))
    })
    .await
    .map_err(|error| format!("Terminal resize task failed: {error}"))?
}

#[tauri::command]
#[specta::specta]
pub fn acknowledge_terminal_output(
    state: State<'_, TerminalState>,
    session_id: String,
    sequence: u64,
) -> Result<(), String> {
    let session = match state.inner.session(&session_id) {
        Ok(session) => session,
        Err(_) => return Ok(()),
    };
    session.output_window.acknowledge(sequence);
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn close_terminal_session(
    state: State<'_, TerminalState>,
    session_id: String,
) -> Result<(), String> {
    state.inner.request_close(&session_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn output_window_releases_acknowledged_chunks() {
        let window = OutputWindow::new();
        let first = window.reserve(10).expect("first sequence");
        let second = window.reserve(20).expect("second sequence");
        assert_eq!((first, second), (1, 2));
        window.acknowledge(first);

        let state = window.state.lock().expect("output window");
        assert_eq!(state.unacknowledged_bytes, 20);
        assert_eq!(state.chunks.front(), Some(&(2, 20)));
    }

    #[test]
    fn last_attachment_is_the_only_cleanup_trigger() {
        let info = TerminalWorktreeInfo {
            repo_path: "/repo".to_string(),
            commit_sha: "abc".to_string(),
            worktree_path: "/managed/abc".to_string(),
            reused: false,
        };
        let mut workspace = TerminalWorkspace {
            status: WorkspaceStatus::Ready,
            info: Some(info),
            reservations: 0,
            session_ids: HashSet::from(["one".to_string(), "two".to_string()]),
        };

        workspace.session_ids.remove("one");
        assert!(cleanup_request_if_unused("key", &mut workspace).is_none());
        workspace.session_ids.remove("two");
        assert!(cleanup_request_if_unused("key", &mut workspace).is_some());
        assert_eq!(workspace.status, WorkspaceStatus::Removing);
    }

    #[test]
    fn pty_size_is_bounded() {
        assert_eq!(normalized_pty_size(0, 1).cols, 2);
        assert_eq!(normalized_pty_size(900, 800).rows, 500);
    }
}
