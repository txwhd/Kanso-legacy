import { useCallback, useEffect, useRef, useState } from "react";

import {
  setMcpEnabled,
  setMcpPermission,
  takeMcpControl,
  useMcp,
} from "../mcp";
import type { McpPermission } from "../api";
import { MCP_PERMISSIONS } from "../mcpConfig";
import { useStore } from "../store";
import { McpConfigDialog } from "./McpConfigDialog";

/** One application-wide switch; terminal selection belongs to the MCP client. */
export function McpStatusControl() {
  const enabled = useMcp((state) => state.enabled);
  const bridgeFile = useMcp((state) => state.bridgeFile);
  const bridgeError = useMcp((state) => state.error);
  const permission = useMcp((state) => state.permission);
  const [busy, setBusy] = useState(false);
  const [configOpen, setConfigOpen] = useState(false);
  const [hoverOpen, setHoverOpen] = useState(false);
  const dismissTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeHover = useCallback(() => setHoverOpen(false), []);
  const closeConfig = useCallback(() => setConfigOpen(false), []);
  const showHover = () => {
    if (dismissTimer.current) clearTimeout(dismissTimer.current);
    setHoverOpen(true);
  };
  const dismissHover = () => {
    dismissTimer.current = setTimeout(closeHover, 200);
  };
  useEffect(
    () => () => {
      if (dismissTimer.current) clearTimeout(dismissTimer.current);
    },
    [],
  );
  const toggle = async () => {
    setBusy(true);
    try {
      await setMcpEnabled(!enabled);
    } catch (error) {
      useStore.getState().setStatus(String(error));
    } finally {
      setBusy(false);
    }
  };
  const changePermission = async (value: McpPermission) => {
    setBusy(true);
    try {
      await setMcpPermission(value);
    } catch (error) {
      useStore.getState().setStatus(String(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <div
        className="mcp-switch-info"
        onMouseEnter={showHover}
        onMouseLeave={dismissHover}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) closeHover();
        }}
      >
        <button
          type="button"
          className={`status-action mcp-status${enabled ? " is-enabled" : ""}${bridgeError ? " has-error" : ""}`}
          onFocus={showHover}
          aria-expanded={configOpen || (enabled && hoverOpen)}
          aria-haspopup="dialog"
          title={
            bridgeError ??
            (enabled
              ? "MCP enabled · stdio. Hover to view configuration; click to keep it open."
              : "MCP disabled. Click to view client configuration.")
          }
          onClick={() => setConfigOpen(true)}
        >
          <span className="mcp-status-dot" aria-hidden="true" />
          <span aria-live="polite">
            MCP {bridgeError ? "Unavailable" : enabled ? "On" : "Off"}
          </span>
        </button>
        {enabled && hoverOpen && !configOpen && (
          <McpConfigDialog popover onClose={closeHover} />
        )}
      </div>
      <select
        className="mcp-permission"
        aria-label="MCP permission"
        value={permission}
        disabled={busy || !bridgeFile}
        title={MCP_PERMISSIONS[permission].description}
        onChange={(event) =>
          void changePermission(event.target.value as McpPermission)
        }
      >
        {Object.entries(MCP_PERMISSIONS).map(([value, { label }]) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </select>
      <button
        type="button"
        role="switch"
        aria-label="MCP"
        aria-checked={enabled}
        className="mcp-toggle"
        disabled={busy || !bridgeFile}
        title={
          bridgeError ??
          (enabled
            ? "Disable MCP and release all selected terminals"
            : "Enable MCP for all connected terminals")
        }
        onClick={() => void toggle()}
      >
        <span className="mcp-toggle-thumb" aria-hidden="true" />
      </button>
      {configOpen && <McpConfigDialog onClose={closeConfig} />}
    </>
  );
}

export function McpNotice() {
  const enabled = useMcp((state) => state.enabled);
  const sessions = useMcp((state) => state.sessions);
  const selected = sessions.filter(
    (session) => session.selected || session.selecting,
  );
  const control = async (id: string) => {
    try {
      await takeMcpControl(id);
    } catch (error) {
      useStore.getState().setStatus(String(error));
    }
  };
  if (!enabled) return null;
  if (!selected.length)
    return (
      <div className="mcp-idle" role="status">
        MCP enabled · {sessions.length} connected terminals available. Your MCP
        client can list and select a terminal; unselected terminals remain
        editable.
      </div>
    );
  return (
    <div className="mcp-notices" aria-label="MCP selected terminals">
      {selected.map((session) => {
        const job = session.execution;
        const running = job?.state === "running";
        return (
          <div
            key={session.id}
            className="sender-pause mcp-notice"
            role="region"
            aria-label={`MCP · ${session.label}`}
          >
            <div className="sender-pause-message" role="status">
              <strong>
                MCP · {session.label} ·{" "}
                {session.selecting
                  ? "Selecting"
                  : running
                    ? "Running"
                    : "Selected · Locked"}
              </strong>
              {running ? (
                <>
                  <code title={job.command}>{job.command}</code>
                  <span>Take control if the command needs input.</span>
                </>
              ) : (
                <span>
                  {job?.state === "completed"
                    ? `Last command exited with code ${job.exitCode}. `
                    : ""}
                  This terminal is reserved for MCP. Other terminals remain
                  editable.
                </span>
              )}
            </div>
            <div className="sender-pause-actions">
              <button
                className="btn"
                onClick={() => useStore.getState().setActive(session.id)}
              >
                Show Terminal
              </button>
              <button className="btn" onClick={() => void control(session.id)}>
                Release / Take Control
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
