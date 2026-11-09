import type { ImportReceipt } from "@zoltbot/protocol";
import { expect, it } from "vitest";
import { importOutcome } from "./imports.js";
import { applyEvents } from "./projectors.js";

const context = {
  commandId: "import:preview",
  actor: { kind: "human" as const, id: "owner" },
  at: "2026-10-27T17:00:00.000Z",
};
const receipt: ImportReceipt = {
  id: "preview",
  items: [
    { id: "repo", kind: "project", source: "git", name: "Repository", path: "/work/repository" },
    {
      id: "hint",
      kind: "project",
      source: "claude",
      name: "-work-maybe-repo",
      nativePath: "/home/.claude/projects/-work-maybe-repo",
    },
    {
      id: "session",
      kind: "session",
      source: "claude",
      name: "Native session",
      nativeId: "native",
      path: "/home/.claude/projects/session.jsonl",
    },
    {
      id: "mcp",
      kind: "mcp",
      source: "cursor",
      name: "Example",
      configuration: { command: "example", env: { API_KEY: "[confirmation required]" } },
    },
  ],
};
it("atomically plans projects, native session metadata, pending MCP entries, and unresolved hints", () => {
  const original = structuredClone(receipt);
  const outcome = importOutcome({}, receipt, context, true);
  const state = applyEvents({}, outcome.events);
  expect(state.project).toHaveLength(1);
  expect(state.project?.[0]?.roots).toEqual([
    { path: "/work/repository", repoRoot: "/work/repository", label: "Repository" },
  ]);
  expect(state.nativeSession?.[0]).toMatchObject({
    provider: "claude",
    nativeId: "native",
    adopted: false,
  });
  const registry = state.settings?.find((item) => item.key === "mcp.registry")?.value;
  expect(registry).toMatchObject([{ state: "needs_confirmation", enabledAgentIds: [] }]);
  expect(state.audit).toHaveLength(1);
  expect(receipt).toEqual(original);
  expect(new Set(outcome.events.map((item) => item.eventId)).size).toBe(outcome.events.length);
});
it("preserves existing projects, adopted native sessions, and explicit MCP enablement", () => {
  const first = applyEvents({}, importOutcome({}, receipt, context, true).events);
  const session = first.nativeSession?.[0];
  if (!session) throw new Error("missing_session");
  session.adopted = true;
  session.threadId = "owned-thread";
  const registry = first.settings?.find((item) => item.key === "mcp.registry")?.value as Record<
    string,
    unknown
  >[];
  if (!registry[0]) throw new Error("missing_registry");
  registry[0].enabledAgentIds = ["profile"];
  registry[0].state = "configured";

  const second = applyEvents(
    first,
    importOutcome(first, receipt, { ...context, commandId: "second" }, true).events,
  );
  expect(second.project).toEqual(first.project);
  expect(second.nativeSession).toEqual(first.nativeSession);
  expect(second.settings).toEqual(first.settings);
});
it("requires human consent and rejects malformed receipts before producing events", () => {
  expect(() => importOutcome({}, receipt, context, false)).toThrow("import_consent_required");
  expect(() =>
    importOutcome({}, receipt, { ...context, actor: { kind: "agent", id: "agent" } }, true),
  ).toThrow("import_consent_required");
  expect(() =>
    importOutcome({}, { ...receipt, items: [...receipt.items, receipt.items[0]] }, context, true),
  ).toThrow();
});
it("keeps selected MCP entries with identical names from distinct config locations", () => {
  const input = {
    id: "origin-preview",
    items: [
      {
        id: "one",
        kind: "mcp",
        source: "opencode",
        name: "shared",
        nativePath: "/work/one/opencode.json",
        configuration: { command: "first" },
      },
      {
        id: "two",
        kind: "mcp",
        source: "opencode",
        name: "shared",
        nativePath: "/work/two/opencode.json",
        configuration: { command: "second" },
      },
    ],
  };
  const first = applyEvents({}, importOutcome({}, input, context, true).events);
  const registry = first.settings?.find((item) => item.key === "mcp.registry")?.value as Record<
    string,
    unknown
  >[];
  expect(registry.map((item) => item.nativePath)).toEqual([
    "/work/one/opencode.json",
    "/work/two/opencode.json",
  ]);
  const second = applyEvents(
    first,
    importOutcome(first, input, { ...context, commandId: "retry-origin" }, true).events,
  );
  expect(second.settings).toEqual(first.settings);
});
it("does not claim that a configured project folder is a verified Git root", () => {
  const input = {
    id: "folder-preview",
    items: [
      { id: "folder", kind: "project", source: "codex", name: "Folder", path: "/work/folder" },
    ],
  };
  const state = applyEvents({}, importOutcome({}, input, context, true).events);
  expect(state.project?.[0]?.roots).toEqual([{ path: "/work/folder", label: "Folder" }]);
});
it("keeps project scoped MCP entries distinct inside one native config file", () => {
  const input = {
    id: "scopes",
    items: [
      {
        id: "one",
        kind: "mcp",
        source: "claude",
        name: "shared",
        nativePath: "/home/.claude.json",
        scopePath: "/work/one",
        configuration: { command: "first" },
      },
      {
        id: "two",
        kind: "mcp",
        source: "claude",
        name: "shared",
        nativePath: "/home/.claude.json",
        scopePath: "/work/two",
        configuration: { command: "second" },
      },
    ],
  };
  const state = applyEvents({}, importOutcome({}, input, context, true).events);
  const registry = state.settings?.find((item) => item.key === "mcp.registry")?.value as Record<
    string,
    unknown
  >[];
  expect(registry.map((item) => item.scopePath)).toEqual(["/work/one", "/work/two"]);
});
