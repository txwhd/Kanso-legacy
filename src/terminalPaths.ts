import type { SessionInfo } from "./types";

export type PathShell = "posix" | "powershell" | "cmd";

/** Local addresses contain the resolved startup command, including the default shell. */
export function pathShellForSession(info: Pick<SessionInfo, "kind" | "address">): PathShell {
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

/** Format dropped or copied paths for the session shell, or as AI attachments. */
export function terminalPathsText(paths: string[], shell: PathShell, verbatim = false): string {
  // Control bytes are terminal input even when they occur in a quoted filename.
  if (paths.some((path) => /[\x00-\x1f\x7f]/.test(path))) {
    throw new Error("Cannot insert file paths containing control characters");
  }
  if (verbatim) return paths.join(" ");
  return paths.map((path) => {
    if (shell === "posix") {
      return path.replace(/([^\p{L}\p{N}_@%+=:,./-])/gu, "\\$1");
    }
    if (shell === "cmd" && /[%!"]/.test(path)) {
      // CMD expands variables inside quotes, and ! depends on delayed expansion.
      throw new Error("CMD cannot safely insert file paths containing %, ! or double quotes; use PowerShell");
    }
    if (/^[\p{L}\p{N}_./\\:-]+$/u.test(path)) return path;
    if (shell === "powershell") {
      return `"${path.replace(/[`$"]/g, "`$&")}"`;
    }
    return `"${path}"`;
  }).join(" ");
}
