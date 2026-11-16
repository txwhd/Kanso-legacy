import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./platform", () => ({ IS_MAC: false, IS_WINDOWS: true }));
import { HostKeyDialog } from "./components/HostKeyDialog";
import { useStore, type HostKeyPrompt } from "./store";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
const prompt = (sessionId: string, reason: "unknown" | "changed" = "unknown"): HostKeyPrompt => ({
  sessionId,
  profile: { id: sessionId, name: sessionId, kind: "ssh" },
  change: { reason, host: "server.example", port: 22, keyType: "ssh-ed25519",
    fingerprint: "SHA256:verified-fingerprint", publicKey: "public key",
    knownHosts: "/test/.ssh/known_hosts", line: reason === "unknown" ? null : 7,
    message: "verification required" },
});
beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  useStore.setState({ hostKeyPrompt: null, hostKeyQueue: [] });
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("host key decisions", () => {
  it("shows the first-contact fingerprint, defaults to Cancel and never auto-accepts", async () => {
    const accept = vi.fn().mockResolvedValue(undefined);
    const cancel = vi.fn();
    await act(async () => root.render(createElement(HostKeyDialog, {
      prompt: prompt("one"), onAccept: accept, onCancel: cancel,
    })));
    expect(container.textContent).toContain("Verify Host Key");
    expect(container.textContent).toContain("SHA256:verified-fingerprint");
    expect(container.textContent).not.toContain("line null");
    expect(document.activeElement?.textContent).toBe("Cancel");
    expect(accept).not.toHaveBeenCalled();
    await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("keeps a failed trust write visible and allows retry", async () => {
    const accept = vi.fn().mockRejectedValue(new Error("cannot save trust file: access denied"));
    await act(async () => root.render(createElement(HostKeyDialog, {
      prompt: prompt("one"), onAccept: accept, onCancel: vi.fn(),
    })));
    const button = Array.from(container.querySelectorAll("button"))
      .find((item) => item.textContent === "Trust and Connect")!;
    await act(async () => button.click());
    expect(container.textContent).toContain("access denied");
    expect(button.disabled).toBe(false);
  });

  it("retains explicit replacement wording for a changed key", async () => {
    await act(async () => root.render(createElement(HostKeyDialog, {
      prompt: prompt("one", "changed"), onAccept: vi.fn(), onCancel: vi.fn(),
    })));
    expect(container.textContent).toContain("Host Key Changed");
    expect(container.textContent).toContain("line 7");
    expect(container.textContent).toContain("Accept New Key");
  });

  it("queues concurrent host confirmations without losing another connection", () => {
    const store = useStore.getState();
    store.setHostKeyPrompt(prompt("one"));
    store.setHostKeyPrompt(prompt("two"));
    store.setHostKeyPrompt(prompt("three"));
    expect(useStore.getState().hostKeyPrompt?.sessionId).toBe("one");
    store.setHostKeyPrompt(null);
    expect(useStore.getState().hostKeyPrompt?.sessionId).toBe("two");
    store.setHostKeyPrompt(null);
    expect(useStore.getState().hostKeyPrompt?.sessionId).toBe("three");
    store.setHostKeyPrompt(null);
    expect(useStore.getState().hostKeyPrompt).toBeNull();
  });
});
