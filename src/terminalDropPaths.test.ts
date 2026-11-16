import { describe, expect, it, vi } from "vitest";

vi.mock("./platform", () => ({ IS_MAC: false, IS_WINDOWS: false }));

import { dropShellForSession, droppedPathArguments } from "./terminalFileDrop";

describe("shell-specific dropped paths", () => {
  it.each([
    ["pwsh -NoLogo", "powershell"],
    ['"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -NoLogo', "powershell"],
    ["C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", "powershell"],
    ["C:\\Windows\\System32\\cmd.exe", "cmd"],
    ["CMD.EXE /d", "cmd"],
    ["/bin/zsh -l", "posix"],
    ["/bin/bash", "posix"],
    ["wsl.exe -d Ubuntu", "posix"],
    ['"C:\\Program Files\\Git\\bin\\bash.exe" --login -i', "posix"],
  ] as const)("uses the resolved local shell %s", (address, expected) => {
    expect(dropShellForSession({ kind: "local", address })).toBe(expected);
  });

  it("does not interpret an SSH address as a local shell", () => {
    expect(dropShellForSession({ kind: "ssh", address: "pwsh" })).toBe("posix");
  });

  it("leaves ordinary POSIX paths unquoted", () => {
    expect(droppedPathArguments(["/Users/me/中文.txt", "/tmp/app.log"], "posix"))
      .toBe("/Users/me/中文.txt /tmp/app.log");
  });

  it("escapes POSIX metacharacters and Windows backslashes without wrapping single quotes", () => {
    expect(droppedPathArguments([String.raw`D:\data\logs\app.log`], "posix"))
      .toBe(String.raw`D:\\data\\logs\\app.log`);
    expect(droppedPathArguments(["/tmp/a b'\"$`;&|<>(){}[]*?!#~.txt"], "posix"))
      .toBe(String.raw`/tmp/a\ b\'\"\$` + "\\`" + String.raw`\;\&\|\<\>\(\)\{\}\[\]\*\?\!\#\~.txt`);
  });

  it("preserves PowerShell variables, quotes and backticks as path text", () => {
    expect(droppedPathArguments(["C:\\My files\\O'Brien $HOME ` \".txt"], "powershell"))
      .toBe('"C:\\My files\\O\'Brien `$HOME `` `".txt"');
  });

  it("quotes CMD spaces and command separators with double quotes", () => {
    expect(droppedPathArguments([String.raw`C:\My files\a&b(c)^d.txt`], "cmd"))
      .toBe(String.raw`"C:\My files\a&b(c)^d.txt"`);
  });

  it.each(["%PATH%", "!TEMP!", 'a"b'])("refuses CMD paths that would be expanded: %s", (name) => {
    expect(() => droppedPathArguments([`C:\\${name}.txt`], "cmd")).toThrow("CMD");
  });
});
