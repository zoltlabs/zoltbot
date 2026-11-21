// R7: workflows. Publishing saves a new immutable version; a dry run walks the graph without
// starting anything. Real runs go through the workflow runner (workflow-runner.ts).
import { type DomainState, handle } from "@zoltbot/core";
import {
  type DomainEvent,
  type PipelineVersion,
  PipelineVersionSchema,
  parse,
  type WorkflowGraph,
  WorkflowRunSchema,
  type WorkflowStepState,
  workflowGraphProblems,
  workflowOrder,
} from "@zoltbot/protocol";
import type { Store } from "@zoltbot/store";
import type { PublicWriteCheck } from "./private-input.js";

const owner = { kind: "human" as const, id: "local-owner" };
const methods = new Set([
  "workflow.list",
  "workflow.publish",
  "workflow.runs",
  "workflow.run",
  "workflow.draftFromTask",
]);

/** The newest version of each workflow. */
export function latestWorkflows(state: DomainState): PipelineVersion[] {
  const newest = new Map<string, PipelineVersion>();
  for (const row of state.workflow ?? []) {
    const value = parse(PipelineVersionSchema, row);
    const seen = newest.get(value.workflowId);
    if (!seen || seen.version < value.version) newest.set(value.workflowId, value);
  }
  return [...newest.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function latest(state: DomainState, workflowId: string) {
  const found = latestWorkflows(state).find((row) => row.workflowId === workflowId);
  if (!found) throw new Error(`not_found: workflow ${workflowId}`);
  return found;
}

/** Every step a run would take, with each agent step's budget as its cost ceiling. */
export function dryRun(graph: WorkflowGraph): WorkflowStepState[] {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  return (workflowOrder(graph) ?? []).map((id) => {
    const node = byId.get(id)!;
    if (node.kind === "trigger") return { id, state: "done" as const };
    return {
      id,
      state: "would_run" as const,
      ...(node.kind === "agent" && node.budgetUsd !== undefined
        ? { costCeilingUsd: node.budgetUsd }
        : {}),
    };
  });
}

function checkGraph(state: DomainState, value: PipelineVersion) {
  const graph = value.graph;
  if (!graph) return;
  const problems = workflowGraphProblems(graph);
  if (problems.length) throw new Error(`workflow_graph_invalid: ${problems.join(", ")}`);
  const agents = new Set(
    (state.agent ?? []).filter((row) => !row.archived).map((row) => String(row.id)),
  );
  for (const node of graph.nodes)
    if ((node.kind === "agent" || node.kind === "media") && !agents.has(node.profileId))
      throw new Error(`profile_unavailable: ${node.id}`);
  // A step that can change files and reads an earlier step's output needs the owner's review,
  // so text from one agent never drives a writing agent unchecked.
  if (value.permissionProfile !== "read_only")
    for (const node of graph.nodes)
      if (
        node.kind === "agent" &&
        node.gate === "none" &&
        graph.edges.some((edge) => edge.to === node.id && edge.carry !== "none")
      )
        throw new Error(`workflow_review_required: ${node.id}`);
}

/** A one-step workflow from a finished task: run by hand, the same brief, the same agent. */
function draftFromTask(state: DomainState, taskId: string): PipelineVersion {
  const task = state.task?.find((row) => row.id === taskId);
  if (!task) throw new Error(`not_found: task ${taskId}`);
  const agent = String(task.ownerAgentId ?? "");
  if (!agent) throw new Error("profile_unavailable");
  const title = String(task.title ?? "Workflow").slice(0, 120);
  const brief = String(task.brief ?? "").slice(0, 4000) || title;
  const projectId = typeof task.projectId === "string" ? task.projectId : undefined;
  return parse(PipelineVersionSchema, {
    workflowId: `workflow-${taskId}`,
    version: 1,
    name: title,
    description: "",
    scope: projectId ? { type: "project", id: projectId } : { type: "user", id: "local-owner" },
    inputs: {},
    briefTemplate: brief,
    acceptance: String(task.acceptance ?? ""),
    expectedDeliverable: { kind: "report", title },
    checks: [],
    permissionProfile: "read_only",
    executorAgent: agent,
    workspaceMode: task.workspaceMode === "worktree" ? "worktree" : "shared",
    budget: {},
    retry: { maxAttempts: 1, backoffSeconds: [], retryOn: [] },
    review: "required",
    notify: "on_change",
    trigger: [{ kind: "manual" }],
    overlap: "skip",
    previousResult: "none",
    stages: [],
    loops: [],
    graph: {
      nodes: [
        { id: "start", kind: "trigger", name: "Run by hand", trigger: { type: "manual" } },
        { id: "step-1", kind: "agent", name: title, profileId: agent, brief, gate: "human" },
      ],
      edges: [{ from: "start", to: "step-1", carry: "none" }],
    },
  });
}

export function workflowsApi(options: {
  store: Store;
  publish(events: DomainEvent[]): void;
  checkPublic(value: unknown): Promise<PublicWriteCheck>;
  now?: () => string;
  /** Starts a real run; without it only dry runs are possible. */
  start?(workflow: PipelineVersion, inputs: unknown, commandId: string): Promise<unknown>;
}) {
  const { store } = options;
  const now = () => options.now?.() ?? new Date().toISOString();
  return async (method: string, params: Record<string, unknown>, commandId?: string) => {
    if (!methods.has(method)) return undefined;
    const state = store.snapshot(["workflow", "workflowRun", "agent", "task"]);
    if (method === "workflow.list") return { items: latestWorkflows(state) };
    if (method === "workflow.runs") {
      const workflowId = typeof params.workflowId === "string" ? params.workflowId : undefined;
      const items = (state.workflowRun ?? [])
        .map((row) => parse(WorkflowRunSchema, row))
        .filter((run) => !workflowId || run.workflowId === workflowId)
        .sort((a, b) => String(b.startedAt ?? "").localeCompare(String(a.startedAt ?? "")));
      return { items };
    }
    if (method === "workflow.draftFromTask") return draftFromTask(state, String(params.taskId));
    if (method === "workflow.run") {
      const workflow = latest(state, String(params.id));
      if (params.dryRun === true) {
        if (!workflow.graph) throw new Error("workflow_graph_required");
        return parse(WorkflowRunSchema, {
          id: `dry-run:${workflow.workflowId}`,
          workflowId: workflow.workflowId,
          version: workflow.version,
          trigger: "dry_run",
          inputs: params.inputs ?? {},
          state: "completed",
          steps: dryRun(workflow.graph),
        });
      }
      if (!commandId) throw new Error("command_id_required");
      if (!options.start) throw new Error("workflow_runner_unavailable");
      return options.start(workflow, params.inputs ?? {}, commandId);
    }
    // workflow.publish: a new version, never an edit of an old one.
    if (!commandId) throw new Error("command_id_required");
    if (params.confirmed !== true) throw new Error("confirmation_required");
    const value = parse(PipelineVersionSchema, params.value);
    checkGraph(state, value);
    const check = await options.checkPublic([params, commandId]);
    const before = store.lastSeq();
    const result = store.dispatch(commandId, (current) => {
      check(current);
      const versions = (current.workflow ?? [])
        .filter((row) => row.workflowId === value.workflowId)
        .map((row) => Number(row.version));
      const next = { ...value, version: Math.max(0, ...versions) + 1 };
      const outcome = handle(
        current,
        { type: "create", kind: "workflow", value: next } as Parameters<typeof handle>[1],
        { commandId, at: now(), actor: owner },
      );
      return { ...outcome, result: next };
    }).result;
    options.publish(store.eventsSince(before));
    return result;
  };
}
