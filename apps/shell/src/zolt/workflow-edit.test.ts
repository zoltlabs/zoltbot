import { describe, expect, it } from "vitest";
import { applyWorkflowEdit } from "./workflow-edit";

const workflow = {
  workflowId: "digest",
  version: 2,
  graph: {
    nodes: [
      { id: "start", kind: "trigger", name: "By hand", trigger: { type: "manual" } },
      { id: "read", kind: "agent", name: "Read", profileId: "ada", brief: "Read.", gate: "human" },
      { id: "big", kind: "condition", name: "Big?", from: "read", test: "contains", value: "big" },
      {
        id: "write",
        kind: "agent",
        name: "Write",
        profileId: "ada",
        brief: "Write.",
        gate: "human",
      },
      { id: "rest", kind: "wait", name: "Rest", until: { type: "minutes", minutes: 5 } },
    ],
    edges: [
      { from: "start", to: "read", carry: "none" },
      { from: "read", to: "big", carry: "summary" },
      { from: "big", to: "write", port: "true", carry: "summary" },
      { from: "big", to: "rest", port: "false", carry: "none" },
    ],
  },
};
type Graph = { nodes: Record<string, unknown>[]; edges: Record<string, unknown>[] };
const graph = (value: Record<string, unknown>) => value.graph as Graph;

describe("R7 workflow edits", () => {
  it("updates a step's name and kind-specific fields, keeping the rest", () => {
    const { value } = applyWorkflowEdit(workflow, {
      op: "update",
      stepId: "rest",
      fields: { name: "Check with me", wait: { approval: true } },
    });
    expect(graph(value).nodes.find((node) => node.id === "rest")).toEqual({
      id: "rest",
      kind: "wait",
      name: "Check with me",
      until: { type: "approval" },
    });
    expect(value.workflowId).toBe("digest");
  });

  it("adds a step between a step and what followed it", () => {
    const { value, stepId } = applyWorkflowEdit(workflow, {
      op: "add",
      after: "start",
      kind: "wait",
      fields: { name: "Hold", wait: { minutes: 10 } },
    });
    expect(stepId).toMatch(/^step-[0-9a-f]{8}$/);
    expect(graph(value).edges).toContainEqual({ from: "start", to: stepId, carry: "none" });
    expect(graph(value).edges).toContainEqual({ from: stepId, to: "read", carry: "none" });
    expect(graph(value).edges.some((edge) => edge.from === "start" && edge.to === "read")).toBe(
      false,
    );
  });

  it("adds on a condition's chosen branch, and new agent steps wait for review", () => {
    const { value, stepId } = applyWorkflowEdit(workflow, {
      op: "add",
      after: "big",
      port: "false",
      kind: "agent",
      fields: { name: "Shorten", agentId: "ada", brief: "Shorten it." },
    });
    expect(graph(value).nodes.at(-1)).toMatchObject({ kind: "agent", gate: "human" });
    expect(graph(value).edges).toContainEqual({
      from: "big",
      to: stepId,
      port: "false",
      carry: "none",
    });
    expect(graph(value).edges).toContainEqual({ from: stepId, to: "rest", carry: "none" });
  });

  it("removes a step and joins what came before it to what came after", () => {
    const { value, stepId } = applyWorkflowEdit(workflow, { op: "remove", stepId: "read" });
    expect(graph(value).nodes.map((node) => node.id)).not.toContain("read");
    expect(graph(value).edges).toContainEqual({ from: "start", to: "big", carry: "none" });
    expect(stepId).toBe("start");
  });

  it("adds a condition with both branches leading to what came next", () => {
    const { value, stepId } = applyWorkflowEdit(workflow, {
      op: "add",
      after: "read",
      kind: "condition",
      fields: { name: "Long?", test: { from: "read", kind: "contains", value: "long" } },
    });
    const edges = graph(value).edges.filter((edge) => edge.from === stepId);
    expect(edges).toEqual([
      { from: stepId, to: "big", port: "true", carry: "summary" },
      { from: stepId, to: "big", port: "false", carry: "summary" },
    ]);
    expect(() =>
      applyWorkflowEdit(workflow, {
        op: "add",
        after: "write",
        kind: "condition",
        fields: { name: "End?", test: { from: "write", kind: "contains", value: "x" } },
      }),
    ).toThrow("workflow_condition_next");
  });

  it("refuses to drop a condition's No branch, and never widens what a step receives", () => {
    expect(() => applyWorkflowEdit(workflow, { op: "remove", stepId: "big" })).toThrow(
      "workflow_condition_branches",
    );
    // read -> big carries a summary, start -> read carries none: nothing new reaches big.
    const { value } = applyWorkflowEdit(workflow, { op: "remove", stepId: "read" });
    expect(graph(value).edges.find((edge) => edge.to === "big")?.carry).toBe("none");
  });

  it("refuses bad fields, unknown edits and removing the start", () => {
    expect(() =>
      applyWorkflowEdit(workflow, { op: "rename" } as unknown as Parameters<typeof applyWorkflowEdit>[1]),
    ).toThrow("workflow_edit_invalid");
    expect(() => applyWorkflowEdit(workflow, { op: "remove", stepId: "start" })).toThrow(
      "workflow_trigger_required",
    );
    expect(() =>
      applyWorkflowEdit(workflow, { op: "update", stepId: "read", fields: { name: " " } }),
    ).toThrow("workflow_step_name");
    expect(() =>
      applyWorkflowEdit(workflow, {
        op: "update",
        stepId: "rest",
        fields: { name: "Rest", wait: { minutes: 0 } },
      }),
    ).toThrow("workflow_wait_minutes");
    expect(() =>
      applyWorkflowEdit(workflow, { op: "update", stepId: "gone", fields: { name: "x" } }),
    ).toThrow("workflow_step_missing");
  });
});
