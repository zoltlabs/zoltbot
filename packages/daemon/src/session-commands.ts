import {
  type CommandContext,
  checkFilesRewind,
  type DomainState,
  type Outcome,
  requestBackgroundStop,
  requestFilesRewind,
  requestSessionMode,
  requestSessionModel,
  settleSessionMode,
  settleSessionModel,
  widensPermission,
} from "@zoltbot/core";
import type { DomainEvent } from "@zoltbot/protocol";
import type { Store } from "@zoltbot/store";
import type { SessionManager } from "./session-manager.js";

type Rewind = NonNullable<Awaited<ReturnType<NonNullable<NativeSession["rewindFiles"]>>>>;
type NativeSession = ReturnType<SessionManager["live"]>["native"];

/**
 * Human session controls that reach the live native session: permission mode, model and effort,
 * background tasks and file rewind. Each records its request (and an audit row) under the caller's command id
 * before the native call, then stores the native outcome under `<commandId>:applied`, so a retry
 * with the same id never repeats a native side effect.
 */
export function sessionCommands(options: {
  store: Store;
  manager: SessionManager;
  publish(events: DomainEvent[]): void;
}) {
  const { store, manager } = options;
  const inflight = new Map<string, { key: string; work: Promise<unknown> }>();
  const human = (commandId: string): CommandContext => ({
    commandId,
    at: new Date().toISOString(),
    actor: { kind: "human", id: "local-owner" },
  });
  const commit = (
    commandId: string,
    produce: (state: DomainState, context: CommandContext) => Outcome,
    context: (commandId: string) => CommandContext,
  ) => {
    const before = store.lastSeq();
    let produced = false;
    const receipt = store.dispatch(commandId, (state) => {
      produced = true;
      return produce(state, context(commandId));
    });
    if (produced) options.publish(store.eventsSince(before));
    return receipt.result as Record<string, unknown>;
  };
  const system = (commandId: string): CommandContext => ({
    commandId,
    at: new Date().toISOString(),
    actor: { kind: "system", id: "runtime" },
  });
  /** Store the native result (or its error code) so a replay returns it without a new call. */
  const applied = (commandId: string, outcome: { value?: unknown; error?: string }) =>
    commit(`${commandId}:applied`, () => ({ events: [], result: outcome }), system);
  const conflicts = (result: Record<string, unknown> | undefined, expected: object) =>
    Object.entries(expected).some(([key, value]) => result?.[key] !== value);
  /** A retried command id returns the stored native outcome and never calls the provider again. */
  function replay<T>(commandId: string, expected: object, failure: string) {
    const previous = store.receipt<Record<string, unknown>>(commandId);
    if (!previous) return undefined;
    if (conflicts(previous.result, expected)) throw new Error("command_receipt_conflict");
    const outcome = store.receipt<{ value?: T; error?: string }>(`${commandId}:applied`);
    // The request was recorded but the provider's answer was not: the person must check.
    if (!outcome) throw new Error(failure.replace(/_failed$/, "_uncertain"));
    if (outcome.result.error) throw new Error(outcome.result.error);
    return { value: outcome.result.value };
  }
  async function audited<T>(
    commandId: string,
    expected: object,
    request: (state: DomainState, context: CommandContext) => Outcome,
    act: () => Promise<T>,
    failure: string,
  ): Promise<T> {
    const result = commit(commandId, request, human);
    if (conflicts(result, expected)) throw new Error("command_receipt_conflict");
    if (Object.entries(expected).some(([key, value]) => result[key] !== value))
      throw new Error("command_receipt_conflict");
    let value: T;
    try {
      value = await act();
    } catch {
      applied(commandId, { error: failure });
      throw new Error(failure);
    }
    applied(commandId, value === undefined ? {} : { value });
    return value;
  }
  /** One native call per command id, also while the first call is still in flight. */
  function once<T>(commandId: string, key: string, work: () => Promise<T>): Promise<T> {
    const pending = inflight.get(commandId);
    if (pending)
      return pending.key === key
        ? (pending.work as Promise<T>)
        : Promise.reject(new Error("command_receipt_conflict"));
    const started = manager.track(work());
    inflight.set(commandId, { key, work: started });
    const settled = () => inflight.delete(commandId);
    void started.then(settled, settled);
    return started;
  }

  async function setMode(sessionId: string, mode: string, confirmed: boolean, commandId: string) {
    // A phone may narrow a session but never widen it. The
    // session's own capabilities say which modes are safe; without them every mode widens.
    if (commandId.startsWith("device:")) {
      const session = store.snapshot().session?.find((row) => row.id === sessionId);
      const capabilities = (session?.capabilities ?? {}) as { safeModes?: unknown };
      if (widensPermission(mode, capabilities.safeModes))
        throw new Error("mac_only: widening the permission mode works only on the Mac");
    }
    const expected = { kind: "set_mode", sessionId, mode };
    if (replay(commandId, expected, "mode_change_failed")) return { ok: true as const };
    const live = manager.live(sessionId);
    await audited(
      commandId,
      expected,
      (state, context) => requestSessionMode(state, sessionId, mode, context, confirmed),
      async () => {
        await live.native.setMode(mode);
        commit(
          `${commandId}:mode`,
          (state, context) => settleSessionMode(state, sessionId, mode, context),
          system,
        );
      },
      "mode_change_failed",
    );
    return { ok: true as const };
  }
  /**
   * The model and effort for the session's next turns. A running turn keeps what it started with;
   * the adapter applies the change live when the provider allows it, else at its next launch.
   */
  async function setModel(
    sessionId: string,
    change: { model: string; effort?: string; cacheWarningAccepted: boolean },
    commandId: string,
  ) {
    const effort = change.effort !== undefined ? { effort: change.effort } : {};
    const expected = { kind: "set_model", sessionId, model: change.model, ...effort };
    if (replay(commandId, expected, "model_change_failed")) return { ok: true as const };
    const live = manager.live(sessionId);
    await audited(
      commandId,
      expected,
      (state, context) => requestSessionModel(state, sessionId, change, context),
      async () => {
        await live.native.setModel(change.model, change.effort);
        commit(
          `${commandId}:model`,
          (state, context) =>
            settleSessionModel(state, sessionId, { model: change.model, ...effort }, context),
          system,
        );
      },
      "model_change_failed",
    );
    return { ok: true as const };
  }
  async function stopBackground(sessionId: string, taskId: string, commandId: string) {
    const expected = { kind: "stop_background", sessionId, taskId };
    if (replay(commandId, expected, "background_stop_failed")) return { ok: true as const };
    const live = manager.live(sessionId);
    const stop = live.native.stopBackground?.bind(live.native);
    if (!stop) throw new Error("unsupported_background_tasks");
    await audited(
      commandId,
      expected,
      (state, context) => requestBackgroundStop(state, sessionId, taskId, context),
      () => stop(taskId),
      "background_stop_failed",
    );
    return { ok: true as const };
  }
  async function rewind(
    sessionId: string,
    turnId: string,
    dryRun: boolean,
    confirmed: boolean,
    commandId: string | undefined,
  ): Promise<Rewind> {
    if (!dryRun && confirmed !== true) throw new Error("confirmation_required");
    if (!dryRun && !commandId) throw new Error("command_id_required");
    const expected = { kind: "rewind", sessionId, turnId };
    const previous =
      commandId && !dryRun ? replay<Rewind>(commandId, expected, "rewind_failed") : undefined;
    if (previous) return previous.value as Rewind;
    const target = () => {
      checkFilesRewind(store.snapshot(), sessionId, turnId);
      const live = manager.live(sessionId);
      const native = live.worker.nativeTurnId(turnId);
      if (!live.native.rewindFiles) throw new Error("unsupported_rewind");
      if (!native) throw new Error("rewind_turn_unavailable");
      const rewindFiles = live.native.rewindFiles.bind(live.native);
      return (run: boolean) => rewindFiles(native, run);
    };
    if (dryRun) return clean(await target()(true));
    const id = commandId as string;
    const call = target();
    let preview: Rewind;
    try {
      preview = clean(await call(true));
    } catch {
      throw new Error("rewind_failed");
    }
    if (!preview.canRewind) return preview;
    return audited<Rewind>(
      id,
      expected,
      (state, context) =>
        requestFilesRewind(
          state,
          {
            sessionId,
            turnId,
            confirmed,
            files: preview.files,
            ...(preview.insertions !== undefined ? { insertions: preview.insertions } : {}),
            ...(preview.deletions !== undefined ? { deletions: preview.deletions } : {}),
          },
          context,
        ),
      async () => clean(await call(false)),
      "rewind_failed",
    );
  }

  return (
    method: string,
    params: Record<string, unknown>,
    commandId?: string,
  ): Promise<unknown> | undefined => {
    const sessionId = String(params.id);
    if (method === "session.setMode") {
      if (!commandId) throw new Error("command_id_required");
      const mode = String(params.mode),
        confirmed = params.confirmed === true;
      return once(commandId, `${method}:${sessionId}:${mode}`, () =>
        setMode(sessionId, mode, confirmed, commandId),
      );
    }
    if (method === "session.setModel" || method === "session.setEffort") {
      if (!commandId) throw new Error("command_id_required");
      // Effort alone keeps the session's model; a session without one has nothing to keep.
      const session = store.snapshot(["session"]).session?.find((row) => row.id === sessionId);
      const model = method === "session.setModel" ? String(params.model) : session?.model;
      if (typeof model !== "string" || !model) throw new Error("model_required");
      const effort = typeof params.effort === "string" ? params.effort : undefined;
      const change = {
        model,
        ...(effort !== undefined ? { effort } : {}),
        cacheWarningAccepted: params.cacheWarningAccepted === true,
      };
      return once(commandId, `session.setModel:${sessionId}:${model}:${effort ?? ""}`, () =>
        setModel(sessionId, change, commandId),
      );
    }
    if (method === "session.stopBackground") {
      if (!commandId) throw new Error("command_id_required");
      const taskId = String(params.taskId);
      return once(commandId, `${method}:${sessionId}:${taskId}`, () =>
        stopBackground(sessionId, taskId, commandId),
      );
    }
    if (method === "session.rewind") {
      const turnId = String(params.turnId),
        dryRun = params.dryRun === true,
        confirmed = params.confirmed === true;
      if (dryRun || !commandId) return rewind(sessionId, turnId, dryRun, confirmed, commandId);
      return once(commandId, `${method}:${sessionId}:${turnId}`, () =>
        rewind(sessionId, turnId, false, confirmed, commandId),
      );
    }
    return undefined;
  };
}

/** Keep only the fields the method result schema allows. */
function clean(value: Rewind): Rewind {
  return {
    canRewind: value.canRewind === true,
    files: Array.isArray(value.files) ? value.files.filter((file) => typeof file === "string") : [],
    ...(Number.isInteger(value.insertions) && Number(value.insertions) >= 0
      ? { insertions: value.insertions }
      : {}),
    ...(Number.isInteger(value.deletions) && Number(value.deletions) >= 0
      ? { deletions: value.deletions }
      : {}),
    ...(typeof value.error === "string" && value.error ? { error: value.error } : {}),
  };
}
