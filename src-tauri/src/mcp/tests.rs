use super::*;
use crate::session::{SessionCommand, SessionHandle};
use encoding_rs::{GBK, UTF_8};
use tokio::sync::mpsc;

fn dispatch(
    mcp: &McpState,
    sessions: &SessionManager,
    token: &str,
    line: &[u8],
) -> Result<(Value, bool)> {
    dispatch_with_output(mcp, sessions, token, line, |_, _| {})
}

pub(super) fn fixture(
    kind: SessionKind,
) -> (
    McpState,
    SessionManager,
    mpsc::UnboundedReceiver<SessionCommand>,
) {
    let mcp = McpState::default();
    *mcp.bridge.lock() = Some(BridgeLease {
        path: std::env::temp_dir().join(format!("kanso-mcp-test-{}", uuid::Uuid::new_v4())),
        token: "test-token".into(),
        task: None,
    });
    let sessions = SessionManager::default();
    let (tx, rx) = mpsc::unbounded_channel();
    sessions.insert(SessionHandle {
        info: session::make_info("session", &crate::tests::profile(kind)),
        tx,
        ssh_transport: None,
        encoding: UTF_8,
    });
    (mcp, sessions, rx)
}

#[test]
fn permissions_default_to_read_only_and_block_before_any_terminal_write() {
    let (mcp, sessions, mut rx) = fixture(SessionKind::Ssh);
    assert_eq!(mcp.inner.lock().permission, Permission::ReadOnly);
    mcp.set_enabled(true).unwrap();
    let claim = mcp.begin_selection(&sessions, "session").unwrap();
    mcp.finish_selection(&sessions, &claim.id, None).unwrap();
    for command in [
        "touch /tmp/new-file",
        "ls && rm -rf /tmp/a",
        "ls\nunknown_script",
        "ls $(echo injected)",
    ] {
        let request = json!({"token":"secret","method":"execute","params":{"sessionId":"session","command":command}});
        let (blocked, changed) = dispatch(
            &mcp,
            &sessions,
            "secret",
            &serde_json::to_vec(&request).unwrap(),
        )
        .unwrap();
        assert_eq!(blocked["code"], "COMMAND_BLOCKED");
        assert_eq!(blocked["state"], "blocked");
        assert_eq!(blocked["permission"], "read_only");
        assert!(!changed);
        assert!(rx.try_recv().is_err());
        assert!(mcp.inner.lock().executions.is_empty());
    }
    let job = mcp.execute(&sessions, "session", "pwd; whoami").unwrap();
    let SessionCommand::Write(bytes) = rx.try_recv().unwrap() else {
        panic!("expected terminal write")
    };
    assert!(String::from_utf8(bytes).unwrap().contains("command"));
    mcp.output("session", &complete(&job.id, "/root\nroot", 0));
    assert!(mcp.manual_input("session", || Ok(())).is_err());
}

#[test]
fn permission_changes_apply_to_next_submission_without_replaying_or_cancelling() {
    let (mcp, sessions, mut rx) = fixture(SessionKind::Ssh);
    mcp.share(&sessions, "session", "target").unwrap();
    let job = mcp.execute(&sessions, "session", "sleep 60").unwrap();
    rx.try_recv().unwrap();
    mcp.set_permission(Permission::ReadOnly);
    assert_eq!(mcp.execution(&job.id).unwrap().state, "running");
    assert!(rx.try_recv().is_err());
    mcp.interrupt(&sessions, &job.id).unwrap();
    assert!(matches!(rx.try_recv().unwrap(), SessionCommand::Write(bytes) if bytes == b"\x03"));
    mcp.output("session", &complete(&job.id, "", 130));
    assert!(matches!(
        mcp.execute(&sessions, "session", "touch /tmp/a"),
        Err(ExecuteError::Blocked(_))
    ));
    assert!(rx.try_recv().is_err());
    mcp.set_permission(Permission::ReadWrite);
    assert!(rx.try_recv().is_err()); // permission changes never replay blocked commands
    let write = mcp.execute(&sessions, "session", "touch /tmp/a").unwrap();
    rx.try_recv().unwrap();
    mcp.output("session", &complete(&write.id, "", 0));
    assert!(matches!(
        mcp.execute(&sessions, "session", "rm -rf /tmp/a"),
        Err(ExecuteError::Blocked(_))
    ));
    assert!(rx.try_recv().is_err());
    mcp.set_permission(Permission::All);
    let allowed = mcp.execute(&sessions, "session", "rm -rf /tmp/a").unwrap();
    rx.try_recv().unwrap();
    mcp.output("session", &complete(&allowed.id, "", 0));
    let before = mcp.inner.lock().permission;
    assert!(dispatch(
        &mcp,
        &sessions,
        "secret",
        br#"{"token":"secret","method":"set_permission","params":{"permission":"all"}}"#
    )
    .is_err());
    assert_eq!(mcp.inner.lock().permission, before);
    mcp.set_enabled(false).unwrap();
    mcp.set_enabled(true).unwrap();
    assert_eq!(mcp.ui_state(&sessions).permission, Permission::All);
    assert_eq!(
        McpState::default().inner.lock().permission,
        Permission::ReadOnly
    );
}

#[test]
fn interrupt_targets_one_current_execution_and_never_unlocks_or_replays() {
    let (mcp, sessions, mut rx) = fixture(SessionKind::Ssh);
    mcp.share(&sessions, "session", "target").unwrap();
    let job = mcp.execute(&sessions, "session", "sleep 60").unwrap();
    rx.try_recv().unwrap();
    assert_eq!(
        mcp.interrupt(&sessions, &job.id).unwrap()["state"],
        "interrupt_requested"
    );
    assert!(matches!(rx.try_recv().unwrap(), SessionCommand::Write(bytes) if bytes == b"\x03"));
    mcp.interrupt(&sessions, &job.id).unwrap();
    assert!(rx.try_recv().is_err());
    assert_eq!(mcp.execution(&job.id).unwrap().state, "running");
    assert!(mcp.execution(&job.id).unwrap().interrupt_requested);
    assert!(mcp.manual_input("session", || Ok(())).is_err());
    assert!(mcp.execute(&sessions, "session", "must not run").is_err());
    mcp.output("session", &complete(&job.id, "interrupted", 130));
    assert_eq!(mcp.execution(&job.id).unwrap().exit_code, Some(130));
    let next = mcp.execute(&sessions, "session", "pwd").unwrap();
    rx.try_recv().unwrap();
    assert!(mcp.interrupt(&sessions, &job.id).is_err());
    assert!(rx.try_recv().is_err());
    mcp.revoke("session", "interrupted", "takeover");
    assert!(mcp.interrupt(&sessions, &next.id).is_err());
    mcp.set_enabled(false).unwrap();
    assert!(mcp.interrupt(&sessions, &next.id).is_err());
    assert!(rx.try_recv().is_err());
}

fn complete(id: &str, output: &str, code: u8) -> Vec<u8> {
    format!("echoed wrapper\r\n\x1eKANSO_MCP_{id}:BEGIN\x1f{output}\x1eKANSO_MCP_{id}:END:{code}\x1fshell$ ").into_bytes()
}

// Existing capture/execution regressions start after a successful frontend
// readiness acknowledgment. The global-selection tests below cover the handshake.
impl McpState {
    fn share(&self, sessions: &SessionManager, id: &str, label: &str) -> Result<()> {
        if label.trim().is_empty() || label.chars().any(char::is_control) {
            return Err(AppError::new("invalid label"));
        }
        self.set_enabled(true)?;
        // Capture/protocol regressions intentionally use unrestricted commands;
        // permission enforcement has dedicated default/lowering tests below.
        self.set_permission(Permission::All);
        self.inner.lock().labels.insert(id.into(), label.into());
        let request = self.begin_selection(sessions, id)?;
        if request.state == "selected" {
            return Ok(());
        }
        let result = self.finish_selection(sessions, &request.id, None)?;
        if result.state != "selected" {
            return Err(AppError::new(result.message.unwrap_or_default()));
        }
        Ok(())
    }
}

#[test]
fn unshared_and_file_sessions_cannot_execute() {
    let (mcp, sessions, mut rx) = fixture(SessionKind::Ssh);
    assert!(mcp.list(&sessions).is_empty());
    assert!(mcp.execute(&sessions, "session", "whoami").is_err());
    assert!(rx.try_recv().is_err());
    let (mcp, sessions, _rx) = fixture(SessionKind::Sftp);
    assert!(mcp.share(&sessions, "session", "target").is_err());
}

#[test]
fn sharing_requires_a_live_terminal_and_target_label() {
    let (mcp, sessions, rx) = fixture(SessionKind::Ssh);
    assert!(mcp.share(&sessions, "missing", "target").is_err());
    assert!(mcp.share(&sessions, "session", " ").is_err());
    assert!(mcp.share(&sessions, "session", "target\nother").is_err());
    drop(rx);
    assert!(mcp.share(&sessions, "session", "target").is_err());
}

#[test]
fn executes_on_the_existing_input_channel_and_returns_real_exit_code() {
    let (mcp, sessions, mut rx) = fixture(SessionKind::Ssh);
    mcp.share(&sessions, "session", "actual target behind bastion")
        .unwrap();
    let job = mcp
        .execute(&sessions, "session", "printf hello; false")
        .unwrap();
    assert_eq!(job.state, "running");
    assert_eq!(job.exit_code, None);
    let SessionCommand::Write(bytes) = rx.try_recv().unwrap() else {
        panic!("must use current terminal input")
    };
    assert!(String::from_utf8(bytes).unwrap().contains(&job.id));
    assert!(rx.try_recv().is_err());
    let (visible, changed) = mcp.output("session", &complete(&job.id, "hello", 1));
    assert_eq!(visible, b"\r\n[MCP] printf hello; false\r\nhelloshell$ ");
    assert!(changed);
    let result = mcp.execution(&job.id).unwrap();
    assert_eq!(result.state, "completed");
    assert_eq!(result.output, "hello");
    assert_eq!(result.exit_code, Some(1));
    assert_eq!(mcp.list(&sessions)[0].label, "actual target behind bastion");
    assert!(mcp.execute(&sessions, "session", "pwd").is_ok());
}

#[test]
fn shared_terminal_blocks_manual_input_and_parallel_execution_until_takeover() {
    let (mcp, sessions, mut rx) = fixture(SessionKind::Ssh);
    mcp.manual_input("session", || sessions.write_text("session", "manual\r"))
        .unwrap();
    rx.try_recv().unwrap();
    mcp.share(&sessions, "session", "target").unwrap();
    assert!(mcp
        .manual_input("session", || sessions.write_text("session", "must not mix"))
        .is_err());
    let job = mcp.execute(&sessions, "session", "sleep 60").unwrap();
    rx.try_recv().unwrap();
    assert!(mcp.execute(&sessions, "session", "whoami").is_err());
    assert!(rx.try_recv().is_err());
    assert_eq!(mcp.execution(&job.id).unwrap().state, "running");
    mcp.revoke("session", "interrupted", "user took control");
    let result = mcp.execution(&job.id).unwrap();
    assert_eq!(result.state, "interrupted");
    assert_eq!(result.exit_code, None);
    assert!(mcp.execute(&sessions, "session", "whoami").is_err());
    // Taking control never sends a signal or another command to the server.
    assert!(rx.try_recv().is_err());
    mcp.manual_input("session", || sessions.write_text("session", "\x03"))
        .unwrap();
}

#[test]
fn disconnect_and_reconnect_do_not_inherit_permission_or_old_capture() {
    let (mcp, sessions, _rx) = fixture(SessionKind::Ssh);
    mcp.share(&sessions, "session", "target").unwrap();
    let job = mcp.execute(&sessions, "session", "sleep 60").unwrap();
    mcp.revoke("session", "disconnected", "closed");
    assert_eq!(mcp.execution(&job.id).unwrap().state, "disconnected");
    assert!(!mcp.list(&sessions)[0].selected);
    assert!(mcp.execute(&sessions, "session", "pwd").is_err());
    assert_eq!(mcp.output("session", b"new shell$ ").0, b"new shell$ ");
    mcp.share(&sessions, "session", "new target").unwrap();
    let new_job = mcp.execute(&sessions, "session", "whoami").unwrap();
    mcp.output("session", &complete(&job.id, "old output", 0));
    assert_eq!(mcp.execution(&new_job.id).unwrap().state, "running");
    mcp.output("session", &complete(&new_job.id, "new user", 0));
    assert_eq!(mcp.execution(&new_job.id).unwrap().output, "new user");
}

#[test]
fn framing_handles_every_split_without_echo_prompt_or_marker_in_results() {
    let stream = complete("nonce", "你好\r\nhello\r\n", 127);
    for split in 0..=stream.len() {
        let mut capture = Capture::new("nonce");
        let mut visible = capture.feed(&stream[..split]);
        visible.extend(capture.feed(&stream[split..]));
        assert_eq!(
            capture.output,
            "你好\r\nhello\r\n".as_bytes(),
            "split {split}"
        );
        assert_eq!(capture.exit_code, Some(127));
        assert_eq!(visible, "你好\r\nhello\r\nshell$ ".as_bytes());
    }
}

#[test]
fn framing_survives_bytewise_streaming_and_invalid_end_markers() {
    let stream = complete("nonce", "a\x1eKANSO_MCP_nonce:END:bogus\x1fb\r\n", 255);
    let mut capture = Capture::new("nonce");
    for byte in stream {
        capture.feed(&[byte]);
    }
    assert_eq!(capture.output, b"a\x1eKANSO_MCP_nonce:END:bogus\x1fb\r\n");
    assert_eq!(capture.exit_code, Some(255));
}

#[test]
fn shell_prompt_and_wait_expiry_never_claim_completion() {
    let mut capture = Capture::new("nonce");
    capture.feed(b"\x1eKANSO_MCP_nonce:BEGIN\x1froot@target:~# ");
    assert!(capture.started);
    assert_eq!(capture.exit_code, None);
    assert_eq!(capture.output, b"root@target:~# ");
    let mut waiting = Capture::new("nonce");
    waiting.feed(&vec![b'x'; 32 * 1024]);
    assert!(waiting.pending.len() < 100);
    assert!(!waiting.started);
    assert_eq!(waiting.exit_code, None);
}

#[test]
fn large_output_is_bounded_but_still_completes_and_reaches_the_terminal() {
    let mut capture = Capture::new("nonce");
    capture.feed(b"\x1eKANSO_MCP_nonce:BEGIN\x1f");
    let bytes = vec![b'x'; OUTPUT_LIMIT + 500];
    assert_eq!(capture.feed(&bytes), bytes);
    capture.feed(b"\x1eKANSO_MCP_nonce:END:0\x1f");
    assert_eq!(capture.output.len(), OUTPUT_LIMIT);
    assert!(capture.truncated);
    assert_eq!(capture.exit_code, Some(0));
}

#[test]
fn output_is_decoded_using_the_session_encoding() {
    let (mcp, sessions, _rx) = fixture(SessionKind::Ssh);
    mcp.share(&sessions, "session", "target").unwrap();
    let job = mcp.execute(&sessions, "session", "whoami").unwrap();
    mcp.inner
        .lock()
        .executions
        .get_mut(&job.id)
        .unwrap()
        .encoding = GBK;
    let bytes = GBK
        .encode(&String::from_utf8(complete(&job.id, "你好", 0)).unwrap())
        .0
        .into_owned();
    mcp.output("session", &bytes);
    assert_eq!(mcp.execution(&job.id).unwrap().output, "你好");
}

#[test]
fn invalid_oversized_and_control_character_commands_write_nothing() {
    let (mcp, sessions, mut rx) = fixture(SessionKind::Ssh);
    mcp.share(&sessions, "session", "target").unwrap();
    for command in [" ", "echo hi\rwhoami", "echo\x03", &"x".repeat(4000)] {
        assert!(mcp.execute(&sessions, "session", command).is_err());
    }
    assert!(rx.try_recv().is_err());
}

#[test]
fn bridge_authentication_and_methods_are_checked_before_access() {
    let (mcp, sessions, mut rx) = fixture(SessionKind::Ssh);
    mcp.share(&sessions, "session", "target").unwrap();
    assert!(dispatch(&mcp, &sessions, "secret", br#"{"token":"wrong","method":"execute","params":{"sessionId":"session","command":"whoami"}}"#).is_err());
    assert!(rx.try_recv().is_err());
    let (listed, changed) = dispatch(
        &mcp,
        &sessions,
        "secret",
        br#"{"token":"secret","method":"list_sessions"}"#,
    )
    .unwrap();
    assert!(!changed);
    assert_eq!(listed["sessions"].as_array().unwrap().len(), 1);
    assert!(dispatch(
        &mcp,
        &sessions,
        "secret",
        br#"{"token":"secret","method":"read_file"}"#
    )
    .is_err());
    assert!(mcp.execution("unknown").is_err());
}

#[test]
fn retained_history_is_bounded_without_evicting_the_running_job() {
    let (mcp, sessions, _rx) = fixture(SessionKind::Ssh);
    mcp.share(&sessions, "session", "target").unwrap();
    for _ in 0..HISTORY_LIMIT + 10 {
        let job = mcp.execute(&sessions, "session", "true").unwrap();
        mcp.output("session", &complete(&job.id, "", 0));
    }
    let job = mcp.execute(&sessions, "session", "sleep 60").unwrap();
    assert!(mcp.inner.lock().executions.len() <= HISTORY_LIMIT);
    assert_eq!(mcp.execution(&job.id).unwrap().state, "running");
}

#[test]
fn session_discovery_stays_below_client_frame_limit_with_32_full_outputs() {
    let (mcp, sessions, _rx) = fixture(SessionKind::Ssh);
    let mut receivers = Vec::new();
    let mut last_execution = String::new();
    for index in 0..HISTORY_LIMIT {
        let id = format!("shared-{index}");
        let (tx, rx) = mpsc::unbounded_channel();
        receivers.push(rx);
        sessions.insert(SessionHandle {
            info: session::make_info(&id, &crate::tests::profile(SessionKind::Ssh)),
            tx,
            ssh_transport: None,
            encoding: UTF_8,
        });
        mcp.share(&sessions, &id, &format!("target {index}"))
            .unwrap();
        let job = mcp.execute(&sessions, &id, "printf large-output").unwrap();
        mcp.output(&id, &complete(&job.id, &"x".repeat(OUTPUT_LIMIT), 0));
        last_execution = job.id;
    }
    let listed = json!({ "result": { "sessions": mcp.list(&sessions) } });
    assert!(serde_json::to_vec(&listed).unwrap().len() < 512 * 1024);
    assert_eq!(listed["result"]["sessions"].as_array().unwrap().len(), 33);
    assert!(listed["result"]["sessions"][0]["execution"]
        .get("output")
        .is_none());
    assert_eq!(
        mcp.execution(&last_execution).unwrap().output.len(),
        OUTPUT_LIMIT
    );
}

#[tokio::test]
async fn real_loopback_bridge_authenticates_and_frames_requests() {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    let (mcp, sessions, _rx) = fixture(SessionKind::Ssh);
    mcp.share(&sessions, "session", "target behind GateShell")
        .unwrap();
    let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
        .await
        .unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        for _ in 0..3 {
            let (stream, _) = listener.accept().await.unwrap();
            serve(stream, &mcp, &sessions, "secret", || {}, |_, _| {})
                .await
                .unwrap();
        }
    });
    for (request, expected) in [
        (
            "{\"token\":\"wrong\",\"method\":\"list_sessions\"}\n".to_string(),
            "authentication failed",
        ),
        (
            "{\"token\":\"secret\",\"method\":\"list_sessions\"}\n".to_string(),
            "target behind GateShell",
        ),
        (
            format!("{}\n", "x".repeat(REQUEST_LIMIT as usize + 1)),
            "oversized",
        ),
    ] {
        let mut client = TcpStream::connect(address).await.unwrap();
        client.write_all(request.as_bytes()).await.unwrap();
        let mut response = String::new();
        BufReader::new(client)
            .read_line(&mut response)
            .await
            .unwrap();
        serde_json::from_str::<Value>(&response).unwrap();
        assert!(response.contains(expected), "{response}");
    }
    server.await.unwrap();
}

#[test]
fn old_bridge_lease_cannot_delete_a_newer_app_descriptor() {
    let path = std::env::temp_dir().join(format!("kanso-lease-test-{}", uuid::Uuid::new_v4()));
    std::fs::write(&path, br#"{"version":1,"port":12345,"token":"new"}"#).unwrap();
    drop(BridgeLease {
        path: path.clone(),
        token: "old".into(),
        task: None,
    });
    assert!(path.is_file());
    drop(BridgeLease {
        path: path.clone(),
        token: "new".into(),
        task: None,
    });
    assert!(!path.exists());
}

#[test]
fn enabling_discovers_live_terminals_without_locking_or_selecting_them() {
    let (mcp, sessions, mut rx) = fixture(SessionKind::Ssh);
    assert!(mcp.begin_selection(&sessions, "session").is_err());
    mcp.set_enabled(true).unwrap();
    let listed = mcp.list(&sessions);
    assert_eq!(listed.len(), 1);
    assert!(!listed[0].selected && !listed[0].selecting);
    assert_eq!(listed[0].label, sessions.list()[0].name);
    mcp.manual_input("session", || sessions.write_text("session", "manual\r"))
        .unwrap();
    rx.try_recv().unwrap();
    assert!(mcp.execute(&sessions, "session", "whoami").is_err());
    assert!(rx.try_recv().is_err());
    drop(rx);
    assert!(mcp.list(&sessions).is_empty());
    let (mcp, sessions, _rx) = fixture(SessionKind::Sftp);
    mcp.set_enabled(true).unwrap();
    assert!(mcp.list(&sessions).is_empty());
    assert!(mcp.begin_selection(&sessions, "session").is_err());
}

#[test]
fn client_release_flushes_pending_output_before_restoring_manual_input() {
    let (mcp, sessions, _rx) = fixture(SessionKind::Ssh);
    mcp.share(&sessions, "session", "target").unwrap();
    let job = mcp.execute(&sessions, "session", "sleep 60").unwrap();
    assert!(mcp
        .output("session", b"buffered before start marker")
        .0
        .is_empty());
    let mut flushed = Vec::new();
    dispatch_with_output(
        &mcp,
        &sessions,
        "secret",
        br#"{"token":"secret","method":"release_session","params":{"sessionId":"session"}}"#,
        |id, bytes| {
            assert_eq!(id, "session");
            flushed.extend_from_slice(bytes);
        },
    )
    .unwrap();
    assert_eq!(flushed, b"buffered before start marker");
    assert_eq!(mcp.execution(&job.id).unwrap().state, "interrupted");
    assert!(mcp.manual_input("session", || Ok(())).is_ok());
}

#[test]
fn repeating_a_pending_selection_at_capacity_is_idempotent() {
    let (mcp, sessions, _rx) = fixture(SessionKind::Ssh);
    mcp.set_enabled(true).unwrap();
    let request = mcp.begin_selection(&sessions, "session").unwrap();
    for index in 1..HISTORY_LIMIT {
        mcp.inner.lock().shared.insert(
            format!("selected-{index}"),
            SharedSession {
                label: "target".into(),
                last_execution: None,
            },
        );
    }
    assert_eq!(
        mcp.begin_selection(&sessions, "session").unwrap().id,
        request.id
    );
    mcp.finish_selection(&sessions, &request.id, None).unwrap();
    assert_eq!(
        mcp.begin_selection(&sessions, "session").unwrap().state,
        "selected"
    );
}

#[test]
fn selection_reserves_input_before_ack_and_failure_releases_without_writing() {
    let (mcp, sessions, mut rx) = fixture(SessionKind::Ssh);
    mcp.set_enabled(true).unwrap();
    let request = mcp.begin_selection(&sessions, "session").unwrap();
    assert_eq!(request.state, "selecting");
    assert_eq!(
        mcp.begin_selection(&sessions, "session").unwrap().id,
        request.id
    );
    assert!(mcp
        .manual_input("session", || sessions.write_text("session", "keyboard"))
        .is_err());
    assert!(mcp.execute(&sessions, "session", "whoami").is_err());
    assert!(rx.try_recv().is_err());
    let failed = mcp
        .finish_selection(&sessions, &request.id, Some("Finish typing first".into()))
        .unwrap();
    assert_eq!(failed.state, "failed");
    assert!(!mcp.list(&sessions)[0].selected);
    mcp.manual_input("session", || sessions.write_text("session", "manual"))
        .unwrap();
    assert!(matches!(rx.try_recv().unwrap(), SessionCommand::Write(_)));
}

#[test]
fn selecting_two_terminals_and_releasing_one_preserves_the_other_lock() {
    let (mcp, sessions, mut rx) = fixture(SessionKind::Ssh);
    let (tx, mut second_rx) = mpsc::unbounded_channel();
    sessions.insert(SessionHandle {
        info: session::make_info("second", &crate::tests::profile(SessionKind::Ssh)),
        tx,
        ssh_transport: None,
        encoding: UTF_8,
    });
    mcp.set_enabled(true).unwrap();
    mcp.inner
        .lock()
        .labels
        .insert("second".into(), "bastion (1)".into());
    for id in ["session", "second"] {
        let request = mcp.begin_selection(&sessions, id).unwrap();
        mcp.finish_selection(&sessions, &request.id, None).unwrap();
    }
    assert!(mcp.list(&sessions).iter().all(|session| session.selected));
    assert_eq!(
        mcp.list(&sessions)
            .iter()
            .find(|session| session.id == "second")
            .unwrap()
            .label,
        "bastion (1)"
    );
    let first = mcp.execute(&sessions, "session", "pwd").unwrap();
    let second = mcp.execute(&sessions, "second", "hostname").unwrap();
    rx.try_recv().unwrap();
    second_rx.try_recv().unwrap();
    mcp.output("session", &complete(&first.id, "/root", 0));
    assert!(mcp.manual_input("session", || Ok(())).is_err());
    mcp.revoke("session", "interrupted", "released");
    assert!(mcp.manual_input("session", || Ok(())).is_ok());
    assert!(mcp.manual_input("second", || Ok(())).is_err());
    assert_eq!(mcp.execution(&second.id).unwrap().state, "running");
    mcp.set_enabled(false).unwrap();
    assert!(mcp.manual_input("second", || Ok(())).is_ok());
    assert!(mcp.list(&sessions).is_empty());
    assert_eq!(mcp.execution(&second.id).unwrap().state, "interrupted");
}

#[test]
fn disable_disconnect_and_expiry_cannot_be_undone_by_a_late_ack() {
    let (mcp, sessions, _rx) = fixture(SessionKind::Ssh);
    mcp.set_enabled(true).unwrap();
    let old = mcp.begin_selection(&sessions, "session").unwrap();
    mcp.set_enabled(false).unwrap();
    mcp.set_enabled(true).unwrap();
    assert_eq!(
        mcp.finish_selection(&sessions, &old.id, None)
            .unwrap()
            .state,
        "failed"
    );
    let request = mcp.begin_selection(&sessions, "session").unwrap();
    mcp.revoke("session", "disconnected", "reconnected");
    assert_eq!(
        mcp.finish_selection(&sessions, &request.id, None)
            .unwrap()
            .state,
        "failed"
    );
    let request = mcp.begin_selection(&sessions, "session").unwrap();
    mcp.inner
        .lock()
        .selections
        .get_mut(&request.id)
        .unwrap()
        .created -= Duration::from_secs(4);
    assert_eq!(mcp.selection_status(&request.id).unwrap().state, "failed");
    assert_eq!(
        mcp.finish_selection(&sessions, &request.id, None)
            .unwrap()
            .state,
        "failed"
    );
    assert!(mcp.manual_input("session", || Ok(())).is_ok());
    assert!(!mcp.list(&sessions)[0].selected);
}

#[cfg(unix)]
#[test]
fn real_posix_shell_preserves_quotes_multiline_backslashes_cwd_and_environment() {
    let first = command_script(
        "first",
        "cd /; export KANSO_MCP_TEST=\"a'b\\c\"\nprintf '%s\\n' \"$KANSO_MCP_TEST\"",
    )
    .unwrap();
    let second =
        command_script("second", "pwd; printf '%s\\n' \"$KANSO_MCP_TEST\"; false").unwrap();
    let script = format!(
        "{}\n{}",
        first.trim_end_matches('\r'),
        second.trim_end_matches('\r')
    );
    let result = std::process::Command::new("sh")
        .args(["-c", &script])
        .output()
        .unwrap();
    let mut capture = Capture::new("first");
    capture.feed(&result.stdout);
    assert_eq!(capture.output, b"a'b\\c\n");
    assert_eq!(capture.exit_code, Some(0));
    let mut capture = Capture::new("second");
    capture.feed(&result.stdout);
    assert_eq!(capture.output, b"/\na'b\\c\n");
    assert_eq!(capture.exit_code, Some(1));
}
