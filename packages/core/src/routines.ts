import {
  compareSessions,
  type DomainEvent,
  type PermissionProfile,
  PhaseExecutionSchema,
  type Profile,
  parse,
  parseEvent,
  type Routine,
  type RoutineOccurrence,
  RoutineOccurrenceSchema,
  RoutineSchema,
  TaskSchema,
} from "@zoltbot/protocol";
import { type CommandContext, handle, type Outcome } from "./commands.js";
import { applyEvents, type DomainState } from "./projectors.js";
import { nextRoutineRun } from "./routine-time.js";
import { createTask, type TaskInput } from "./tasks.js";

export {
  ROUTINE_FOLDER_WAIT_MS,
  ROUTINE_PERMISSION_TIMEOUT_MS,
  routineOutcome,
  routineShouldNotify,
} from "./routine-policy.js";

const permissions: PermissionProfile[] = [
  "read_only",
  "workspace_write",
  "workspace_write_net",
  "full_access",
];
export function clampRoutinePermission(
  requested: PermissionProfile,
  creator: PermissionProfile,
): PermissionProfile {
  return (
    permissions[Math.min(permissions.indexOf(requested), permissions.indexOf(creator))] ??
    "read_only"
  );
}
export function routineEvent(
  kind: "routine" | "routineOccurrence",
  value: Routine | RoutineOccurrence,
  context: CommandContext,
): DomainEvent {
  return parseEvent({
    eventId: `${context.commandId}:${kind}`,
    commandId: context.commandId,
    aggregateType: kind,
    aggregateId: value.id,
    type: `${kind}.updated`,
    occurredAt: context.at,
    payload: value,
  });
}
export function routineFromTask(
  state: DomainState,
  input: {
    id: string;
    taskId: string;
    name: string;
    schedule: Routine["schedule"];
    notify: Routine["notify"];
    permissionCeiling?: PermissionProfile;
  },
  context: CommandContext,
): Outcome {
  if (context.actor.kind !== "human") throw new Error("human_routine_required");
  const task = parse(
    TaskSchema,
    state.task?.find((row) => row.id === input.taskId),
  );
  if (!task.node || !task.ownerAgentId || !state.taskResult?.some((row) => row.taskId === task.id))
    throw new Error("routine_requires_finished_task");
  const saved = (state.session ?? [])
    .filter((row) => row.threadId === task.threadId)
    .sort(compareSessions)
    .map(
      (row) =>
        state.settings?.find((setting) => setting.key === `runtime.configuration.${row.id}`)?.value,
    )
    .find((value) => value && typeof value === "object") as
    | { profile?: { permissionProfile?: PermissionProfile } }
    | undefined;
  const profile = state.agent?.find((row) => row.id === task.ownerAgentId);
  const creator =
    task.permissionCeiling ??
    saved?.profile?.permissionProfile ??
    (profile?.permissionProfile as PermissionProfile);
  if (!permissions.includes(creator)) throw new Error("routine_permissions_unavailable");
  const events: DomainEvent[] = [];
  let workspaceId = task.workspaceId;
  const project = state.project?.find((row) => row.id === task.projectId);
  const roots = project?.roots as { path: string; repoRoot?: string }[] | undefined;
  if (!workspaceId && roots?.length === 1 && roots[0]) {
    workspaceId = `${input.id}:folder`;
    events.push(
      ...handle(
        state,
        {
          type: "create",
          kind: "workspace",
          value: {
            id: workspaceId,
            projectId: task.projectId,
            kind: "folder",
            path: roots[0].path,
            ...(roots[0].repoRoot ? { repoRoot: roots[0].repoRoot } : {}),
            state: "active",
            createdAt: context.at,
          },
        },
        { ...context, commandId: `${context.commandId}:folder` },
      ).events,
    );
  }
  const routine = parse(RoutineSchema, {
    id: input.id,
    name: input.name.trim() || task.title,
    template: {
      title: task.title,
      brief: task.brief,
      acceptance: task.acceptance,
      profileId: task.ownerAgentId,
      node: task.node,
      ...(workspaceId ? { workspaceId } : {}),
      inputs: task.routineInputs ?? {
        ...(task.browser
          ? { browser: { ...(task.browser as { mode: string; url?: string }), mode: "background" } }
          : {}),
        knowledge: "inherit",
        skills: "inherit",
        connections: "inherit",
      },
    },
    schedule: input.schedule,
    permissionCeiling: clampRoutinePermission(input.permissionCeiling ?? creator, creator),
    notify: input.notify,
    paused: false,
    nextRunAt: nextRoutineRun(input.schedule, context.at),
    createdAt: context.at,
    updatedAt: context.at,
  });
  return { events: [...events, routineEvent("routine", routine, context)], result: routine };
}
/** Store.dispatch commits these events and its command receipt in one SQLite transaction. */
export function fireRoutine(
  state: DomainState,
  routine: Routine,
  scheduledAt: string,
  disposition: "fire" | "missed",
  context: CommandContext,
): Outcome {
  const id = `${routine.id}@${new Date(scheduledAt).toISOString()}`;
  const old = state.routineOccurrence?.find((row) => row.id === id);
  if (old) return { events: [], result: old };
  const previousActive = state.routineOccurrence?.some(
    (row) =>
      row.routineId === routine.id &&
      state.task?.some(
        (task) =>
          task.id === row.taskId && ["queued", "running", "blocked"].includes(String(task.state)),
      ),
  );
  const status = disposition === "missed" ? "missed" : previousActive ? "skipped" : "queued";
  const occurrence = parse(RoutineOccurrenceSchema, {
    id,
    routineId: routine.id,
    scheduledAt,
    status,
    notify: routine.notify,
    createdAt: context.at,
    updatedAt: context.at,
    ...(previousActive && disposition !== "missed"
      ? { reason: "Previous occurrence is still active" }
      : {}),
    ...(status === "queued" ? { taskId: `run:${id}` } : {}),
  });
  const events: DomainEvent[] = [];
  if (occurrence.taskId) {
    const t = routine.template;
    const created = createTask(
      state,
      {
        id: occurrence.taskId,
        title: t.title,
        brief: t.brief,
        acceptance: t.acceptance,
        profileId: t.profileId,
        node: t.node,
        routineOccurrenceId: id,
        permissionCeiling: routine.permissionCeiling,
        routineInputs: t.inputs,
      } satisfies TaskInput,
      { ...context, actor: { kind: "human", id: "routine" } },
    );
    events.push(...created.events);
    if (t.workspaceId) {
      const task = parse(
        TaskSchema,
        (applyEvents(state, events).task ?? []).find((row) => row.id === occurrence.taskId),
      );
      events.push(
        parseEvent({
          eventId: `${context.commandId}:workspace`,
          commandId: context.commandId,
          aggregateType: "task",
          aggregateId: task.id,
          type: "task.updated",
          occurredAt: context.at,
          payload: { ...task, workspaceId: t.workspaceId, workspaceMode: "shared" },
        }),
      );
    }
  }
  const next = {
    ...routine,
    nextRunAt: nextRoutineRun(routine.schedule, scheduledAt),
    updatedAt: context.at,
  };
  events.push(
    routineEvent("routineOccurrence", occurrence, context),
    routineEvent("routine", next, context),
  );
  return { events, result: occurrence };
}
/** Apply the captured ceiling even if the saved profile was widened after creation. */
export function routineProfile(
  state: DomainState,
  taskId: string | undefined,
  profile: Profile,
): Profile {
  const task = state.task?.find((row) => row.id === taskId);
  if (task?.phaseExecution) {
    const execution = parse(PhaseExecutionSchema, task.phaseExecution);
    const { effort: _effort, ...base } = profile;
    return {
      ...base,
      definitionId: execution.definitionId,
      model: execution.model,
      ...(execution.effort ? { effort: execution.effort } : {}),
      permissionProfile: clampRoutinePermission(
        profile.permissionProfile,
        execution.permissionCeiling,
      ),
    };
  }
  return task?.permissionCeiling
    ? {
        ...profile,
        permissionProfile: clampRoutinePermission(
          profile.permissionProfile,
          task.permissionCeiling as PermissionProfile,
        ),
      }
    : profile;
}
