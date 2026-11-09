import path from "node:path";
import type { ToolInvocation } from "@zoltbot/hostmcp";
import type { Snapshot } from "@zoltbot/store";
import {
  readBounded,
  roots,
  sensitiveName,
  textExtension,
  walk,
  workspaceFile,
} from "./context.js";

// Read-only workspace tools for Quick Chat, served by its own host tool server. They reach every
// workspace on this host, skip credential files, and drop text the host's secret filter matches.
// Results stay under the dispatcher's 4000 character limit.

export interface QuickHostContext {
  state(): Snapshot;
  containsSecret(text: string): Promise<boolean>;
}
const Workspace = {
  type: "string",
  minLength: 1,
  maxLength: 200,
  description: "Workspace id or name from quick_workspaces.",
};
export const quickHostToolDefinitions = [
  {
    name: "quick_workspaces",
    description:
      "List the person's Zoltbot workspaces (their products and projects) with ids, goals and folders.",
    inputSchema: { type: "object" as const, properties: {}, additionalProperties: false },
  },
  {
    name: "quick_search",
    description:
      "Search file names and contents across the person's workspaces, or one workspace. Returns matching lines with paths.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: { type: "string", minLength: 2, maxLength: 200 },
        workspace: Workspace,
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "quick_read",
    description:
      "Read part of a text file in a workspace, from a starting line. Call again with the returned next line for more.",
    inputSchema: {
      type: "object" as const,
      properties: {
        workspace: Workspace,
        path: { type: "string", minLength: 1, maxLength: 1024 },
        line: { type: "integer", minimum: 1 },
      },
      required: ["workspace", "path"],
      additionalProperties: false,
    },
  },
];
export const quickHostToolNames = new Set(quickHostToolDefinitions.map((tool) => tool.name));
const readChars = 3000;
const searchMatches = 20;

function projects(state: Snapshot) {
  return (state.project ?? []).filter((row) => !row.archived);
}
function findWorkspace(state: Snapshot, value: string) {
  const wanted = value.trim().toLowerCase();
  const row = projects(state).find(
    (item) => item.id === value || String(item.name).toLowerCase() === wanted,
  );
  if (!row) throw new Error("quick_workspace_unavailable");
  return row;
}
const args = (call: ToolInvocation) => (call.arguments ?? {}) as Record<string, unknown>;

export function quickHostTools(host: QuickHostContext) {
  return new Map<string, (call: ToolInvocation) => Promise<unknown>>([
    [
      "quick_workspaces",
      async () => {
        const items: unknown[] = [];
        let used = 0;
        for (const row of projects(host.state())) {
          const item = {
            id: row.id,
            name: row.name,
            ...(row.goal ? { goal: String(row.goal).slice(0, 200) } : {}),
            folders: ((row.roots as { label?: string; path: string }[] | undefined) ?? []).map(
              (root) => root.label || path.basename(root.path),
            ),
          };
          used += JSON.stringify(item).length;
          if (used > 3500) return { workspaces: items, truncated: true };
          items.push(item);
        }
        return { workspaces: items };
      },
    ],
    [
      "quick_search",
      async (call) => {
        const { query, workspace } = args(call);
        const words = String(query).toLowerCase().split(/\s+/).filter(Boolean);
        const state = host.state();
        const targets =
          typeof workspace === "string" ? [findWorkspace(state, workspace)] : projects(state);
        const matches: { workspace: string; path: string; line?: number; text?: string }[] = [];
        for (const project of targets)
          for (const root of await roots(state, String(project.id)))
            for await (const file of walk(root, 3000)) {
              if (matches.length >= searchMatches) return { matches, truncated: true };
              const label = path.relative(root, file).split(path.sep).join("/");
              if (sensitiveName.test(label)) continue;
              const name = label.toLowerCase();
              if (words.every((word) => name.includes(word))) {
                matches.push({ workspace: String(project.name), path: label });
                continue;
              }
              if (!textExtension.test(file)) continue;
              const text = await readBounded(file, 50_000).catch(() => undefined);
              if (!text) continue;
              const lines = text.split("\n");
              const index = lines.findIndex((line) =>
                words.every((word) => line.toLowerCase().includes(word)),
              );
              const found = lines[index]?.trim().slice(0, 160);
              if (index < 0 || !found || (await host.containsSecret(found))) continue;
              matches.push({
                workspace: String(project.name),
                path: label,
                line: index + 1,
                text: found,
              });
            }
        return { matches };
      },
    ],
    [
      "quick_read",
      async (call) => {
        const { workspace, path: file, line } = args(call);
        const state = host.state();
        const project = findWorkspace(state, String(workspace));
        if (sensitiveName.test(String(file))) throw new Error("quick_file_private");
        const found = await workspaceFile(state, String(project.id), String(file));
        const text = await readBounded(found.absolute, 500_000);
        if (text === undefined) throw new Error("quick_file_unreadable");
        const lines = text.split("\n");
        const start = Math.max(1, Number(line ?? 1));
        let out = "";
        let next = start;
        while (next <= lines.length && out.length + (lines[next - 1]?.length ?? 0) < readChars)
          out += `${lines[next++ - 1]}\n`;
        // A single very long line is cut rather than never returned.
        if (!out && next <= lines.length) out = (lines[next++ - 1] ?? "").slice(0, readChars);
        if (await host.containsSecret(out)) throw new Error("quick_file_private");
        return {
          workspace: project.name,
          path: found.label,
          line: start,
          text: out,
          ...(next <= lines.length ? { next } : {}),
        };
      },
    ],
  ]);
}
