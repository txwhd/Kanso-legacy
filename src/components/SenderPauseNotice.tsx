import { answerSenderPause, useSenderPauses } from "../senderPause";
import { useStore } from "../store";

/** A non-modal notice leaves the terminal available for passwords and pagers. */
export function SenderPauseNotice() {
  const pauses = useSenderPauses();
  const tabs = useStore((state) => state.tabs);
  if (pauses.length === 0) return null;
  const pause = pauses[0];
  const name = tabs.find((tab) => tab.info.id === pause.sessionId)?.info.name ?? "Session";
  return (
    <div className="sender-pause" role="region" aria-label="Sender paused">
      <div className="sender-pause-message" role="status">
        <strong>Sender paused · {name}{pauses.length > 1 ? ` · ${pauses.length} sessions waiting` : ""}</strong>
        <span>{pause.reason === "timeout"
          ? "No shell prompt returned within 30 seconds."
          : "Cannot track this command’s completion."} You can use the terminal before continuing.</span>
        {pause.nextLine !== null
          ? <code title={pause.nextLine}>Next: {pause.nextLine}</code>
          : <span>Waiting before scheduling the next repetition.</span>}
      </div>
      <div className="sender-pause-actions">
        <button className="btn" onClick={() => answerSenderPause(pause.id, "wait")}>Continue Waiting</button>
        <button className="btn" onClick={() => answerSenderPause(pause.id, "stop")}>Stop Sending</button>
        <button className="btn is-danger" onClick={() => answerSenderPause(pause.id, "force")}>
          {pause.nextLine !== null ? "Force Send Next Line" : "Continue Schedule Anyway"}
        </button>
      </div>
    </div>
  );
}
