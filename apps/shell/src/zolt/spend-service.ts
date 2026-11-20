// S6: the Usage page's daemon calls.
import { randomUUID } from "node:crypto";
import { IPC_CHANNELS } from "../shared/ipc";
import type { SpendBudgetInput } from "../shared/spend";
import type { DaemonClient } from "./daemon-client";
import { isObject, requireString } from "./parsers";
import { toSpendView } from "./spend-view";

function parseFrom(input: unknown): string {
  const from = isObject(input) ? input.from : undefined;
  if (typeof from !== "string" || Number.isNaN(Date.parse(from)))
    throw new Error("Invalid usage range.");
  return from;
}

function parseBudget(input: unknown): SpendBudgetInput {
  if (!isObject(input)) throw new Error("Invalid budget.");
  const usd = Math.round(Number(input.usd) * 100) / 100;
  if (!Number.isFinite(usd) || usd < 0 || usd > 1_000_000)
    throw new Error("Enter an amount from $0 to $1,000,000.");
  return { projectId: requireString(input.projectId, "projectId"), usd };
}

export function spendHandlers(client: DaemonClient): Record<string, (input: unknown) => unknown> {
  return {
    [IPC_CHANNELS.spendList]: (input) =>
      toSpendView(client.snapshot as Parameters<typeof toSpendView>[0], parseFrom(input)),
    [IPC_CHANNELS.spendSetBudget]: async (input) => {
      const budget = parseBudget(input);
      await client.call(
        "budget.set",
        { scopeType: "project", scopeId: budget.projectId, usd: budget.usd, confirmed: true },
        randomUUID(),
      );
    },
  };
}
