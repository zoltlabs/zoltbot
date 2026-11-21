// A9: cost caps. A routine can cap what one run spends; agents and projects can cap a week.
// Caps live in settings rows `limits.{scopeType}.{scopeId}`; spend comes from usage records.
import { parseEvent } from "@zoltbot/protocol";
import { type CommandContext, handle, type Outcome } from "./commands.js";
import { requestInteraction } from "./interactions.js";
import type { DomainState } from "./projectors.js";

/** Which limits each scope takes. */
export const LIMIT_FIELDS: Record<string, readonly string[]> = {
  routine: ["usdPerRun"],
  agent: ["usdPerWeek"],
  project: ["usdPerWeek"],
};
export const limitsKey = (scopeType: string, scopeId: string) => `limits.${scopeType}.${scopeId}`;

export function readLimits(state: DomainState, scopeType: string, scopeId: string) {
  const value = state.settings?.find((row) => row.key === limitsKey(scopeType, scopeId))?.value;
  const limits: Record<string, number> = {};
  if (value && typeof value === "object" && !Array.isArray(value))
    for (const [key, amount] of Object.entries(value))
      if (typeof amount === "number" && Number.isFinite(amount)) limits[key] = amount;
  return limits;
}

/**
 * Sets a scope's limits; a missing field clears it. People only, and confirmed, since a higher
 * cap lets work spend more (I13).
 */
export function setLimits(
  state: DomainState,
  input: { scopeType: string; scopeId: string; limits: Record<string, number>; confirmed: boolean },
  context: CommandContext,
): Outcome {
  if (context.actor.kind !== "human" || input.confirmed !== true)
    throw new Error("human_limit_confirmation_required");
  const fields = LIMIT_FIELDS[input.scopeType];
  if (!fields) throw new Error("invalid_limit_scope");
  const kind = input.scopeType as "routine" | "agent" | "project";
  if (!state[kind]?.some((row) => row.id === input.scopeId && !row.archived))
    throw new Error("limit_scope_unavailable");
  for (const [key, amount] of Object.entries(input.limits))
    if (!fields.includes(key) || !Number.isFinite(amount) || amount <= 0 || amount > 100_000)
      throw new Error("invalid_limit");
  const key = limitsKey(input.scopeType, input.scopeId);
  const exists = state.settings?.some((row) => row.key === key);
  const outcome = handle(
    state,
    exists
      ? { type: "update", kind: "settings", id: key, changes: { value: input.limits } }
      : { type: "create", kind: "settings", value: { key, value: input.limits } },
    context,
  );
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
        action: "limits.set",
        target: `${input.scopeType}:${input.scopeId}`,
        result: "allowed",
        detail: { confirmed: true, ...input.limits },
        at: context.at,
      },
    }),
  );
  return { events: outcome.events, result: { ok: true } };
}

/** What a task has spent so far, in dollars, from its usage records. */
export function taskSpendUsd(state: DomainState, taskId: string): number {
  return (state.usage ?? [])
    .filter((row) => row.taskId === taskId && typeof row.costUsd === "number")
    .reduce((sum, row) => sum + (row.costUsd as number), 0);
}

/** The average cost of the routine's last 5 finished runs with recorded spend; none without. */
export function routineRunEstimate(state: DomainState, routineId: string): number | undefined {
  const runs = (state.routineOccurrence ?? [])
    .filter((row) => row.routineId === routineId && row.status === "completed" && row.taskId)
    .sort((a, b) => String(b.scheduledAt).localeCompare(String(a.scheduledAt)))
    .map((row) => String(row.taskId))
    .filter((taskId) => (state.usage ?? []).some((row) => row.taskId === taskId))
    .slice(0, 5);
  if (!runs.length) return undefined;
  return runs.reduce((sum, taskId) => sum + taskSpendUsd(state, taskId), 0) / runs.length;
}

export const capInteractionId = (occurrenceId: string) => `routine-cap-${occurrenceId}`;
const dollars = (usd: number) => `$${Number.isInteger(usd) ? usd : usd.toFixed(2)}`;

/** The owner's answer to a run's cap card: allow, stop, still pending, or never asked. */
export function routineCapAnswer(state: DomainState, occurrenceId: string) {
  const card = state.interaction?.find((row) => row.id === capInteractionId(occurrenceId));
  if (!card) return undefined;
  if (card.state === "pending") return "pending";
  const resolution = card.resolution as
    | { action?: string; answers?: Record<string, { options?: string[] }> }
    | undefined;
  return resolution?.action === "accept" &&
    resolution.answers?.choice?.options?.includes("allow") === true
    ? "allow"
    : "stop";
}

/**
 * Raises the cap card when a run's spend reaches its routine's cap and it hasn't been asked.
 * Returns undefined when there is nothing to do.
 */
export function routineCapCheck(
  state: DomainState,
  occurrence: { id: string; routineId: string; taskId?: string },
  context: CommandContext,
): Outcome | undefined {
  const cap = readLimits(state, "routine", occurrence.routineId).usdPerRun;
  if (cap === undefined || !occurrence.taskId) return undefined;
  if (routineCapAnswer(state, occurrence.id) !== undefined) return undefined;
  if (taskSpendUsd(state, occurrence.taskId) < cap) return undefined;
  const task = state.task?.find((row) => row.id === occurrence.taskId);
  const thread = state.thread?.find((row) => row.id === task?.threadId);
  if (!thread) return undefined;
  const routine = state.routine?.find((row) => row.id === occurrence.routineId);
  const name = String(routine?.name ?? "This routine");
  return requestInteraction(
    state,
    {
      id: capInteractionId(occurrence.id),
      agentId: String(thread.agentId),
      threadId: String(thread.id),
      type: "question",
      title: `"${name}" reached its ${dollars(cap)} cap`,
      chain: [{ kind: "system", id: "routine-caps" }],
      urgency: "blocking",
      items: [
        {
          id: "choice",
          header: "Cost cap",
          prompt: `This run has spent ${dollars(taskSpendUsd(state, occurrence.taskId))}.`,
          options: [
            { id: "allow", label: "Allow this run" },
            { id: "stop", label: "Stop", recommended: true },
          ],
        },
      ],
    },
    `${capInteractionId(occurrence.id)}:item`,
    context,
  );
}
