export type McpClient = "codex" | "dsh";

/** JSON quoted strings/arrays are also valid TOML basic strings and YAML flow values. */
export function mcpClientConfig(
  client: McpClient,
  executable: string,
  bridgeFile: string,
): string {
  const command = JSON.stringify(executable);
  const args = JSON.stringify(["--mcp", "--bridge-file", bridgeFile]);
  return client === "codex"
    ? `[mcp_servers.kanso]\ncommand = ${command}\nargs = ${args}\n`
    : `- id: mcp\n  config:\n    servers:\n      kanso:\n        transport: stdio\n        command: ${command}\n        args: ${args}\n        enabled: true\n`;
}
