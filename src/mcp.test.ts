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
  listener: vi.fn(),
  isSending: vi.fn(),
}));
vi.mock("./api", () => ({
  mcpUiState: mocks.snapshot,
  mcpSetEnabled: mocks.enabled,
  mcpReleaseSession: mocks.release,
  mcpFinishSelection: mocks.finish,
  mcpSyncLabels: mocks.labels,
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
};
const other = { ...controller, sessionId: "other", setMcpShared: vi.fn() };
const tab = {
  info: { id: "session", kind: "ssh", name: "bastion" },
  state: "connected",
  ordinal: 0,
} as Tab;
const empty: McpUiState = {
  enabled: false,
  revision: 0,
  selections: [],
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
