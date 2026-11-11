import { createHash } from "node:crypto";
import path from "node:path";
import {
  type CommandContext,
  cancelTask,
  createTask,
  type DomainState,
  finishTaskTurn,
  handle,
  holdTask,
  type Outcome,
  resumeTask,
  retryTask,
  startTask,
  taskReady,
} from "@zoltbot/core";
import type { InteractionDraft } from "@zoltbot/protocol";
import {
  type DomainEvent,
  OutputModeSchema,
  ProjectSchema,
  parse,
  ScopeSchema,
  type Task,
  TaskSchema,
} from "@zoltbot/protocol";
import type { Store } from "@zoltbot/store";
import { repositoryLock } from "../../gitkit/src/git.js";
import { changes } from "../../gitkit/src/index.js";
import { canonicalApprovalRoot } from "./approval-paths.js";
import { materializeTaskArtifacts } from "./artifacts/repository-write.js";
import { cleanupThreadStaging } from "./artifacts/staging.js";
import { browserHoldReasons } from "./browser/errors.js";
import { eventRoutines } from "./event-routines.js";
import { prepareTaskWorktree } from "./prepare-task-worktree.js";
import type { PublicWriteCheck } from "./private-input.js";
import { routineScheduler } from "./routine-scheduler.js";
import { worktreeApi } from "./worktree-api.js";
import type { worktreeService } from "./worktree-service.js";

const human = { kind: "human", id: "local-owner" } as const;
const system = { kind: "system", id: "tasks" } as const;
const ended = new Set(["completed", "failed", "interrupted"]);
export interface TaskRunnerOptions {
  store: Store;
  now?(): string;
  routinePollMs?: number;
  eventRoutineTransport?: import("../../github/src/transport.js").GitHubTransport;
  stopUnattended?(threadId: string): Promise<void>;
  worktrees?: ReturnType<typeof worktreeService>;
  requestApproval?(draft: InteractionDraft, commandId: string): Promise<unknown>;
  publish(events: DomainEvent[]): void;
  checkPublic(value: unknown): Promise<PublicWriteCheck>;
  wake?(threadId: string): Promise<void>;
  preflight?(threadId: string): Promise<void>;
  startInSession?: boolean;
  interrupt?(threadId: string, turnId: string, commandId: string): Promise<unknown>;
  onError?(code: string): void;
}

/** The folder a shared task writes to: a code root, or undefined for its private app folder. */
function folderOf(state: DomainState, task: Task): string | undefined | "choice" {
  if (state.thread?.some((r) => r.id === task.threadId && r.kind === "manager")) return undefined;
  if (task.workspaceMode === "worktree" && !task.workspaceId) return "choice";
  if (task.workspaceId) {
    const workspace = state.workspace?.find((row) => row.id === task.workspaceId);
    return workspace ? (canonicalApprovalRoot(String(workspace.path))?.path ?? "choice") : "choice";
  }
  const row = state.project?.find((entry) => entry.id === task.projectId);
  if (!row) return "choice";
  const roots = parse(ProjectSchema, row).roots;
  if (!roots.length) return undefined;
  if (roots.length > 1) return "choice";
  return canonicalApprovalRoot(roots[0]?.path ?? "")?.path ?? "choice";
}
function finalText(state: DomainState, threadId: string, turnId: string): string {
  const messages = (state.item ?? [])
    .filter((row) => row.threadId === threadId && row.turnId === turnId && row.kind === "message")
    .sort((a, b) => Number(a.seq) - Number(b.seq));
  const final = messages.filter((row) => row.phase === "final");
  const body = (final.at(-1) ?? messages.at(-1))?.body as { text?: unknown } | undefined;
  return typeof body?.text === "string" ? body.text : "";
}
function hasQueuedInput(state: DomainState, threadId: string): boolean {
  return (state.item ?? []).some(
    (row) =>
      row.threadId === threadId &&
      row.kind === "user" &&
      (row.body as { queueState?: unknown } | undefined)?.queueState === "queued",
  );
}

export function taskRunner(options: TaskRunnerOptions) {
  const { store } = options;
  const gitApi = options.worktrees
    ? worktreeApi({
        store,
        worktrees: options.worktrees,
        publish: options.publish,
        ...(options.requestApproval ? { requestApproval: options.requestApproval } : {}),
      })
    : undefined;
  let scheduling: Promise<void> | undefined,
    again = false,
    closed = false;
  const run = (
    commandId: string,
    actor: CommandContext["actor"],
    work: (state: DomainState, context: CommandContext) => Outcome,
    check?: PublicWriteCheck,
  ) => {
    const before = store.lastSeq();
    const receipt = store.dispatch(commandId, (state) => {
      check?.(state);
      return work(state, { commandId, at: options.now?.() ?? new Date().toISOString(), actor });
    });
    const events = store.eventsSince(before);
    if (events.length) options.publish(events);
    return receipt.result;
  };
  const task = (id: string) => {
    const row = store.record("task", id);
    if (!row) throw new Error(`not_found: task ${id}`);
    return parse(TaskSchema, row);
  };

  const events = eventRoutines({
    checkPublic: options.checkPublic,
    ...(options.eventRoutineTransport ? { transport: options.eventRoutineTransport } : {}),
    store,
    now: () => options.now?.() ?? new Date().toISOString(),
    run: (id, work) => run(id, system, work),
  });
  const routines = routineScheduler({
    store,
    now: () => options.now?.() ?? new Date().toISOString(),
    run: (commandId, work) => run(commandId, system, work),
    async stop(taskId) {
      const row = task(taskId);
      if (row.threadId && options.stopUnattended) {
        await options.stopUnattended(row.threadId);
        return;
      }
      const turn = (store.snapshot(["turn"]).turn ?? []).find(
        (entry) => entry.threadId === row.threadId && entry.status === "running",
      );
      if (row.threadId && turn && options.interrupt)
        await options
          .interrupt(row.threadId, String(turn.id), `routine:stop:${taskId}`)
          .catch(() => options.onError?.("routine_stop_uncertain"));
    },
  });
  const routineTimer = setInterval(() => {
    void schedule();
  }, options.routinePollMs ?? 30_000);
  routineTimer.unref();

  async function wake(started: Task) {
    if (!options.wake || !started.threadId) return;
    try {
      await options.wake(started.threadId);
    } catch (error) {
      // Only a bare error code or sanitized budget breakdown reaches the task, never a path.
      const raw = error instanceof Error ? error.message : "";
      const code = raw.split(":")[0] ?? "";
      const reason = /^[a-z][a-z0-9_]{0,63}$/.test(code) ? code : "runtime_open_failed";
      // A shutdown during open leaves the task running, so the next boot parks and resumes it.
      if (closed || reason === "runtime_closed") return;
      if (store.record("task", started.id)?.state === "queued") {
        const hold = formatPreflightHold(reason, raw);
        run(`task:launch-held:${started.id}:${Date.now()}`, system, (state, context) =>
          holdTask(state, started.id, hold, context),
        );
        return;
      }
      options.onError?.(`task_wake_failed: ${reason}`);
      run(`task:wake-failed:${started.id}:${started.revision}`, system, (state, context) =>
        finishTaskTurn(
          state,
          started.id,
          started.revision,
          { status: "failed", text: "", reason },
          context,
        ),
      );
    }
  }
  async function scheduleOnce() {
    await routines.tick();
    await events.tick();
    const state = store.snapshot([
      "task",
      "project",
      "workspace",
      "session",
      "thread",
      "initiativeRecord",
    ]);
    const tasks = (state.task ?? []).map((row) => parse(TaskSchema, row));
    const busy = new Map<string, Task>();
    for (const row of tasks) {
      // A task parked by a restart still owns its folder until it resumes or stops.
      const folder = ["running", "blocked"].includes(row.state) ? folderOf(state, row) : undefined;
      if (folder && folder !== "choice") busy.set(folder, row);
    }
    const queued = tasks
      .filter((row) => row.state === "queued")
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    for (const next of queued) {
      const graphHold = taskReady(state, next);
      if (graphHold) {
        if (next.holdReason !== graphHold)
          run(`task:graph-hold:${next.id}:${hash(graphHold)}`, system, (s, context) =>
            holdTask(s, next.id, graphHold, context),
          );
        continue;
      }
      if (next.routineOccurrenceId) {
        try {
          await events.launchCheck(next);
        } catch (error) {
          const reason =
            error instanceof Error && /^(event_|github_)[a-z_]+$/.test(error.message)
              ? error.message
              : "event_launch_check_failed";
          if (next.holdReason !== reason)
            run(`event-hold:${next.id}:${hash(reason)}`, system, (s, context) =>
              holdTask(s, next.id, reason, context),
            );
          continue;
        }
      }
      const folder = folderOf(state, next);
      const holder = folder && folder !== "choice" ? busy.get(folder) : undefined;
      const reason =
        folder === "choice"
          ? next.workspaceMode === "worktree" && !next.workspaceId
            ? next.holdReason?.startsWith("Worktree preparation")
              ? next.holdReason
              : "Worktree preparation pending. Retry setup before running this task."
            : "Choose one code folder for this project before running tasks"
          : holder && folder
            ? `Waiting for "${holder.title}" to finish in ${path.basename(folder)}`
            : undefined;
      if (reason) {
        if (next.holdReason !== reason)
          run(`task:hold:${next.id}:${hash(reason)}:${Date.now()}`, system, (s, context) =>
            holdTask(s, next.id, reason, context),
          );
        continue;
      }
      if (next.threadId && options.preflight) {
        try {
          await options.preflight(next.threadId);
        } catch (error) {
          const raw = error instanceof Error ? error.message : "";
          const code = raw.split(":")[0] ?? "";
          const hold = formatPreflightHold(code, raw, true);
          if (next.holdReason !== hold)
            run(`task:preflight:${next.id}:${hash(hold)}:${Date.now()}`, system, (s, context) =>
              holdTask(s, next.id, hold, context),
            );
          continue;
        }
      }
      const existingSession = state.session?.some(
        (session) =>
          session.threadId === next.threadId &&
          ["starting", "ready", "running"].includes(String(session.state)),
      );
      if (!options.startInSession || existingSession)
        run(`task:start:${next.id}:${next.revision}`, system, (s, context) =>
          startTask(s, next.id, next.revision, context),
        );
      if (folder) busy.set(folder, next);
      await wake(next);
    }
  }
  function schedule(): Promise<void> {
    if (closed) return Promise.resolve();
    if (scheduling) {
      again = true;
      return scheduling;
    }
    scheduling = (async () => {
      try {
        do {
          again = false;
          await scheduleOnce();
        } while (again && !closed);
      } catch {
        options.onError?.("task_schedule_failed");
      } finally {
        scheduling = undefined;
      }
    })();
    return scheduling;
  }

  /** Turn the end of a task turn into its result, then let the next task in that folder start. */
  function finish(turn: Record<string, unknown>) {
    const threadId = String(turn.threadId);
    const state = store.snapshot(["task", "item"]);
    const row = state.task?.find(
      (entry) => entry.threadId === threadId && entry.state === "running",
    );
    if (!row || row.state !== "running") return;
    const current = parse(TaskSchema, row);
    if (turn.status === "completed" && hasQueuedInput(state, threadId)) return;
    run(`task:finish:${String(turn.id)}`, system, (s, context) =>
      finishTaskTurn(
        s,
        current.id,
        current.revision,
        {
          status: turn.status as "completed" | "failed" | "interrupted",
          text: finalText(state, threadId, String(turn.id)),
          ...(typeof turn.stopReason === "string" ? { reason: turn.stopReason } : {}),
        },
        context,
      ),
    );
  }

  return {
    schedule,
    /** Watch published turn and task events. Work is deferred so publishing never nests. */
    observe(events: readonly DomainEvent[]) {
      if (closed) return;
      const turns = events.filter(
        (event) =>
          event.aggregateType === "turn" &&
          ended.has(String((event.payload as { status?: unknown }).status)),
      );
      const tasks = events.some(
        (event) =>
          event.aggregateType === "task" ||
          event.aggregateType === "initiativeRecord" ||
          event.aggregateType === "knowledge" ||
          event.aggregateType === "routine" ||
          event.aggregateType === "interaction",
      );
      if (!turns.length && !tasks) return;
      setImmediate(() => {
        if (closed) return;
        for (const event of turns) {
          try {
            finish(event.payload as Record<string, unknown>);
          } catch {
            options.onError?.("task_finish_failed");
          }
        }
        void schedule();
      });
    },
    /** After a restart, continue each task recovery parked in its existing native conversation. */
    async resume(bootId: string) {
      const running = (store.snapshot(["task"]).task ?? [])
        .map((row) => parse(TaskSchema, row))
        .filter(
          (row) =>
            row.state === "blocked" && row.holdReason === "daemon_restarted" && !row.phaseExecution,
        );
      for (const row of running) {
        try {
          run(`task:resume:${row.id}:${bootId}`, system, (s, context) =>
            resumeTask(s, row.id, bootId, context),
          );
          await wake(row);
        } catch {
          options.onError?.("task_resume_failed");
        }
      }
      await schedule();
    },
    async api(
      method: string,
      params: Record<string, unknown>,
      commandId?: string,
    ): Promise<unknown> {
      if (method.startsWith("routine.")) {
        const check =
          commandId &&
          !store.receipt(commandId) &&
          (["routine.create", "routine.update"].includes(method) || events.handles(method))
            ? await options.checkPublic(params)
            : undefined;
        const result = events.handles(method)
          ? await events.api(method, params, commandId ?? "", check)
          : routines.api(method, params, commandId, check);
        void schedule();
        return result;
      }
      if (!method.startsWith("task.")) return undefined;
      const gitResult = await gitApi?.(method, params, commandId);
      if (gitResult !== undefined) return gitResult;
      if (method === "task.list") {
        const items = (store.snapshot(["task"]).task ?? []).filter(
          (row) => !params.projectId || row.projectId === params.projectId,
        );
        return { items };
      }
      if (method === "task.changes") {
        const selected = task(String(params.id));
        if (!selected.workspaceId || !options.worktrees) throw new Error("worktree_unavailable");
        const binding = await options.worktrees.contribution(selected.workspaceId);
        return changes(binding.cwd, binding.baseCommit);
      }
      if (!commandId) throw new Error("command_id_required");
      if (method === "task.create") {
        const input = {
          ...(params.outputMode ? { outputMode: parse(OutputModeSchema, params.outputMode) } : {}),
          id: `task-${hash(commandId)}`,
          ...(params.browser
            ? { browser: params.browser as import("./browser/runtime.js").BrowserSelection }
            : {}),
          title: String(params.title),
          brief: String(params.brief),
          acceptance: typeof params.acceptance === "string" ? params.acceptance : "",
          profileId: String(params.profileId),
          node: parse(ScopeSchema, params.node),
          workspaceMode:
            params.workspaceMode === "worktree" ? ("worktree" as const) : ("shared" as const),
          ...(typeof params.baseRef === "string" ? { baseRef: params.baseRef } : {}),
        };
        const check = store.receipt(commandId)
          ? undefined
          : await options.checkPublic([input.title, input.brief, input.acceptance]);
        const result = run(commandId, human, (s, context) => createTask(s, input, context), check);
        if (input.workspaceMode === "worktree" && options.worktrees) {
          const prepared = await prepareTaskWorktree({
            store,
            worktrees: options.worktrees,
            taskId: input.id,
            publish: options.publish,
            ...(options.requestApproval ? { requestApproval: options.requestApproval } : {}),
          });
          void schedule();
          return prepared;
        }
        void schedule();
        return result;
      }
      const id = String(params.id);
      if (method === "task.prepareWorkspace") {
        if (!options.worktrees) throw new Error("worktree_unavailable");
        const prepared = await prepareTaskWorktree({
          store,
          worktrees: options.worktrees,
          taskId: id,
          publish: options.publish,
          ...(options.requestApproval ? { requestApproval: options.requestApproval } : {}),
        });
        void schedule();
        return prepared;
      }
      if (method === "task.review") {
        return repositoryLock(`artifact-task-review:${id}`, async () => {
          const decision = params.decision as "accept" | "changes" | "reject";
          const feedback = typeof params.feedback === "string" ? params.feedback : undefined;
          if (params.confirmed !== true) throw new Error("confirmation_required");
          const check =
            store.receipt(commandId) || !feedback ? undefined : await options.checkPublic(feedback);
          if (!store.receipt(commandId) && decision === "accept") {
            handle(
              store.snapshot(),
              { type: "review", id, revision: Number(params.revision), decision },
              { commandId, at: new Date().toISOString(), actor: human },
            );
            const current = task(id);
            if (current.threadId) await cleanupThreadStaging(store, current.threadId);
            await materializeTaskArtifacts(store, id, Number(params.revision), {
              publish: options.publish,
              privateCheck: async (text) => {
                try {
                  await options.checkPublic(text);
                  return false;
                } catch {
                  return true;
                }
              },
            });
          }
          const result = run(
            commandId,
            human,
            (s, context) =>
              handle(
                s,
                {
                  type: "review",
                  id,
                  revision: Number(params.revision),
                  decision,
                  ...(feedback ? { feedback } : {}),
                },
                context,
              ),
            check,
          );
          void schedule();
          return result;
        });
      }
      if (method === "task.retry") {
        const result = run(commandId, human, (s, context) =>
          retryTask(s, id, task(id).revision, context),
        );
        void schedule();
        return result;
      }
      if (method === "task.cancel") {
        return repositoryLock(`artifact-task-review:${id}`, async () => {
          const result = run(commandId, human, (s, context) =>
            cancelTask(s, id, params.confirmed === true, context),
          );
          const threadId = task(id).threadId;
          const turn = (store.snapshot(["turn"]).turn ?? []).find(
            (row) => row.threadId === threadId && row.status === "running",
          );
          if (threadId && turn && options.interrupt)
            await options
              .interrupt(threadId, String(turn.id), `task:stop:${id}:${String(turn.id)}`)
              .catch(() => options.onError?.("task_stop_uncertain"));
          void schedule();
          return result;
        });
      }
      return undefined;
    },
    close() {
      closed = true;
      clearInterval(routineTimer);
    },
  };
}
function formatPreflightHold(code: string, raw: string, preflight = false) {
  if (code === "context_budget_hold") {
    if (/^context_budget_hold: [A-Za-z0-9_., ();:-]{1,220}$/.test(raw)) return raw;
    return "context_budget_hold: Edit knowledge, exclude for this execution, or cancel.";
  }
  if (code === "injection_fixed_budget_exceeded")
    return "injection_fixed_budget_exceeded: Profile, workspace, and tool instructions exceed the 1500-token fixed budget.";
  if (preflight)
    return (
      browserHoldReasons[code] ??
      "Session inputs could not be prepared. Check profile connections and try again."
    );
  return `Session inputs unavailable: ${code}`;
}
function hash(value: string) {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}
