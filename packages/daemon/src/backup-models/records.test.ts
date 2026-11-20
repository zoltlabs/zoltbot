import type { DomainState } from "@zoltbot/core";
import { expect, it } from "vitest";
import {
  accountHomeKey,
  configuredOrder,
  listAccounts,
  loginArgs,
  ordersKey,
  slashCommand,
  threadRole,
} from "./records.js";

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

const tool = (id: string, adapter: string, experimental = false, extra = {}) => ({
  id,
  displayName: id,
  adapter,
  ...(adapter === "acp" ? { flavor: id } : {}),
  binaryNames: [id],
  versionCommand: ["--version"],
  launch: { command: id, args: [], env: {} },
  testedVersions: "1.0.0",
  defaults: { permissionProfile: "workspace_write" },
  staticCapabilities: {},
  nativeSessionRoots: [],
  experimental,
  ...extra,
});

it("lists every coding tool's own sign-in; only some can add more", () => {
  const accounts = listAccounts({
    agentDefinition: [
      tool("claude", "claude"),
      tool("antigravity", "acp", false, { auth: { loginCommand: [] } }),
      tool("pi", "pi"),
      tool("pi:deepseek", "pi", false, { auth: { apiKeyEnv: "DEEPSEEK_API_KEY" } }),
      tool("opencode", "acp", false, { auth: { loginCommand: ["auth", "login"] } }),
      tool("grok", "acp", false, { auth: { loginCommand: ["login"] } }),
      tool("cline", "acp"),
      tool("qwen", "acp"),
      tool("kimi", "acp"),
      tool("goose", "acp"),
      tool("trial", "acp", true),
    ],
  });
  expect(accounts.map((row) => [row.definitionId, row.isDefault, row.canAddAccounts])).toEqual([
    ["claude", true, true],
    ["antigravity", true, false],
    ["pi", true, true],
    ["pi:deepseek", true, false],
    ["opencode", true, true],
    ["grok", true, true],
    ["cline", true, true],
    ["qwen", true, true],
    ["kimi", true, true],
    ["goose", true, false],
  ]);
});

it("points an added account's launch at its own sign-in folder", () => {
  expect(accountHomeKey(tool("opencode", "acp"))).toBe("XDG_DATA_HOME");
  expect(accountHomeKey(tool("grok", "acp"))).toBe("GROK_HOME");
  expect(accountHomeKey(tool("pi", "pi"))).toBe("PI_CODING_AGENT_DIR");
  expect(accountHomeKey(tool("antigravity", "acp"))).toBeUndefined();
  expect(accountHomeKey(tool("cursor", "acp"))).toBeUndefined();
});

it("signs in from inside the tool when its command only opens it", () => {
  expect([loginArgs(tool("cline", "acp")), slashCommand(tool("cline", "acp"))]).toEqual([
    ["auth"],
    undefined,
  ]);
  expect([loginArgs(tool("kimi", "acp")), slashCommand(tool("kimi", "acp"))]).toEqual([
    ["login"],
    undefined,
  ]);
  expect([loginArgs(tool("qwen", "acp")), slashCommand(tool("qwen", "acp"))]).toEqual([
    [],
    "/auth",
  ]);
  expect([loginArgs(tool("pi", "pi")), slashCommand(tool("pi", "pi"))]).toEqual([[], "/login"]);
});
