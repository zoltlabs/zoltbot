import {
  applyEvents,
  type CommandContext,
  type DomainState,
  handle,
  type Outcome,
  startTask,
} from "@zoltbot/core";
import { sessionGeneration } from "@zoltbot/protocol";
import type { Store } from "@zoltbot/store";
import type { LaunchManifest } from "../../connections/src/launch-manifest.js";

/** Append immutable launch inputs to the SAME transaction as session creation. */
export function launchIntent(
  snapshot: DomainState,
  context: CommandContext,
  created: Outcome,
  sessionId: string,
  configuration: Record<string, unknown> | undefined,
  store?: Store,
): Outcome {
  if (!configuration) return created;
  const events = [...created.events];
  const saved = handle(
    applyEvents(snapshot, events),
    {
      type: "create",
      kind: "settings",
      value: { key: `runtime.configuration.${sessionId}`, value: configuration },
    },
    { ...context, commandId: `${context.commandId}:configuration` },
  );
  events.push(...saved.events);
  const manifest = configuration.launchManifest as LaunchManifest | undefined;
  if (manifest && store) {
    // Executed inside Store.dispatch: crash kill points roll back this row with all intent events.
    store.database
      .prepare(
        "INSERT INTO launch_manifests_aux(id,execution_id,body) VALUES(?,?,?) ON CONFLICT(id) DO NOTHING",
      )
      .run(manifest.id, manifest.executionId, JSON.stringify(manifest));
  }
  const pack = manifest?.knowledge?.pack;
  if (pack && !snapshot.contextPack?.some((row) => row.id === pack.id)) {
    events.push(
      ...handle(
        applyEvents(snapshot, events),
        { type: "create", kind: "contextPack", value: pack },
        { ...context, commandId: `${context.commandId}:pack` },
      ).events,
    );
  }
  return { ...created, events };
}

export function createSessionLaunchIntent(
  snapshot: DomainState,
  context: CommandContext,
  input: {
    sessionId: string;
    threadId: string;
    provider: string;
    cwd: string;
    model?: string;
    effort?: string;
    nativeId?: string;
    configuration?: Record<string, unknown>;
  },
  store: Store,
): Outcome {
  const thread = snapshot.thread?.find((row) => row.id === input.threadId);
  const task = snapshot.task?.find((row) => row.id === thread?.taskId);
  const started =
    task?.state === "queued"
      ? startTask(snapshot, String(task.id), Number(task.revision), {
          ...context,
          commandId: `${context.commandId}:task`,
        }).events
      : [];
  const state = applyEvents(snapshot, started);
  const created = handle(
    state,
    {
      type: "create",
      kind: "session",
      value: {
        id: input.sessionId,
        threadId: input.threadId,
        provider: input.provider,
        cwd: input.cwd,
        state: "starting",
        generation:
          (snapshot.session ?? []).reduce(
            (latest, row) =>
              row.threadId === input.threadId ? Math.max(latest, sessionGeneration(row)) : latest,
            0,
          ) + 1,
        capabilities: {},
        ...(input.nativeId ? { nativeId: input.nativeId } : {}),
        ...(input.model ? { model: input.model } : {}),
        ...(input.effort ? { effort: input.effort } : {}),
        startedAt: context.at,
      },
    },
    { ...context, commandId: `${context.commandId}:native-session` },
  );
  const intent = launchIntent(state, context, created, input.sessionId, input.configuration, store);
  return { ...intent, events: [...started, ...intent.events] };
}
