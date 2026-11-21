// R7: a workflow run walks its graph. Each call to `advanceWorkflowRun` reads the run, its version
// and its agent steps' tasks, and moves every step it can; nothing is held in memory, so after a
// crash the next call picks up from what's stored.
import {
  conditionHolds,
  type DomainEvent,
  PipelineVersionSchema,
  parse,
  parseEvent,
  TaskResultSchema,
  TaskSchema,
  WORKFLOW_CARRY_LIMIT,
  type WorkflowRun,
  WorkflowRunSchema,
  type WorkflowStepState,
  workflowOrder,
  workflowSkipped,
} from "@zoltbot/protocol";
import type { CommandContext, Outcome } from "./commands.js";
import { applyEvents, type DomainState } from "./projectors.js";
import { createWorkflowStepTask } from "./tasks.js";

const ACTIVE = ["running", "at_gate"];
const FINISHED = ["done", "skipped", "failed"];

function runEvent(run: WorkflowRun, context: CommandContext, verb: string): DomainEvent {
  const value = parse(WorkflowRunSchema, run);
  return parseEvent({
    eventId: `${context.commandId}:run`,
    commandId: context.commandId,
    aggregateType: "workflowRun",
    aggregateId: value.id,
    type: `workflowRun.${verb}`,
    occurredAt: context.at,
    payload: value,
  });
}
function numbered(events: DomainEvent[], context: CommandContext): DomainEvent[] {
  return events.map((event, index) => ({ ...event, eventId: `${context.commandId}:${index}` }));
}
function version(state: DomainState, workflowId: string, number: number) {
  const row = state.workflow?.find(
    (entry) => entry.workflowId === workflowId && entry.version === number,
  );
  return row ? parse(PipelineVersionSchema, row) : undefined;
}

/** Start a run of a published version: every step waits, then the run advances once. */
export function startWorkflowRun(
  state: DomainState,
  input: { runId: string; workflowId: string; version: number; trigger: string; inputs: unknown },
  context: CommandContext,
): Outcome {
  const workflow = version(state, input.workflowId, input.version);
  if (!workflow?.graph) throw new Error("workflow_graph_required");
  if (state.workflowRun?.some((row) => row.id === input.runId))
    throw new Error("already_exists: workflowRun");
  // Only "skip" is built so far, so every overlap setting runs one at a time.
  if (
    state.workflowRun?.some(
      (row) => row.workflowId === workflow.workflowId && ACTIVE.includes(String(row.state)),
    )
  )
    throw new Error("workflow_already_running");
  const run: WorkflowRun = {
    id: input.runId,
    workflowId: workflow.workflowId,
    version: workflow.version,
    trigger: input.trigger,
    inputs: input.inputs ?? {},
    state: "running",
    startedAt: context.at,
    steps: (workflowOrder(workflow.graph) ?? []).map((id) => ({ id, state: "waiting" as const })),
  };
  const created = runEvent(run, context, "created");
  const advanced = advanceWorkflowRun(applyEvents(state, [created]), run.id, context);
  return {
    events: numbered([created, ...advanced.events], context),
    result: advanced.events.length ? advanced.result : run,
  };
}

/** What an agent step's task says about the step. */
function fromTask(state: DomainState, step: WorkflowStepState): Partial<WorkflowStepState> {
  const row = state.task?.find((entry) => entry.id === step.taskId);
  if (!row) return { state: "failed" };
  const task = parse(TaskSchema, row);
  if (task.state === "review" || task.state === "blocked") return { state: "needs_you" };
  if (task.state === "failed" || task.state === "cancelled") return { state: "failed" };
  if (task.state !== "completed") return { state: "running" };
  const result = (state.taskResult ?? [])
    .map((entry) => parse(TaskResultSchema, entry))
    .filter((entry) => entry.taskId === task.id)
    .sort((a, b) => b.revision - a.revision)[0];
  return { state: "done", output: (result?.summary ?? "").slice(0, WORKFLOW_CARRY_LIMIT) };
}

/** A paused workflow's runs start no new steps; the setting is the owner's. */
export const workflowPausedKey = (workflowId: string) => `workflow.paused.${workflowId}`;
const minutes = (from: string | undefined, to: string) =>
  from ? (Date.parse(to) - Date.parse(from)) / 60_000 : 0;
const OPEN_TASK = ["queued", "running", "blocked", "review"];

/** Cancel every open task of a run that has ended; the daemon then stops their turns. */
function cancelOpenTasks(
  state: DomainState,
  runId: string,
  reason: string,
  context: CommandContext,
) {
  return (state.task ?? [])
    .filter((row) => row.workflowRunId === runId && OPEN_TASK.includes(String(row.state)))
    .map((row) =>
      parseEvent({
        eventId: `${context.commandId}:cancel:${String(row.id)}`,
        commandId: context.commandId,
        aggregateType: "task",
        aggregateId: String(row.id),
        type: "task.updated",
        occurredAt: context.at,
        payload: parse(TaskSchema, {
          ...row,
          state: "cancelled",
          holdReason: reason,
          updatedAt: context.at,
        }),
      }),
    );
}

/** Move every step that can move; returns no events when nothing changed. */
export function advanceWorkflowRun(
  state: DomainState,
  runId: string,
  context: CommandContext,
): Outcome {
  const row = state.workflowRun?.find((entry) => entry.id === runId);
  if (!row) throw new Error(`not_found: workflowRun ${runId}`);
  const before = parse(WorkflowRunSchema, row);
  const workflow = version(state, before.workflowId, before.version);
  const graph = workflow?.graph;
  if (!ACTIVE.includes(before.state) || !workflow || !graph) return { events: [], result: before };
  const paused =
    state.settings?.find((entry) => entry.key === workflowPausedKey(workflow.workflowId))?.value ===
    true;
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const steps = new Map((before.steps ?? []).map((step) => [step.id, { ...step }]));
  const events: DomainEvent[] = [];
  let current = state;
  let reason: string | undefined;
  const finish = (step: WorkflowStepState, change: Partial<WorkflowStepState>) => {
    Object.assign(step, change);
    if (FINISHED.includes(step.state)) step.endedAt ??= context.at;
  };
  const skippedNow = () => {
    const branches: Record<string, "true" | "false"> = {};
    for (const step of steps.values()) if (step.branch) branches[step.id] = step.branch;
    return workflowSkipped(graph, branches);
  };
  // The run's total: every task step's budget ceiling counts once it starts.
  const committed = () =>
    [...steps.values()].reduce((sum, step) => {
      const node = nodes.get(step.id);
      return step.taskId && node && "budgetUsd" in node ? sum + (node.budgetUsd ?? 0) : sum;
    }, 0);
  const limit = workflow.budget.wallClockMinutes;
  if (limit !== undefined && minutes(before.startedAt, context.at) > limit)
    reason = "workflow_time_limit";
  for (let pass = 0, moved = !reason; moved && pass <= graph.nodes.length; pass++) {
    moved = false;
    for (const step of steps.values()) {
      const node = nodes.get(step.id);
      if (step.taskId && ["running", "needs_you"].includes(step.state)) {
        const next = fromTask(current, step);
        if (next.state !== step.state) {
          finish(step, next);
          moved = true;
        }
      } else if (
        node?.kind === "wait" &&
        node.until.type === "minutes" &&
        step.state === "running" &&
        minutes(step.startedAt, context.at) >= node.until.minutes
      ) {
        finish(step, { state: "done" });
        moved = true;
      }
    }
    if (paused) break;
    for (const id of workflowOrder(graph) ?? []) {
      const step = steps.get(id);
      const node = nodes.get(id);
      if (!step || !node || step.state !== "waiting" || reason) continue;
      // A branch decided earlier in this pass rules steps out before they're tried.
      if (skippedNow().has(id)) {
        finish(step, { state: "skipped" });
        moved = true;
        continue;
      }
      const ready = graph.edges
        .filter((edge) => edge.to === id)
        .every((edge) => ["done", "skipped"].includes(steps.get(edge.from)?.state ?? ""));
      if (!ready) continue;
      moved = true;
      if (node.kind === "trigger") {
        finish(step, { state: "done", startedAt: context.at });
      } else if (node.kind === "condition") {
        const source = steps.get(node.from);
        const result = (current.taskResult ?? []).find((entry) => entry.taskId === source?.taskId);
        const outcome = result ? String(result.outcome ?? result.status) : undefined;
        const holds = conditionHolds(node, {
          text: source?.output ?? "",
          ...(outcome ? { outcome } : {}),
        });
        finish(step, { state: "done", startedAt: context.at, branch: holds ? "true" : "false" });
      } else if (node.kind === "wait") {
        // A timed wait ends on a later tick; an approval waits for the owner's answer.
        finish(step, {
          state: node.until.type === "minutes" ? "running" : "needs_you",
          startedAt: context.at,
        });
      } else {
        const total = workflow.budget.usd;
        // A step with no ceiling of its own could spend past the total, so it doesn't start.
        if (
          total !== undefined &&
          (node.budgetUsd === undefined || committed() + node.budgetUsd > total)
        ) {
          reason = "workflow_budget_reached";
          break;
        }
        const taskId = `${runId}:${id}`;
        // The task's brief reads the outputs this pass has gathered so far.
        const interim = { ...before, steps: (before.steps ?? []).map((s) => steps.get(s.id) ?? s) };
        current = applyEvents(current, [runEvent(interim, context, "updated")]);
        const created = createWorkflowStepTask(
          current,
          { runId, stepId: id, taskId },
          { ...context, actor: { kind: "system", id: "workflow" } },
        );
        events.push(...created.events);
        current = applyEvents(current, created.events);
        finish(step, { state: "running", startedAt: context.at, taskId });
      }
    }
  }
  const list = (before.steps ?? []).map((step) => steps.get(step.id) ?? step);
  if (!reason && list.some((step) => step.state === "failed")) reason = "workflow_step_failed";
  const state_: WorkflowRun["state"] = reason
    ? "failed"
    : list.every((step) => ["done", "skipped"].includes(step.state))
      ? "completed"
      : list.some((step) => step.state === "needs_you")
        ? "at_gate"
        : "running";
  const after: WorkflowRun = {
    ...before,
    state: state_,
    steps: list,
    ...(reason ? { reason } : {}),
    ...(["failed", "completed"].includes(state_) ? { endedAt: context.at } : {}),
  };
  if (JSON.stringify(after) === JSON.stringify(before)) return { events: [], result: before };
  // One failed step ends the run, so its other steps' tasks stop too.
  const cancelled = reason ? cancelOpenTasks(current, runId, reason, context) : [];
  return {
    events: numbered([...events, ...cancelled, runEvent(after, context, "updated")], context),
    result: after,
  };
}

/** The owner answers a "wait for my approval" step: continue the run, or stop it. */
export function decideWorkflowStep(
  state: DomainState,
  input: { runId: string; stepId: string; decision: "continue" | "stop" },
  context: CommandContext,
): Outcome {
  if (context.actor.kind !== "human") throw new Error("human_decision_required");
  const row = state.workflowRun?.find((entry) => entry.id === input.runId);
  if (!row) throw new Error(`not_found: workflowRun ${input.runId}`);
  const run = parse(WorkflowRunSchema, row);
  const graph = version(state, run.workflowId, run.version)?.graph;
  const node = graph?.nodes.find((entry) => entry.id === input.stepId);
  const step = run.steps?.find((entry) => entry.id === input.stepId);
  if (
    !ACTIVE.includes(run.state) ||
    node?.kind !== "wait" ||
    node.until.type !== "approval" ||
    step?.state !== "needs_you"
  )
    throw new Error("workflow_step_not_waiting");
  const steps = (run.steps ?? []).map((entry) =>
    entry.id === step.id
      ? {
          ...entry,
          state: input.decision === "continue" ? ("done" as const) : ("skipped" as const),
          endedAt: context.at,
        }
      : entry,
  );
  if (input.decision === "stop") {
    const stopped: WorkflowRun = {
      ...run,
      state: "cancelled",
      steps,
      reason: "workflow_stopped",
      endedAt: context.at,
    };
    return {
      events: numbered(
        [
          ...cancelOpenTasks(state, run.id, "workflow_stopped", context),
          runEvent(stopped, context, "updated"),
        ],
        context,
      ),
      result: stopped,
    };
  }
  const answered = runEvent({ ...run, state: "running", steps }, context, "updated");
  const advanced = advanceWorkflowRun(applyEvents(state, [answered]), run.id, context);
  return {
    events: numbered([answered, ...advanced.events], context),
    result: advanced.events.length ? advanced.result : { ...run, state: "running", steps },
  };
}
