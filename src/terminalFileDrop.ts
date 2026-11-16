import { getCurrentWebview } from "@tauri-apps/api/webview";

import { dropPoint } from "./fileDrop";
import type { SessionInfo } from "./types";

export type DropShell = "posix" | "powershell" | "cmd";

/** Local addresses contain the resolved startup command, including the default shell. */
export function dropShellForSession(info: Pick<SessionInfo, "kind" | "address">): DropShell {
  if (info.kind !== "local") return "posix";
  const command = info.address.trim();
  const executable = command.startsWith('"')
    ? command.slice(1, command.indexOf('"', 1))
    : command.startsWith("'")
      ? command.slice(1, command.indexOf("'", 1))
      : command.split(/\s/, 1)[0];
  const name = executable.split(/[\\/]/).pop()?.toLowerCase().replace(/\.exe$/, "");
  if (name === "pwsh" || name === "powershell") return "powershell";
  if (name === "cmd") return "cmd";
  return "posix";
}

/** Preserve each local path as one shell argument without fixed single quotes. */
export function droppedPathArguments(paths: string[], shell: DropShell): string {
  // Even a quoted newline/control byte is terminal input, not just a filename.
  if (paths.some((path) => /[\x00-\x1f\x7f]/.test(path))) {
    throw new Error("Cannot insert file paths containing control characters");
  }
  return paths.map((path) => {
    if (shell === "posix") {
      // Finder/Terminal style: escape spaces and metacharacters, including
      // Windows backslashes, so the shell receives the original path literally.
      return path.replace(/([^\p{L}\p{N}_@%+=:,./-])/gu, "\\$1");
    }
    if (shell === "cmd" && /[%!\"]/.test(path)) {
      // CMD expands percent variables even inside quotes; delayed expansion
      // also consumes !. Do not silently insert a different path.
      throw new Error("CMD cannot safely insert file paths containing %, ! or double quotes; use PowerShell");
    }
    if (/^[\p{L}\p{N}_./\\:-]+$/u.test(path)) return path;
    if (shell === "powershell") {
      return `"${path.replace(/[`$\"]/g, "`$&")}"`;
    }
    return `"${path}"`;
  }).join(" ");
}

/** Listen only while the owning terminal pane is visible and connected. */
export function listenForTerminalFileDrop(
  host: HTMLElement,
  paste: (text: string) => void,
  onError: (message: string) => void,
  shell: DropShell = "posix",
): () => void {
  let live = true;
  const unlisten = getCurrentWebview().onDragDropEvent(({ payload }) => {
    if (!live || payload.type !== "drop" || payload.paths.length === 0) return;
    const { x, y } = dropPoint(payload.position);
    const bounds = host.getBoundingClientRect();
    if (x < bounds.left || x >= bounds.right || y < bounds.top || y >= bounds.bottom) {
      return;
    }
    // A dialog/menu covering the pane must not send input to the shell below.
    const hit = document.elementFromPoint(x, y);
    if (!hit || !host.contains(hit)) return;
    try {
      paste(droppedPathArguments(payload.paths, shell));
    } catch (error) {
      onError(String(error));
    }
  });
  void unlisten.catch((error: unknown) => {
    if (live) onError(`File drop unavailable: ${String(error)}`);
  });
  return () => {
    live = false;
    void unlisten.then((off) => off()).catch(() => {});
  };
}
