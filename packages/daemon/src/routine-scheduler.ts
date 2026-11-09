import { createHash } from "node:crypto";
import {
  type CommandContext,
  clampRoutinePermission,
  type DomainState,
  expireInteractions,
  fireRoutine,
  nextRoutineRun,
  type Outcome,
  ROUTINE_FOLDER_WAIT_MS,
  ROUTINE_PERMISSION_TIMEOUT_MS,
  routineEvent,
  routineFromTask,
  routineGrace,
  routineOutcome,
} from "@zoltbot/core";
import {
  type PermissionProfile,
  parse,
  parseEvent,
  type Routine,
  type RoutineOccurrence,
  RoutineOccurrenceSchema,
  RoutineSchema,
  RoutineTemplateSchema,
} from "@zoltbot/protocol";
import type { Store } from "@zoltbot/store";

export function routineScheduler(options: {
  store: Store;
  now(): string;
  run(commandId: string, work: (state: DomainState, context: CommandContext) => Outcome): unknown;
  stop(taskId: string): Promise<void>;
}) {
  const { store, run } = options;
  let lastTick: number | undefined;
  async function reconcile() {
    for (const raw of store.snapshot(["routineOccurrence"]).routineOccurrence ?? []) {
      const occurrence = parse(RoutineOccurrenceSchema, raw);
      if (!["queued", "started"].includes(occurrence.status) || !occurrence.taskId) continue;
      const task = store.record("task", occurrence.taskId);
      if (!task) continue;
      const now = options.now();
      const pending = (store.snapshot(["interaction"]).interaction ?? []).find(
        (row) => row.threadId === task.threadId && row.state === "pending",
      );
      let next: RoutineOccurrence = { ...occurrence, updatedAt: now };
      let stop = false;
      if (
        occurrence.sourceEvent &&
        ["running", "blocked"].includes(String(task.state)) &&
        Date.parse(now) - Date.parse(occurrence.createdAt) >= 15 * 60_000
      ) {
        next = {
          ...next,
          status: "expired",
          outcome: "needs_you",
          reason: "Event investigation reached its 15-minute runtime limit",
        };
        stop = true;
      } else if (
        task.state === "queued" &&
        Date.parse(now) - Date.parse(occurrence.createdAt) >= ROUTINE_FOLDER_WAIT_MS
      ) {
        next = {
          ...next,
          status: "skipped",
          reason: String(task.holdReason ?? "Launch wait limit reached"),
        };
        stop = true;
      } else if (pending && !occurrence.permissionDeadline) {
        next = {
          ...next,
          outcome: "needs_you",
          permissionDeadline: new Date(
            Date.parse(String(pending.createdAt)) + ROUTINE_PERMISSION_TIMEOUT_MS,
          ).toISOString(),
        };
      } else if (
        (pending || task.state === "blocked") &&
        occurrence.permissionDeadline &&
        Date.parse(now) >= Date.parse(occurrence.permissionDeadline)
      ) {
        next = {
          ...next,
          status: "expired",
          outcome: "needs_you",
          reason: "Unattended permission request expired",
        };
        stop = true;
      } else if (["review", "completed", "failed", "cancelled"].includes(String(task.state))) {
        const result = (store.snapshot(["taskResult"]).taskResult ?? []).find(
          (row) => row.taskId === task.id,
        );
        next = {
          ...next,
          status: "completed",
          outcome:
            (result?.outcome as RoutineOccurrence["outcome"]) ??
            (result ? routineOutcome(String(result.summary)) : "actionable"),
        };
      } else if (!pending && occurrence.permissionDeadline && task.state === "running") {
        const { permissionDeadline: _deadline, outcome: _outcome, ...rest } = next;
        next = rest;
      } else if (task.state === "running" && occurrence.status === "queued") {
        next = { ...next, status: "started" };
      } else continue;
      // Terminal history and cancellation commit together, before releasing the folder.
      run(
        `routine:reconcile:${occurrence.id}:${next.status}:${next.outcome ?? ""}:${next.permissionDeadline ?? ""}:${now}`,
        (state, context) => {
          const current = parse(
            RoutineOccurrenceSchema,
            state.routineOccurrence?.find((row) => row.id === occurrence.id),
          );
          if (!["queued", "started"].includes(current.status))
            return { events: [], result: current };
          const events = [routineEvent("routineOccurrence", next, context)];
          if (stop) {
            const threadId = state.task?.find((row) => row.id === occurrence.taskId)?.threadId;
            if (threadId)
              events.push(
                ...expireInteractions(state, [String(threadId)], "timeout", context).events,
              );
            const currentTask = state.task?.find((row) => row.id === occurrence.taskId);
            if (currentTask && ["queued", "running", "blocked"].includes(String(currentTask.state)))
              events.push(
                parseEvent({
                  eventId: `${context.commandId}:task`,
                  commandId: context.commandId,
                  aggregateType: "task",
                  aggregateId: String(currentTask.id),
                  type: "task.updated",
                  occurredAt: context.at,
                  payload: {
                    ...currentTask,
                    state: "cancelled",
                    holdReason: next.reason,
                    updatedAt: context.at,
                  },
                }),
              );
          }
          return { events, result: next };
        },
      );
      if (stop) await options.stop(occurrence.taskId);
    }
  }
  return {
    async tick() {
      await reconcile();
      const now = options.now();
      const waking = lastTick === undefined || Date.parse(now) - lastTick > 60_000;
      lastTick = Date.parse(now);
      const routines = (store.snapshot(["routine"]).routine ?? []).map((row) =>
        parse(RoutineSchema, row),
      );
      // On boot/wake there is one catch-up allowance for the daemon, across all routines.
      const latestMissed = routines
        .filter((routine) => !routine.event && !routine.paused && routine.nextRunAt <= now)
        .map((routine) => {
          let latest = routine.nextRunAt,
            next = nextRoutineRun(routine.schedule, latest);
          while (next <= now) {
            latest = next;
            next = nextRoutineRun(routine.schedule, next);
          }
          return { routine, latest };
        })
        .filter(
          ({ routine, latest }) =>
            Date.parse(now) - Date.parse(latest) <= routineGrace(routine.schedule, latest),
        )
        .sort(
          (a, b) => b.latest.localeCompare(a.latest) || a.routine.id.localeCompare(b.routine.id),
        )[0]?.routine.id;
      for (const routine of routines) {
        if (routine.event || routine.paused || routine.nextRunAt > now) continue;
        const due: string[] = [];
        let cursor = routine.nextRunAt;
        while (cursor <= now) {
          due.push(cursor);
          cursor = nextRoutineRun(routine.schedule, cursor);
        }
        const latest = due.at(-1);
        for (const scheduledAt of due) {
          const catchUp =
            scheduledAt === latest &&
            (!waking || routine.id === latestMissed) &&
            Date.parse(now) - Date.parse(scheduledAt) <=
              routineGrace(routine.schedule, scheduledAt);
          run(`routine:fire:${routine.id}@${scheduledAt}`, (state, context) => {
            const current = parse(
              RoutineSchema,
              state.routine?.find((row) => row.id === routine.id),
            );
            if (current.paused) return { events: [], result: current };
            return fireRoutine(state, current, scheduledAt, catchUp ? "fire" : "missed", context);
          });
        }
      }
    },
    api(
      method: string,
      params: Record<string, unknown>,
      commandId?: string,
      check?: (state: DomainState) => void,
    ) {
      const command = (
        id: string,
        work: (state: DomainState, context: CommandContext) => Outcome,
      ) =>
        run(id, (state, context) => {
          check?.(state);
          return work(state, context);
        });
      if (!method.startsWith("routine.")) return undefined;
      if (method === "routine.list") return { items: store.snapshot(["routine"]).routine ?? [] };
      if (method === "routine.history")
        return {
          items: (store.snapshot(["routineOccurrence"]).routineOccurrence ?? []).filter(
            (row) => row.routineId === params.id,
          ),
        };
      if (!commandId) throw new Error("command_id_required");
      if (method === "routine.create")
        return command(commandId, (state, context) =>
          routineFromTask(
            state,
            {
              id: `routine-${createHash("sha256").update(commandId).digest("hex").slice(0, 24)}`,
              taskId: String(params.taskId),
              name: String(params.name),
              schedule: params.schedule as Routine["schedule"],
              notify: params.notify as Routine["notify"],
              ...(params.permissionCeiling
                ? { permissionCeiling: params.permissionCeiling as PermissionProfile }
                : {}),
            },
            { ...context, actor: { kind: "human", id: "local-owner" } },
          ),
        );
      if (method === "routine.update")
        return command(commandId, (state, context) => {
          const old = parse(
            RoutineSchema,
            state.routine?.find((row) => row.id === params.id),
          );
          if (old.event) throw new Error("use_event_routine_commands");
          if (old.updatedAt !== params.expectedUpdatedAt) throw new Error("stale_revision");
          const schedule = params.schedule as Routine["schedule"] | undefined;
          const next = parse(RoutineSchema, {
            ...old,
            ...(schedule ? { schedule } : {}),
            ...(params.template ? { template: parse(RoutineTemplateSchema, params.template) } : {}),
            ...(params.notify ? { notify: params.notify } : {}),
            ...(typeof params.paused === "boolean" ? { paused: params.paused } : {}),
            ...(params.permissionCeiling
              ? {
                  permissionCeiling: clampRoutinePermission(
                    params.permissionCeiling as PermissionProfile,
                    old.permissionCeiling,
                  ),
                }
              : {}),
            ...(schedule || (old.paused && params.paused === false)
              ? { nextRunAt: nextRoutineRun(schedule ?? old.schedule, context.at) }
              : {}),
            updatedAt: context.at,
          });
          return { events: [routineEvent("routine", next, context)], result: next };
        });
      return undefined;
    },
  };
}
