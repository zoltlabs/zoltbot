// R7: workflows on the phone. The phone lists them and their runs, runs them, pauses them and
// answers approval waits; building and publishing stays on the Mac.
import { Value } from "@sinclair/typebox/value";
import {
  type PipelineVersion,
  PipelineVersionSchema,
  type WorkflowNode,
  type WorkflowRun,
  WorkflowRunSchema,
  type WorkflowStepState,
  workflowOrder,
} from "@zoltbot/protocol";

export const stepLabel: Record<WorkflowStepState["state"], string> = {
  waiting: "Not started",
  running: "Running",
  needs_you: "Needs you",
  done: "Done",
  skipped: "Skipped",
  failed: "Failed",
  would_run: "Would run",
};
export const runLabel: Record<WorkflowRun["state"], string> = {
  scheduled: "Running",
  running: "Running",
  looping: "Running",
  at_gate: "Needs you",
  completed: "Done",
  failed: "Failed",
  cancelled: "Stopped",
};
export const reasonLabel: Record<string, string> = {
  workflow_budget_reached: "Stopped at its budget.",
  workflow_time_limit: "Stopped at its time limit.",
  workflow_stopped: "You stopped this run.",
  workflow_step_failed: "A step failed.",
};
export const kindLabel: Record<WorkflowNode["kind"], string> = {
  trigger: "Start",
  agent: "Agent",
  condition: "Condition",
  wait: "Wait",
  connection: "Connection",
  media: "Image or video",
};

export const readWorkflows = (value: unknown): PipelineVersion[] =>
  (((value ?? {}) as { items?: unknown[] }).items ?? []).filter((item): item is PipelineVersion =>
    Value.Check(PipelineVersionSchema, item),
  );
export const readRuns = (value: unknown): WorkflowRun[] =>
  (((value ?? {}) as { items?: unknown[] }).items ?? []).filter((item): item is WorkflowRun =>
    Value.Check(WorkflowRunSchema, item),
  );

/** The newest version of each workflow, by name. */
export function latestWorkflows(rows: readonly unknown[]): PipelineVersion[] {
  const newest = new Map<string, PipelineVersion>();
  for (const row of readWorkflows({ items: [...rows] })) {
    const seen = newest.get(row.workflowId);
    if (!seen || seen.version < row.version) newest.set(row.workflowId, row);
  }
  return [...newest.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** A workflow's runs, newest first. */
export const workflowRuns = (rows: readonly unknown[], workflowId?: string): WorkflowRun[] =>
  readRuns({ items: [...rows] })
    .filter((run) => !workflowId || run.workflowId === workflowId)
    .sort((a, b) => String(b.startedAt ?? "").localeCompare(String(a.startedAt ?? "")));

/** The run's steps in graph order, each with its node, for a list on a small screen. */
export function runSteps(workflow: PipelineVersion, run: WorkflowRun | undefined) {
  const graph = workflow.graph;
  if (!graph) return [];
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  return (workflowOrder(graph) ?? graph.nodes.map((node) => node.id)).flatMap((id) => {
    const node = nodes.get(id);
    if (!node) return [];
    const state = run?.steps?.find((step) => step.id === id);
    return [{ node, state }];
  });
}

/** An approval wait the owner can answer now. */
export const awaitsApproval = (node: WorkflowNode, state: WorkflowStepState | undefined) =>
  node.kind === "wait" && node.until.type === "approval" && state?.state === "needs_you";

/** A workflow is paused when the owner paused it; the setting is written by workflow.pause. */
export const workflowPaused = (
  settings: readonly { key?: unknown; value?: unknown }[],
  id: string,
) => settings.some((row) => row.key === `workflow.paused.${id}` && row.value === true);

/** One line for a workflow in a list: paused, its newest run, or that it hasn't run. */
export function workflowLine(paused: boolean, newest: WorkflowRun | undefined): string {
  if (paused) return "Paused";
  if (!newest) return "Not run yet";
  return runLabel[newest.state];
}

/** Words for an error from a workflow command. */
export function workflowError(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause);
  if (message.includes("workflow_already_running")) return "This workflow is already running.";
  if (message.includes("workflow_step_not_waiting")) return "That step isn't waiting any more.";
  if (message.includes("scope_")) return "Its project was archived or deleted.";
  if (message.includes("not_found")) return "This workflow is gone.";
  if (message.includes("mac_only") || message.includes("method_unavailable"))
    return "Update Zoltbot on your Mac to do this.";
  return "That didn't work. Try again.";
}
