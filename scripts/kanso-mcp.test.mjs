import assert from "node:assert/strict";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const token = "t".repeat(44);

// CI supplies its freshly built executable. Local runs use release, then debug.
const binary = process.platform === "win32" ? "kanso.exe" : "kanso";
const candidates = ["release", "debug"].map((profile) =>
  fileURLToPath(
    new URL(`../src-tauri/target/${profile}/${binary}`, import.meta.url),
  ),
);
const nativeExecutable =
  process.env.KANSO_MCP_EXECUTABLE || candidates.find(existsSync);
assert.ok(
  nativeExecutable,
  "Build Kanso first, or set KANSO_MCP_EXECUTABLE to a compiled binary",
);
const transport = (bridgeFile) =>
  new StdioClientTransport({
    command: nativeExecutable,
    args: ["--mcp", "--bridge-file", bridgeFile],
    stderr: "pipe",
  });

async function fixture(handler) {
  const directory = await mkdtemp(join(tmpdir(), "kanso-mcp-test-"));
  const bridgeFile = join(directory, "mcp-bridge.json");
  const requests = [];
  const sockets = new Set();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let buffer = "";
    socket.on("data", (data) => {
      buffer += data.toString();
      if (!buffer.includes("\n")) return;
      const request = JSON.parse(buffer.slice(0, buffer.indexOf("\n")));
      requests.push(request);
      assert.equal(request.token, token);
      const result = handler(request);
      if (result === undefined) socket.end();
      else socket.end(`${JSON.stringify(result)}\n`);
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  await writeFile(
    bridgeFile,
    JSON.stringify({ version: 1, port: server.address().port, token }),
    { mode: 0o600 },
  );
  let client;
  return {
    bridgeFile,
    requests,
    async client() {
      client = new Client({ name: "kanso-test", version: "1" });
      await client.connect(transport(bridgeFile));
      return client;
    },
    async close() {
      await client?.close();
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("stdio MCP handshake discovers nine terminal tools, without a running app", async () => {
  const client = new Client({ name: "discovery-test", version: "1" });
  try {
    await client.connect(transport(join(tmpdir(), "missing-kanso-descriptor")));
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((tool) => tool.name).sort(), [
      "kanso_execute_command",
      "kanso_get_execution",
      "kanso_get_session_status",
      "kanso_interrupt_execution",
      "kanso_list_sessions",
      "kanso_read_terminal",
      "kanso_release_session",
      "kanso_select_session",
      "kanso_show_terminal",
    ]);
    const result = await client.callTool({
      name: "kanso_list_sessions",
      arguments: {},
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Start.*Kanso/);
  } finally {
    await client.close();
  }
});

test("stdio selects a terminal through readiness handshake and releases it without executing", async () => {
  let checks = 0;
  const f = await fixture((request) => {
    if (request.method === "select_session") {
      assert.deepEqual(request.params, { sessionId: "target" });
      return {
        result: {
          id: "claim",
          sessionId: "target",
          state: "selecting",
          message: null,
        },
      };
    }
    if (request.method === "selection_status") {
      checks++;
      assert.deepEqual(request.params, { selectionId: "claim" });
      return {
        result: {
          id: "claim",
          sessionId: "target",
          state: "selected",
          message: null,
        },
      };
    }
    assert.equal(request.method, "release_session");
    return { result: { sessionId: "target", state: "released" } };
  });
  try {
    const client = await f.client();
    const selected = await client.callTool({
      name: "kanso_select_session",
      arguments: { sessionId: "target" },
    });
    assert.equal(selected.structuredContent.state, "selected");
    assert.equal(checks, 1);
    const released = await client.callTool({
      name: "kanso_release_session",
      arguments: { sessionId: "target" },
    });
    assert.equal(released.structuredContent.state, "released");
    assert.deepEqual(
      f.requests.map((request) => request.method),
      ["select_session", "selection_status", "release_session"],
    );
  } finally {
    await f.close();
  }
});

test("selection refusal is a tool error and never submits a command", async () => {
  const f = await fixture(() => ({
    result: {
      id: "claim",
      sessionId: "target",
      state: "failed",
      message: "Finish the typed line first",
    },
  }));
  try {
    const client = await f.client();
    const result = await client.callTool({
      name: "kanso_select_session",
      arguments: { sessionId: "target" },
    });
    assert.equal(result.isError, true);
    assert.match(result.structuredContent.message, /typed line/);
    assert.equal(f.requests.length, 1);
    assert.equal(f.requests[0].method, "select_session");
  } finally {
    await f.close();
  }
});

test("real stdio tool call reaches the authenticated bridge and polls one execution", async () => {
  let reads = 0;
  const base = {
    id: "execution",
    sessionId: "session",
    command: "pwd",
    state: "running",
    started: true,
    output: "",
    exitCode: null,
    truncated: false,
  };
  const f = await fixture((request) => {
    if (request.method === "list_sessions")
      return {
        result: {
          sessions: [{ id: "session", label: "target behind GateShell" }],
        },
      };
    if (request.method === "execute") {
      assert.deepEqual(request.params, {
        sessionId: "session",
        command: "pwd",
      });
      return { result: base };
    }
    assert.equal(request.method, "execution_status");
    assert.deepEqual(request.params, { executionId: "execution" });
    reads++;
    return {
      result: {
        ...base,
        state: "completed",
        exitCode: 0,
        output: "\u001b[32m/srv/你好\u001b[0m\r\n",
      },
    };
  });
  try {
    const client = await f.client();
    const listed = await client.callTool({
      name: "kanso_list_sessions",
      arguments: {},
    });
    assert.equal(
      listed.structuredContent.sessions[0].label,
      "target behind GateShell",
    );
    const result = await client.callTool({
      name: "kanso_execute_command",
      arguments: { sessionId: "session", command: "pwd", waitMs: 1000 },
    });
    assert.equal(result.structuredContent.state, "completed");
    assert.equal(result.structuredContent.exitCode, 0);
    assert.equal(result.structuredContent.output, "/srv/你好\r\n");
    assert.equal(result.isError, undefined);
    assert.equal(reads, 1);
    assert.equal(
      f.requests.filter((request) => request.method === "execute").length,
      1,
    );
    assert.ok(!JSON.stringify(result).includes(token));
  } finally {
    await f.close();
  }
});

test("wait expiry reports running without a guessed exit code or resubmission", async () => {
  const job = {
    id: "long",
    state: "running",
    output: "working",
    exitCode: null,
  };
  const f = await fixture(() => ({ result: job }));
  try {
    const client = await f.client();
    const result = await client.callTool({
      name: "kanso_execute_command",
      arguments: { sessionId: "session", command: "sleep 60", waitMs: 0 },
    });
    assert.equal(result.structuredContent.state, "running");
    assert.equal(result.structuredContent.exitCode, null);
    const polled = await client.callTool({
      name: "kanso_get_execution",
      arguments: { executionId: "long" },
    });
    assert.equal(polled.structuredContent.state, "running");
    assert.deepEqual(
      f.requests.map((request) => request.method),
      ["execute", "execution_status"],
    );
  } finally {
    await f.close();
  }
});

test("nonzero command exits and interrupted jobs are tool errors", async () => {
  let state = "completed";
  const f = await fixture(() => ({
    result: {
      id: "job",
      state,
      exitCode: state === "completed" ? 7 : null,
      output: "failed",
    },
  }));
  try {
    const client = await f.client();
    for (const next of ["completed", "interrupted", "disconnected"]) {
      state = next;
      const result = await client.callTool({
        name: "kanso_get_execution",
        arguments: { executionId: "job" },
      });
      assert.equal(result.isError, true);
      assert.equal(result.structuredContent.state, next);
    }
  } finally {
    await f.close();
  }
});

test("bridge errors remain clear MCP tool errors", async () => {
  const f = await fixture((request) => ({
    error:
      request.method === "execute"
        ? "session is not shared"
        : "execution not found",
  }));
  try {
    const client = await f.client();
    const result = await client.callTool({
      name: "kanso_execute_command",
      arguments: { sessionId: "session", command: "whoami", waitMs: 0 },
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /not shared/);
    const missing = await client.callTool({
      name: "kanso_get_execution",
      arguments: { executionId: "unknown" },
    });
    assert.equal(missing.isError, true);
    assert.match(missing.content[0].text, /not found/);
  } finally {
    await f.close();
  }
});

test("stdio rejects invalid arguments before any bridge request", async () => {
  const f = await fixture(() => ({ result: {} }));
  try {
    const client = await f.client();
    assert.equal((await client.listTools()).tools.length, 9);
    for (const args of [
      { sessionId: "target", command: "pwd", waitMs: -1 },
      { sessionId: "target", command: "pwd", waitMs: 1.5 },
      { sessionId: "target", command: "pwd", waitMs: 20001 },
      { sessionId: "", command: "pwd" },
    ]) {
      const result = await client
        .callTool({ name: "kanso_execute_command", arguments: args })
        .catch(() => ({ isError: true }));
      assert.equal(result.isError, true);
    }
    assert.equal(f.requests.length, 0);
  } finally {
    await f.close();
  }
});

test("inspection tools poll the frontend and preserve cursor/state/show results without selecting", async () => {
  const completed = {
    read_terminal: {
      sessionId: "target",
      output: "人工执行的输出",
      nextCursor: "snapshot:12",
      bufferType: "normal",
    },
    get_session_status: {
      sessionId: "target",
      connected: true,
      selected: false,
      readyToSelect: false,
      selectionBlocker: "Finish typing first",
    },
    show_terminal: { sessionId: "target", state: "shown" },
  };
  let method;
  const f = await fixture((request) => {
    if (request.method === "frontend_request_status") {
      assert.deepEqual(request.params, { requestId: "request" });
      return {
        result: {
          id: "request",
          state: "completed",
          result: completed[method],
        },
      };
    }
    assert.ok(Object.hasOwn(completed, request.method));
    method = request.method;
    assert.equal(request.params.sessionId, "target");
    if (method === "read_terminal")
      assert.deepEqual(request.params, {
        sessionId: "target",
        maxLines: 12,
        cursor: "snapshot:24",
      });
    return { result: { id: "request", state: "pending" } };
  });
  try {
    const client = await f.client();
    for (const operation of Object.keys(completed)) {
      const result = await client.callTool({
        name: `kanso_${operation}`,
        arguments: {
          sessionId: "target",
          ...(operation === "read_terminal"
            ? { maxLines: 12, cursor: "snapshot:24" }
            : {}),
        },
      });
      assert.deepEqual(result.structuredContent, completed[operation]);
    }
    assert.ok(
      f.requests.every(
        (request) => !["select_session", "execute"].includes(request.method),
      ),
    );
  } finally {
    await f.close();
  }
});

test("inspection failure remains an MCP tool error and invalid pagination never reaches the bridge", async () => {
  const f = await fixture(() => ({
    result: { state: "failed", message: "Terminal cursor expired" },
  }));
  try {
    const client = await f.client();
    const failed = await client.callTool({
      name: "kanso_read_terminal",
      arguments: { sessionId: "target" },
    });
    assert.equal(failed.isError, true);
    assert.match(failed.content[0].text, /cursor expired/);
    for (const maxLines of [0, 501, 2.5]) {
      const invalid = await client
        .callTool({
          name: "kanso_read_terminal",
          arguments: { sessionId: "target", maxLines },
        })
        .catch(() => ({ isError: true }));
      assert.equal(invalid.isError, true);
    }
    assert.equal(f.requests.length, 1);
  } finally {
    await f.close();
  }
});

test("interrupt uses an execution ID and reports a request without claiming completion", async () => {
  const f = await fixture((request) => {
    assert.equal(request.method, "interrupt_execution");
    assert.deepEqual(request.params, { executionId: "exact-job" });
    return {
      result: {
        state: "interrupt_requested",
        executionId: "exact-job",
        sessionId: "target",
      },
    };
  });
  try {
    const client = await f.client();
    const result = await client.callTool({
      name: "kanso_interrupt_execution",
      arguments: { executionId: "exact-job" },
    });
    assert.equal(result.structuredContent.state, "interrupt_requested");
    assert.equal(result.isError, undefined);
    assert.equal(f.requests.length, 1);
  } finally {
    await f.close();
  }
});

test("permission blocks are structured MCP errors without polling or replay", async () => {
  const blocked = {
    code: "COMMAND_BLOCKED",
    state: "blocked",
    permission: "read_only",
    rule: "write_operation",
    message: "Command was not sent",
  };
  const f = await fixture((request) => {
    assert.equal(request.method, "execute");
    return { result: blocked };
  });
  try {
    const client = await f.client();
    const result = await client.callTool({
      name: "kanso_execute_command",
      arguments: { sessionId: "target", command: "touch /tmp/a", waitMs: 1000 },
    });
    assert.equal(result.isError, true);
    assert.deepEqual(result.structuredContent, blocked);
    assert.equal(f.requests.length, 1);
    assert.ok(
      !(await client.listTools()).tools.some((tool) =>
        /permission/.test(tool.name),
      ),
    );
  } finally {
    await f.close();
  }
});

test("stdio reports a lost submission reply without retrying the command", async () => {
  const f = await fixture(() => undefined);
  try {
    const client = await f.client();
    const result = await client.callTool({
      name: "kanso_execute_command",
      arguments: { sessionId: "target", command: "pwd", waitMs: 0 },
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /retry|resubmit/);
    assert.equal(f.requests.length, 1);
    assert.equal(f.requests[0].method, "execute");
  } finally {
    await f.close();
  }
});

test("native stdio preserves the execution ID after a polling connection fails", async () => {
  let failPoll = true;
  const f = await fixture((request) => {
    if (request.method === "execute")
      return {
        result: {
          id: "submitted-job",
          sessionId: "target",
          state: "running",
          output: "",
          exitCode: null,
        },
      };
    if (failPoll) {
      failPoll = false;
      return undefined;
    }
    return {
      result: {
        id: "submitted-job",
        state: "completed",
        output: "done",
        exitCode: 0,
      },
    };
  });
  try {
    const client = await f.client();
    const submitted = await client.callTool({
      name: "kanso_execute_command",
      arguments: { sessionId: "target", command: "pwd", waitMs: 1000 },
    });
    assert.equal(submitted.structuredContent.id, "submitted-job");
    assert.equal(submitted.structuredContent.state, "running");
    assert.match(submitted.structuredContent.message, /do not resubmit/);
    const recovered = await client.callTool({
      name: "kanso_get_execution",
      arguments: { executionId: "submitted-job" },
    });
    assert.equal(recovered.structuredContent.state, "completed");
    assert.equal(f.requests.filter((r) => r.method === "execute").length, 1);
  } finally {
    await f.close();
  }
});

test("invalid descriptors and oversized replies are rejected", async () => {
  const f = await fixture(() => ({
    result: { output: "x".repeat(512 * 1024) },
  }));
  try {
    const client = await f.client();
    const oversized = await client.callTool({
      name: "kanso_list_sessions",
      arguments: {},
    });
    assert.equal(oversized.isError, true);
    assert.match(oversized.content[0].text, /oversized/);
    await writeFile(
      f.bridgeFile,
      JSON.stringify({ version: 1, port: -1, token }),
    );
    const invalid = await client.callTool({
      name: "kanso_list_sessions",
      arguments: {},
    });
    assert.equal(invalid.isError, true);
    assert.match(invalid.content[0].text, /Invalid bridge descriptor/);
    assert.equal(f.requests.length, 1);
  } finally {
    await f.close();
  }
});
