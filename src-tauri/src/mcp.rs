//! Local, authenticated bridge with global enablement and per-terminal selection.
//! This deliberately writes to the existing PTY, including a shell reached
//! inside GateShell. Opening a new SSH channel would lose that route/state.

use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use encoding_rs::Encoding;
use parking_lot::Mutex;
use ring::rand::{SecureRandom, SystemRandom};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Semaphore;

use crate::commands::AppState;
use crate::error::{err, AppError, Result};
use crate::model::SessionKind;
use crate::session::{self, SessionManager};

pub const EVENT_CHANGED: &str = "mcp:changed";
const OUTPUT_LIMIT: usize = 64 * 1024;
const HISTORY_LIMIT: usize = 32;
const REQUEST_LIMIT: u64 = 32 * 1024;

pub(crate) mod frontend;
mod policy;
use frontend::{FrontendRequest, FrontendRequestView};
use policy::{CommandBlocked, Permission};

#[derive(Default)]
pub struct McpState {
    inner: Mutex<Inner>,
    bridge: Mutex<Option<BridgeLease>>,
    startup_error: Mutex<Option<String>>,
}

#[derive(Default)]
struct Inner {
    enabled: bool,
    permission: Permission,
    revision: u64,
    labels: HashMap<String, String>,
    selections: HashMap<String, Selection>,
    shared: HashMap<String, SharedSession>,
    executions: HashMap<String, Execution>,
    order: VecDeque<String>,
    frontend_requests: HashMap<String, FrontendRequest>,
}

#[derive(Debug)]
enum ExecuteError {
    App(AppError),
    Blocked(CommandBlocked),
}
impl From<AppError> for ExecuteError {
    fn from(error: AppError) -> Self {
        Self::App(error)
    }
}
impl std::fmt::Display for ExecuteError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::App(error) => error.fmt(f),
            Self::Blocked(blocked) => blocked.fmt(f),
        }
    }
}

struct Selection {
    id: String,
    session_id: String,
    state: &'static str,
    message: Option<String>,
    created: Instant,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SelectionView {
    id: String,
    session_id: String,
    state: String,
    message: Option<String>,
}

impl Selection {
    fn view(&self) -> SelectionView {
        SelectionView {
            id: self.id.clone(),
            session_id: self.session_id.clone(),
            state: self.state.into(),
            message: self.message.clone(),
        }
    }
}

struct SharedSession {
    label: String,
    last_execution: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionView {
    id: String,
    session_id: String,
    command: String,
    state: String,
    started: bool,
    output: String,
    truncated: bool,
    exit_code: Option<i32>,
    message: Option<String>,
    elapsed_ms: u64,
    interrupt_requested: bool,
}

/// Discovery/UI metadata stays small even when many terminals have full buffers.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ExecutionSummary {
    id: String,
    session_id: String,
    command: String,
    state: String,
    started: bool,
    truncated: bool,
    exit_code: Option<i32>,
    message: Option<String>,
    elapsed_ms: u64,
    interrupt_requested: bool,
}

struct Execution {
    id: String,
    session_id: String,
    command: String,
    state: &'static str,
    capture: Capture,
    encoding: &'static Encoding,
    message: Option<String>,
    created: Instant,
    finished_ms: Option<u64>,
    interrupt_requested: bool,
}

impl Execution {
    fn summary(&self) -> ExecutionSummary {
        ExecutionSummary {
            id: self.id.clone(),
            session_id: self.session_id.clone(),
            command: self.command.clone(),
            state: self.state.into(),
            started: self.capture.started,
            truncated: self.capture.truncated,
            exit_code: self.capture.exit_code,
            message: self.message.clone(),
            elapsed_ms: self.finished_ms.unwrap_or_else(|| self.elapsed_ms()),
            interrupt_requested: self.interrupt_requested,
        }
    }

    fn view(&self) -> ExecutionView {
        ExecutionView {
            id: self.id.clone(),
            session_id: self.session_id.clone(),
            command: self.command.clone(),
            state: self.state.into(),
            started: self.capture.started,
            output: self.encoding.decode(&self.capture.output).0.into_owned(),
            truncated: self.capture.truncated,
            exit_code: self.capture.exit_code,
            message: self.message.clone(),
            elapsed_ms: self.finished_ms.unwrap_or_else(|| self.elapsed_ms()),
            interrupt_requested: self.interrupt_requested,
        }
    }

    fn elapsed_ms(&self) -> u64 {
        self.created.elapsed().as_millis().min(u64::MAX as u128) as u64
    }

    fn finish(&mut self, state: &'static str, message: Option<String>) {
        self.state = state;
        self.message = message;
        self.finished_ms = Some(self.elapsed_ms());
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SharedSessionView {
    id: String,
    label: String,
    connection_name: String,
    connection_address: String,
    kind: SessionKind,
    selected: bool,
    selecting: bool,
    execution: Option<ExecutionSummary>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UiState {
    enabled: bool,
    permission: Permission,
    revision: u64,
    selections: Vec<SelectionView>,
    bridge_file: Option<String>,
    error: Option<String>,
    sessions: Vec<SharedSessionView>,
    requests: Vec<FrontendRequestView>,
}

#[derive(Serialize, Deserialize)]
struct Descriptor {
    version: u8,
    port: u16,
    token: String,
}

struct BridgeLease {
    path: PathBuf,
    token: String,
    task: Option<tauri::async_runtime::JoinHandle<()>>,
}

impl Drop for BridgeLease {
    fn drop(&mut self) {
        if let Some(task) = self.task.take() {
            task.abort();
        }
        // An older app instance must not remove a newer instance's endpoint.
        if std::fs::read(&self.path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Descriptor>(&bytes).ok())
            .is_some_and(|descriptor| descriptor.token == self.token)
        {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

impl McpState {
    pub fn start(app: &AppHandle) {
        if let Err(error) = Self::start_bridge(app) {
            *app.state::<AppState>().mcp.startup_error.lock() = Some(error.to_string());
        }
    }

    fn start_bridge(app: &AppHandle) -> Result<()> {
        let listener = std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))?;
        listener.set_nonblocking(true)?;
        let mut secret = [0; 32];
        SystemRandom::new()
            .fill(&mut secret)
            .map_err(|_| AppError::new("could not create MCP bridge token"))?;
        let token = B64.encode(secret);
        let descriptor = Descriptor {
            version: 1,
            port: listener.local_addr()?.port(),
            token: token.clone(),
        };
        let directory = crate::store::data_dir();
        std::fs::create_dir_all(&directory)?;
        let path = directory.join("mcp-bridge.json");
        let temporary = directory.join(format!(".mcp-bridge-{}.tmp", uuid::Uuid::new_v4()));
        let result = (|| -> Result<()> {
            use std::io::Write;
            let mut options = std::fs::OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            let mut file = options.open(&temporary)?;
            file.write_all(&serde_json::to_vec(&descriptor)?)?;
            file.sync_all()?;
            std::fs::rename(&temporary, &path)?;
            Ok(())
        })();
        if result.is_err() {
            let _ = std::fs::remove_file(&temporary);
        }
        result?;
        *app.state::<AppState>().mcp.bridge.lock() = Some(BridgeLease {
            path,
            token: token.clone(),
            task: None,
        });
        let server_app = app.clone();
        let task = tauri::async_runtime::spawn(async move {
            let Ok(listener) = TcpListener::from_std(listener) else {
                return;
            };
            let slots = Arc::new(Semaphore::new(16));
            loop {
                let Ok(permit) = slots.clone().acquire_owned().await else {
                    break;
                };
                let Ok((stream, _)) = listener.accept().await else {
                    break;
                };
                let app = server_app.clone();
                let token = token.clone();
                tauri::async_runtime::spawn(async move {
                    let _permit = permit;
                    let state = app.state::<AppState>();
                    let _ = tokio::time::timeout(
                        Duration::from_secs(5),
                        serve(
                            stream,
                            &state.mcp,
                            &state.sessions,
                            &token,
                            || changed(&app),
                            |id, bytes| session::emit_output(&app, id, bytes),
                        ),
                    )
                    .await;
                });
            }
        });
        if let Some(bridge) = app.state::<AppState>().mcp.bridge.lock().as_mut() {
            bridge.task = Some(task);
        }
        Ok(())
    }

    pub fn ui_state(&self, sessions: &SessionManager) -> UiState {
        let mut inner = self.inner.lock();
        expire_selections(&mut inner);
        UiState {
            enabled: inner.enabled,
            permission: inner.permission,
            revision: inner.revision,
            selections: inner
                .selections
                .values()
                .filter(|selection| selection.state == "selecting")
                .map(Selection::view)
                .collect(),
            bridge_file: self
                .bridge
                .lock()
                .as_ref()
                .map(|bridge| bridge.path.to_string_lossy().into_owned()),
            error: self.startup_error.lock().clone(),
            sessions: list_sessions(&inner, sessions),
            requests: inner
                .frontend_requests
                .values()
                .filter(|request| request.state == "pending")
                .map(FrontendRequest::view)
                .collect(),
        }
    }

    pub fn shutdown(&self) {
        self.bridge.lock().take();
    }

    fn list(&self, sessions: &SessionManager) -> Vec<SharedSessionView> {
        let mut inner = self.inner.lock();
        expire_selections(&mut inner);
        list_sessions(&inner, sessions)
    }

    pub fn manual_input<T>(&self, id: &str, write: impl FnOnce() -> Result<T>) -> Result<T> {
        let mut inner = self.inner.lock();
        expire_selections(&mut inner);
        if inner.shared.contains_key(id)
            || inner
                .selections
                .values()
                .any(|selection| selection.session_id == id && selection.state == "selecting")
        {
            return Err(AppError::new(
                "MCP has selected this terminal. Release it or take control in Kanso before typing.",
            ));
        }
        write()
    }

    fn set_enabled(&self, enabled: bool) -> Result<Vec<(String, Vec<u8>)>> {
        if enabled && self.bridge.lock().is_none() {
            return Err(AppError::new(
                "MCP bridge is unavailable; restart Kanso and check its data directory.",
            ));
        }
        let mut inner = self.inner.lock();
        inner.enabled = enabled;
        inner.revision += 1;
        let mut visible = Vec::new();
        if !enabled {
            frontend::cancel_requests(&mut inner, None, "MCP was disabled");
            let ids: Vec<_> = inner.shared.keys().cloned().collect();
            for id in ids {
                visible.push((
                    id.clone(),
                    revoke_inner(
                        &mut inner,
                        &id,
                        "interrupted",
                        "MCP disabled in Kanso. The command may still be running.",
                    ),
                ));
            }
            for selection in inner
                .selections
                .values_mut()
                .filter(|selection| selection.state == "selecting")
            {
                selection.state = "failed";
                selection.message = Some("MCP was disabled before selection completed".into());
            }
        }
        Ok(visible)
    }

    fn set_permission(&self, permission: Permission) {
        let mut inner = self.inner.lock();
        inner.permission = permission;
        inner.revision += 1;
    }

    fn begin_selection(&self, sessions: &SessionManager, id: &str) -> Result<SelectionView> {
        if self.bridge.lock().is_none() {
            return Err(AppError::new(
                "MCP bridge is unavailable; restart Kanso and check its data directory.",
            ));
        }
        let mut inner = self.inner.lock();
        expire_selections(&mut inner);
        if !inner.enabled {
            return Err(AppError::new("MCP is disabled. Enable MCP in Kanso first."));
        }
        let info = sessions
            .list()
            .into_iter()
            .find(|info| info.id == id)
            .ok_or_else(|| AppError::new("session is not open"))?;
        if info.kind == SessionKind::Sftp || !sessions.is_live(id) {
            return Err(AppError::new("only live terminal sessions can be shared"));
        }
        if inner.shared.contains_key(id) {
            return Ok(SelectionView {
                id: String::new(),
                session_id: id.into(),
                state: "selected".into(),
                message: None,
            });
        }
        if let Some(selection) = inner
            .selections
            .values()
            .find(|selection| selection.session_id == id && selection.state == "selecting")
        {
            return Ok(selection.view());
        }
        let pending_count = inner
            .selections
            .values()
            .filter(|selection| selection.state == "selecting")
            .count();
        if inner.shared.len() + pending_count >= HISTORY_LIMIT {
            return Err(AppError::new("maximum number of shared terminals reached"));
        }
        // Completed handshake records are bounded; selected terminals live separately.
        if inner.selections.len() >= 64 {
            inner
                .selections
                .retain(|_, selection| selection.state == "selecting");
        }
        let selection = Selection {
            id: uuid::Uuid::new_v4().to_string(),
            session_id: id.into(),
            state: "selecting",
            message: None,
            created: Instant::now(),
        };
        let view = selection.view();
        inner.selections.insert(selection.id.clone(), selection);
        inner.revision += 1;
        Ok(view)
    }

    fn finish_selection(
        &self,
        sessions: &SessionManager,
        id: &str,
        error: Option<String>,
    ) -> Result<SelectionView> {
        let mut inner = self.inner.lock();
        expire_selections(&mut inner);
        let selection = inner
            .selections
            .get(id)
            .ok_or_else(|| AppError::new("selection request expired"))?;
        if selection.state != "selecting" {
            return Ok(selection.view());
        }
        let session_id = selection.session_id.clone();
        let info = sessions
            .list()
            .into_iter()
            .find(|info| info.id == session_id);
        let error = if !inner.enabled {
            Some("MCP is disabled".into())
        } else if !sessions.is_live(&session_id)
            || info
                .as_ref()
                .is_none_or(|info| info.kind == SessionKind::Sftp)
        {
            Some("terminal disconnected before selection completed".into())
        } else {
            error
        };
        let success = error.is_none();
        let selection = inner.selections.get_mut(id).unwrap();
        selection.state = if success { "selected" } else { "failed" };
        selection.message = error;
        let view = selection.view();
        if success {
            let label = inner
                .labels
                .get(&session_id)
                .cloned()
                .unwrap_or_else(|| info.unwrap().name);
            inner.shared.insert(
                session_id,
                SharedSession {
                    label,
                    last_execution: None,
                },
            );
        }
        inner.revision += 1;
        Ok(view)
    }

    fn selection_status(&self, id: &str) -> Result<SelectionView> {
        let mut inner = self.inner.lock();
        expire_selections(&mut inner);
        inner
            .selections
            .get(id)
            .map(Selection::view)
            .ok_or_else(|| AppError::new("selection request not found"))
    }

    /// Revocation is unconditional; the old terminal never grants access to a reconnect.
    pub fn revoke(&self, id: &str, state: &'static str, message: &str) -> Vec<u8> {
        let mut inner = self.inner.lock();
        revoke_inner(&mut inner, id, state, message)
    }

    fn execute(
        &self,
        sessions: &SessionManager,
        id: &str,
        command: &str,
    ) -> std::result::Result<ExecutionView, ExecuteError> {
        let execution_id = uuid::Uuid::new_v4().simple().to_string();
        command_script(&execution_id, command)?;
        let mut inner = self.inner.lock();
        if !inner.enabled {
            return Err(AppError::new("MCP is disabled. Enable MCP in Kanso first.").into());
        }
        let shared = inner.shared.get(id).ok_or_else(|| {
            AppError::new("terminal is not selected; call kanso_select_session first")
        })?;
        if shared
            .last_execution
            .as_ref()
            .and_then(|id| inner.executions.get(id))
            .is_some_and(|job| job.state == "running")
        {
            return Err(AppError::new(
                "this session has a running execution; poll it or take control in Kanso",
            )
            .into());
        }
        // Permission changes and submissions share this lock. Validate every
        // segment before creating history/capture or queuing even one byte.
        let approved =
            policy::authorize(inner.permission, command).map_err(ExecuteError::Blocked)?;
        let script = command_script(&execution_id, &approved)?;
        let encoding = sessions.live_encoding(id)?;
        // Reject unmappable input rather than silently executing a changed command.
        let (encoded, _, unmappable) = encoding.encode(&script);
        if unmappable {
            return Err(AppError::new(
                "command contains characters unsupported by this terminal's encoding",
            )
            .into());
        }
        if encoded.len() > 3500 {
            return Err(AppError::new(
                "encoded command exceeds the 3,500-byte terminal input limit",
            )
            .into());
        }
        let mut capture = Capture::new(&execution_id);
        // The terminal still uses its configured byte encoding.
        capture.header = session::encoding::encode_input(
            encoding,
            &format!("\r\n[MCP] {}\r\n", command.replace('\n', "\r\n")),
        );
        let job = Execution {
            id: execution_id.clone(),
            session_id: id.into(),
            command: command.into(),
            state: "running",
            capture,
            encoding,
            message: None,
            created: Instant::now(),
            finished_ms: None,
            interrupt_requested: false,
        };
        // The capture is registered before the write; the lock also serializes submissions.
        inner.executions.insert(execution_id.clone(), job);
        inner.shared.get_mut(id).unwrap().last_execution = Some(execution_id.clone());
        inner.order.push_back(execution_id.clone());
        if let Err(error) = sessions.write_text(id, &script) {
            inner
                .executions
                .get_mut(&execution_id)
                .unwrap()
                .finish("disconnected", Some(error.to_string()));
            inner.shared.remove(id);
            return Err(error.into());
        }
        prune(&mut inner);
        Ok(inner.executions[&execution_id].view())
    }

    fn execution(&self, id: &str) -> Result<ExecutionView> {
        self.inner.lock().executions.get(id).map(Execution::view)
            .ok_or_else(|| AppError::new("execution not found (results are kept only in this Kanso process, with bounded history)"))
    }

    fn interrupt(&self, sessions: &SessionManager, execution_id: &str) -> Result<Value> {
        let mut inner = self.inner.lock();
        if !inner.enabled {
            return Err(AppError::new("MCP is disabled"));
        }
        let job = inner
            .executions
            .get(execution_id)
            .ok_or_else(|| AppError::new("execution not found"))?;
        let session_id = job.session_id.clone();
        if job.state != "running"
            || inner
                .shared
                .get(&session_id)
                .and_then(|shared| shared.last_execution.as_deref())
                != Some(execution_id)
        {
            return Err(AppError::new(
                "execution is no longer the selected terminal's running command",
            ));
        }
        sessions.live_encoding(&session_id)?;
        if !job.interrupt_requested {
            // Validate execution identity and enqueue the signal under the same
            // lock as execute/release. Repeated requests never signal a new job.
            sessions.write_text(&session_id, "\x03")?;
            let job = inner.executions.get_mut(execution_id).unwrap();
            job.interrupt_requested = true;
            job.message = Some("Ctrl+C requested. Wait for an end marker; if the wrapper was interrupted too, inspect the terminal and release/reselect after the shell prompt returns.".into());
            inner.revision += 1;
        }
        Ok(
            json!({"sessionId":session_id,"executionId":execution_id,"state":"interrupt_requested","message":"Ctrl+C was queued once. Delivery and process exit are not confirmed; selection stays locked. Poll the execution or inspect the terminal before releasing/reselecting."}),
        )
    }

    /// Filter our framing and echoed wrapper out of the visible terminal stream.
    /// Ordinary unshared output is byte-for-byte unchanged.
    pub fn output(&self, id: &str, bytes: &[u8]) -> (Vec<u8>, bool) {
        let mut inner = self.inner.lock();
        let execution_id = inner
            .shared
            .get(id)
            .and_then(|shared| shared.last_execution.clone());
        let Some(job) = execution_id.and_then(|id| inner.executions.get_mut(&id)) else {
            return (bytes.to_vec(), false);
        };
        if job.state != "running" {
            return (bytes.to_vec(), false);
        }
        let visible = job.capture.feed(bytes);
        let completed = job.capture.exit_code.is_some();
        if completed {
            job.finish("completed", None);
        }
        (visible, completed)
    }
}

fn expire_selections(inner: &mut Inner) {
    frontend::expire_requests(inner);
    for selection in inner.selections.values_mut() {
        if selection.state == "selecting" && selection.created.elapsed() > Duration::from_secs(3) {
            selection.state = "failed";
            selection.message = Some(
                "Kanso did not confirm the terminal within 3 seconds; no terminal was selected"
                    .into(),
            );
            inner.revision += 1;
        }
    }
}

fn revoke_inner(inner: &mut Inner, id: &str, state: &'static str, message: &str) -> Vec<u8> {
    frontend::cancel_requests(inner, Some(id), message);
    inner.revision += 1;
    for selection in inner
        .selections
        .values_mut()
        .filter(|selection| selection.session_id == id)
    {
        selection.state = "failed";
        selection.message = Some(message.into());
    }
    let mut visible = Vec::new();
    if let Some(shared) = inner.shared.remove(id) {
        if let Some(execution) = shared
            .last_execution
            .and_then(|id| inner.executions.get_mut(&id))
        {
            if execution.state == "running" {
                visible = std::mem::take(&mut execution.capture.pending);
                execution.finish(state, Some(message.into()));
            }
        }
    }
    visible
}

fn list_sessions(inner: &Inner, sessions: &SessionManager) -> Vec<SharedSessionView> {
    if !inner.enabled {
        return Vec::new();
    }
    let mut result: Vec<_> = sessions
        .list()
        .into_iter()
        .filter(|info| info.kind != SessionKind::Sftp && sessions.is_live(&info.id))
        .map(|info| {
            let shared = inner.shared.get(&info.id);
            SharedSessionView {
                execution: shared
                    .and_then(|shared| shared.last_execution.as_ref())
                    .and_then(|id| inner.executions.get(id))
                    .map(Execution::summary),
                label: inner
                    .labels
                    .get(&info.id)
                    .cloned()
                    .or_else(|| shared.map(|shared| shared.label.clone()))
                    .unwrap_or_else(|| info.name.clone()),
                selected: shared.is_some(),
                selecting: inner.selections.values().any(|selection| {
                    selection.session_id == info.id && selection.state == "selecting"
                }),
                id: info.id,
                connection_name: info.name,
                connection_address: info.address,
                kind: info.kind,
            }
        })
        .collect();
    result.sort_by(|left, right| left.id.cmp(&right.id));
    result
}

fn prune(inner: &mut Inner) {
    while inner.executions.len() > HISTORY_LIMIT {
        let removable = inner.order.iter().position(|id| {
            inner
                .executions
                .get(id)
                .is_some_and(|job| job.state != "running")
                && !inner
                    .shared
                    .values()
                    .any(|shared| shared.last_execution.as_ref() == Some(id))
        });
        let Some(index) = removable else { break };
        if let Some(id) = inner.order.remove(index) {
            inner.executions.remove(&id);
        }
    }
}

/// Single physical line, including for multiline commands. Backslashes are
/// escaped before printf %b, so user shell syntax is passed to eval unchanged.
fn command_script(id: &str, command: &str) -> Result<String> {
    if command.trim().is_empty()
        || command
            .chars()
            .any(|c| c.is_control() && c != '\n' && c != '\t')
    {
        return Err(AppError::new(
            "provide a nonempty POSIX command without terminal control characters",
        ));
    }
    let escaped = command
        .replace('\\', "\\\\")
        .replace('\n', "\\n")
        .replace('\t', "\\t")
        .replace('\'', "'\\''");
    let script = format!(
        "printf '\\036KANSO_MCP_{id}:BEGIN\\037'; if eval \"$(printf '%b' '{escaped}')\"; then __kanso_mcp_status=0; else __kanso_mcp_status=$?; fi; printf '\\036KANSO_MCP_{id}:END:%s\\037' \"$__kanso_mcp_status\"; unset __kanso_mcp_status\r"
    );
    if script.len() > 3500 {
        return Err(AppError::new(
            "command is too long (maximum quoted terminal input is 3,500 bytes)",
        ));
    }
    Ok(script)
}

struct Capture {
    header: Vec<u8>,
    begin: Vec<u8>,
    end: Vec<u8>,
    pending: Vec<u8>,
    output: Vec<u8>,
    started: bool,
    truncated: bool,
    exit_code: Option<i32>,
}

impl Capture {
    fn new(id: &str) -> Self {
        Self {
            begin: format!("\x1eKANSO_MCP_{id}:BEGIN\x1f").into_bytes(),
            end: format!("\x1eKANSO_MCP_{id}:END:").into_bytes(),
            header: Vec::new(),
            pending: Vec::new(),
            output: Vec::new(),
            started: false,
            truncated: false,
            exit_code: None,
        }
    }

    fn record(&mut self, bytes: &[u8]) {
        let count = bytes
            .len()
            .min(OUTPUT_LIMIT.saturating_sub(self.output.len()));
        self.output.extend_from_slice(&bytes[..count]);
        self.truncated |= count != bytes.len();
    }

    fn feed(&mut self, bytes: &[u8]) -> Vec<u8> {
        if self.exit_code.is_some() {
            return bytes.to_vec();
        }
        self.pending.extend_from_slice(bytes);
        let mut visible = Vec::new();
        if !self.started {
            if let Some(index) = find(&self.pending, &self.begin) {
                self.pending.drain(..index + self.begin.len());
                self.started = true;
                visible.append(&mut self.header);
            } else {
                // A wrong target/prompt must not hide an unbounded stream.
                if self.pending.len() > 16 * 1024 {
                    let length = self.pending.len() - self.begin.len();
                    visible.extend(self.pending.drain(..length));
                }
                return visible;
            }
        }
        loop {
            if let Some(index) = find(&self.pending, &self.end) {
                let suffix = &self.pending[index + self.end.len()..];
                if let Some(length) = suffix.iter().position(|&byte| byte == 0x1f) {
                    let code = std::str::from_utf8(&suffix[..length])
                        .ok()
                        .and_then(|value| value.parse::<u8>().ok());
                    if let Some(code) = code {
                        let output: Vec<_> = self.pending.drain(..index).collect();
                        self.record(&output);
                        visible.extend(output);
                        self.pending.drain(..self.end.len() + length + 1);
                        visible.append(&mut self.pending);
                        self.exit_code = Some(i32::from(code));
                        return visible;
                    }
                } else if suffix.len() <= 3 {
                    let output: Vec<_> = self.pending.drain(..index).collect();
                    self.record(&output);
                    visible.extend(output);
                    return visible;
                }
                // A lookalike/invalid marker is ordinary output, not completion.
                let output: Vec<_> = self.pending.drain(..index + 1).collect();
                self.record(&output);
                visible.extend(output);
                continue;
            }
            let keep = (1..self.end.len().min(self.pending.len() + 1))
                .rev()
                .find(|&length| self.pending.ends_with(&self.end[..length]))
                .unwrap_or(0);
            let length = self.pending.len() - keep;
            let output: Vec<_> = self.pending.drain(..length).collect();
            self.record(&output);
            visible.extend(output);
            return visible;
        }
    }
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    token: String,
    method: String,
    #[serde(default)]
    params: Value,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ExecuteParams {
    session_id: String,
    command: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StatusParams {
    execution_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SessionParams {
    session_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SelectionParams {
    selection_id: String,
}

async fn serve(
    stream: TcpStream,
    mcp: &McpState,
    sessions: &SessionManager,
    token: &str,
    on_change: impl FnOnce(),
    on_output: impl FnOnce(&str, &[u8]),
) -> Result<()> {
    use tokio::io::AsyncReadExt;
    let (read, mut write) = stream.into_split();
    let mut line = Vec::new();
    BufReader::new(read)
        .take(REQUEST_LIMIT + 1)
        .read_until(b'\n', &mut line)
        .await?;
    let result = if line.len() as u64 > REQUEST_LIMIT || line.last() != Some(&b'\n') {
        Err(AppError::new("invalid or oversized bridge request"))
    } else {
        let result = dispatch_with_output(mcp, sessions, token, &line, on_output);
        if result.as_ref().is_ok_and(|(_, changed)| *changed) {
            on_change();
        }
        result.map(|(value, _)| value)
    };
    let response = match result {
        Ok(value) => json!({ "result": value }),
        Err(error) => json!({ "error": error.to_string() }),
    };
    write.write_all(&serde_json::to_vec(&response)?).await?;
    write.write_all(b"\n").await?;
    Ok(())
}

fn dispatch_with_output(
    mcp: &McpState,
    sessions: &SessionManager,
    token: &str,
    line: &[u8],
    on_output: impl FnOnce(&str, &[u8]),
) -> Result<(Value, bool)> {
    let request: Request =
        serde_json::from_slice(line).map_err(|_| AppError::new("invalid bridge request"))?;
    if request.token != token {
        return Err(AppError::new("bridge authentication failed"));
    }
    match request.method.as_str() {
        "list_sessions" => Ok((
            json!({ "sessions": mcp.list(sessions), "permission": mcp.inner.lock().permission }),
            false,
        )),
        "read_terminal" | "get_session_status" | "show_terminal" => {
            let params: frontend::FrontendParams =
                serde_json::from_value(request.params).map_err(err)?;
            Ok((
                serde_json::to_value(mcp.begin_frontend_request(
                    sessions,
                    &request.method,
                    params,
                )?)?,
                true,
            ))
        }
        "frontend_request_status" => {
            let params: frontend::RequestStatusParams =
                serde_json::from_value(request.params).map_err(err)?;
            Ok((
                serde_json::to_value(mcp.frontend_request_status(&params.request_id)?)?,
                false,
            ))
        }
        "interrupt_execution" => {
            let params: StatusParams = serde_json::from_value(request.params).map_err(err)?;
            Ok((mcp.interrupt(sessions, &params.execution_id)?, true))
        }
        "select_session" => {
            let params: SessionParams = serde_json::from_value(request.params).map_err(err)?;
            Ok((
                serde_json::to_value(mcp.begin_selection(sessions, &params.session_id)?)?,
                true,
            ))
        }
        "selection_status" => {
            let params: SelectionParams = serde_json::from_value(request.params).map_err(err)?;
            // A timed out selection must also unlock any frontend reservation.
            Ok((
                serde_json::to_value(mcp.selection_status(&params.selection_id)?)?,
                true,
            ))
        }
        "release_session" => {
            let params: SessionParams = serde_json::from_value(request.params).map_err(err)?;
            let visible = mcp.revoke(
                &params.session_id,
                "interrupted",
                "MCP released this terminal. The command may still be running.",
            );
            on_output(&params.session_id, &visible);
            Ok((
                json!({ "sessionId": params.session_id, "state": "released" }),
                true,
            ))
        }
        "execute" => {
            let params: ExecuteParams = serde_json::from_value(request.params).map_err(err)?;
            match mcp.execute(sessions, &params.session_id, &params.command) {
                Ok(job) => Ok((serde_json::to_value(job)?, true)),
                Err(ExecuteError::Blocked(blocked)) => Ok((serde_json::to_value(blocked)?, false)),
                Err(ExecuteError::App(error)) => Err(error),
            }
        }
        "execution_status" => {
            let params: StatusParams = serde_json::from_value(request.params).map_err(err)?;
            Ok((
                serde_json::to_value(mcp.execution(&params.execution_id)?)?,
                false,
            ))
        }
        _ => Err(AppError::new("unknown bridge method")),
    }
}

pub fn changed(app: &AppHandle) {
    let _ = app.emit(EVENT_CHANGED, ());
}

#[tauri::command]
pub fn mcp_ui_state(state: State<'_, AppState>) -> UiState {
    state.mcp.ui_state(&state.sessions)
}

#[tauri::command]
pub fn mcp_executable_path() -> Option<String> {
    std::env::current_exe().ok()?.to_str().map(str::to_owned)
}

#[tauri::command]
pub fn mcp_set_permission(app: AppHandle, state: State<'_, AppState>, permission: Permission) {
    state.mcp.set_permission(permission);
    changed(&app);
}

#[tauri::command]
pub fn mcp_set_enabled(app: AppHandle, state: State<'_, AppState>, enabled: bool) -> Result<()> {
    let visible = state.mcp.set_enabled(enabled)?;
    for (id, bytes) in visible {
        session::emit_output(&app, &id, &bytes);
    }
    changed(&app);
    Ok(())
}

#[tauri::command]
pub fn mcp_release_session(app: AppHandle, state: State<'_, AppState>, id: String) -> Result<()> {
    let visible = state.mcp.revoke(
        &id,
        "interrupted",
        "User took control in Kanso. The remote command may still be running.",
    );
    session::emit_output(&app, &id, &visible);
    changed(&app);
    Ok(())
}

#[tauri::command]
pub fn mcp_finish_selection(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    error: Option<String>,
) -> Result<SelectionView> {
    let result = state.mcp.finish_selection(
        &state.sessions,
        &id,
        error.map(|message| message.chars().take(500).collect()),
    );
    changed(&app);
    result
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalLabel {
    id: String,
    name: String,
}

#[tauri::command]
pub fn mcp_sync_labels(app: AppHandle, state: State<'_, AppState>, labels: Vec<TerminalLabel>) {
    let mut inner = state.mcp.inner.lock();
    let live = state.sessions.list();
    inner.labels = labels
        .into_iter()
        .take(512)
        .filter(|label| {
            live.iter().any(|info| info.id == label.id) && !label.name.trim().is_empty()
        })
        .map(|label| {
            (
                label.id,
                label
                    .name
                    .chars()
                    .filter(|c| !c.is_control())
                    .take(200)
                    .collect(),
            )
        })
        .collect();
    inner.revision += 1;
    drop(inner);
    changed(&app);
}

#[cfg(test)]
mod tests;
