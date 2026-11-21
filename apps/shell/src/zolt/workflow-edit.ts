// R7: one edit to a workflow's graph, applied to the newest version before it is published as
// the next one. The daemon checks the result (order, agents, reviews, budgets) when it publishes.

import { randomBytes } from "node:crypto";
import type { WorkflowEdit, WorkflowStepFields } from "../shared/workflows";
import { isObject } from "./parsers";

type Row = Record<string, unknown>;
interface Edge {
  from: string;
  to: string;
  port?: "true" | "false";
  carry: "summary" | "deliverable" | "none";
}

const NAME_LIMIT = 120;
const BRIEF_LIMIT = 4000;
const VALUE_LIMIT = 200;
const TESTS = new Set(["contains", "equals", "outcome"]);
const OPS = new Set(["update", "add", "remove"]);
const ADD_KINDS = new Set(["agent", "wait", "condition"]);
const text = (value: unknown) => (typeof value === "string" ? value : undefined);

function name(fields: WorkflowStepFields): string {
  const value = text(fields?.name)?.trim() ?? "";
  if (!value || value.length > NAME_LIMIT) throw new Error("workflow_step_name");
  return value;
}

/** The kind-specific fields of a step, checked here so a bad form never reaches publish. */
function fieldsFor(kind: string, fields: WorkflowStepFields, current: Row = {}): Row {
  if (kind === "agent" || kind === "media") {
    const brief = (text(fields.brief) ?? String(current.brief ?? "")).trim();
    const profileId = text(fields.agentId) ?? String(current.profileId ?? "");
    if (!brief || brief.length > BRIEF_LIMIT) throw new Error("workflow_step_brief");
    if (!profileId) throw new Error("profile_unavailable");
    return { brief, profileId };
  }
  if (kind === "wait") {
    const wait = fields.wait;
    if (!wait) return {};
    if ("approval" in wait) return { until: { type: "approval" } };
    const minutes = Number(wait.minutes);
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 43200)
      throw new Error("workflow_wait_minutes");
    return { until: { type: "minutes", minutes } };
  }
  if (kind === "condition") {
    const test = fields.test;
    if (!test) return {};
    const value = text(test.value)?.trim() ?? "";
    if (!TESTS.has(test.kind) || !text(test.from) || !value || value.length > VALUE_LIMIT)
      throw new Error("workflow_condition_test");
    return { from: test.from, test: test.kind, value };
  }
  return {};
}

function edges(graph: Row): Edge[] {
  return (Array.isArray(graph.edges) ? graph.edges : []).filter(isObject).map((edge) => ({
    from: String(edge.from),
    to: String(edge.to),
    ...(edge.port === "true" || edge.port === "false" ? { port: edge.port } : {}),
    carry: edge.carry === "summary" || edge.carry === "deliverable" ? edge.carry : "none",
  }));
}

const same = (a: Edge, b: Edge) => a.from === b.from && a.to === b.to && a.port === b.port;

/** Carry only flows across a removed step when both of its edges carried something. */
const joinedCarry = (before: Edge, after: Edge): Edge["carry"] =>
  before.carry === "none" || after.carry === "none" ? "none" : after.carry;

/** The next version's value, and the step the edit touched (for a removal, the one before it). */
export function applyWorkflowEdit(
  workflow: Row,
  edit: WorkflowEdit,
): { value: Row; stepId?: string } {
  if (!isObject(edit) || !OPS.has(edit.op)) throw new Error("workflow_edit_invalid");
  const graph = isObject(workflow.graph) ? workflow.graph : {};
  const nodes = (Array.isArray(graph.nodes) ? graph.nodes : []).filter(isObject);
  let links = edges(graph);
  const find = (id: string) => {
    const node = nodes.find((entry) => entry.id === id);
    if (!node) throw new Error("workflow_step_missing");
    return node;
  };

  if (edit.op === "update") {
    const node = find(edit.stepId);
    const next = {
      ...node,
      name: name(edit.fields),
      ...fieldsFor(String(node.kind), edit.fields, node),
    };
    return {
      value: {
        ...workflow,
        graph: { nodes: nodes.map((entry) => (entry === node ? next : entry)), edges: links },
      },
      stepId: edit.stepId,
    };
  }

  if (edit.op === "remove") {
    const node = find(edit.stepId);
    if (node.kind === "trigger") throw new Error("workflow_trigger_required");
    const incoming = links.filter((edge) => edge.to === edit.stepId);
    if (node.kind === "condition") {
      // Its No branch would be left with nothing leading to it.
      const yes = new Set(
        links.filter((edge) => edge.from === edit.stepId && edge.port === "true").map((e) => e.to),
      );
      const strays = links.filter(
        (edge) => edge.from === edit.stepId && edge.port === "false" && !yes.has(edge.to),
      );
      if (strays.length) throw new Error("workflow_condition_branches");
    }
    // A removed condition keeps its Yes branch; its No branch goes with it.
    const outgoing = links.filter(
      (edge) => edge.from === edit.stepId && (node.kind !== "condition" || edge.port !== "false"),
    );
    links = links.filter((edge) => edge.from !== edit.stepId && edge.to !== edit.stepId);
    for (const before of incoming)
      for (const after of outgoing) {
        const joined: Edge = {
          from: before.from,
          to: after.to,
          ...(before.port ? { port: before.port } : {}),
          carry: joinedCarry(before, after),
        };
        if (!links.some((edge) => same(edge, joined))) links.push(joined);
      }
    return {
      value: {
        ...workflow,
        graph: { nodes: nodes.filter((entry) => entry !== node), edges: links },
      },
      ...(incoming[0] ? { stepId: incoming[0].from } : {}),
    };
  }

  // add: the new step goes between `after` and whatever followed it on that branch.
  if (!ADD_KINDS.has(edit.kind)) throw new Error("workflow_edit_invalid");
  const after = find(edit.after);
  const port = after.kind === "condition" ? (edit.port ?? "true") : undefined;
  // A fresh id, so older runs' states never attach to a new step.
  const ids = new Set(nodes.map((entry) => String(entry.id)));
  let id = `step-${randomBytes(4).toString("hex")}`;
  while (ids.has(id)) id = `step-${randomBytes(4).toString("hex")}`;
  const node: Row = {
    id,
    kind: edit.kind,
    name: name(edit.fields),
    ...(edit.kind === "agent" ? { gate: "human" } : {}),
    ...(edit.kind === "wait" ? { until: { type: "approval" } } : {}),
    ...(edit.kind === "condition" ? { from: String(after.id), test: "contains", value: "" } : {}),
    ...fieldsFor(edit.kind, edit.fields),
  };
  const moved = links.filter((edge) => edge.from === edit.after && edge.port === port);
  // A condition needs somewhere for both branches to go; both start at what came next.
  if (edit.kind === "condition" && !moved.length) throw new Error("workflow_condition_next");
  const produces = after.kind === "agent" || after.kind === "media";
  links = links.filter((edge) => !moved.includes(edge));
  links.push({
    from: String(after.id),
    to: id,
    ...(port ? { port } : {}),
    carry: produces && edit.kind === "agent" ? "summary" : "none",
  });
  for (const edge of moved) {
    if (edit.kind !== "condition") {
      links.push({ from: id, to: edge.to, carry: edge.carry });
      continue;
    }
    links.push({ from: id, to: edge.to, port: "true", carry: edge.carry });
    links.push({ from: id, to: edge.to, port: "false", carry: edge.carry });
  }
  return { value: { ...workflow, graph: { nodes: [...nodes, node], edges: links } }, stepId: id };
}
