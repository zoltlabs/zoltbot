import type { DomainState } from "@zoltbot/core";
import { expect, it } from "vitest";
import { configuredOrder, listAccounts, ordersKey, threadRole } from "./records.js";

const state = (orders: unknown): DomainState => ({
  thread: [
    { id: "lead", kind: "manager", node: { type: "project" } },
    { id: "team", kind: "manager", node: { type: "subproject" } },
    { id: "task", kind: "task" },
  ],
  settings: [{ key: ordersKey, value: orders }],
});
const a = [{ accountId: "a" }];
const b = [{ accountId: "b" }];
const c = [{ accountId: "c" }];

it("derives the role from the chat", () => {
  const s = state({});
  expect(threadRole(s, "lead")).toBe("ceo");
  expect(threadRole(s, "team")).toBe("manager");
  expect(threadRole(s, "task")).toBe("employee");
});

it("uses the agent's order, then its role's, then the employee order", () => {
  expect(configuredOrder(state({ employee: a }), "lead")).toEqual(a);
  expect(configuredOrder(state({ employee: a, manager: null }), "team")).toEqual(a);
  expect(configuredOrder(state({ employee: a, ceo: b }), "lead")).toEqual(b);
  expect(configuredOrder(state({ employee: a, ceo: b }), "task")).toEqual(a);
  expect(configuredOrder(state({ employee: a, ceo: b, agents: { lead: c } }), "lead")).toEqual(c);
});

const tool = (id: string, adapter: string, experimental = false) => ({
  id,
  displayName: id,
  adapter,
  binaryNames: [id],
  versionCommand: ["--version"],
  launch: { command: id, args: [], env: {} },
  testedVersions: "1.0.0",
  defaults: { permissionProfile: "workspace_write" },
  staticCapabilities: {},
  nativeSessionRoots: [],
  experimental,
});

it("lists every coding tool's own sign-in; only some can add more", () => {
  const accounts = listAccounts({
    agentDefinition: [
      tool("claude", "claude"),
      tool("antigravity", "acp"),
      tool("pi", "pi"),
      tool("trial", "acp", true),
    ],
  });
  expect(accounts.map((row) => [row.definitionId, row.isDefault, row.canAddAccounts])).toEqual([
    ["claude", true, true],
    ["antigravity", true, false],
    ["pi", true, false],
  ]);
});
