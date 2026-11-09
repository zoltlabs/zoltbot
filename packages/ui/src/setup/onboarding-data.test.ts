import type { ImportItem } from "@zoltbot/protocol";
import { expect, it } from "vitest";
import {
  agentRows,
  defaultAgents,
  firstChatAgent,
  historySources,
  importSelection,
  serverRows,
  sessionGroups,
  sessionTitle,
} from "./onboarding-data.js";

const agent = (id: string, login: string, path = `/bin/${id}`, plan?: string) => ({
  kind: "agent",
  definitionId: id,
  displayName: id,
  install: { selected: { path, version: "1.0.0", support: "tested" } },
  login: { state: login, ...(plan ? { plan } : {}) },
});
it("checks installed, signed-in agents and keeps the reported plan", () => {
  const rows = agentRows([
    agent("cursor", "signed_out"),
    agent("claude", "signed_in", "/bin/claude", "Max plan"),
    { kind: "agent", definitionId: "opencode", displayName: "OpenCode", install: {}, login: {} },
    agent("gemini", "unknown"),
    agent("pi", "api_key_configured"),
  ]);
  expect(rows.at(-1)?.id).toBe("opencode");
  expect(rows.find((row) => row.id === "claude")?.plan).toBe("Max plan");
  expect([...defaultAgents(rows)].sort()).toEqual(["claude", "pi"]);
});
it("starts the first chat with Claude Code, then Codex, then Antigravity, then any agent", () => {
  expect(firstChatAgent(["gemini", "codex", "claude"])).toBe("claude");
  expect(firstChatAgent(["gemini", "codex"])).toBe("codex");
  expect(firstChatAgent(["gemini", "antigravity"])).toBe("antigravity");
  expect(firstChatAgent(["gemini", "cursor"], () => 0.9)).toBe("cursor");
  expect(firstChatAgent([])).toBeUndefined();
});
it("reads history only from connected agents Zoltbot can import from", () => {
  expect(historySources(["codex", "antigravity", "claude"])).toEqual(["claude", "codex"]);
});

const now = Date.UTC(2026, 10, 6);
const day = 86400000;
const session = (id: string, age: number, extra: Partial<ImportItem> = {}): ImportItem => ({
  id,
  kind: "session",
  source: "claude",
  name: id,
  modifiedAt: now - age * day,
  ...extra,
});
const items: ImportItem[] = [
  session("a", 1, { repoRoot: "/code/app", remote: "acme/app" }),
  session("b", 200, { repoRoot: "/code/app", remote: "acme/app" }),
  session("c", 5, { repoRoot: "/code/tool" }),
  session("d", 3),
  session("e", 2, { repoRoot: "/code/app", remote: "acme/app", brief: true }),
  {
    id: "p1",
    kind: "project",
    source: "claude",
    name: "app",
    path: "/code/app",
    repoRoot: "/code/app",
  },
  {
    id: "p2",
    kind: "project",
    source: "codex",
    name: "web",
    path: "/code/app/web",
    repoRoot: "/code/app",
  },
  { id: "p3", kind: "project", source: "claude", name: "tool", path: "/code/tool" },
  {
    id: "m1",
    kind: "mcp",
    source: "claude",
    name: "github",
    configuration: { env: { TOKEN: "x" } },
  },
  { id: "m2", kind: "mcp", source: "codex", name: "github" },
  { id: "m3", kind: "mcp", source: "claude", name: "local", scopePath: "/code/app" },
];
it("groups recent sessions by repository, hides brief ones and keeps loose sessions last", () => {
  const { groups, brief } = sessionGroups(items, 90, now);
  expect(groups.map((group) => [group.name, group.sessions.map((row) => row.id)])).toEqual([
    ["acme/app", ["a"]],
    ["tool", ["c"]],
    ["Sessions outside a repository", ["d"]],
  ]);
  expect(brief).toBe(1);
  expect(sessionGroups(items, "all", now).groups[0]?.sessions.map((row) => row.id)).toEqual([
    "a",
    "b",
  ]);
});
it("turns only repositories with chosen sessions into projects", () => {
  expect(importSelection(items, new Set(["a", "d"]), new Set(["m1"]))).toEqual([
    "a",
    "d",
    "m1",
    "p1",
  ]);
  expect(importSelection(items, new Set(["c"]), new Set())).toEqual(["c", "p3"]);
});
it("shows each global MCP server once with secret names only", () => {
  expect(serverRows(items)).toEqual([
    { name: "github", ids: ["m1", "m2"], sources: ["claude", "codex"], secrets: ["TOKEN"] },
  ]);
});
it("names ID-only sessions without opening them", () => {
  expect(sessionTitle(session("0b6e0a8e-5f1c-4f3e-9a0b-1c2d3e4f5a6b", 0))).toBe("Untitled session");
  expect(
    sessionTitle(session("rollout-2026-11-06T10-00-00-0b6e0a8e-5f1c-4f3e-9a0b-1c2d3e4f5a6b", 0)),
  ).toBe("Untitled session");
  expect(sessionTitle(session("Fix the flaky test", 0))).toBe("Fix the flaky test");
});

it("imports selected repositories without any session history", () => {
  expect(
    importSelection(items, new Set(), new Set(), new Set(["/code/app", "/code/tool"])),
  ).toEqual(["p1", "p3"]);
});
it("combines repository-only choices with sessions from another repository", () => {
  expect(importSelection(items, new Set(["c"]), new Set(["m1"]), new Set(["/code/app"]))).toEqual([
    "c",
    "m1",
    "p1",
    "p3",
  ]);
});
