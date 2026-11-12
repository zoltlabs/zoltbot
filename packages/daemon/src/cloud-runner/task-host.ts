import type { AgentDefinition } from "@zoltbot/protocol";
import type { RunnerLease } from "@zoltbot/runner-protocol";
import type { Store } from "@zoltbot/store";
import { InteractionEngine } from "../interaction-engine.js";
import type { PrivateVault } from "../private-context.js";
import { createInProcessRuntime } from "../runner/in-process.js";
import type { RuntimeHost } from "../runtime-host.js";
import { CloudTaskCache } from "./cache.js";
import type { RunnerConnectionOptions } from "./connection.js";
import { ObservationJournal } from "./observation-journal.js";
import type { ManagedWorkspaces } from "./workspaces.js";

export interface CloudTaskResources {
  host: RuntimeHost;
  secrets?: PrivateVault;
  /** Revoke tools and terminate only processes owned by this task host. */
  close(): Promise<void>;
}
export interface CloudTasksOptions {
  orgId: string;
  memberId: string;
  cacheDirectory: string;
  workspaces: ManagedWorkspaces;
  /** Resolve a locally pinned definition; do not evaluate the Cell's launch recipe. */
  definition(id: string, signal: AbortSignal): Promise<AgentDefinition>;
  resources(input: {
    store: Store;
    cwd: string;
    baseCommit: string;
    lease: RunnerLease;
    signal: AbortSignal;
  }): Promise<CloudTaskResources>;
  guard(value: unknown): void;
  status?(code: string): void;
}

/** Execution composition shared by Mac runners and the sandbox worker. No Local runtime is used. */
export function cloudTasks(options: CloudTasksOptions): RunnerConnectionOptions["task"] {
  return async (assignment, outbox, publish, connectionSignal) => {
    const initial = structuredClone(assignment);
    const lifetime = new AbortController();
    let cache: CloudTaskCache | undefined, resources: CloudTaskResources | undefined;
    let runtime: ReturnType<typeof createInProcessRuntime> | undefined;
    let engine: InteractionEngine | undefined;
    let journal: ObservationJournal | undefined;
    let readySessionId: string | undefined,
      faulted = false;
    let closed = false,
      closing: Promise<void> | undefined;
    const status = (code: string) => {
      try {
        options.status?.(code);
      } catch {}
    };
    const close = () =>
      (closing ??= (async () => {
        closed = true;
        lifetime.abort();
        connectionSignal.removeEventListener("abort", abort);
        const cleanup = await Promise.allSettled([
          Promise.resolve().then(() => resources?.close()),
          Promise.resolve().then(() => runtime?.runner.close()),
          Promise.resolve().then(() => engine?.stopTimers()),
        ]);
        try {
          journal?.flush();
        } finally {
          cache?.close();
        }
        if (cleanup.some((result) => result.status === "rejected"))
          throw new Error("runner_task_cleanup_required");
      })());
    const abort = () => {
      lifetime.abort();
      // Startup owns cleanup until all resources have been assigned.
      if (runtime) void close().catch(() => status("runner_task_cleanup_required"));
    };
    connectionSignal.addEventListener("abort", abort, { once: true });
    const check = () => {
      if (closed || connectionSignal.aborted || lifetime.signal.aborted)
        throw new Error("runner_task_canceled");
    };
    const ready = () =>
      !closed &&
      !faulted &&
      readySessionId !== undefined &&
      ["ready", "running"].includes(String(cache?.store.record("session", readySessionId)?.state));
    const start = async () => {
      check();
      if (!runtime || !initial.execution) throw new Error("runner_task_unavailable");
      await runtime.runner.prepareWorkspace({ threadId: initial.execution.thread.id });
      check();
      await runtime.runner.startSession({ threadId: initial.execution.thread.id });
      check();
      const deadline = Date.now() + 60000;
      while (!ready()) {
        check();
        if (Date.now() >= deadline) throw new Error("runner_task_start_timeout");
        await new Promise<void>((resolve) => setTimeout(resolve, 25));
      }
      publish();
    };
    try {
      check();
      const execution = initial.execution;
      if (!execution?.project.cloud || initial.actor.userId !== options.memberId)
        throw new Error("runner_task_scope_conflict");
      const definition = structuredClone(
        await options.definition(execution.definition.id, lifetime.signal),
      );
      check();
      const workspace = await options.workspaces.prepare(
        {
          orgId: options.orgId,
          taskId: initial.taskId,
          repository: execution.project.cloud.repository,
          defaultBranch: execution.project.cloud.defaultBranch,
        },
        lifetime.signal,
      );
      check();
      cache = await CloudTaskCache.open({
        directory: options.cacheDirectory,
        orgId: options.orgId,
        memberId: options.memberId,
        lease: initial,
        workspace,
        definition,
        guard: options.guard,
      });
      journal = new ObservationJournal({
        store: cache.store,
        outbox,
        threadId: execution.thread.id,
        guard: options.guard,
      });
      journal.flush();
      publish();
      check();
      resources = await options.resources({
        store: cache.store,
        cwd: workspace.cwd,
        baseCommit: workspace.baseCommit,
        lease: structuredClone(initial),
        signal: lifetime.signal,
      });
      check();
      runtime = createInProcessRuntime({
        store: cache.store,
        host: resources.host,
        ...(resources.secrets ? { secrets: resources.secrets } : {}),
        publish() {},
        interactions: async () => {
          if (!engine) {
            if (!cache || !runtime) throw new Error("runner_task_unavailable");
            engine = new InteractionEngine({
              store: cache.store,
              host: runtime.manager.interactionHost,
              publish() {},
            });
          }
          return engine;
        },
        recordObservation: (observation) => journal?.record(observation),
        recordTransientObservation: (observation) => journal?.recordTransient(observation),
        persistObservation: async (observation) => {
          journal?.flush();
          if (observation.event.t === "session.ready") {
            readySessionId = observation.sessionId;
            faulted = false;
          }
          publish();
        },
        onError(code) {
          faulted = true;
          status(code);
          publish();
        },
      });
      await start();
      return {
        ready,
        async update(lease) {
          check();
          cache?.update(lease);
          await start();
        },
        async command(input, signal) {
          check();
          if (
            signal.aborted ||
            !runtime ||
            !cache ||
            input.taskId !== initial.taskId ||
            input.leaseId !== initial.leaseId
          )
            throw new Error("runner_task_scope_conflict");
          const command = input.command,
            threadId = execution.thread.id;
          if (command.type === "send_turn") {
            const result = cache.queue(
              input.commandId,
              command.inputId ?? `runner-input:${input.commandId}`,
              command.input,
              command.mode,
            );
            await start();
            return result;
          }
          if (command.type === "answer_interaction") {
            const interaction = cache.store.record("interaction", command.interactionId);
            if (
              !ready() ||
              !interaction ||
              interaction.threadId !== threadId ||
              (command.nativeRef && interaction.nativeRef !== command.nativeRef)
            )
              throw new Error("runner_interaction_unavailable");
            return runtime.runner.answerInteraction({
              id: command.interactionId,
              version: command.version ?? Number(interaction.version),
              answer: command.answer,
              commandId: input.commandId,
              actor: { kind: "human", id: options.memberId },
            });
          }
          if (command.type === "interrupt") {
            const turnId =
              command.turnId ??
              cache.store.snapshot(["turn"]).turn?.find((row) => row.status === "running")?.id;
            if (typeof turnId !== "string") return { ok: true };
            return runtime.runner.interrupt({ threadId, turnId, commandId: input.commandId });
          }
          if (command.type === "stop") {
            await runtime.runner.stop({ threadId });
            publish();
            return { ok: true };
          }
          // Diff/publication needs the bounded result protocol before results can cross the socket.
          throw new Error("runner_command_unavailable");
        },
        close,
      };
    } catch {
      await close();
      throw new Error("runner_task_unavailable");
    }
  };
}
