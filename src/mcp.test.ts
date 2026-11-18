import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { McpUiState } from "./api";
import type { Tab } from "./store";
import type { TerminalController } from "./terminal";

const mocks = vi.hoisted(() => ({
  snapshot: vi.fn(),
  enabled: vi.fn(),
  release: vi.fn(),
  finish: vi.fn(),
  labels: vi.fn(),
  finishRequest: vi.fn(),
  validateRequest: vi.fn(),
  listener: vi.fn(),
  isSending: vi.fn(),
}));
vi.mock("./api", () => ({
  mcpUiState: mocks.snapshot,
  mcpSetEnabled: mocks.enabled,
  mcpReleaseSession: mocks.release,
  mcpFinishSelection: mocks.finish,
  mcpSyncLabels: mocks.labels,
  mcpFinishRequest: mocks.finishRequest,
  mcpValidateRequest: mocks.validateRequest,
  onMcpChanged: mocks.listener,
}));
vi.mock("./senderSend", () => ({ isSending: mocks.isSending }));
vi.mock("./platform", () => ({ IS_MAC: false, IS_WINDOWS: true }));
import {
  prepareMcpSelection,
  setMcpEnabled,
  takeMcpControl,
  useMcp,
  watchMcp,
} from "./mcp";
import { useStore } from "./store";
import { disposeController, setController } from "./terminalRegistry";

const controller = {
  sessionId: "session",
  prepareMcpSelection: vi.fn(),
  mcpSharingBlocker: vi.fn(),
  setMcpShared: vi.fn(),
  dispose: vi.fn(),
  readMcpTerminal: vi.fn(),
  mcpTerminalStatus: vi.fn(),
};
const other = { ...controller, sessionId: "other", setMcpShared: vi.fn() };
const tab = {
  info: { id: "session", kind: "ssh", name: "bastion" },
  state: "connected",
  ordinal: 0,
} as Tab;
const empty: McpUiState = {
  enabled: false,
  permission: "read_only",
  revision: 0,
  selections: [],
  requests: [],
  bridgeFile: "bridge-file",
  error: null,
  sessions: [],
};
const available = {
  id: "session",
  label: "bastion",
  connectionName: "bastion",
  connectionAddress: "bastion:22",
  kind: "ssh",
  selected: false,
  selecting: false,
  execution: null,
};
let stop: (() => void) | undefined;
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  vi.resetAllMocks();
  mocks.isSending.mockReturnValue(false);
  mocks.labels.mockResolvedValue(undefined);
  mocks.finishRequest.mockResolvedValue({ state: "completed" });
  controller.readMcpTerminal.mockReturnValue({
    output: "manual output",
    nextCursor: null,
  });
  controller.mcpTerminalStatus.mockReturnValue({
    readyToSelect: true,
    selectionBlocker: null,
    inputLocked: false,
  });
  mocks.enabled.mockResolvedValue(undefined);
  mocks.release.mockResolvedValue(undefined);
  mocks.snapshot.mockResolvedValue(empty);
  mocks.listener.mockResolvedValue(vi.fn());
  controller.prepareMcpSelection.mockReturnValue(true);
  controller.mcpSharingBlocker.mockReturnValue("Clear the shell input first.");
  setController("session", controller as unknown as TerminalController);
  setController("other", other as unknown as TerminalController);
  useStore.setState({ tabs: [tab] });
  useMcp.setState(empty);
});
afterEach(() => {
  stop?.();
  stop = undefined;
  disposeController("session");
  disposeController("other");
});

describe("global MCP selection", () => {
  it("reads terminal pages and queries status without selecting or changing tracking", async () => {
    let snapshot: McpUiState = {
      ...empty,
      enabled: true,
      revision: 1,
      requests: [
        {
          id: "read",
          sessionId: "session",
          method: "read_terminal",
          params: { maxLines: 12, cursor: "snapshot:24" },
          state: "pending",
          result: null,
          message: null,
        },
        {
          id: "status",
          sessionId: "session",
          method: "get_session_status",
          params: { maxLines: 200, cursor: null },
          state: "pending",
          result: null,
          message: null,
        },
      ],
    };
    mocks.snapshot.mockImplementation(async () => snapshot);
    mocks.finishRequest.mockImplementation(async () => {
      snapshot = { ...snapshot, revision: 2, requests: [] };
      return { state: "completed" };
    });
    stop = watchMcp();
    await tick();
    await tick();
    expect(controller.readMcpTerminal).toHaveBeenCalledWith(12, "snapshot:24");
    expect(mocks.finishRequest).toHaveBeenCalledWith(
      "read",
      { output: "manual output", nextCursor: null },
      null,
    );
    expect(mocks.finishRequest).toHaveBeenCalledWith(
      "status",
      expect.objectContaining({
        readyToSelect: true,
        senderRunning: false,
        tabState: "connected",
      }),
      null,
    );
    expect(controller.prepareMcpSelection).not.toHaveBeenCalled();
    expect(mocks.finish).not.toHaveBeenCalled();
    expect(controller.setMcpShared.mock.calls.some(([locked]) => locked)).toBe(
      false,
    );
  });

  it("reports Sender as a selection blocker without trying to recover the terminal", async () => {
    mocks.isSending.mockReturnValue(true);
    let snapshot: McpUiState = {
      ...empty,
      enabled: true,
      revision: 1,
      requests: [
        {
          id: "status",
          sessionId: "session",
          method: "get_session_status",
          params: { maxLines: 200, cursor: null },
          state: "pending",
          result: null,
          message: null,
        },
      ],
    };
    mocks.snapshot.mockImplementation(async () => snapshot);
    mocks.finishRequest.mockImplementation(async () => {
      snapshot = { ...snapshot, requests: [], revision: 2 };
      return { state: "completed" };
    });
    stop = watchMcp();
    await tick();
    await tick();
    expect(mocks.finishRequest).toHaveBeenCalledWith(
      "status",
      expect.objectContaining({
        readyToSelect: false,
        senderRunning: true,
        selectionBlocker: expect.stringMatching(/Sender/),
      }),
      null,
    );
    expect(controller.prepareMcpSelection).not.toHaveBeenCalled();
  });

  it.each(["completed", "failed"])(
    "activates a tab only after an accepted show request (%s)",
    async (state) => {
      const activate = vi
        .spyOn(useStore.getState(), "setActive")
        .mockImplementation(() => {});
      let snapshot: McpUiState = {
        ...empty,
        enabled: true,
        revision: 1,
        requests: [
          {
            id: "show",
            sessionId: "session",
            method: "show_terminal",
            params: { maxLines: 200, cursor: null },
            state: "pending",
            result: null,
            message: null,
          },
        ],
      };
      mocks.snapshot.mockImplementation(async () => snapshot);
      mocks.validateRequest.mockImplementation(async () => {
        expect(activate).not.toHaveBeenCalled();
        if (state === "failed") {
          snapshot = { ...snapshot, requests: [], revision: 2 };
          throw new Error("Request revoked");
        }
        return { state: "pending" };
      });
      mocks.finishRequest.mockImplementation(async () => {
        expect(activate).toHaveBeenCalledWith("session");
        snapshot = { ...snapshot, requests: [], revision: 2 };
        return { state };
      });
      stop = watchMcp();
      await tick();
      await tick();
      expect(activate).toHaveBeenCalledTimes(state === "completed" ? 1 : 0);
      expect(controller.prepareMcpSelection).not.toHaveBeenCalled();
      activate.mockRestore();
    },
  );

  it("enables globally without selecting or locking any controller", async () => {
    await setMcpEnabled(true);
    expect(mocks.enabled).toHaveBeenCalledWith(true);
    expect(controller.setMcpShared).not.toHaveBeenCalled();
    stop = watchMcp();
    await tick();
    expect(mocks.finish).not.toHaveBeenCalled();
    expect(controller.setMcpShared).toHaveBeenLastCalledWith(false);
  });

  it("uses default tab titles and syncs new or duplicated tabs without a selection dialog", async () => {
    stop = watchMcp();
    await tick();
    expect(mocks.labels).toHaveBeenLastCalledWith([
      { id: "session", name: "bastion" },
    ]);
    useStore.setState({
      tabs: [tab, { ...tab, info: { ...tab.info, id: "other" }, ordinal: 1 }],
    });
    expect(mocks.labels).toHaveBeenLastCalledWith([
      { id: "session", name: "bastion" },
      { id: "other", name: "bastion (1)" },
    ]);
    const calls = mocks.labels.mock.calls.length;
    useStore.setState({ error: "unrelated status" });
    expect(mocks.labels).toHaveBeenCalledTimes(calls);
  });

  it("checks and locks only the MCP-selected terminal before acknowledging ownership", async () => {
    let snapshot: McpUiState = {
      ...empty,
      enabled: true,
      revision: 1,
      selections: [
        {
          id: "claim",
          sessionId: "session",
          state: "selecting",
          message: null,
        },
      ],
      sessions: [
        { ...available, selecting: true },
        { ...available, id: "other" },
      ],
    };
    mocks.snapshot.mockImplementation(async () => snapshot);
    mocks.finish.mockImplementation(async (id, error) => {
      expect(id).toBe("claim");
      expect(error).toBeNull();
      expect(controller.setMcpShared).toHaveBeenLastCalledWith(true);
      snapshot = {
        ...snapshot,
        revision: 2,
        selections: [],
        sessions: [
          { ...available, selected: true },
          { ...available, id: "other" },
        ],
      };
      return { id, sessionId: "session", state: "selected", message: null };
    });
    stop = watchMcp();
    await tick();
    await tick();
    expect(mocks.finish).toHaveBeenCalledOnce();
    expect(controller.setMcpShared).toHaveBeenLastCalledWith(true);
    expect(other.setMcpShared).toHaveBeenLastCalledWith(false);
  });

  it("rejects busy or not-ready selections without granting a lock", async () => {
    expect(prepareMcpSelection("unknown")).toMatch(/Connect/);
    mocks.isSending.mockReturnValue(true);
    expect(prepareMcpSelection("session")).toMatch(/Sender/);
    mocks.isSending.mockReturnValue(false);
    controller.prepareMcpSelection.mockReturnValue(false);
    let snapshot: McpUiState = {
      ...empty,
      enabled: true,
      revision: 1,
      selections: [
        {
          id: "claim",
          sessionId: "session",
          state: "selecting",
          message: null,
        },
      ],
      sessions: [{ ...available, selecting: true }],
    };
    mocks.snapshot.mockImplementation(async () => snapshot);
    mocks.finish.mockImplementation(async (_id, error) => {
      expect(error).toMatch(/Clear/);
      snapshot = {
        ...snapshot,
        revision: 2,
        selections: [],
        sessions: [available],
      };
      return {
        id: "claim",
        sessionId: "session",
        state: "failed",
        message: error,
      };
    });
    stop = watchMcp();
    await tick();
    await tick();
    expect(controller.setMcpShared.mock.calls.some(([locked]) => locked)).toBe(
      false,
    );
  });

  it("ignores a stale snapshot after selection was revoked", async () => {
    let changed = () => {};
    mocks.listener.mockImplementation((handler) => {
      changed = handler;
      return Promise.resolve(vi.fn());
    });
    let resolveOld: (value: McpUiState) => void = () => {};
    mocks.snapshot.mockReturnValueOnce(
      new Promise<McpUiState>((resolve) => {
        resolveOld = resolve;
      }),
    );
    mocks.snapshot.mockResolvedValueOnce({ ...empty, revision: 5 });
    stop = watchMcp();
    await tick();
    changed();
    await tick();
    resolveOld({
      ...empty,
      enabled: true,
      revision: 4,
      sessions: [{ ...available, selected: true }],
    });
    await tick();
    expect(useMcp.getState().revision).toBe(5);
    expect(controller.setMcpShared).toHaveBeenLastCalledWith(false);
  });

  it("leaves lock updates to authoritative snapshots after release or disabling", async () => {
    mocks.release.mockRejectedValueOnce(new Error("release failed"));
    await expect(takeMcpControl("session")).rejects.toThrow(/release/);
    expect(controller.setMcpShared).not.toHaveBeenCalled();
    await takeMcpControl("session");
    await setMcpEnabled(false);
    // A delayed response must never undo a newer selection's input lock.
    expect(controller.setMcpShared).not.toHaveBeenCalled();
    expect(other.setMcpShared).not.toHaveBeenCalled();
    stop = watchMcp();
    await tick();
    expect(controller.setMcpShared).toHaveBeenLastCalledWith(false);
    expect(other.setMcpShared).toHaveBeenLastCalledWith(false);
  });

  it("unsubscribes without processing later snapshots", async () => {
    const off = vi.fn();
    mocks.listener.mockResolvedValue(off);
    stop = watchMcp();
    await tick();
    stop();
    stop = undefined;
    await tick();
    expect(off).toHaveBeenCalledOnce();
  });
});
