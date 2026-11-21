// R7: a workflow with a schedule trigger owns a routine, so routine history, Run now, keeping the
// Mac awake and the calendar feed cover workflows too. When that routine fires, it starts a
// workflow run instead of a task.
import {
  type DomainEvent,
  type PipelineVersion,
  PipelineVersionSchema,
  parse,
  parseEvent,
  type Routine,
  type RoutineOccurrence,
  RoutineOccurrenceSchema,
  RoutineSchema,
} from "@zoltbot/protocol";
import type { CommandContext, Outcome } from "./commands.js";
import type { DomainState } from "./projectors.js";
import { nextRoutineRun } from "./routine-time.js";
import { startWorkflowRun, workflowPausedKey } from "./workflow-runs.js";

export const workflowRoutineId = (workflowId: string) => `workflow-routine:${workflowId}`;

function event(kind: "routine" | "routineOccurrence", value: unknown, context: CommandContext) {
  const payload = parse(kind === "routine" ? RoutineSchema : RoutineOccurrenceSchema, value);
  return parseEvent({
    eventId: `${context.commandId}:${kind}`,
    commandId: context.commandId,
    aggregateType: kind,
    aggregateId: payload.id,
    type: `${kind}.updated`,
    occurredAt: context.at,
    payload,
  });
}

/** The newest published version of a workflow. */
export function latestWorkflow(state: DomainState, workflowId: string) {
  const rows = (state.workflow ?? []).filter((row) => row.workflowId === workflowId);
  const newest = rows.sort((a, b) => Number(b.version) - Number(a.version))[0];
  return newest ? parse(PipelineVersionSchema, newest) : undefined;
}

/**
 * After a publish: a schedule trigger makes or updates the workflow's routine; any other trigger
 * pauses a routine an earlier version made, keeping its history. Event and message triggers
 * aren't available yet.
 */
export function syncWorkflowRoutine(
  state: DomainState,
  workflow: PipelineVersion,
  context: CommandContext,
): DomainEvent[] {
  const trigger = workflow.graph?.nodes.find((node) => node.kind === "trigger");
  if (trigger?.kind !== "trigger") return [];
  if (trigger.trigger.type === "event" || trigger.trigger.type === "message")
    throw new Error(`workflow_trigger_unavailable: ${trigger.trigger.type}`);
  const id = workflowRoutineId(workflow.workflowId);
  const row = state.routine?.find((entry) => entry.id === id);
  const old = row ? parse(RoutineSchema, row) : undefined;
  if (trigger.trigger.type !== "schedule") {
    // Retired for good, keeping its history; a later schedule makes it again.
    if (!old || old.doneAt) return [];
    return [
      event(
        "routine",
        { ...old, paused: true, doneAt: context.at, updatedAt: context.at },
        context,
      ),
    ];
  }
  const paused =
    state.settings?.find((entry) => entry.key === workflowPausedKey(workflow.workflowId))?.value ===
    true;
  const schedule = {
    cron: trigger.trigger.cron,
    timezone: trigger.trigger.timezone,
    ...(trigger.trigger.at ? { at: trigger.trigger.at } : {}),
  };
  const routine: Routine = {
    id,
    workflowId: workflow.workflowId,
    name: workflow.name.slice(0, 150),
    schedule,
    template: {
      title: workflow.name.slice(0, 150) || "Workflow",
      brief: (workflow.description || workflow.name).slice(0, 4000) || "Workflow",
      acceptance: "",
      profileId: workflow.executorAgent,
      node: workflow.scope,
      inputs: { knowledge: "inherit", skills: "inherit", connections: "inherit" },
    },
    permissionCeiling: workflow.permissionProfile,
    notify: "actionable_only",
    paused,
    nextRunAt: nextRoutineRun(schedule, context.at),
    createdAt: old?.createdAt ?? context.at,
    updatedAt: context.at,
  };
  return [event("routine", routine, context)];
}

/** A workflow's routine fired: start a run of the newest version, unless one is still going. */
export function fireWorkflowRoutine(
  state: DomainState,
  routine: Routine,
  occurrenceId: string,
  scheduledAt: string,
  disposition: "fire" | "missed",
  context: CommandContext,
  manual: boolean,
): Outcome {
  const workflow = routine.workflowId ? latestWorkflow(state, routine.workflowId) : undefined;
  if (!workflow) throw new Error("not_found: workflow");
  let status: RoutineOccurrence["status"] = disposition === "missed" ? "missed" : "completed";
  let reason = disposition === "missed" ? undefined : "Started a workflow run";
  const events: DomainEvent[] = [];
  const scheduled =
    workflow.graph?.nodes.some(
      (node) => node.kind === "trigger" && node.trigger.type === "schedule",
    ) ?? false;
  const paused =
    state.settings?.find((entry) => entry.key === workflowPausedKey(workflow.workflowId))?.value ===
    true;
  // The newest version no longer runs on a schedule, or the owner paused it: nothing starts.
  if (disposition === "fire" && (!scheduled || paused)) {
    status = "skipped";
    reason = paused ? "Workflow is paused" : "Workflow no longer runs on a schedule";
  } else if (disposition === "fire")
    try {
      events.push(
        ...startWorkflowRun(
          state,
          {
            runId: `run:${occurrenceId}`,
            workflowId: workflow.workflowId,
            version: workflow.version,
            trigger: manual ? "run_now" : "schedule",
            inputs: {},
          },
          { ...context, actor: { kind: "system", id: "workflow" } },
        ).events,
      );
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "workflow_already_running") throw error;
      status = "skipped";
      reason = "Previous run is still going";
    }
  const occurrence = {
    id: occurrenceId,
    routineId: routine.id,
    scheduledAt,
    status,
    notify: routine.notify,
    ...(manual ? { manual: true } : {}),
    ...(reason ? { reason } : {}),
    createdAt: context.at,
    updatedAt: context.at,
  };
  const next = {
    ...routine,
    nextRunAt: nextRoutineRun(routine.schedule, scheduledAt),
    ...(routine.schedule.cron === "@once" ? { doneAt: context.at } : {}),
    updatedAt: context.at,
  };
  events.push(
    event("routineOccurrence", occurrence, context),
    ...(manual ? [] : [event("routine", next, context)]),
  );
  return {
    events: events.map((entry, index) => ({ ...entry, eventId: `${context.commandId}:${index}` })),
    result: parse(RoutineOccurrenceSchema, occurrence),
  };
}
