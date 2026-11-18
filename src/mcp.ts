import { create } from "zustand";

import * as api from "./api";
import { isSending } from "./senderSend";
import { tabTitle, useStore } from "./store";
import { allControllers, getController } from "./terminalRegistry";

export const useMcp = create<api.McpUiState>(() => ({
  enabled: false,
  permission: "read_only",
  revision: 0,
  selections: [],
  requests: [],
  bridgeFile: null,
  error: null,
  sessions: [],
}));

/** Check the exact terminal at selection time, not when global MCP is enabled. */
export function prepareMcpSelection(id: string): string | null {
  const tab = useStore.getState().tabs.find((tab) => tab.info.id === id);
  if (!tab || tab.state !== "connected" || tab.info.kind === "sftp")
    return "Connect a terminal session first.";
  if (isSending(id))
    return "Stop Sender before selecting this terminal with MCP.";
  const controller = getController(id);
  if (!controller) return "The terminal is not ready yet.";
  if (!controller.prepareMcpSelection()) return controller.mcpSharingBlocker();
  return null;
}

export function watchMcp(): () => void {
  let stopped = false;
  let requestVersion = 0;
  const inFlight = new Set<string>();
  const requestsInFlight = new Set<string>();
  const reservations = new Map<string, string>();
  let lastLabels = "";
  const syncLabels = () => {
    const labels = useStore
      .getState()
      .tabs.filter((tab) => tab.state === "connected")
      .map((tab) => ({ id: tab.info.id, name: tabTitle(tab) }));
    const signature = JSON.stringify(labels);
    if (signature === lastLabels) return;
    lastLabels = signature;
    void api.mcpSyncLabels(labels).catch((error) => {
      if (!stopped) useMcp.setState({ error: String(error) });
    });
  };
  const refresh = async () => {
    const request = ++requestVersion;
    try {
      const snapshot = await api.mcpUiState();
      if (
        stopped ||
        request !== requestVersion ||
        snapshot.revision < useMcp.getState().revision
      )
        return;
      useMcp.setState(snapshot);
      const pending = new Set(
        snapshot.selections.map((selection) => selection.id),
      );
      for (const id of inFlight) if (!pending.has(id)) inFlight.delete(id);
      for (const [sessionId, claimId] of reservations)
        if (!pending.has(claimId)) reservations.delete(sessionId);
      const selected = new Set(
        snapshot.sessions
          .filter((session) => session.selected)
          .map((session) => session.id),
      );
      for (const controller of allControllers()) {
        if (!reservations.has(controller.sessionId))
          controller.setMcpShared(selected.has(controller.sessionId));
      }
      const requests = new Set(snapshot.requests.map((request) => request.id));
      for (const id of requestsInFlight)
        if (!requests.has(id)) requestsInFlight.delete(id);
      for (const request of snapshot.requests) {
        if (requestsInFlight.has(request.id)) continue;
        requestsInFlight.add(request.id);
        let result: Record<string, unknown> | null = null;
        let error: string | null = null;
        const originalTab = useStore
          .getState()
          .tabs.find((tab) => tab.info.id === request.sessionId);
        try {
          if (!snapshot.enabled) throw new Error("MCP is disabled");
          const tab = useStore
            .getState()
            .tabs.find((tab) => tab.info.id === request.sessionId);
          if (!tab || tab.info.kind === "sftp")
            throw new Error("Terminal tab is no longer open");
          const controller = getController(request.sessionId);
          if (request.method === "read_terminal") {
            if (!controller)
              throw new Error("Terminal output is not ready yet");
            result = controller.readMcpTerminal(
              request.params.maxLines,
              request.params.cursor,
            );
          } else if (request.method === "get_session_status") {
            const senderRunning = isSending(request.sessionId);
            const status = controller?.mcpTerminalStatus();
            result = {
              ...status,
              tabState: tab.state,
              label: tabTitle(tab),
              controllerReady: Boolean(controller),
              senderRunning,
              readyToSelect: Boolean(
                status?.readyToSelect &&
                !senderRunning &&
                tab.state === "connected",
              ),
              selectionBlocker:
                tab.state !== "connected"
                  ? "Terminal is disconnected"
                  : senderRunning
                    ? "Stop Sender before selecting this terminal"
                    : (status?.selectionBlocker ??
                      (controller ? null : "Terminal is not ready yet")),
            };
          } else {
            result = { state: "shown" };
          }
        } catch (cause) {
          error = String(cause);
        }
        void (async () => {
          if (request.method === "show_terminal" && !error) {
            await api.mcpValidateRequest(request.id);
            const current = useStore
              .getState()
              .tabs.find((tab) => tab.info.id === request.sessionId);
            if (
              stopped ||
              !useMcp.getState().enabled ||
              !current ||
              current.info !== originalTab?.info
            ) {
              return api.mcpFinishRequest(
                request.id,
                null,
                "Terminal changed before it could be shown",
              );
            }
            useStore.getState().setActive(request.sessionId);
          }
          return api.mcpFinishRequest(request.id, result, error);
        })()
          .catch((cause) => {
            if (!stopped) useMcp.setState({ error: String(cause) });
          })
          .finally(() => {
            if (!stopped) void refresh();
          });
      }
      for (const selection of snapshot.selections) {
        if (inFlight.has(selection.id)) continue;
        inFlight.add(selection.id);
        const error = prepareMcpSelection(selection.sessionId);
        const controller = getController(selection.sessionId);
        if (!error) {
          reservations.set(selection.sessionId, selection.id);
          controller?.setMcpShared(true);
        }
        // The backend reservation already excludes keyboard/Sender writes.
        // Grant execution only after this exact live controller was checked.
        void api
          .mcpFinishSelection(selection.id, error)
          .catch((error) => {
            if (!stopped) useMcp.setState({ error: String(error) });
          })
          .finally(() => {
            if (reservations.get(selection.sessionId) === selection.id)
              reservations.delete(selection.sessionId);
            if (!stopped) void refresh();
          });
      }
    } catch (error) {
      if (!stopped && request === requestVersion)
        useMcp.setState({ error: String(error) });
    }
  };
  const listener = api.onMcpChanged(() => void refresh());
  const unsubscribe = useStore.subscribe(syncLabels);
  // Also recover reservations if the client disappeared before polling.
  const timer = window.setInterval(() => void refresh(), 1000);
  void listener.then(() => {
    if (!stopped) {
      syncLabels();
      void refresh();
    }
  });
  return () => {
    stopped = true;
    window.clearInterval(timer);
    unsubscribe();
    void listener.then((off) => off());
  };
}

export async function setMcpEnabled(enabled: boolean): Promise<void> {
  await api.mcpSetEnabled(enabled);
}

export async function setMcpPermission(
  permission: api.McpPermission,
): Promise<void> {
  await api.mcpSetPermission(permission);
}

export async function takeMcpControl(id: string): Promise<void> {
  await api.mcpReleaseSession(id);
}
