import { useSyncExternalStore } from "react";

export type PauseDecision = "wait" | "stop" | "force";
export interface SenderPause {
  id: number;
  sessionId: string;
  nextLine: string | null;
  reason: "timeout" | "untracked";
}

let serial = 0;
let pauses: SenderPause[] = [];
const answers = new Map<number, (decision: PauseDecision) => void>();
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((listener) => listener());
export const getSenderPauses = () => pauses;
export function subscribeSenderPauses(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export const useSenderPauses = () =>
  useSyncExternalStore(subscribeSenderPauses, getSenderPauses);

export function answerSenderPause(id: number, decision: PauseDecision) {
  answers.get(id)?.(decision);
}

/** Requests remain visible even when the Sender panel is hidden. */
export function requestSenderPause(
  pause: Omit<SenderPause, "id">,
  signal: AbortSignal,
): Promise<PauseDecision> {
  if (signal.aborted) return Promise.resolve("stop");
  return new Promise((resolve) => {
    const id = ++serial;
    const done = (decision: PauseDecision) => {
      signal.removeEventListener("abort", cancelled);
      answers.delete(id);
      pauses = pauses.filter((entry) => entry.id !== id);
      notify();
      resolve(decision);
    };
    const cancelled = () => done("stop");
    answers.set(id, done);
    signal.addEventListener("abort", cancelled, { once: true });
    pauses = [...pauses, { ...pause, id }];
    notify();
  });
}
