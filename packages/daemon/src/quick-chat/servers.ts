import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { QuickTool } from "@zoltbot/protocol";

// The MCP servers the person configured in their coding tools, by name only. Server settings
// (commands, URLs, headers, keys) are never read into Zoltbot state or sent to a client.

const validName = /^[\w.-]{1,100}$/;
function claudeServers(env: NodeJS.ProcessEnv) {
  const home = env.HOME ?? homedir();
  const file = path.join(env.CLAUDE_CONFIG_DIR ?? home, ".claude.json");
  try {
    const servers = (JSON.parse(readFileSync(file, "utf8")) as { mcpServers?: unknown }).mcpServers;
    return servers && typeof servers === "object" ? Object.keys(servers) : [];
  } catch {
    return [];
  }
}
function codexServers(env: NodeJS.ProcessEnv) {
  const file = path.join(
    env.CODEX_HOME ?? path.join(env.HOME ?? homedir(), ".codex"),
    "config.toml",
  );
  try {
    const names = new Set<string>();
    for (const match of readFileSync(file, "utf8").matchAll(
      /^\s*\[mcp_servers\.(?:"([^"]+)"|([^.\]\s]+))\]/gm,
    ))
      names.add(match[1] ?? match[2] ?? "");
    return [...names];
  } catch {
    return [];
  }
}
/** Servers by name, with the tools that have each. Antigravity's own servers are not listed. */
export function discoverServers(env: NodeJS.ProcessEnv = process.env) {
  const found = new Map<string, Set<QuickTool>>();
  const add = (tool: QuickTool, names: string[]) => {
    for (const name of names)
      if (validName.test(name) && name !== "zoltbot")
        found.set(name, (found.get(name) ?? new Set()).add(tool));
  };
  add("claude", claudeServers(env));
  add("codex", codexServers(env));
  return [...found]
    .map(([name, tools]) => ({ name, tools: [...tools].sort() }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
