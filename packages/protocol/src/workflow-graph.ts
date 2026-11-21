// R7: a workflow as a graph. One trigger starts it; agent, condition, wait, connection and media
// steps follow along edges that carry an upstream step's output. A run walks the graph in order,
// and each agent step is a task in the existing task runner.
import { type Static, Type } from "@sinclair/typebox";
import { At, Id, Json, object, values } from "./common.js";
import { EventSourceSchema } from "./event-routines.js";

/** Text a step adds to the next step's brief is capped, so a run can't flood a prompt. */
export const WORKFLOW_CARRY_LIMIT = 4000;
export const WORKFLOW_NODE_LIMIT = 50;

const Name = Type.String({ minLength: 1, maxLength: 120 });
const Brief = Type.String({ minLength: 1, maxLength: WORKFLOW_CARRY_LIMIT });
const Position = { x: Type.Optional(Type.Number()), y: Type.Optional(Type.Number()) };

export const WorkflowTriggerSchema = Type.Union([
  object({ type: Type.Literal("manual") }),
  object({
    type: Type.Literal("schedule"),
    cron: Type.String({ minLength: 1, maxLength: 100 }),
    timezone: Type.String({ minLength: 1, maxLength: 100 }),
    at: Type.Optional(Type.String()),
  }),
  object({ type: Type.Literal("event"), source: EventSourceSchema }),
  // A message in a chat-app bridge (I1) whose text contains `pattern`.
  object({
    type: Type.Literal("message"),
    bridgeId: Id,
    pattern: Type.Optional(Type.String({ maxLength: 200 })),
  }),
]);

export const WorkflowNodeSchema = Type.Union([
  object({
    id: Id,
    kind: Type.Literal("trigger"),
    name: Name,
    trigger: WorkflowTriggerSchema,
    ...Position,
  }),
  object({
    id: Id,
    kind: Type.Literal("agent"),
    name: Name,
    profileId: Id,
    brief: Brief,
    gate: values(["human", "auto_if_checks_pass", "none"]),
    budgetUsd: Type.Optional(Type.Number({ minimum: 0 })),
    ...Position,
  }),
  // Decided by the daemon without a model: a test on one upstream step's output.
  object({
    id: Id,
    kind: Type.Literal("condition"),
    name: Name,
    from: Id,
    test: values(["contains", "equals", "outcome"]),
    value: Type.String({ maxLength: 200 }),
    ...Position,
  }),
  object({
    id: Id,
    kind: Type.Literal("wait"),
    name: Name,
    until: Type.Union([
      object({
        type: Type.Literal("minutes"),
        minutes: Type.Integer({ minimum: 1, maximum: 43200 }),
      }),
      object({ type: Type.Literal("approval") }),
    ]),
    ...Position,
  }),
  // One action of a connection's recipe; actions marked for review wait for the owner.
  object({
    id: Id,
    kind: Type.Literal("connection"),
    name: Name,
    connectionId: Id,
    action: Type.String({ minLength: 1, maxLength: 200 }),
    input: Json,
    budgetUsd: Type.Optional(Type.Number({ minimum: 0 })),
    ...Position,
  }),
  object({
    id: Id,
    kind: Type.Literal("media"),
    name: Name,
    profileId: Id,
    brief: Brief,
    output: values(["image", "video"]),
    budgetUsd: Type.Optional(Type.Number({ minimum: 0 })),
    ...Position,
  }),
]);

export const WorkflowEdgeSchema = object({
  from: Id,
  to: Id,
  /** Which branch of a condition this edge leaves from. */
  port: Type.Optional(values(["true", "false"])),
  carry: values(["summary", "deliverable", "none"]),
});

export const WorkflowGraphSchema = object({
  nodes: Type.Array(WorkflowNodeSchema, { maxItems: WORKFLOW_NODE_LIMIT }),
  edges: Type.Array(WorkflowEdgeSchema, { maxItems: WORKFLOW_NODE_LIMIT * 2 }),
});

/** One step's state within a run. */
export const WorkflowStepStateSchema = object({
  id: Id,
  state: values(["waiting", "running", "needs_you", "done", "skipped", "failed", "would_run"]),
  taskId: Type.Optional(Id),
  /** The step's output, as carried to later steps. */
  output: Type.Optional(Type.String({ maxLength: WORKFLOW_CARRY_LIMIT })),
  /** For a condition: which branch it took. */
  branch: Type.Optional(values(["true", "false"])),
  /** A dry run's estimate: the step's budget ceiling. */
  costCeilingUsd: Type.Optional(Type.Number({ minimum: 0 })),
  startedAt: Type.Optional(At),
  endedAt: Type.Optional(At),
});
export type WorkflowStepState = Static<typeof WorkflowStepStateSchema>;

export type WorkflowTrigger = Static<typeof WorkflowTriggerSchema>;
export type WorkflowNode = Static<typeof WorkflowNodeSchema>;
export type WorkflowEdge = Static<typeof WorkflowEdgeSchema>;
export type WorkflowGraph = Static<typeof WorkflowGraphSchema>;

/** Why a graph can't be published; empty when it can. */
export function workflowGraphProblems(graph: WorkflowGraph): string[] {
  const problems = new Set<string>();
  const ids = new Set<string>();
  for (const node of graph.nodes) {
    if (ids.has(node.id)) problems.add("duplicate_step");
    ids.add(node.id);
  }
  if (graph.nodes.length > WORKFLOW_NODE_LIMIT) problems.add("too_many_steps");
  const triggers = graph.nodes.filter((node) => node.kind === "trigger");
  if (triggers.length !== 1) problems.add("one_trigger_required");
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const seen = new Set<string>();
  for (const edge of graph.edges) {
    const from = byId.get(edge.from);
    const to = byId.get(edge.to);
    if (!from || !to) {
      problems.add("edge_to_missing_step");
      continue;
    }
    if (to.kind === "trigger") problems.add("trigger_has_input");
    if ((from.kind === "condition") !== (edge.port !== undefined)) problems.add("branch_mismatch");
    const key = `${edge.from}>${edge.to}>${edge.port ?? ""}`;
    if (seen.has(key)) problems.add("duplicate_edge");
    seen.add(key);
  }
  for (const node of graph.nodes) {
    if (node.kind !== "condition") continue;
    const ports = graph.edges.filter((edge) => edge.from === node.id).map((edge) => edge.port);
    if (!ports.includes("true") || !ports.includes("false")) problems.add("branch_missing");
    // A condition tests a step that runs before it.
    if (!byId.has(node.from) || !upstream(graph, node.id).has(node.from))
      problems.add("condition_source_not_upstream");
  }
  const order = workflowOrder(graph);
  if (!order) problems.add("cycle");
  else if (triggers.length === 1) {
    const reached = downstream(graph, triggers[0]!.id);
    if (graph.nodes.some((node) => !reached.has(node.id))) problems.add("unreachable_step");
  }
  return [...problems];
}

/** The steps in an order where each comes after every step that feeds it; undefined if cyclic. */
export function workflowOrder(graph: WorkflowGraph): string[] | undefined {
  const incoming = new Map(graph.nodes.map((node) => [node.id, 0]));
  for (const edge of graph.edges)
    if (incoming.has(edge.to) && incoming.has(edge.from))
      incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1);
  const ready = graph.nodes.filter((node) => incoming.get(node.id) === 0).map((node) => node.id);
  const order: string[] = [];
  while (ready.length) {
    const id = ready.shift()!;
    order.push(id);
    for (const edge of graph.edges) {
      if (edge.from !== id || !incoming.has(edge.to)) continue;
      const left = (incoming.get(edge.to) ?? 0) - 1;
      incoming.set(edge.to, left);
      if (left === 0) ready.push(edge.to);
    }
  }
  return order.length === graph.nodes.length ? order : undefined;
}

function walk(graph: WorkflowGraph, start: string, forward: boolean) {
  const found = new Set<string>([start]);
  const queue = [start];
  while (queue.length) {
    const id = queue.shift()!;
    for (const edge of graph.edges) {
      const [here, there] = forward ? [edge.from, edge.to] : [edge.to, edge.from];
      if (here === id && !found.has(there)) {
        found.add(there);
        queue.push(there);
      }
    }
  }
  return found;
}
const downstream = (graph: WorkflowGraph, id: string) => walk(graph, id, true);
function upstream(graph: WorkflowGraph, id: string) {
  const found = walk(graph, id, false);
  found.delete(id);
  return found;
}

/** Whether a condition step's test passes on its source step's output. */
export function conditionHolds(
  node: Extract<WorkflowNode, { kind: "condition" }>,
  output: { text: string; outcome?: string },
): boolean {
  const value = node.value.trim().toLowerCase();
  if (node.test === "outcome") return (output.outcome ?? "").toLowerCase() === value;
  const text = output.text.toLowerCase();
  return node.test === "equals" ? text.trim() === value : text.includes(value);
}

/**
 * Steps that can no longer run, given the branches decided so far: a step is skipped when every
 * edge into it comes from a skipped step or from a branch its condition didn't take.
 */
export function workflowSkipped(
  graph: WorkflowGraph,
  branches: Readonly<Record<string, "true" | "false">>,
): Set<string> {
  const skipped = new Set<string>();
  for (const id of workflowOrder(graph) ?? []) {
    const incoming = graph.edges.filter((edge) => edge.to === id);
    if (!incoming.length) continue;
    const dead = incoming.every(
      (edge) =>
        skipped.has(edge.from) ||
        (edge.port !== undefined &&
          branches[edge.from] !== undefined &&
          branches[edge.from] !== edge.port),
    );
    if (dead) skipped.add(id);
  }
  return skipped;
}
