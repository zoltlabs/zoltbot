import { expect, it } from "vitest";
import { setBudget } from "./budgets.js";
import { applyEvents } from "./projectors.js";

const at = "2026-10-28T12:00:00Z";
const context = { commandId: "budget", at, actor: { kind: "human" as const, id: "owner" } };
const task = {
  id: "task",
  rootId: "task",
  title: "Build",
  brief: "Build",
  acceptance: "Pass",
  expectedDeliverable: "Code",
  workspaceMode: "shared",
  state: "queued",
  revision: 1,
  attempt: 1,
  maxAttempts: 1,
  reviewRequired: true,
  executionLocation: "local",
  budgetTokens: 500,
  createdBy: context.actor,
  createdAt: at,
  updatedAt: at,
};
it("sets a task budget without dropping its other limit and audits the confirmed human action", () => {
  const next = applyEvents(
    { task: [task] },
    setBudget(
      { task: [task] },
      { scopeType: "task", scopeId: "task", usd: 1, confirmed: true },
      context,
    ).events,
  );
  expect(next.task?.[0]).toMatchObject({ budgetUsd: 1, budgetTokens: 500 });
  expect(next.audit?.[0]).toMatchObject({
    action: "budget.set",
    actor: context.actor,
    detail: { confirmed: true, usd: 1 },
  });
});
it("records project and day limits separately from per task defaults", () => {
  const state = { project: [{ id: "project", defaultBudgetUsd: 0.5 }] };
  const next = applyEvents(
    state,
    setBudget(state, { scopeType: "project", scopeId: "project", usd: 5, confirmed: true }, context)
      .events,
  );
  expect(next.project).toEqual(state.project);
  expect(next.settings?.[0]).toMatchObject({ key: "budget.project.project", value: { usd: 5 } });
  expect(
    setBudget(
      {},
      { scopeType: "day", scopeId: "2026-10-28", tokens: 1000, confirmed: true },
      context,
    ).events,
  ).toHaveLength(2);
});
it("refuses unconfirmed actors, invalid limits, and nonexistent scopes", () => {
  const input = { scopeType: "day", scopeId: "2026-10-28", usd: 1, confirmed: true };
  expect(() => setBudget({}, { ...input, confirmed: false }, context)).toThrow(
    "human_budget_confirmation_required",
  );
  expect(() =>
    setBudget({}, input, { ...context, actor: { kind: "agent", id: "profile" } }),
  ).toThrow("human_budget_confirmation_required");
  expect(() => setBudget({}, { ...input, usd: -1 }, context)).toThrow("invalid_budget");
  expect(() => setBudget({}, { ...input, scopeType: "task", scopeId: "absent" }, context)).toThrow(
    "budget_scope_unavailable",
  );
});
