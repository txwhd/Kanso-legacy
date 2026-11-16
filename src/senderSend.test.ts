import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./platform", () => ({ IS_MAC: false, IS_WINDOWS: true }));
vi.mock("./api", () => ({ writeSession: vi.fn().mockResolvedValue(undefined) }));
vi.mock("./terminalRegistry", () => ({ getController: vi.fn() }));

import * as api from "./api";
import { answerSenderPause, getSenderPauses } from "./senderPause";
import { getSchedule, startSchedule, stopSchedule } from "./senderSchedule";
import { isSending, LINE_TIMEOUT_MS, newStopSignal, sendUnits } from "./senderSend";
import { useStore, type Tab } from "./store";
import type { TerminalController } from "./terminal";
import { getController } from "./terminalRegistry";

const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const tabs = ["one", "two"].map((id) => ({
  info: { id, name: id, kind: "ssh" }, state: "connected",
})) as Tab[];
let stop = newStopSignal();

function controller(tracked = true) {
  const completions: (() => void)[] = [];
  const result = {
    isTransferActive: vi.fn(() => false),
    noteCommandSent: vi.fn(() => tracked),
    cancelCommandSent: vi.fn(),
    waitForCommand: vi.fn((ms: number, signal?: AbortSignal) =>
      new Promise<"complete" | "timeout" | "cancelled">((resolve) => {
        const done = (value: "complete" | "timeout" | "cancelled") => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", aborted);
          resolve(value);
        };
        const aborted = () => done("cancelled");
        const timer = setTimeout(() => done("timeout"), ms);
        completions.push(() => done("complete"));
        signal?.addEventListener("abort", aborted, { once: true });
      })),
    complete: () => completions.shift()?.(),
  };
  vi.mocked(getController).mockReturnValue(result as unknown as TerminalController);
  return result;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  vi.mocked(api.writeSession).mockResolvedValue(undefined);
  useStore.setState({ tabs });
  stop = newStopSignal();
});
afterEach(async () => {
  stop.stop();
  stopSchedule();
  await flush();
  expect(getSenderPauses()).toEqual([]);
  vi.useRealTimers();
});

describe("Sender completion decisions", () => {
  it("sends the next line only after the prompt returns", async () => {
    const terminal = controller();
    const run = sendUnits(["one"], ["sleep 60\n", "echo done\n"], "lf", stop);
    await flush();
    expect(api.writeSession).toHaveBeenCalledTimes(1);
    terminal.complete();
    await run;
    expect(api.writeSession).toHaveBeenLastCalledWith("one", "echo done\n");
    expect(getSenderPauses()).toEqual([]);
  });

  it("pauses on timeout and can wait again without sending anything", async () => {
    const terminal = controller();
    const run = sendUnits(["one"], ["sleep 60\n", "echo done\n"], "lf", stop);
    await flush();
    await vi.advanceTimersByTimeAsync(LINE_TIMEOUT_MS);
    expect(getSenderPauses()[0]).toMatchObject({ sessionId: "one", reason: "timeout" });
    expect(api.writeSession).toHaveBeenCalledTimes(1);
    answerSenderPause(getSenderPauses()[0].id, "wait");
    await flush();
    expect(getSenderPauses()).toEqual([]);
    expect(api.writeSession).toHaveBeenCalledTimes(1);
    // The timed-out waiter is stale; the newly registered wait must complete.
    terminal.complete();
    terminal.complete();
    await run;
    expect(api.writeSession).toHaveBeenCalledTimes(2);
  });

  it("stops the remaining script after timeout", async () => {
    controller();
    const run = sendUnits(["one"], ["sudo true\n", "never send\n"], "lf", stop);
    await flush();
    await vi.advanceTimersByTimeAsync(LINE_TIMEOUT_MS);
    answerSenderPause(getSenderPauses()[0].id, "stop");
    await run;
    expect(stop.stopped).toBe(true);
    expect(api.writeSession).toHaveBeenCalledTimes(1);
    expect(isSending("one")).toBe(false);
  });

  it("forces only the next line, keeping the following wait protected", async () => {
    controller();
    const run = sendUnits(["one"], ["first\n", "second\n", "third\n"], "lf", stop);
    await flush();
    await vi.advanceTimersByTimeAsync(LINE_TIMEOUT_MS);
    answerSenderPause(getSenderPauses()[0].id, "force");
    await flush();
    expect(api.writeSession).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(LINE_TIMEOUT_MS);
    expect(getSenderPauses()[0].nextLine).toBe("third\n");
    answerSenderPause(getSenderPauses()[0].id, "stop");
    await run;
    expect(api.writeSession).toHaveBeenCalledTimes(2);
  });

  it("pauses untrackable input instead of assuming a 100 ms delay is sufficient", async () => {
    controller(false);
    const run = sendUnits(["one"], ["first", "second"], "none", stop);
    await flush();
    expect(getSenderPauses()[0].reason).toBe("untracked");
    answerSenderPause(getSenderPauses()[0].id, "wait");
    await vi.advanceTimersByTimeAsync(LINE_TIMEOUT_MS);
    expect(api.writeSession).toHaveBeenCalledTimes(1);
    expect(getSenderPauses()[0].reason).toBe("untracked");
    answerSenderPause(getSenderPauses()[0].id, "force");
    await run;
    expect(api.writeSession).toHaveBeenLastCalledWith("one", "second");
  });

  it("cancels a paused script when the session disconnects, including a later reconnect", async () => {
    controller();
    const run = sendUnits(["one"], ["first\n", "second\n"], "lf", stop);
    await flush();
    await vi.advanceTimersByTimeAsync(LINE_TIMEOUT_MS);
    useStore.setState({ tabs: tabs.map((tab) => ({ ...tab, state: "closed" })) });
    useStore.setState({ tabs });
    await run;
    expect(getSenderPauses()).toEqual([]);
    expect(api.writeSession).toHaveBeenCalledTimes(1);
  });

  it("cancels all paused broadcast targets and releases their ownership", async () => {
    controller();
    const run = sendUnits(["one", "two"], ["first\n", "second\n"], "lf", stop);
    await flush();
    await vi.advanceTimersByTimeAsync(LINE_TIMEOUT_MS);
    expect(getSenderPauses()).toHaveLength(2);
    answerSenderPause(getSenderPauses()[0].id, "stop");
    await run;
    expect(api.writeSession).toHaveBeenCalledTimes(2);
    expect(isSending("one")).toBe(false);
    expect(isSending("two")).toBe(false);
  });

  it("stopping a paused schedule prevents future ticks", async () => {
    controller();
    startSchedule({ text: "first\nsecond", ending: "lf", target: "current",
      sessionId: "one", every: 1, times: 0 });
    await flush();
    await vi.advanceTimersByTimeAsync(LINE_TIMEOUT_MS);
    expect(getSenderPauses()).toHaveLength(1);
    answerSenderPause(getSenderPauses()[0].id, "stop");
    await flush();
    expect(getSchedule()).toBeNull();
    await vi.advanceTimersByTimeAsync(LINE_TIMEOUT_MS);
    expect(api.writeSession).toHaveBeenCalledTimes(1);
  });

  it("also pauses a single-line scheduled command until its prompt returns", async () => {
    const terminal = controller();
    startSchedule({ text: "sleep 60", ending: "lf", target: "current",
      sessionId: "one", every: 1, times: 0 });
    await flush();
    await vi.advanceTimersByTimeAsync(LINE_TIMEOUT_MS);
    expect(api.writeSession).toHaveBeenCalledTimes(1);
    expect(getSenderPauses()[0]).toMatchObject({ reason: "timeout", nextLine: null });
    answerSenderPause(getSenderPauses()[0].id, "wait");
    await flush();
    terminal.complete();
    terminal.complete();
    await flush();
    expect(api.writeSession).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(api.writeSession).toHaveBeenCalledTimes(2);
  });

  it.each(["current", "all"] as const)("stops a %s schedule if a target disconnects between ticks", async (target) => {
    const terminal = controller();
    terminal.waitForCommand.mockResolvedValue("complete");
    startSchedule({ text: "uptime", ending: "lf", target,
      sessionId: "one", every: 10, times: 0 });
    await flush();
    const sent = target === "all" ? 2 : 1;
    expect(api.writeSession).toHaveBeenCalledTimes(sent);
    expect(getSchedule()?.nextAt).not.toBeNull();
    useStore.setState({ tabs: tabs.map((tab) => tab.info.id === "one" ? { ...tab, state: "closed" } : tab) });
    expect(getSchedule()).toBeNull();
    useStore.setState({ tabs });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(api.writeSession).toHaveBeenCalledTimes(sent);
  });
});
