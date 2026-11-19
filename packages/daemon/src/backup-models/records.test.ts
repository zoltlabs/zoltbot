import type { DomainState } from "@zoltbot/core";
import { expect, it } from "vitest";
import { configuredOrder, ordersKey, threadRole } from "./records.js";

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
