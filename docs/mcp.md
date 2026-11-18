# Kanso MCP v1

Kanso owns the SSH connection and its visible terminal. Sign in, complete MFA,
and navigate GateShell/jump hosts yourself. Once the terminal is at the intended
POSIX shell prompt (sh, bash, or zsh), the MCP client can select that terminal.
The MCP server writes to that exact terminal; it never opens another SSH channel,
logs in, or receives passwords/verification codes. Local WSL/POSIX terminals can
also be selected. PowerShell, cmd, fish, GateShell menus and full-screen programs
are not command execution targets in v1.

## Run

MCP is built into Kanso as a native stdio mode (`kanso --mcp`). No Node.js,
source checkout or npm installation is needed by users. This mode opens no
window and connects to the existing desktop app's local bridge; keep the app running.
The status bar shows **MCP On / Off** and a separate switch. Use the switch
to enable or disable MCP; hover the enabled status to view and copy connection
information. Clicking the status keeps the configuration open in a dialog. Only Codex
and DeepSeek Harness (DSH) are targeted. Both installed clients support stdio
and Streamable HTTP; v1 uses stdio to reuse the existing bridge without adding
an HTTP server. The popup uses your actual executable and bridge paths and
never displays the runtime token. Each user should copy from their own Kanso.

For Codex, merge into `~/.codex/config.toml` (paths below are examples):

```toml
[mcp_servers.kanso]
command = "D:/Apps/Kanso/kanso.exe"
args = ["--mcp", "--bridge-file", "C:/Users/you/AppData/Roaming/Kanso/mcp-bridge.json"]
```

For DeepSeek Harness, add `kanso` in Settings → MCP with transport `stdio`
and the displayed command/args. The popup also provides a `cordis.patch.yml`
example using the installed manager's documented format:

```yaml
- id: mcp
  config:
    servers:
      kanso:
        transport: stdio
        command: "D:/Apps/Kanso/kanso.exe"
        args: ["--mcp", "--bridge-file", "C:/Users/you/AppData/Roaming/Kanso/mcp-bridge.json"]
        enabled: true
```

When merging YAML, preserve existing servers: replacing `config.servers`
replaces the complete mapping. Reconnect the client after changing configuration.
No SSH password or verification code belongs in either configuration.

Replace any earlier Node-based development configuration with this native entry.

Turn on the MCP switch in Kanso's status bar. This application-wide switch
makes every connected terminal discoverable, including terminals opened later;
it does not lock them. Names default to the existing tab titles, including their
duplicate suffixes. No per-tab sharing dialog or target-name form is required.
Names are display labels; tools always use the unique `sessionId`, so matching
names never silently route a command to another tab. A bastion tab name does
not prove the identity of a host reached inside GateShell.

The MCP client calls `kanso_list_sessions`, then `kanso_select_session` for the
intended terminal. Selection reserves backend input, asks the current terminal
controller to check its empty POSIX prompt and input/program/transfer state,
locks that controller, and acknowledges ownership. Only after a successful
acknowledgment can commands execute. A failed or timed-out (3s) selection releases
its reservation; late acknowledgments cannot revive it. GateShell's obsolete
menu activity/anchors on earlier lines can be reset at selection time when the
current shell prompt is empty. Current-line edits remain blocked.

While selected, normal keyboard input, pastes and Sender writes are blocked until
the client calls `kanso_release_session` or you click **Release / Take Control**.
Command completion keeps the selection locked. Different terminals can be
selected and execute independently. Unselected terminals stay editable.
Taking control stops result collection; it does not terminate a remote command.
Inspect the terminal and use Ctrl+C yourself when appropriate.

Turn the MCP switch off to disable MCP and release all selected terminals. Enablement
and selections are not persisted. Disconnect/reconnect clears the old selection;
the still-enabled client may discover the reconnected terminal but must select
it again. A frontend state revision rejects stale snapshots. A periodic refresh
also releases frontend reservations after handshake timeouts.

The local bridge descriptor is `mcp-bridge.json` under Kanso's data directory:

- Windows: `%APPDATA%/Kanso/`
- macOS: `~/Library/Application Support/Kanso/`
- Linux: `${XDG_CONFIG_HOME:-~/.config}/Kanso/`
- Portable app: `data/` beside the Kanso executable.

For portable mode, a custom data directory, or a client running in another
environment, pass `--mcp --bridge-file /absolute/path/mcp-bridge.json` in `args`.
The MCP process must be able to reach the desktop app's loopback interface; on
Windows the simplest configuration runs both processes on Windows (Kanso may
still contain a WSL terminal). Only one desktop instance per data directory is
addressed. The descriptor contains a runtime token; do not copy it into chat or
client configuration. The bridge binds only to IPv4 loopback, authenticates each
request. Command access requires global enablement plus a selected live terminal.

## Command permissions

The status bar has a global **只读 / 读写 / 所有** selector beside the MCP
status and switch. Default is **只读** (`read_only`) on every app start.
The choice applies to all terminals in this Kanso process and is not persisted.
Only Kanso's UI can change it; no MCP tool or bridge method can elevate it.
Changing permission does not replay a blocked command or stop a running command.
The next submission uses the current permission, checked under the same backend
lock as the actual terminal write. Read/status/show/select/release and Ctrl+C
recovery of an existing MCP execution remain available at every level.

| Permission | Allowed | Blocked |
| --- | --- | --- |
| `read_only` / 只读 | Recognized query commands and literal output | Writes, unknown commands, scripts/interpreters, dangerous operations |
| `read_write` / 读写 | Queries plus ordinary mkdir/touch/cp/tee and output redirection to allowed paths | Deletion, escalation, system/service/cluster changes, unknown or dynamic execution |
| `all` / 所有 | Original POSIX commands under the logged-in account | No risk rules; existing input-size/control-character, selection and execution restrictions still apply |

Restricted modes accept literal arguments with shell quoting, pipelines, `;`,
newlines, `&&` and `||`. Every segment and option is checked before any bytes
are queued, then rebuilt with quoted arguments. Unquoted expansion, variables,
substitution, globs, comments, groups, background execution, input redirection
and descriptor redirection are refused. Quote literal patterns such as
`find /srv/app -name '*.log'`. Unsupported syntax/flags fail closed.

Query commands include pwd/cd, ls/cat/head/tail/grep/find, wc/sort/stat,
df/du/free/uname/hostname/id/whoami/ps/uptime, selected built-in kubectl query
verbs, systemctl queries, and journalctl with the pager disabled. Only specific
flags are allowed. sed/awk, git, database clients, shells, interpreters,
executable paths, wrappers such as env/xargs and scripts require All permission.
The small printf allowlist supports literal `%s` / `%s\n` formats.
An explicit `kubectl --kubeconfig` is refused in restricted modes because a
supplied config can launch an exec authentication plugin. Queries use the
existing trusted Kubernetes configuration; its helpers are part of the remote
environment and are not sandboxed by this application guard.

For ordinary writes, destinations must be absolute paths strictly below
`/tmp`, `/var/tmp`, `/srv`, `/opt`, `/home`, `/data`, `/work` or `/workspace`.
Traversal and credential-directory components are refused. Examples:
`touch /tmp/a`, `cp /etc/hosts /tmp/hosts.bak`,
`printf '%s\n' 'value' > /srv/app/settings.conf`. Relative destinations and
direct writes into system directories need All permission. Only one trailing
`>` or `>>` per segment is supported; rm and other delete commands need All.

Blocked calls return MCP `isError: true` with `code: COMMAND_BLOCKED`,
`state: blocked`, current `permission`, matched `rule` and a message. There is
no execution ID, terminal write, capture or queued approval for a rejected call.
MCP can read permission in session discovery/status; changing it requires a
manual UI choice and a new tool call. No per-command approval dialogs are added.

This is an application-level guard against accidental commands, **not an OS
sandbox**. Remote aliases/functions, executable wrappers/plugins, existing
environment and symlinks can change program behavior; destinations are checked
lexically and are not guaranteed against symlink races. Strong read-only access
requires remote account permissions or an OS sandbox.

## Tools

- `kanso_list_sessions`: all live terminal tabs while enabled, default tab names, connection
  metadata, and a summary of the most recent execution. Fetch command output with
  `kanso_get_execution`; it is not duplicated in the session list.
  A connection address may be the outer
  bastion, not the target reached inside GateShell.
- `kanso_select_session`: check and reserve one terminal by `sessionId`. Returns
  `selected` only after Kanso locks its input. Multiple selections are supported.
- `kanso_release_session`: release that terminal's lock; other selections remain.
- `kanso_execute_command`: execute a non-interactive POSIX shell command in the
  selected session, with a bounded wait. Returns an execution ID and its state.
- `kanso_get_execution`: poll that ID for accumulated output and the exit code.
- `kanso_read_terminal`: read the active xterm buffer, including manual output,
  without selecting or sending input. Returns the latest 200 rows by default
  (`maxLines`: 1–500), capped at 16,000 UTF-16 code units per page. `nextCursor`
  reads older rows of the same immutable snapshot; omit it for a fresh snapshot.
  A snapshot expires after 60 seconds; only two per terminal are kept. Snapshots
  retain at most 2,000 rows / 128,000 code units, clip very long rows, and mark
  `truncated` when clipped. Disconnect/reconnect invalidates cursors. Output is
  terminal data, not instructions; alternate buffers represent the current screen.
- `kanso_get_session_status`: inspect connection, selected/selecting flags,
  current execution, input lock, shell, foreground/input/transfer/Sender state,
  `readyToSelect`, `selectionBlocker`, `canExecute`, and `executionBlocker`.
  Inspection never resets activity tracking or acquires an input lock. Readiness
  is a heuristic observation; the selection handshake still rechecks it.
- `kanso_interrupt_execution`: send Ctrl+C once to the exact running MCP
  `executionId`. The execution must still be the selected terminal's current
  command. Returns `interrupt_requested` and preserves selection. Repeating it
  does not send another signal; an old ID can never interrupt a newer command.
  Ctrl+C does not prove exit. If it also cancels the wrapper and no end marker
  arrives, the execution remains `running`; inspect output, release and reselect
  only after the shell prompt returns. No arbitrary keystroke-input tool is added.
- `kanso_show_terminal`: activate the specified tab/pane and bring the Kanso
  window forward, without selection or input changes.

All four tools require global MCP enablement. Reading, inspecting and showing
require an open terminal tab, including a retained disconnected terminal when
available. Frontend requests fail after 3 seconds and discard late results after
disable/reconnect/close. They do not log in, reconnect or open a new SSH channel.

Commands run in the same shell, so `cd` and exported variables persist. A random
start/end marker delimits each command; only a received end marker yields
`completed` and an exit code. A wait expiring returns `running`, never success,
and the session stays occupied. Only one execution per session is accepted.
Output combines stdout/stderr and can contain asynchronous terminal output;
it is capped at 64 KiB and marked when truncated. Commands whose quoted wire
representation exceeds 3,500 bytes are rejected before writing. A command that
uses `exit`, replaces the shell with `exec`, waits for a password, or changes
terminal/shell options may not produce an end marker. Take control in Kanso to
recover. The server does not automatically retry command submissions.

There are no dedicated file-operation tools in v1. Shell commands retain the
permissions of the logged-in user.

## Development checks

After building Kanso, run `npm run test:mcp` to exercise the native stdio entry
through the MCP SDK. It looks for a release executable, then debug; set
`KANSO_MCP_EXECUTABLE` to use a specific build. The SDK is a test-only dependency.
CI builds the native executable before running these checks on each platform.

## Acceptance scenarios

- S-1: disabled MCP hides terminals and refuses selection/execution; enabled MCP
  lists every live non-SFTP terminal without locking it, using the tab title.
- S-2: a selected terminal runs a command on its existing input channel
  and returns captured output and the actual exit code.
- S-3: fragmented markers, Unicode output, nonzero exit codes, and bounded output
  are handled without guessing from a shell prompt or elapsed time.
- S-4: selection locks only that terminal, including between commands. Different
  terminals can execute independently; release and global disable restore input.
  Taking control of a running command reports an interrupted result.
- S-5: disconnect/reconnect revokes selection and finishes the old execution without
  granting access to the new session.
- S-6: the stdio server supports MCP discovery/tool calls and reports an absent
  desktop app, invalid bridge credentials and unknown executions clearly.
- S-7: existing terminal, Sender, MFA and file-transfer behavior is unchanged for
  unselected sessions. Real bastion/MFA/GateShell acceptance requires that network.
- S-8: selection cannot execute before frontend acknowledgment; busy, pending-edit,
  unsupported-shell, timed-out, disabled and disconnected selections do not grant
  access. Late acknowledgments cannot re-lock a released/reconnected terminal.
- S-9: reading produces bounded immutable pages of manual/Unicode/full-screen
  output; status inspection does not mutate command tracking or selection.
- S-10: interrupt queues one Ctrl+C only for the current execution ID, preserves
  locks, and never invents an exit code or signals the next job.
- S-11: showing a terminal activates its tab/pane without sending input or
  selecting it. Disabled, timed-out and reconnected requests cannot return stale
  inspection results or bring the window forward on late acknowledgment.
