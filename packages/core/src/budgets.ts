import { parseEvent } from "@zoltbot/protocol";
import { type CommandContext, handle, type Outcome } from "./commands.js";
import type { DomainState } from "./projectors.js";
import { type BudgetLimit, evaluateBudget } from "./usage-meter.js";

export interface BudgetInput {
  scopeType: string;
  scopeId: string;
  usd?: number;
  tokens?: number;
  confirmed: boolean;
}
export function setBudget(
  state: DomainState,
  input: BudgetInput,
  context: CommandContext,
): Outcome {
  if (context.actor.kind !== "human" || input.confirmed !== true)
    throw new Error("human_budget_confirmation_required");
  const limit: BudgetLimit = {
    scopeType: input.scopeType as BudgetLimit["scopeType"],
    scopeId: input.scopeId,
    ...(input.usd !== undefined ? { usd: input.usd } : {}),
    ...(input.tokens !== undefined ? { tokens: input.tokens } : {}),
  };
  evaluateBudget([], limit);
  if (!input.scopeId || input.scopeId.length > 160) throw new Error("invalid_budget_scope");
  const scoped = state[input.scopeType]?.find((row) => row.id === input.scopeId && !row.archived);
  if (input.scopeType !== "day" && !scoped) throw new Error("budget_scope_unavailable");
  const value = {
    ...(input.usd !== undefined ? { usd: input.usd } : {}),
    ...(input.tokens !== undefined ? { tokens: input.tokens } : {}),
  };
  let outcome: Outcome;
  if (input.scopeType === "task") {
    outcome = handle(
      state,
      {
        type: "update",
        kind: "task",
        id: input.scopeId,
        changes: {
          ...(input.usd !== undefined ? { budgetUsd: input.usd } : {}),
          ...(input.tokens !== undefined ? { budgetTokens: input.tokens } : {}),
        },
      },
      context,
    );
  } else {
    const key = `budget.${input.scopeType}.${input.scopeId}`;
    const previous = state.settings?.find((row) => row.key === key);
    const old =
      previous?.value && typeof previous.value === "object" && !Array.isArray(previous.value)
        ? (previous.value as Record<string, unknown>)
        : {};
    const merged = {
      ...(typeof old.usd === "number" ? { usd: old.usd } : {}),
      ...(typeof old.tokens === "number" ? { tokens: old.tokens } : {}),
      ...value,
    };
    evaluateBudget([], { ...limit, ...merged });
    outcome = handle(
      state,
      previous
        ? { type: "update", kind: "settings", id: key, changes: { value: merged } }
        : { type: "create", kind: "settings", value: { key, value: merged } },
      context,
    );
  }
  outcome.events.push(
    parseEvent({
      eventId: `${context.commandId}:${outcome.events.length}`,
      commandId: context.commandId,
      aggregateType: "audit",
      aggregateId: `audit:${context.commandId}`,
      type: "audit.created",
      occurredAt: context.at,
      payload: {
        id: `audit:${context.commandId}`,
        actor: context.actor,
        action: "budget.set",
        target: `${input.scopeType}:${input.scopeId}`,
        result: "allowed",
        detail: { confirmed: true, ...value },
        at: context.at,
      },
    }),
  );
  return { events: outcome.events, result: { ok: true } };
}
