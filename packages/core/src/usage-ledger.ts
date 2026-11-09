import { parse, UsageRecordSchema, type UsageSample, UsageSampleSchema } from "@zoltbot/protocol";
import { type CommandContext, handle, type Outcome } from "./commands.js";
import type { DomainState } from "./projectors.js";

export interface UsageInput {
  sessionId: string;
  turnId: string;
  sample: UsageSample;
  /** Zero for a new native session, or measured pre turn totals on adoption. */
  baseline?: UsageSample;
  injectedTokens?: number;
}
const fields = [
  "inputTokens",
  "outputTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "costUsd",
] as const;
export function recordUsage(
  state: DomainState,
  input: UsageInput,
  context: CommandContext,
): Outcome {
  if (context.actor.kind !== "system") throw new Error("system_usage_writer_required");
  const session = state.session?.find((row) => row.id === input.sessionId);
  const turn = state.turn?.find((row) => row.id === input.turnId);
  const thread = state.thread?.find((row) => row.id === session?.threadId);
  if (
    !session ||
    !turn ||
    !thread ||
    turn.sessionId !== session.id ||
    turn.threadId !== session.threadId
  )
    throw new Error("usage_session_mismatch");
  if (
    input.injectedTokens !== undefined &&
    (!Number.isSafeInteger(input.injectedTokens) || input.injectedTokens < 0)
  )
    throw new Error("invalid_injected_tokens");
  const sample = parse(UsageSampleSchema, input.sample);
  const baseline = input.baseline ? parse(UsageSampleSchema, input.baseline) : undefined;
  const previousRow = state.usage?.find((row) => row.id === input.turnId);
  const previous = previousRow ? parse(UsageRecordSchema, previousRow) : undefined;
  if (previous && previous.sessionId !== input.sessionId) throw new Error("usage_record_conflict");
  const other = (state.usage ?? [])
    .filter((row) => row.sessionId === input.sessionId && row.id !== input.turnId)
    .map((row) => parse(UsageRecordSchema, row));
  const unrecordedTurn = state.turn?.some(
    (row) =>
      row.sessionId === input.sessionId &&
      row.id !== input.turnId &&
      !other.some((record) => record.turnId === row.id),
  );
  const values: Record<string, number> = {};
  let counterReset = false;
  for (const field of fields) {
    const reported = sample[field];
    if (reported === undefined) continue;
    if (!Number.isFinite(reported) || (field !== "costUsd" && !Number.isSafeInteger(reported)))
      throw new Error("invalid_usage_sample");
    if (!sample.cumulative) {
      values[field] = reported;
      continue;
    }
    const initial = baseline?.[field];
    if (
      initial === undefined ||
      unrecordedTurn ||
      other.some((row) => row[field] === undefined || (field === "costUsd" && !row.costKnown))
    )
      continue;
    const amount = reported - initial - other.reduce((sum, row) => sum + (row[field] as number), 0);
    if (amount < 0 && (field !== "costUsd" || amount < -1e-10)) {
      counterReset = true;
      continue;
    }
    values[field] = Math.max(0, amount);
  }
  const record = parse(UsageRecordSchema, {
    ...previous,
    ...values,
    id: input.turnId,
    sessionId: input.sessionId,
    turnId: input.turnId,
    ...(typeof thread.taskId === "string" ? { taskId: thread.taskId } : {}),
    ...(typeof thread.projectId === "string" ? { projectId: thread.projectId } : {}),
    costKnown: values.costUsd !== undefined || previous?.costKnown === true,
    injectedTokens: input.injectedTokens ?? previous?.injectedTokens ?? 0,
    recordedAt: previous?.recordedAt ?? turn.startedAt ?? context.at,
  });
  const { id: _id, ...changes } = record;
  const outcome = handle(
    state,
    previous
      ? { type: "update", kind: "usage", id: input.turnId, changes }
      : { type: "create", kind: "usage", value: record },
    context,
  );
  return { events: outcome.events, result: { record, counterReset } };
}
