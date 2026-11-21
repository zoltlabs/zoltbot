// R7: the Workflows view's IPC handlers. The daemon checks every change; this side shapes the
// newest version of each workflow and its recent runs for the canvas, and turns codes into words.
import { randomUUID } from "node:crypto";
import {
  WORKFLOW_CHANNELS as C,
  type WorkflowAgent,
  type WorkflowEdge,
  type WorkflowEdit,
  type WorkflowItem,
  type WorkflowRunItem,
  type WorkflowStep,
} from "../shared/workflows";
import type { DaemonClient } from "./daemon-client";
import { isObject, requireString } from "./parsers";
import { applyWorkflowEdit } from "./workflow-edit";

/** Workflow, run and step ids are short; anything longer never reaches the daemon. */
function requireId(value: unknown, field: string): string {
  const id = requireString(value, field);
  if (id.length > 200) throw new Error(`${field} is too long.`);
  return id;
}

type Client = Pick<DaemonClient, "call" | "rows">;
type Row = Record<string, unknown>;

const MESSAGES: Record<string, string> = {
  workflow_already_running: "It's already running.",
  workflow_step_not_waiting: "That step isn't waiting any more.",
  workflow_scope_required: "Its project was archived or deleted.",
  workflow_changed: "It changed since you opened it. Look again, then retry.",
  branch_missing: "Each branch of a condition needs a step after it.",
  unreachable_step: "That would leave a step that nothing leads to.",
  condition_source_not_upstream: "A condition can only check a step that comes before it.",
  workflow_condition_branches: "Remove the steps on its No branch first.",
  workflow_condition_next: "Add a condition before another step, so both branches lead somewhere.",
  workflow_edit_invalid: "That change isn't possible here.",
  workflow_step_name: "Give the step a name of up to 120 characters.",
  workflow_step_brief: "Say what the step should do, in up to 4,000 characters.",
  workflow_wait_minutes: "Wait between 1 minute and 30 days.",
  workflow_condition_test: "Choose a step to check and enter up to 200 characters to look for.",
  workflow_trigger_required: "A workflow needs its start step.",
  workflow_step_missing: "That step is gone. Look again, then retry.",
  workflow_graph_invalid: "That would leave steps out of order or unreachable.",
  workflow_review_required: "A later step would act on this output without a review.",
  workflow_step_budget_required: "That step needs a budget.",
  workflow_connection_carry: "A connection step can't take another step's output.",
  profile_unavailable: "That agent isn't available.",
  scope_unavailable: "Its project was archived or deleted.",
};

function failure(error: unknown, fallback: string): Error {
  const message = error instanceof Error ? error.message : "";
  const code = Object.keys(MESSAGES).find((key) => message.includes(key));
  return new Error(code ? MESSAGES[code] : fallback);
}

const text = (value: unknown) => (typeof value === "string" ? value : undefined);
const number = (value: unknown) => (typeof value === "number" ? value : undefined);
const STEP_STATES = new Set(["waiting", "running", "needs_you", "done", "skipped", "failed"]);
const RUN_STATES = new Set([
  "running",
  "at_gate",
  "completed",
  "failed",
  "cancelled",
  "scheduled",
  "looping",
]);

function step(node: Row, agents: Map<string, string>): WorkflowStep | null {
  const id = text(node.id);
  const name = text(node.name);
  const kind = text(node.kind);
  if (!id || !name || !kind) return null;
  const agentOf = (profile: unknown) => agents.get(String(profile)) ?? String(profile);
  const base = { id, name, ...(number(node.x) !== undefined ? { x: Number(node.x) } : {}) };
  const placed = { ...base, ...(number(node.y) !== undefined ? { y: Number(node.y) } : {}) };
  if (kind === "trigger") return { ...placed, kind };
  if (kind === "agent" || kind === "media")
    return {
      ...placed,
      kind,
      agent: agentOf(node.profileId),
      agentId: String(node.profileId ?? ""),
      brief: String(node.brief ?? ""),
      ...(kind === "media" ? { output: node.output === "video" ? "video" : "image" } : {}),
    };
  if (kind === "condition") {
    const test = text(node.test);
    return {
      ...placed,
      kind,
      test: {
        from: String(node.from ?? ""),
        kind: test === "equals" || test === "outcome" ? test : "contains",
        value: String(node.value ?? ""),
      },
    };
  }
  if (kind === "wait") {
    const until = isObject(node.until) ? node.until : {};
    return {
      ...placed,
      kind,
      wait: until.type === "minutes" ? { minutes: Number(until.minutes) || 1 } : { approval: true },
    };
  }
  if (kind === "connection")
    return {
      ...placed,
      kind,
      action: { connection: String(node.connectionId ?? ""), action: String(node.action ?? "") },
    };
  return null;
}

function run(row: Row): WorkflowRunItem | null {
  const id = text(row.id);
  const state = text(row.state);
  if (!id || !state || !RUN_STATES.has(state)) return null;
  const steps = Array.isArray(row.steps) ? row.steps : [];
  return {
    id,
    state: state as WorkflowRunItem["state"],
    ...(text(row.startedAt) ? { startedAt: String(row.startedAt) } : {}),
    ...(text(row.reason) ? { reason: String(row.reason) } : {}),
    steps: steps.flatMap((entry) =>
      isObject(entry) && text(entry.id) && STEP_STATES.has(String(entry.state))
        ? [
            {
              id: String(entry.id),
              state: entry.state as WorkflowRunItem["steps"][number]["state"],
              ...(entry.branch === "true" || entry.branch === "false"
                ? { branch: entry.branch }
                : {}),
            },
          ]
        : [],
    ),
  };
}

export function parseWorkflow(
  value: unknown,
  agents: Map<string, string>,
  paused: boolean,
  runs: WorkflowRunItem[],
): WorkflowItem | null {
  if (!isObject(value) || !isObject(value.graph)) return null;
  const id = text(value.workflowId);
  const version = number(value.version);
  if (!id || version === undefined) return null;
  const nodes = Array.isArray(value.graph.nodes) ? value.graph.nodes : [];
  const steps = nodes.flatMap((node) => {
    const parsed = isObject(node) ? step(node, agents) : null;
    return parsed ? [parsed] : [];
  });
  const ids = new Set(steps.map((entry) => entry.id));
  const edges = (Array.isArray(value.graph.edges) ? value.graph.edges : []).flatMap(
    (edge): WorkflowEdge[] =>
      isObject(edge) && ids.has(String(edge.from)) && ids.has(String(edge.to))
        ? [
            {
              from: String(edge.from),
              to: String(edge.to),
              ...(edge.port === "true" || edge.port === "false" ? { port: edge.port } : {}),
            },
          ]
        : [],
  );
  const trigger = nodes.find((node) => isObject(node) && node.kind === "trigger") as
    | Row
    | undefined;
  const when = isObject(trigger?.trigger) ? trigger.trigger : {};
  return {
    id,
    name: text(value.name) ?? id,
    version,
    trigger:
      when.type === "schedule" && text(when.cron) && text(when.timezone)
        ? {
            type: "schedule",
            cron: String(when.cron),
            timezone: String(when.timezone),
            ...(text(when.at) ? { at: String(when.at) } : {}),
          }
        : { type: "manual" },
    paused,
    steps,
    edges,
    runs,
  };
}

export function workflowHandlers(client: Client): Record<string, (input: unknown) => unknown> {
  return {
    [C.workflowsList]: async (): Promise<WorkflowItem[]> => {
      const agents = new Map(
        client.rows("agent").map((row) => [String(row.id), String(row.name ?? row.id)]),
      );
      const settings = new Map(
        client.rows("settings").map((row) => [String(row.key), row.value] as const),
      );
      const [workflows, runs] = (await Promise.all([
        client.call("workflow.list", {}),
        client.call("workflow.runs", {}),
      ])) as [{ items?: unknown[] }, { items?: unknown[] }];
      const byWorkflow = new Map<string, WorkflowRunItem[]>();
      for (const row of runs.items ?? []) {
        if (!isObject(row)) continue;
        const parsed = run(row);
        const list = byWorkflow.get(String(row.workflowId)) ?? [];
        if (parsed && list.length < 10) byWorkflow.set(String(row.workflowId), [...list, parsed]);
      }
      return (workflows.items ?? []).flatMap((row) => {
        const id = isObject(row) ? String(row.workflowId) : "";
        const parsed = parseWorkflow(
          row,
          agents,
          settings.get(`workflow.paused.${id}`) === true,
          byWorkflow.get(id) ?? [],
        );
        return parsed ? [parsed] : [];
      });
    },
    [C.workflowsRun]: async (input) => {
      try {
        await client.call("workflow.run", { id: requireId(input, "id"), inputs: {} }, randomUUID());
      } catch (error) {
        throw failure(error, "Couldn't start it. Try again.");
      }
    },
    [C.workflowsSetPaused]: async (input) => {
      if (!isObject(input) || typeof input.paused !== "boolean")
        throw new Error("Invalid request.");
      try {
        await client.call(
          input.paused ? "workflow.pause" : "workflow.resume",
          { id: requireId(input.id, "id") },
          randomUUID(),
        );
      } catch (error) {
        throw failure(error, "Couldn't change it. Try again.");
      }
    },
    [C.workflowsAgents]: async (): Promise<WorkflowAgent[]> =>
      client
        .rows("agent")
        .filter((row) => typeof row.id === "string" && row.archived !== true)
        .map((row) => ({ id: String(row.id), name: String(row.name ?? row.id) }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [C.workflowsEdit]: async (input): Promise<{ stepId?: string }> => {
      if (!isObject(input) || !isObject(input.edit) || typeof input.version !== "number")
        throw new Error("Invalid request.");
      const id = requireId(input.id, "id");
      try {
        const list = (await client.call("workflow.list", {})) as { items?: unknown[] };
        const current = (list.items ?? []).find(
          (row): row is Row => isObject(row) && row.workflowId === id,
        );
        if (!current) throw new Error("workflow_step_missing");
        if (current.version !== input.version) throw new Error("workflow_changed");
        const { value, stepId } = applyWorkflowEdit(current, input.edit as WorkflowEdit);
        await client.call(
          "workflow.publish",
          { value, confirmed: true, baseVersion: input.version },
          randomUUID(),
        );
        return stepId ? { stepId } : {};
      } catch (error) {
        throw failure(error, "Couldn't save it. Try again.");
      }
    },
    [C.workflowsDecide]: async (input) => {
      if (!isObject(input) || (input.decision !== "continue" && input.decision !== "stop"))
        throw new Error("Invalid request.");
      try {
        await client.call(
          "workflow.decide",
          {
            id: requireId(input.runId, "runId"),
            stepId: requireId(input.stepId, "stepId"),
            decision: input.decision,
          },
          randomUUID(),
        );
      } catch (error) {
        throw failure(error, "Couldn't answer it. Try again.");
      }
    },
  };
}
