import { type CommandContext, handle, type Outcome } from "./commands.js";
import type { DomainState } from "./projectors.js";

/**
 * Whether a native mode widens what an agent may do without asking (I13). The session's
 * capabilities.safeModes lists the modes that never widen; without that list every mode widens.
 */
export function widensPermission(mode: string, safeModes: unknown): boolean {
  return !(Array.isArray(safeModes) && safeModes.includes(mode));
}

function liveSession(state: DomainState, sessionId: string) {
  const session = state.session?.find((row) => row.id === sessionId);
  const thread = state.thread?.find((row) => row.id === session?.threadId && !row.archived);
  if (!session || !thread || !["starting", "ready", "running"].includes(String(session.state)))
    throw new Error("runtime_session_unavailable");
  return {
    session,
    capabilities: (session.capabilities ?? {}) as Record<string, unknown>,
  };
}
function audited(
  state: DomainState,
  action: string,
  target: string,
  detail: Record<string, unknown>,
  context: CommandContext,
  result: Record<string, unknown>,
): Outcome {
  const outcome = handle(
    state,
    {
      type: "create",
      kind: "audit",
      value: {
        id: `audit:${context.commandId}`,
        actor: context.actor,
        action,
        target,
        result: "allowed",
        detail,
        at: context.at,
      },
    },
    context,
  );
  return { events: outcome.events, result };
}

/** Record a human mode change before the native session is told. Widening is audited as I13. */
export function requestSessionMode(
  state: DomainState,
  sessionId: string,
  mode: string,
  context: CommandContext,
  confirmed = false,
): Outcome {
  if (context.actor.kind !== "human") throw new Error("human_mode_change_required");
  const { session, capabilities } = liveSession(state, sessionId);
  const modes = capabilities.modes;
  if (!Array.isArray(modes) || !modes.includes(mode)) throw new Error("unsupported_mode");
  const widens = widensPermission(mode, capabilities.safeModes);
  if (
    mode !== session.mode &&
    state.compare?.some((row) => row.summaryThreadId === session.threadId)
  )
    throw new Error("compare_summary_permission_ceiling");
  if (
    mode !== session.mode &&
    state.compareMember?.some(
      (row) => row.threadId === session.threadId && row.ceiling === "read_only",
    )
  )
    throw new Error("compare_permission_ceiling: use compare.widen first");
  // I13: widening needs an explicit human confirmation, recorded in the audit row.
  if (widens && confirmed !== true) throw new Error("confirmation_required");
  return audited(
    state,
    "session.setMode",
    sessionId,
    {
      threadId: session.threadId,
      mode,
      ...(typeof session.mode === "string" ? { previous: session.mode } : {}),
      widensPermission: widens,
      confirmed: confirmed === true,
    },
    context,
    { kind: "set_mode", sessionId, mode, widens },
  );
}

/** The native session acknowledged the mode; mode.changed from the adapter may also arrive. */
export function settleSessionMode(
  state: DomainState,
  sessionId: string,
  mode: string,
  context: CommandContext,
): Outcome {
  if (context.actor.kind !== "system") throw new Error("system_mode_writer_required");
  const session = state.session?.find((row) => row.id === sessionId);
  if (!session || ["closed", "failed"].includes(String(session.state)) || session.mode === mode)
    return { events: [], result: { mode } };
  return handle(
    state,
    { type: "update", kind: "session", id: sessionId, changes: { mode } },
    context,
  );
}

/**
 * Record a human model or effort change before the native session is told. The model must be one
 * the session lists (when it lists any) and the effort one it offers. Changing either after the
 * first turn drops the provider's prompt cache, so the caller must have shown that and say so.
 */
export function requestSessionModel(
  state: DomainState,
  sessionId: string,
  change: { model: string; effort?: string; cacheWarningAccepted: boolean },
  context: CommandContext,
): Outcome {
  if (context.actor.kind !== "human") throw new Error("human_model_change_required");
  const { session, capabilities } = liveSession(state, sessionId);
  const models = (capabilities.models ?? {}) as { selectable?: unknown; list?: unknown };
  if (models.selectable !== true) throw new Error("unsupported_model");
  if (
    Array.isArray(models.list) &&
    models.list.length &&
    !models.list.some((row) => (row as { id?: unknown }).id === change.model)
  )
    throw new Error("unsupported_model");
  const efforts = Array.isArray(capabilities.effort) ? capabilities.effort : [];
  if (change.effort !== undefined && !efforts.includes(change.effort))
    throw new Error("unsupported_effort");
  const started = state.turn?.some((turn) => turn.sessionId === sessionId);
  if (started && change.cacheWarningAccepted !== true) throw new Error("cache_warning_required");
  return audited(
    state,
    "session.setModel",
    sessionId,
    {
      threadId: session.threadId,
      model: change.model,
      ...(change.effort !== undefined ? { effort: change.effort } : {}),
      ...(typeof session.model === "string" ? { previousModel: session.model } : {}),
      ...(typeof session.effort === "string" ? { previousEffort: session.effort } : {}),
    },
    context,
    {
      kind: "set_model",
      sessionId,
      model: change.model,
      ...(change.effort !== undefined ? { effort: change.effort } : {}),
    },
  );
}

/** Stores the model and effort the native session accepted. */
export function settleSessionModel(
  state: DomainState,
  sessionId: string,
  change: { model: string; effort?: string },
  context: CommandContext,
): Outcome {
  if (context.actor.kind !== "system") throw new Error("system_model_writer_required");
  const session = state.session?.find((row) => row.id === sessionId);
  if (!session || ["closed", "failed"].includes(String(session.state)))
    return { events: [], result: change };
  return handle(
    state,
    {
      type: "update",
      kind: "session",
      id: sessionId,
      // No effort means the model's default, as at launch; undefined drops the stored one.
      changes: { model: change.model, effort: change.effort },
    },
    context,
  );
}

/** Stopping a background task kills its process, so the request is audited. */
export function requestBackgroundStop(
  state: DomainState,
  sessionId: string,
  taskId: string,
  context: CommandContext,
): Outcome {
  if (context.actor.kind !== "human") throw new Error("human_background_stop_required");
  const { session, capabilities } = liveSession(state, sessionId);
  if (capabilities.backgroundTasks !== true) throw new Error("unsupported_background_tasks");
  const tasks = Array.isArray(session.background)
    ? (session.background as { id: string; state: string }[])
    : [];
  if (!tasks.some((task) => task.id === taskId && task.state === "running"))
    throw new Error("background_task_unavailable");
  return audited(
    state,
    "session.stopBackground",
    taskId,
    { threadId: session.threadId, sessionId },
    context,
    { kind: "stop_background", sessionId, taskId },
  );
}

/** Validate a rewind target: a finished turn of this session's thread while nothing runs. */
export function checkFilesRewind(state: DomainState, sessionId: string, turnId: string) {
  const { session, capabilities } = liveSession(state, sessionId);
  if (capabilities.rewind !== true) throw new Error("unsupported_rewind");
  const turn = state.turn?.find((row) => row.id === turnId);
  if (!turn || turn.threadId !== session.threadId) throw new Error("rewind_turn_unavailable");
  if (state.turn?.some((row) => row.sessionId === sessionId && row.status === "running"))
    throw new Error("rewind_requires_idle");
  return { session, turn };
}

/** I13: restoring files discards work. Record the confirmation and the files it will touch. */
export function requestFilesRewind(
  state: DomainState,
  input: {
    sessionId: string;
    turnId: string;
    confirmed: boolean;
    files: readonly string[];
    insertions?: number;
    deletions?: number;
  },
  context: CommandContext,
): Outcome {
  if (context.actor.kind !== "human") throw new Error("human_rewind_required");
  if (input.confirmed !== true) throw new Error("confirmation_required");
  const { session } = checkFilesRewind(state, input.sessionId, input.turnId);
  return audited(
    state,
    "session.rewind",
    input.turnId,
    {
      threadId: session.threadId,
      sessionId: input.sessionId,
      files: [...input.files],
      ...(input.insertions !== undefined ? { insertions: input.insertions } : {}),
      ...(input.deletions !== undefined ? { deletions: input.deletions } : {}),
      confirmed: true,
    },
    context,
    { kind: "rewind", sessionId: input.sessionId, turnId: input.turnId },
  );
}
