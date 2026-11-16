import { describe, expect, it } from "vitest";

import { pathShellForSession, terminalPathsText } from "./terminalPaths";

describe("session shell path formatting", () => {
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
    expect(pathShellForSession({ kind: "local", address })).toBe(expected);
  });

  it("SSH paths always use POSIX syntax regardless of the client platform", () => {
    expect(pathShellForSession({ kind: "ssh", address: "pwsh" })).toBe("posix");
  });

  it("leaves ordinary paths unquoted", () => {
    expect(terminalPathsText(["/Users/me/中文.txt", "/tmp/app.log"], "posix"))
      .toBe("/Users/me/中文.txt /tmp/app.log");
    for (const shell of ["powershell", "cmd"] as const) {
      expect(terminalPathsText([String.raw`D:\data\app.log`], shell))
        .toBe(String.raw`D:\data\app.log`);
    }
  });

  it("escapes POSIX metacharacters and Windows backslashes without outer quotes", () => {
    expect(terminalPathsText([String.raw`D:\data\app.log`], "posix"))
      .toBe(String.raw`D:\\data\\app.log`);
    expect(terminalPathsText(["/tmp/a b'\"$`;&|<>(){}[]*?!#~.txt"], "posix"))
      .toBe(String.raw`/tmp/a\ b\'\"\$` + "\\`" + String.raw`\;\&\|\<\>\(\)\{\}\[\]\*\?\!\#\~.txt`);
  });

  it("preserves PowerShell variables, quotes and backticks as path text", () => {
    expect(terminalPathsText(["C:\\My files\\O'Brien $HOME ` \".txt"], "powershell"))
      .toBe('"C:\\My files\\O\'Brien `$HOME `` `".txt"');
  });

  it("quotes CMD spaces and command separators with double quotes", () => {
    expect(terminalPathsText([String.raw`C:\My files\a&b(c)^d.txt`], "cmd"))
      .toBe(String.raw`"C:\My files\a&b(c)^d.txt"`);
  });

  it.each(["%PATH%", "!TEMP!", 'a"b'])("refuses CMD expansion in %s", (name) => {
    expect(() => terminalPathsText([`C:\\${name}.txt`], "cmd")).toThrow("CMD");
  });

  it.each(["\n", "\r", "\t", "\x00", "\x1b", "\x7f"])("rejects control byte %j even for AI attachments", (control) => {
    for (const shell of ["posix", "powershell", "cmd"] as const) {
      for (const verbatim of [false, true]) {
        expect(() => terminalPathsText(["/tmp/good", `/tmp/bad${control}name`], shell, verbatim))
          .toThrow("control characters");
      }
    }
  });

  it("preserves AI attachment paths without shell quoting or CMD filtering", () => {
    const paths = ["/tmp/My files/中文.png", String.raw`C:\100%!\image.png`];
    expect(terminalPathsText(paths, "cmd", true)).toBe(paths.join(" "));
  });
});
