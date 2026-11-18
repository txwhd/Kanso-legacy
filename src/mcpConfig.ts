export type McpClient = "codex" | "dsh";

export const MCP_PERMISSIONS = {
  read_only: {
    label: "只读",
    description: "仅允许已识别的查询命令；修改、动态执行和未知命令会被拦截。",
  },
  read_write: {
    label: "读写",
    description:
      "允许查询和指定绝对路径下的普通写入；高危、动态执行和未知命令会被拦截。",
  },
  all: {
    label: "所有",
    description: "不拦截高危命令，可执行当前登录账号允许的全部命令。",
  },
} as const;

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
