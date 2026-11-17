import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./platform", () => ({
  IS_MAC: true,
  IS_WINDOWS: false,
}));

import { isShellPrompt, shellPromptEnd } from "./semanticColors";
import { TerminalController } from "./terminal";

const controllers: TerminalController[] = [];

function createController(states: string[], commands: string[] = []) {
  const controller = new TerminalController(
    "activity-test",
    {
      onData() {},
      onResize() {},
      onStatus() {},
      onCommand: (command) => commands.push(command),
      onCommandState: (state) => states.push(state),
      suggest: () => [],
    },
    13,
    100,
  );
  controllers.push(controller);
  return controller;
}

function write(controller: TerminalController, text: string): Promise<void> {
  return new Promise((resolve) => controller.term.write(text, resolve));
}

afterEach(() => {
  for (const controller of controllers.splice(0)) controller.dispose();
});

describe("shell prompt recognition", () => {
  it.each([
    "alice@server:~/work$ ",
    "root@server /srv # ",
    "~/repo ❯ ",
    "$ ",
    "PS C:\\Users\\alice> ",
    "C:\\work> ",
    // `%n %1~ %#`: a username and a directory with no host between them.
    "huaxin ~ % ",
    "huaxin /data/workspace % ",
    "alice ~/src $ ",
    // The shim's chips: directory and branch in filled blocks, so the sign
    // lands far from the line's start and no word-shaped pattern fits it.
    "/data/workspace/Kanso  main % ",
    "/data/workspace  main % ",
    "~/src  feature/x $ ",
    // The shim's chips are padded, so the line begins with a space and the
    // sign sits behind it: without allowing that lead, these matched nothing.
    " /data/workspace  % ",
    " /data/workspace  main  % ",
    " /data/workspace  \uf126 main  % ",
    " ~   main % ",
  ])("recognises %s", (prompt) => {
    expect(shellPromptEnd(prompt)).toBeGreaterThan(0);
    expect(isShellPrompt(prompt)).toBe(true);
  });

  it.each([
    "# a comment",
    "Finished build",
    "progress > 50%",
    // Two words and a `%` are a prompt only when the second reads as a path.
    "Time: 100 %",
    "foo bar %",
    // A sign alone is not enough: the front has to read as prompt parts.
    "100% done",
    "50 % of it",
  ])("does not mistake %s for a prompt", (output) => {
    expect(isShellPrompt(output)).toBe(false);
  });
});

describe("terminal command activity", () => {
  it("selects a ready POSIX prompt, but rejects unsupported shells and pending edits", async () => {
    const controller = createController([]);
    await write(controller, "alice@server:~$ ");
    controller.setPathShell("powershell");
    expect(controller.prepareMcpSelection()).toBe(false);
    controller.setPathShell("posix");
    expect(controller.prepareMcpSelection()).toBe(true);
    controller.term.input("x", true);
    expect(controller.prepareMcpSelection()).toBe(false);
    await write(controller, "x");
    expect(controller.prepareMcpSelection()).toBe(false);
  });

  it.each(["\x1b[B", "q"])(
    "recovers a GateShell menu input anchor left on an earlier line (%j)",
    async (key) => {
      const states: string[] = [];
      const controller = createController(states);
      await write(controller, "Asset number: ");
      controller.term.input("001", true);
      await write(controller, "001");
      controller.term.input("\r", true);
      await write(controller, "\r\nGateShell menu: ");
      controller.term.input(key, true);
      await write(controller, "\r\nConnecting...\r\n[root@node1 ~]# ");
      expect(controller.canShareWithMcp()).toBe(false);
      expect(controller.canConfirmMcpShellReady()).toBe(true);
      const waiter = controller.waitForCommand(1000);
      expect(controller.prepareMcpSelection()).toBe(true);
      expect(controller.canShareWithMcp()).toBe(true);
      expect(await waiter).toBe("closed");
      expect(states).toEqual(["running", "idle"]);
    },
  );

  it("offers recovery for an old menu anchor even when no command was tracked", async () => {
    const controller = createController([]);
    await write(controller, "GateShell assets\r\nSelect target: ");
    controller.term.input("\x1b[B", true);
    await write(controller, "\r\nWelcome to target\r\n[root@node1 ~]# ");
    expect(controller.canShareWithMcp()).toBe(false);
    expect(controller.canConfirmMcpShellReady()).toBe(true);
    expect(controller.confirmMcpShellReady()).toBe(true);
    expect(controller.canShareWithMcp()).toBe(true);
  });

  it("requires explicit recovery after GateShell reaches a target prompt without completing Sender waiters", async () => {
    const states: string[] = [];
    const controller = createController(states);
    await write(controller, "GateShell assets\r\nAsset number: ");
    controller.term.input("001", true);
    await write(controller, "001");
    controller.term.input("\r", true);
    await write(controller, "\r\nConnecting to target...\r\nPassword: ");
    expect(controller.canShareWithMcp()).toBe(false);
    await write(controller, "\r\nWelcome to node1\r\n[root@node1 ~]# ");
    // The old GateShell prompt is not a shell signature. Do not loosen the
    // automatic completion rules just to allow the user's explicit sharing.
    expect(states).toEqual(["running"]);
    expect(controller.canShareWithMcp()).toBe(false);
    expect(controller.canConfirmMcpShellReady()).toBe(true);
    controller.term.input("kubectl get pod", true);
    expect(controller.canShareWithMcp()).toBe(false);
    expect(controller.canConfirmMcpShellReady()).toBe(false);
    await write(controller, "kubectl get pod");
    controller.term.input("\r", true);
    await write(
      controller,
      "\r\nNo resources found in default namespace.\r\n[root@node1 ~]# ",
    );
    expect(controller.canShareWithMcp()).toBe(false);
    expect(controller.canConfirmMcpShellReady()).toBe(true);
    const waiter = controller.waitForCommand(1000);
    expect(controller.confirmMcpShellReady()).toBe(true);
    expect(controller.canShareWithMcp()).toBe(true);
    controller.setMcpShared(true);
    expect(await waiter).toBe("closed");
    expect(states).toEqual(["running", "idle"]);
    expect(controller.term.options.disableStdin).toBe(true);
  });

  it("blocks unacknowledged input even when unrelated output is parsed", async () => {
    const controller = createController([]);
    await write(controller, "[root@node1 ~]# ");
    controller.term.input("x", true);
    expect(controller.canShareWithMcp()).toBe(false);
    await write(controller, "\x1b[0m");
    expect(controller.canShareWithMcp()).toBe(false);
    expect(controller.canConfirmMcpShellReady()).toBe(false);
    await write(controller, "x");
    expect(controller.canShareWithMcp()).toBe(false);
    controller.term.input("\x7f", true);
    expect(controller.canShareWithMcp()).toBe(false);
    await write(controller, "\b \b");
    // A clear-looking line alone does not acknowledge input. Ctrl+C explicitly
    // abandons the unfinished edit without pretending a command completed.
    expect(controller.canShareWithMcp()).toBe(false);
    controller.term.input("\x03", true);
    await write(controller, "^C\r\n[root@node1 ~]# ");
    expect(controller.canShareWithMcp()).toBe(true);
  });

  it("does not share a command hidden to the right of the cursor or on a wrapped row", async () => {
    const controller = createController([]);
    controller.term.resize(40, 10);
    await write(controller, "[root@node1 ~]# ");
    const command = "echo " + "x".repeat(50);
    controller.term.input(command, true);
    await write(controller, command);
    // Move to the prompt boundary while leaving the unsubmitted command in
    // the buffer, including the continuation of its soft-wrapped line.
    await write(controller, "\x1b[1;16H");
    expect(controller.canShareWithMcp()).toBe(false);
    expect(controller.canConfirmMcpShellReady()).toBe(false);
  });

  it("does not automatically share a running program that prints a prompt-like line", async () => {
    const controller = createController([]);
    await write(controller, "Asset number: ");
    controller.term.input("001", true);
    await write(controller, "001");
    controller.term.input("\r", true);
    await write(
      controller,
      "\r\nA foreground program prints an example prompt:\r\n[root@node1 ~]# ",
    );
    expect(controller.canShareWithMcp()).toBe(false);
    expect(await controller.waitForCommand(1)).toBe("timeout");
  });

  it("shares only idle terminals and restores input without unlocking a closed session", async () => {
    const controller = createController([]);
    await write(controller, "alice@server:~$ ");
    expect(controller.canShareWithMcp()).toBe(true);
    controller.term.input("x", true);
    expect(controller.canShareWithMcp()).toBe(false);
    controller.term.input("\x03", true);
    await write(controller, "^C\r\nalice@server:~$ ");
    expect(controller.canShareWithMcp()).toBe(true);
    controller.setMcpShared(true);
    expect(controller.term.options.disableStdin).toBe(true);
    expect(controller.noteCommandSent("pwd")).toBe(false);
    controller.setLocked(true);
    controller.setMcpShared(false);
    expect(controller.term.options.disableStdin).toBe(true);
    expect(controller.canShareWithMcp()).toBe(false);
    controller.setLocked(false);
    expect(controller.term.options.disableStdin).toBe(false);
    controller.noteCommandSent("sleep 60");
    expect(controller.canShareWithMcp()).toBe(false);
  });

  it("distinguishes a timeout, returned prompt, cancellation and session close", async () => {
    const controller = createController([]);
    const prompt = "alice@server:~/work$ ";
    await write(controller, prompt);
    controller.noteCommandSent("sleep 60");
    expect(await controller.waitForCommand(1)).toBe("timeout");
    const returned = controller.waitForCommand(1000);
    await write(controller, `sleep 60\r\n${prompt}`);
    expect(await returned).toBe("complete");

    controller.noteCommandSent("sleep 60");
    const abort = new AbortController();
    const cancelled = controller.waitForCommand(1000, abort.signal);
    abort.abort();
    expect(await cancelled).toBe("cancelled");
    const closed = controller.waitForCommand(1000);
    controller.setLocked(true);
    expect(await closed).toBe("closed");
    expect(await controller.waitForCommand(1000)).toBe("closed");
  });

  it("stays running through quiet output and completes on the returned prompt", async () => {
    const states: string[] = [];
    const controller = createController(states);
    const prompt = "alice@server:~/work$ ";

    await write(controller, prompt);
    controller.term.input("sleep 30", true);
    await write(controller, "sleep 30");
    controller.term.input("\r", true);

    expect(states).toEqual(["running"]);
    await write(controller, "\r\nstill waiting\r\n");
    expect(states).toEqual(["running"]);

    await write(controller, prompt);
    expect(states).toEqual(["running", "complete"]);
  });

  it("accepts a recognised prompt whose working directory changed", async () => {
    const states: string[] = [];
    const controller = createController(states);

    await write(controller, "alice@server:~/old$ ");
    controller.term.input("cd ../new", true);
    await write(controller, "cd ../new");
    controller.term.input("\r", true);
    await write(controller, "\r\nalice@server:~/new$ ");

    expect(states).toEqual(["running", "complete"]);
  });

  it("completes a `user dir %` prompt after the directory changed", async () => {
    const states: string[] = [];
    const controller = createController(states);

    // The prompt is `%n %1~ %#`: no host, and `cd` rewrites the middle word,
    // so neither the signature nor the old prompt text can match the new one.
    await write(controller, "huaxin ~ % ");
    controller.term.input("cd /data/workspace", true);
    await write(controller, "cd /data/workspace");
    controller.term.input("\r", true);
    await write(controller, "\r\nhuaxin /data/workspace % ");

    expect(states).toEqual(["running", "complete"]);
  });

  it("uses an exact signature for a custom prompt", async () => {
    const states: string[] = [];
    const controller = createController(states);

    await write(controller, "λ ");
    controller.term.input("make", true);
    await write(controller, "make");
    controller.term.input("\r", true);
    await write(controller, "\r\nDone\r\nλ ");

    expect(states).toEqual(["running", "complete"]);
  });

  it("uses a prompt cwd report when the visible prompt is empty", async () => {
    const states: string[] = [];
    const controller = createController(states);

    await write(controller, "\x1b]7;file://localhost/old\x07");
    controller.term.input("cd ../new", true);
    await write(controller, "cd ../new");
    controller.term.input("\r", true);
    await write(controller, "\r\n\x1b]7;file://localhost/new\x07");

    expect(states).toEqual(["running", "complete"]);
  });

  it("does not treat input requested by a foreground command as a new command", async () => {
    const states: string[] = [];
    const controller = createController(states);
    const prompt = "alice@server:~/work$ ";

    await write(controller, prompt);
    controller.term.input("sudo true", true);
    await write(controller, "sudo true");
    controller.term.input("\r", true);
    await write(controller, "\r\nPassword: ");

    controller.term.input("not-recorded", true);
    controller.term.input("\r", true);
    await write(controller, `\r\n${prompt}`);

    expect(states).toEqual(["running", "complete"]);
  });

  /**
   * procps top paints in the normal buffer: it clears the screen, draws its
   * frames with absolute addressing and parks the cursor inside them. `q`
   * hands the shell back without the user ever pressing Enter, so the
   * keystroke's anchor is left sitting on a row top painted.
   */
  async function quitTop(controller: TerminalController, prompt: string) {
    controller.term.input("top", true);
    await write(controller, "top");
    controller.term.input("\r", true);
    await write(controller, "\r\n");
    const frame = [
      "top - 12:00:00 up 3 days,  1 user,  load average: 0.05, 0.03",
      "Tasks: 123 total,   1 running, 122 sleeping,   0 stopped",
      "    1 root      20   0  168940  12084 S   0.0   0:02.11 systemd",
    ]
      .map((row, index) => `\x1b[${index + 1}d\r${row}\x1b[K`)
      .join("");
    await write(controller, `\x1b[?7l\x1b[H\x1b[2J${frame}\x1b[H`);
    controller.term.input("q", true);
    // at_eoj: cursor to the last row, margins back, one newline.
    await write(controller, `\x1b[99;1H\x1b[?7h\n${prompt}`);
  }

  it("tracks the next command after a full-screen program is quit", async () => {
    const states: string[] = [];
    const controller = createController(states);
    const prompt = "root@server:~# ";

    await write(controller, prompt);
    await quitTop(controller, prompt);
    expect(states).toEqual(["running", "complete"]);

    controller.term.input("ls", true);
    await write(controller, "ls");
    controller.term.input("\r", true);
    await write(controller, `\r\nfile-a  file-b\r\n${prompt}`);

    expect(states).toEqual(["running", "complete", "running", "complete"]);
  });

  it("does not record a full-screen program's own screen as a command", async () => {
    const states: string[] = [];
    const commands: string[] = [];
    const controller = createController(states, commands);
    controller.setSuggestions(true);
    const prompt = "root@server:~# ";

    await write(controller, prompt);
    await quitTop(controller, prompt);

    controller.term.input("ls", true);
    await write(controller, "ls");
    controller.term.input("\r", true);
    await write(controller, `\r\nfile-a  file-b\r\n${prompt}`);
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(commands).toEqual(["top", "ls"]);
  });
});
