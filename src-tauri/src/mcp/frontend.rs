//! Bounded frontend requests for xterm inspection and tab activation. Results
//! never outlive disable/disconnect/reconnect, even with a delayed UI response.
use super::*;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct FrontendParams {
    session_id: String,
    max_lines: Option<u32>,
    cursor: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct RequestStatusParams {
    pub request_id: String,
}

pub(super) struct FrontendRequest {
    id: String,
    session_id: String,
    method: String,
    params: Value,
    pub state: &'static str,
    result: Option<Value>,
    message: Option<String>,
    created: Instant,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FrontendRequestView {
    id: String,
    session_id: String,
    method: String,
    params: Value,
    state: String,
    result: Option<Value>,
    message: Option<String>,
}

impl FrontendRequest {
    pub(super) fn view(&self) -> FrontendRequestView {
        FrontendRequestView {
            id: self.id.clone(),
            session_id: self.session_id.clone(),
            method: self.method.clone(),
            params: self.params.clone(),
            state: self.state.into(),
            result: self.result.clone(),
            message: self.message.clone(),
        }
    }
}

pub(super) fn expire_requests(inner: &mut Inner) {
    for request in inner.frontend_requests.values_mut() {
        if request.state == "pending" && request.created.elapsed() > Duration::from_secs(3) {
            request.state = "failed";
            request.message =
                Some("Kanso terminal inspection timed out; no result was returned".into());
            inner.revision += 1;
        }
    }
}

pub(super) fn cancel_requests(inner: &mut Inner, session: Option<&str>, message: &str) {
    for request in inner
        .frontend_requests
        .values_mut()
        .filter(|request| session.is_none_or(|id| request.session_id == id))
    {
        request.state = "failed";
        request.result = None;
        request.message = Some(message.into());
    }
}

impl McpState {
    pub(super) fn begin_frontend_request(
        &self,
        sessions: &SessionManager,
        method: &str,
        params: FrontendParams,
    ) -> Result<FrontendRequestView> {
        let mut inner = self.inner.lock();
        expire_requests(&mut inner);
        if !inner.enabled {
            return Err(AppError::new("MCP is disabled"));
        }
        let info = sessions
            .list()
            .into_iter()
            .find(|info| info.id == params.session_id)
            .ok_or_else(|| AppError::new("terminal session is not open"))?;
        if info.kind == SessionKind::Sftp {
            return Err(AppError::new("file sessions are not terminals"));
        }
        if method != "read_terminal" && (params.max_lines.is_some() || params.cursor.is_some()) {
            return Err(AppError::new(
                "pagination is supported only for read_terminal",
            ));
        }
        if params
            .max_lines
            .is_some_and(|count| count == 0 || count > 500)
            || params
                .cursor
                .as_ref()
                .is_some_and(|cursor| cursor.is_empty() || cursor.len() > 200)
        {
            return Err(AppError::new("invalid terminal pagination parameters"));
        }
        if inner
            .frontend_requests
            .values()
            .filter(|request| request.state == "pending")
            .count()
            >= 16
        {
            return Err(AppError::new("too many pending terminal requests"));
        }
        if inner.frontend_requests.len() >= 64 {
            inner
                .frontend_requests
                .retain(|_, request| request.state == "pending");
        }
        let request = FrontendRequest {
            id: uuid::Uuid::new_v4().to_string(),
            session_id: params.session_id,
            method: method.into(),
            params: json!({"maxLines":params.max_lines.unwrap_or(200),"cursor":params.cursor}),
            state: "pending",
            result: None,
            message: None,
            created: Instant::now(),
        };
        let view = request.view();
        inner.frontend_requests.insert(request.id.clone(), request);
        inner.revision += 1;
        Ok(view)
    }

    pub(super) fn frontend_request_status(&self, id: &str) -> Result<FrontendRequestView> {
        let mut inner = self.inner.lock();
        expire_requests(&mut inner);
        inner
            .frontend_requests
            .get(id)
            .map(FrontendRequest::view)
            .ok_or_else(|| AppError::new("terminal request expired"))
    }

    fn finish_frontend_request_with_action(
        &self,
        sessions: &SessionManager,
        id: &str,
        result: Option<Value>,
        error: Option<String>,
        show_window: impl FnOnce() -> Result<()>,
    ) -> Result<(FrontendRequestView, bool)> {
        let mut inner = self.inner.lock();
        expire_requests(&mut inner);
        let request = inner
            .frontend_requests
            .get(id)
            .ok_or_else(|| AppError::new("terminal request expired"))?;
        if request.state != "pending" {
            return Ok((request.view(), false));
        }
        let session_id = request.session_id.clone();
        let method = request.method.clone();
        let mut result = result.unwrap_or_else(|| json!({}));
        let error = error
            .or_else(|| (!inner.enabled).then(|| "MCP is disabled".into()))
            .or_else(|| {
                (!sessions.list().iter().any(|info| info.id == session_id))
                    .then(|| "terminal was closed".into())
            })
            .or_else(|| {
                (!result.is_object()
                    || serde_json::to_vec(&result).map_or(true, |bytes| bytes.len() > OUTPUT_LIMIT))
                .then(|| "invalid or oversized terminal result".into())
            })
            .or_else(|| {
                if method == "show_terminal" {
                    show_window().err().map(|error| error.to_string())
                } else {
                    None
                }
            });
        if error.is_none() {
            result["sessionId"] = json!(session_id);
            if method == "get_session_status" {
                result["permission"] = json!(inner.permission);
                let shared = inner.shared.get(&session_id);
                let job = shared
                    .and_then(|shared| shared.last_execution.as_ref())
                    .and_then(|id| inner.executions.get(id));
                let connected = sessions.is_live(&session_id);
                let selecting = inner.selections.values().any(|selection| {
                    selection.session_id == session_id && selection.state == "selecting"
                });
                result["connected"] = json!(connected);
                result["selected"] = json!(shared.is_some());
                result["selecting"] = json!(selecting);
                result["execution"] = json!(job.map(Execution::summary));
                result["canExecute"] = json!(
                    connected && shared.is_some() && !job.is_some_and(|job| job.state == "running")
                );
                result["inputLocked"] = json!(
                    shared.is_some()
                        || selecting
                        || result["inputLocked"].as_bool().unwrap_or(false)
                );
                let blocker = if !connected {
                    Some("Terminal is disconnected")
                } else if selecting {
                    Some("Terminal selection is pending")
                } else if shared.is_none() {
                    Some("Select this terminal before executing")
                } else if job.is_some_and(|job| job.state == "running") {
                    Some("A command is still running; poll it or inspect the terminal")
                } else {
                    None
                };
                result["executionBlocker"] = json!(blocker);
                if shared.is_some() || selecting || !connected {
                    result["readyToSelect"] = json!(false);
                    result["selectionBlocker"] = json!(if shared.is_some() {
                        "Terminal is already selected"
                    } else if selecting {
                        "Terminal selection is pending"
                    } else {
                        "Terminal is disconnected"
                    });
                }
            }
        }
        let request = inner.frontend_requests.get_mut(id).unwrap();
        request.state = if error.is_none() {
            "completed"
        } else {
            "failed"
        };
        request.message = error;
        request.result = (request.state == "completed").then_some(result);
        let view = request.view();
        inner.revision += 1;
        Ok((view, true))
    }

    #[cfg(test)]
    fn finish_frontend_request(
        &self,
        sessions: &SessionManager,
        id: &str,
        result: Option<Value>,
        error: Option<String>,
    ) -> Result<(FrontendRequestView, bool)> {
        self.finish_frontend_request_with_action(sessions, id, result, error, || Ok(()))
    }
}

#[tauri::command]
pub fn mcp_validate_request(state: State<'_, AppState>, id: String) -> Result<FrontendRequestView> {
    let mut inner = state.mcp.inner.lock();
    expire_requests(&mut inner);
    let request = inner
        .frontend_requests
        .get(&id)
        .ok_or_else(|| AppError::new("terminal request expired"))?;
    if !inner.enabled || request.state != "pending" || request.method != "show_terminal" {
        return Err(AppError::new("terminal show request is no longer pending"));
    }
    Ok(request.view())
}

#[tauri::command]
pub fn mcp_finish_request(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    result: Option<Value>,
    error: Option<String>,
) -> Result<FrontendRequestView> {
    let (view, _) = state.mcp.finish_frontend_request_with_action(
        &state.sessions,
        &id,
        result,
        error.map(|error| error.chars().take(500).collect()),
        || {
            let window = app
                .get_webview_window("main")
                .ok_or_else(|| AppError::new("Kanso main window is unavailable"))?;
            window.show().map_err(err)?;
            window.unminimize().map_err(err)?;
            window.set_focus().map_err(err)?;
            Ok(())
        },
    )?;
    changed(&app);
    Ok(view)
}

#[cfg(test)]
mod tests {
    use super::super::tests::fixture;
    use super::*;

    fn params(id: &str) -> FrontendParams {
        FrontendParams {
            session_id: id.into(),
            max_lines: None,
            cursor: None,
        }
    }

    #[test]
    fn show_window_failure_is_reported_and_late_ack_never_replays_the_action() {
        let (mcp, sessions, _rx) = fixture(SessionKind::Ssh);
        mcp.set_enabled(true).unwrap();
        let request = mcp
            .begin_frontend_request(&sessions, "show_terminal", params("session"))
            .unwrap();
        let (reply, _) = mcp
            .finish_frontend_request_with_action(
                &sessions,
                &request.id,
                Some(json!({"state":"shown"})),
                None,
                || Err(AppError::new("window unavailable")),
            )
            .unwrap();
        assert_eq!(reply.state, "failed");
        assert!(reply.result.is_none());
        assert_eq!(reply.message.as_deref(), Some("window unavailable"));
        let request = mcp
            .begin_frontend_request(&sessions, "show_terminal", params("session"))
            .unwrap();
        mcp.revoke("session", "disconnected", "reconnected");
        mcp.finish_frontend_request_with_action(
            &sessions,
            &request.id,
            Some(json!({"state":"shown"})),
            None,
            || panic!("must not bring a window forward after reconnect"),
        )
        .unwrap();
    }

    #[test]
    fn inspection_needs_enablement_but_never_selects_or_writes() {
        let (mcp, sessions, mut rx) = fixture(SessionKind::Ssh);
        assert!(mcp
            .begin_frontend_request(&sessions, "read_terminal", params("session"))
            .is_err());
        mcp.set_enabled(true).unwrap();
        for method in ["read_terminal", "show_terminal", "get_session_status"] {
            let request = mcp
                .begin_frontend_request(&sessions, method, params("session"))
                .unwrap();
            assert_eq!(request.state, "pending");
            assert!(mcp.manual_input("session", || Ok(())).is_ok());
            let (reply, fresh) = mcp
                .finish_frontend_request(
                    &sessions,
                    &request.id,
                    Some(json!({"output":"manual output","readyToSelect":true})),
                    None,
                )
                .unwrap();
            assert!(fresh);
            assert_eq!(reply.state, "completed");
            assert_eq!(reply.result.as_ref().unwrap()["sessionId"], "session");
            if method == "get_session_status" {
                assert_eq!(reply.result.as_ref().unwrap()["selected"], false);
                assert_eq!(reply.result.as_ref().unwrap()["canExecute"], false);
            }
            assert!(
                !mcp.finish_frontend_request(&sessions, &request.id, Some(json!({})), None)
                    .unwrap()
                    .1
            );
        }
        assert!(rx.try_recv().is_err());
        assert!(!mcp.list(&sessions)[0].selected);
    }

    #[test]
    fn stale_disabled_reconnected_and_expired_requests_discard_late_results() {
        let (mcp, sessions, _rx) = fixture(SessionKind::Ssh);
        mcp.set_enabled(true).unwrap();
        for reason in ["disable", "reconnect", "timeout"] {
            let request = mcp
                .begin_frontend_request(&sessions, "show_terminal", params("session"))
                .unwrap();
            match reason {
                "disable" => {
                    mcp.set_enabled(false).unwrap();
                    mcp.set_enabled(true).unwrap();
                }
                "reconnect" => {
                    mcp.revoke("session", "disconnected", "reconnected");
                }
                _ => {
                    mcp.inner
                        .lock()
                        .frontend_requests
                        .get_mut(&request.id)
                        .unwrap()
                        .created -= Duration::from_secs(4);
                }
            }
            let (reply, fresh) = mcp
                .finish_frontend_request(
                    &sessions,
                    &request.id,
                    Some(json!({"state":"shown"})),
                    None,
                )
                .unwrap();
            assert!(!fresh);
            assert_eq!(reply.state, "failed");
            assert!(reply.result.is_none());
        }
    }

    #[test]
    fn results_and_request_queue_are_bounded_and_file_sessions_refused() {
        let (mcp, sessions, _rx) = fixture(SessionKind::Ssh);
        mcp.set_enabled(true).unwrap();
        let request = mcp
            .begin_frontend_request(&sessions, "read_terminal", params("session"))
            .unwrap();
        assert_eq!(
            mcp.finish_frontend_request(
                &sessions,
                &request.id,
                Some(json!({"output":"x".repeat(OUTPUT_LIMIT+1)})),
                None
            )
            .unwrap()
            .0
            .state,
            "failed"
        );
        let mut bad = params("session");
        bad.max_lines = Some(501);
        assert!(mcp
            .begin_frontend_request(&sessions, "read_terminal", bad)
            .is_err());
        for _ in 0..16 {
            mcp.begin_frontend_request(&sessions, "read_terminal", params("session"))
                .unwrap();
        }
        assert!(mcp
            .begin_frontend_request(&sessions, "read_terminal", params("session"))
            .is_err());
        let (mcp, sessions, _rx) = fixture(SessionKind::Sftp);
        mcp.set_enabled(true).unwrap();
        assert!(mcp
            .begin_frontend_request(&sessions, "show_terminal", params("session"))
            .is_err());
    }
}
