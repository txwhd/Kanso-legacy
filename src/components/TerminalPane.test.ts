import { PhysicalPosition } from "@tauri-apps/api/dpi";
import type { EventCallback, UnlistenFn } from "@tauri-apps/api/event";
import type { DragDropEvent } from "@tauri-apps/api/webview";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({ listen: vi.fn(), windows: false, mac: false }));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: native.listen }),
}));
vi.mock("../platform", () => ({
  get IS_MAC() { return native.mac; },
  get IS_WINDOWS() { return native.windows; },
}));
vi.mock("../actions", () => ({ ensureController: vi.fn() }));

import { ensureController } from "../actions";
import { useStore, type Tab } from "../store";
import { TerminalController } from "../terminal";
import { disposeController, getController, setController } from "../terminalRegistry";
import { SessionPane } from "./TerminalPane";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// jsdom has no layout hit testing; choose the actual pane under the test point.
Object.defineProperty(document, "elementFromPoint", {
  configurable: true,
  value: () => null,
});

const initialState = useStore.getState();
const listeners = new Set<EventCallback<DragDropEvent>>();
const outputs = new Map<string, ReturnType<typeof vi.fn>>();
let root: Root;
let container: HTMLDivElement;

function tab(id: string, kind: Tab["info"]["kind"] = "ssh"): Tab {
  return {
    info: {
      id, kind, profileId: null, name: id, protocol: "SSH",
      address: kind === "local" ? (native.windows ? "cmd.exe" : "/bin/zsh") : "host:22",
      color: null, supportsRemoteFiles: kind === "ssh", legacyAlgorithms: [],
    },
    profile: { id, name: id, kind },
    number: 1, ordinal: 0, state: "connected", commandActivity: "idle",
    activityKind: "command", cols: 80, rows: 24, paneId: `pane-${id}`,
  };
}

async function render(tabs: Tab[], hidden: string[] = []) {
  await act(async () => {
    useStore.setState({
      tabs,
      panes: tabs.map((item) => ({ id: item.paneId, activeTabId: item.info.id })),
    });
    root.render(createElement("div", null, ...tabs.map((item) =>
      createElement(SessionPane, {
        key: item.info.id, tab: item, visible: !hidden.includes(item.info.id),
        focused: false, style: {},
      }),
    )));
  });
  const hosts = Array.from(container.querySelectorAll<HTMLElement>(".term-pane"));
  hosts.forEach((host, index) => {
    vi.spyOn(host, "getBoundingClientRect").mockReturnValue({
      left: index * 400, right: (index + 1) * 400, top: 0, bottom: 300,
      width: 400, height: 300, x: index * 400, y: 0, toJSON() {},
    });
  });
  vi.spyOn(document, "elementFromPoint").mockImplementation((x) => hosts[Math.floor(x / 400)] ?? null);
  return hosts;
}

async function emit(payload: DragDropEvent) {
  await act(async () => {
    for (const handler of listeners) handler({ event: "tauri://drag-drop", id: 0, payload });
  });
}

const drop = (paths: string[], x = 100, y = 100) => emit({
  type: "drop", paths, position: new PhysicalPosition(x, y),
});

beforeEach(() => {
  native.windows = false;
  native.mac = false;
  listeners.clear();
  outputs.clear();
  native.listen.mockReset().mockImplementation(async (handler: EventCallback<DragDropEvent>) => {
    listeners.add(handler);
    return () => { listeners.delete(handler); };
  });
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.spyOn(window, "devicePixelRatio", "get").mockReturnValue(2);
  useStore.setState({ ...initialState, activeId: null }, true);
  vi.mocked(ensureController).mockImplementation(async (id) => {
    const existing = getController(id);
    if (existing) return existing;
    const onData = vi.fn();
    outputs.set(id, onData);
    const controller = new TerminalController(id, {
      onData, onResize() {}, onStatus() {}, onCommand() {}, onCommandState() {}, suggest: () => [],
    }, 13, 100);
    vi.spyOn(controller, "setVisible").mockImplementation(() => {});
    vi.spyOn(controller, "fit").mockReturnValue(null);
    setController(id, controller);
    return controller;
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  for (const id of outputs.keys()) disposeController(id);
  container.remove();
  useStore.setState(initialState, true);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("local files dropped into a terminal", () => {
  it("pastes multiple absolute paths literally, without executing or changing the clipboard", async () => {
    await render([tab("ssh")]);
    const clipboard = vi.fn();
    vi.stubGlobal("navigator", { clipboard: { writeText: clipboard } });
    await drop([String.raw`C:\Users\曹丁\My files\a.txt`, "/tmp/O'Brien $HOME;$(id).txt"]);
    expect(outputs.get("ssh")).toHaveBeenCalledExactlyOnceWith(
      String.raw`C:\\Users\\曹丁\\My\ files\\a.txt /tmp/O\'Brien\ \$HOME\;\$\(id\).txt`,
    );
    expect(useStore.getState().activeId).toBe("ssh");
    expect(clipboard).not.toHaveBeenCalled();
  });

  it.each([false, true])("routes by the drop position with Windows=%s at 200%% scaling", async (windows) => {
    native.windows = windows;
    await render([tab("left"), tab("right")]);
    const controller = getController("right")!;
    const focus = vi.spyOn(controller, "focus");
    await drop(["/tmp/file"], windows ? 1000 : 500, windows ? 200 : 100);
    expect(outputs.get("left")).not.toHaveBeenCalled();
    expect(outputs.get("right")).toHaveBeenCalledExactlyOnceWith("/tmp/file");
    expect(focus).toHaveBeenCalledOnce();
    expect(useStore.getState().activeId).toBe("right");
  });

  it.each([false, true])("pastes desktop paths into a POSIX local terminal with macOS=%s", async (mac) => {
    native.mac = mac;
    await render([tab("local", "local")]);
    await drop(["/Users/test/My files/中文.txt", "/Users/test/O'Brien.txt"]);
    expect(outputs.get("local")).toHaveBeenCalledExactlyOnceWith(
      String.raw`/Users/test/My\ files/中文.txt /Users/test/O\'Brien.txt`,
    );
    expect(useStore.getState().activeId).toBe("local");
  });

  it("uses logical Retina coordinates to focus the dropped-on macOS local split", async () => {
    native.mac = true;
    await render([tab("left", "local"), tab("right", "local")]);
    const focus = vi.spyOn(getController("right")!, "focus");
    await drop(["/Users/test/file.txt"], 500, 100);
    expect(outputs.get("left")).not.toHaveBeenCalled();
    expect(outputs.get("right")).toHaveBeenCalledExactlyOnceWith("/Users/test/file.txt");
    expect(focus).toHaveBeenCalledOnce();
    expect(useStore.getState().activeId).toBe("right");
  });

  it("ignores hidden and ended macOS local terminals", async () => {
    native.mac = true;
    await render([
      tab("hidden", "local"), { ...tab("closed", "local"), state: "closed" },
    ], ["hidden"]);
    await drop(["/Users/test/file.txt"]);
    await drop(["/Users/test/file.txt"], 500);
    expect(native.listen).not.toHaveBeenCalled();
    for (const output of outputs.values()) expect(output).not.toHaveBeenCalled();
  });

  it.each(["cmd.exe", '"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -NoLogo'])(
    "pastes Windows local paths for %s, quoting only where needed", async (shell) => {
      native.windows = true;
      const local = tab("local", "local");
      // The backend resolves a default shell into info.address even when
      // profile.shell is unset, so default CMD and explicit pwsh both work.
      local.info.address = shell;
      await render([local]);
      await drop([String.raw`D:\data\logs\app.log`, String.raw`D:\My files\中文.txt`]);
      expect(outputs.get("local")).toHaveBeenCalledExactlyOnceWith(
        String.raw`D:\data\logs\app.log "D:\My files\中文.txt"`,
      );
    },
  );

  it("leaves drops over the Filer or a covering dialog alone", async () => {
    await render([tab("ssh")]);
    await drop(["/tmp/file"], 600);
    const dialog = document.createElement("div");
    vi.mocked(document.elementFromPoint).mockReturnValue(dialog);
    await drop(["/tmp/file"]);
    expect(outputs.get("ssh")).not.toHaveBeenCalled();
  });

  it("ignores hover, leave and empty drops", async () => {
    await render([tab("ssh")]);
    const position = new PhysicalPosition(100, 100);
    await emit({ type: "enter", paths: ["/tmp/file"], position });
    await emit({ type: "over", position });
    await emit({ type: "leave" });
    await drop([]);
    expect(outputs.get("ssh")).not.toHaveBeenCalled();
  });

  it("does not paste into hidden, disconnected or connecting terminals", async () => {
    await render([
      tab("hidden"),
      { ...tab("closed"), state: "closed" },
      { ...tab("connecting"), state: "connecting" },
    ], ["hidden"]);
    for (const x of [100, 500, 900]) await drop(["/tmp/file"], x);
    expect(native.listen).not.toHaveBeenCalled();
    for (const output of outputs.values()) expect(output).not.toHaveBeenCalled();
  });

  it("stops accepting drops when the session disconnects", async () => {
    await render([tab("ssh")]);
    await render([{ ...tab("ssh"), state: "closed" }]);
    await drop(["/tmp/file"]);
    expect(outputs.get("ssh")).not.toHaveBeenCalled();
    expect(listeners.size).toBe(0);
  });

  it.each([false, true])("preserves bracketed paste and the stdin lock with macOS local=%s", async (macLocal) => {
    native.mac = macLocal;
    await render([tab("terminal", macLocal ? "local" : "ssh")]);
    const controller = getController("terminal")!;
    await new Promise<void>((resolve) => controller.term.write("\x1b[?2004h", resolve));
    await drop(["/tmp/file"]);
    expect(outputs.get("terminal")).toHaveBeenCalledExactlyOnceWith("\x1b[200~/tmp/file\x1b[201~");
    outputs.get("terminal")!.mockClear();
    controller.term.options.disableStdin = true;
    await drop(["/tmp/other"]);
    expect(outputs.get("terminal")).not.toHaveBeenCalled();
  });

  it.each(["\n", "\r", "\x1b", "\t"])("rejects a batch containing control byte %j", async (control) => {
    await render([tab("ssh")]);
    await drop(["/tmp/good", `/tmp/bad${control}name`]);
    expect(outputs.get("ssh")).not.toHaveBeenCalled();
    expect(container.querySelector(".transfer-notice.is-error")?.textContent).toContain("control characters");
  });

  it("cleans up a listener that resolves after its pane has gone away", async () => {
    let resolve!: (off: UnlistenFn) => void;
    native.listen.mockImplementationOnce((handler: EventCallback<DragDropEvent>) => {
      listeners.add(handler);
      return new Promise<UnlistenFn>((done) => { resolve = done; });
    });
    await render([tab("ssh")]);
    await act(async () => root.render(null));
    await drop(["/tmp/file"]);
    expect(outputs.get("ssh")).not.toHaveBeenCalled();
    const off = vi.fn();
    resolve(off);
    await Promise.resolve();
    expect(off).toHaveBeenCalledOnce();
  });
});
