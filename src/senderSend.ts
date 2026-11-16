import * as api from "./api";
import { requestSenderPause } from "./senderPause";
import { useStore } from "./store";
import type { SendUnit } from "./senderUnits";
import { getController } from "./terminalRegistry";
import type { LineEnding } from "./types";

// The Sender's write path, shared by the panel's Run button and the repeat
// schedule (`senderSchedule.ts`). A script goes to a session one line at a
// time: a line the terminal can track (it has a line ending and the shell
// is at a prompt) is followed only once its prompt is back, so `cd` and a
// slow command are done before the next line arrives, instead of the whole
// script landing as typeahead that a password prompt or a pager would eat.

/** A missing prompt pauses the script; elapsed time never authorizes a write. */
export const LINE_TIMEOUT_MS = 30_000;

/** Lets a send in progress be abandoned between lines. */
export interface StopSignal {
  readonly stopped: boolean;
  stop(): void;
  readonly promise: Promise<void>;
  readonly signal: AbortSignal;
}

export function newStopSignal(): StopSignal {
  let stopped = false;
  const controller = new AbortController();
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return {
    get stopped() {
      return stopped;
    },
    stop() {
      stopped = true;
      controller.abort();
      resolve();
    },
    promise,
    signal: controller.signal,
  };
}

const busy = new Set<string>();

/** Whether a send to the session is still in progress. */
export const isSending = (id: string) => busy.has(id);

export interface SendOutcome {
  sent: string[];
  /** Sessions left out: a file transfer or another send owned them. */
  skipped: string[];
}

/**
 * Writes `units` to each session in `ids`, in order per session and all
 * sessions in parallel. A session with a transfer or a send in progress is
 * skipped rather than interleaved. Rejects with the first write failure.
 */
export async function sendUnits(
  ids: string[],
  units: SendUnit[],
  ending: LineEnding,
  stop: StopSignal,
  waitForLast = false,
): Promise<SendOutcome> {
  const sent = ids.filter(
    (id) => !busy.has(id) && !getController(id)?.isTransferActive()
      && useStore.getState().tabs.some((tab) => tab.info.id === id && tab.state === "connected"),
  );
  const skipped = ids.filter((id) => !sent.includes(id));
  for (const id of sent) busy.add(id);
  const unsubscribe = useStore.subscribe((state) => {
    if (sent.some((id) => !state.tabs.some((tab) => tab.info.id === id && tab.state === "connected"))) {
      stop.stop();
    }
  });
  try {
    // Keep ownership until every target has stopped, including a sibling
    // cancelled after a write failure in a broadcast.
    const results = await Promise.allSettled(sent.map(async (id) => {
      try {
        await sendSequence(id, units, ending, stop, waitForLast);
      } catch (error) {
        stop.stop();
        throw error;
      }
    }));
    const failed = results.find((result) => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
  } finally {
    unsubscribe();
    for (const id of sent) busy.delete(id);
  }
  return { sent, skipped };
}

async function sendSequence(
  id: string,
  units: SendUnit[],
  ending: LineEnding,
  stop: StopSignal,
  waitForLast: boolean,
): Promise<void> {
  for (let index = 0; index < units.length; index += 1) {
    if (stop.stopped) return;
    const unit = units[index];
    const controller = getController(id);
    // Told before the write so the prompt on screen becomes the completion
    // signature; false when the terminal cannot track this line.
    const tracked =
      ending !== "none" &&
      controller !== undefined &&
      controller.noteCommandSent(unit);
    try {
      await api.writeSession(id, unit);
    } catch (error) {
      if (tracked) controller.cancelCommandSent();
      throw error;
    }
    if (index === units.length - 1 && !waitForLast) return;
    while (!stop.stopped) {
      const result = tracked
        ? await controller.waitForCommand(LINE_TIMEOUT_MS, stop.signal)
        : await waitUntracked(id, index, units, stop);
      if (result === "complete" || result === "force") break;
      if (result === "closed" || result === "cancelled" || stop.stopped) {
        stop.stop();
        return;
      }
      // Untrackable sessions have already asked before waiting. They must
      // never turn a delay into an assumed successful command.
      if (!tracked) continue;
      const decision = await requestSenderPause({
        sessionId: id, nextLine: units[index + 1] ?? null, reason: "timeout",
      }, stop.signal);
      if (decision === "force") break;
      if (decision === "stop") { stop.stop(); return; }
    }
  }
}

async function waitUntracked(id: string, index: number, units: SendUnit[], stop: StopSignal) {
  const decision = await requestSenderPause({
    sessionId: id, nextLine: units[index + 1] ?? null, reason: "untracked",
  }, stop.signal);
  if (decision === "stop") { stop.stop(); return "cancelled"; }
  if (decision === "force") return "force";
  await new Promise<void>((resolve) => {
    const done = () => {
      window.clearTimeout(timer);
      stop.signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = window.setTimeout(done, LINE_TIMEOUT_MS);
    stop.signal.addEventListener("abort", done, { once: true });
    if (stop.stopped) done();
  });
  return "timeout";
}
