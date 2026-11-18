import { useEffect, useRef, useState } from "react";

import { mcpExecutablePath } from "../api";
import { useMcp } from "../mcp";
import { mcpClientConfig, type McpClient } from "../mcpConfig";
import { MCP_PERMISSIONS } from "../mcpConfig";

export function McpConfigDialog({
  onClose,
  popover = false,
}: {
  onClose: () => void;
  popover?: boolean;
}) {
  const bridgeFile = useMcp((state) => state.bridgeFile);
  const sessions = useMcp((state) => state.sessions);
  const permission = useMcp((state) => state.permission);
  const [executable, setExecutable] = useState("");
  const [client, setClient] = useState<McpClient>("codex");
  const [notice, setNotice] = useState("");
  const sectionRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    let active = true;
    if (!popover) closeRef.current?.focus();
    void mcpExecutablePath()
      .then((path) => {
        if (active) setExecutable(path ?? "");
      })
      .catch((error) => {
        if (active) setNotice(String(error));
      });
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }
      if (!popover && event.key === "Tab") {
        const elements = [
          ...(sectionRef.current?.querySelectorAll<HTMLElement>(
            "button:not(:disabled), select, textarea",
          ) ?? []),
        ];
        const first = elements[0],
          last = elements[elements.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    window.addEventListener("keydown", keydown, true);
    return () => {
      active = false;
      window.removeEventListener("keydown", keydown, true);
    };
  }, [onClose, popover]);
  const ready = Boolean(executable && bridgeFile);
  const config = ready
    ? mcpClientConfig(client, executable, bridgeFile!)
    : "Loading Kanso connection information…";
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(config);
      setNotice(
        "Copied. Merge the Kanso entry into your client's existing MCP configuration.",
      );
    } catch (error) {
      setNotice(
        `Copy failed: ${String(error)}. Select the text to copy manually.`,
      );
    }
  };
  const panel = (
    <section
      ref={sectionRef}
      className={`dialog mcp-config-dialog${popover ? " mcp-config-popover" : ""}`}
      role="dialog"
      aria-modal={popover ? undefined : true}
      aria-labelledby={popover ? "mcp-hover-title" : "mcp-config-title"}
      onMouseDown={(event) => event.stopPropagation()}
    >
      <div
        className="dialog-header"
        id={popover ? "mcp-hover-title" : "mcp-config-title"}
      >
        Kanso MCP · stdio
      </div>
      <div className="dialog-body mcp-config-body">
        <p>
          <strong>权限：{MCP_PERMISSIONS[permission].label}</strong> ·{" "}
          {MCP_PERMISSIONS[permission].description} 仅能在 Kanso
          中手动切换，重启后恢复只读。
        </p>
        <p>
          {sessions.length} connected terminals ·{" "}
          {sessions.filter((session) => session.selected).length} selected. Only
          selected terminals are input locked.
        </p>
        <p>
          Built into Kanso. No Node.js or source download required. Keep Kanso
          running; configure the AI client on this same computer.
        </p>
        <label className="session-field is-wide">
          <span className="session-field-label">Client</span>
          <select
            value={client}
            onChange={(event) => {
              setClient(event.target.value as McpClient);
              setNotice("");
            }}
          >
            <option value="codex">Codex · config.toml</option>
            <option value="dsh">DeepSeek Harness · YAML</option>
          </select>
        </label>
        <textarea
          aria-label="MCP client configuration"
          className="mcp-config-code"
          readOnly
          value={config}
          spellCheck={false}
        />
        <p>
          {client === "codex"
            ? "Merge this entry into ~/.codex/config.toml, then reconnect the MCP server."
            : "In DeepSeek Harness Settings → MCP, add kanso using transport stdio and the command/args below. This YAML is a cordis.patch.yml example; preserve your existing servers when merging."}
        </p>
        <p>
          List terminals → select sessionId → execute → release. Paths are for
          this computer; another user should copy their own Kanso configuration.
        </p>
        <div role="status">{notice}</div>
      </div>
      <div className="dialog-footer">
        <button className="btn" ref={closeRef} onClick={onClose}>
          Close
        </button>
        <button
          className="btn is-primary"
          disabled={!ready}
          onClick={() => void copy()}
        >
          Copy Configuration
        </button>
      </div>
    </section>
  );
  return popover ? (
    panel
  ) : (
    <div className="dialog-backdrop" onMouseDown={onClose}>
      {panel}
    </div>
  );
}
