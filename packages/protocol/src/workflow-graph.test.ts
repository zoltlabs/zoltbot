import { describe, expect, it } from "vitest";
import { parse } from "./index.js";
import {
  type WorkflowGraph,
  WorkflowGraphSchema,
  workflowGraphProblems,
  workflowOrder,
} from "./workflow-graph.js";

const agent = (id: string) => ({
  id,
  kind: "agent" as const,
  name: `Step ${id}`,
  profileId: "profile",
  brief: "Summarize what changed.",
  gate: "none" as const,
});

/** Trigger → research → condition → (true) post, (false) wait. */
function graph(): WorkflowGraph {
  return {
    nodes: [
      {
        id: "start",
        kind: "trigger",
        name: "Every morning",
        trigger: { type: "schedule", cron: "0 9 * * *", timezone: "UTC" },
      },
      agent("research"),
      {
        id: "check",
        kind: "condition",
        name: "Anything new?",
        from: "research",
        test: "contains",
        value: "new",
      },
      {
        id: "post",
        kind: "connection",
        name: "Post to Slack",
        connectionId: "slack",
        action: "post_message",
        input: { channel: "news" },
      },
      { id: "later", kind: "wait", name: "Wait an hour", until: { type: "minutes", minutes: 60 } },
    ],
    edges: [
      { from: "start", to: "research", carry: "none" },
      { from: "research", to: "check", carry: "summary" },
      { from: "check", to: "post", port: "true", carry: "summary" },
      { from: "check", to: "later", port: "false", carry: "none" },
    ],
  };
}

describe("R7 workflow graphs", () => {
  it("accepts a graph with one trigger, both branches and every step reachable", () => {
    const value = parse(WorkflowGraphSchema, graph());
    expect(workflowGraphProblems(value)).toEqual([]);
    const order = workflowOrder(value);
    expect(order?.[0]).toBe("start");
    expect(order?.indexOf("research")).toBeLessThan(order?.indexOf("check") ?? -1);
  });

  it("names every reason a graph can't be published", () => {
    const cyclic = graph();
    cyclic.edges.push({ from: "post", to: "research", carry: "summary" });
    expect(workflowGraphProblems(cyclic)).toContain("cycle");
    expect(workflowOrder(cyclic)).toBeUndefined();

    const twoTriggers = graph();
    twoTriggers.nodes.push({
      id: "again",
      kind: "trigger",
      name: "By hand",
      trigger: { type: "manual" },
    });
    expect(workflowGraphProblems(twoTriggers)).toEqual(
      expect.arrayContaining(["one_trigger_required"]),
    );

    const oneBranch = graph();
    oneBranch.edges = oneBranch.edges.filter((edge) => edge.port !== "false");
    expect(workflowGraphProblems(oneBranch)).toEqual(
      expect.arrayContaining(["branch_missing", "unreachable_step"]),
    );

    const loose = graph();
    loose.edges.push({ from: "research", to: "post", port: "true", carry: "none" });
    loose.edges.push({ from: "research", to: "ghost", carry: "none" });
    expect(workflowGraphProblems(loose)).toEqual(
      expect.arrayContaining(["branch_mismatch", "edge_to_missing_step"]),
    );

    const backwards = graph();
    const check = backwards.nodes.find((node) => node.id === "check");
    if (check?.kind === "condition") check.from = "post";
    expect(workflowGraphProblems(backwards)).toContain("condition_source_not_upstream");

    const intoTrigger = graph();
    intoTrigger.edges.push({ from: "later", to: "start", carry: "none" });
    expect(workflowGraphProblems(intoTrigger)).toContain("trigger_has_input");
  });

  it("caps steps and the brief text a step carries", () => {
    const many = { nodes: Array.from({ length: 51 }, (_, index) => agent(`n${index}`)), edges: [] };
    expect(() => parse(WorkflowGraphSchema, many)).toThrow();
    const long = graph();
    long.nodes[1] = { ...agent("research"), brief: "x".repeat(4001) };
    expect(() => parse(WorkflowGraphSchema, long)).toThrow();
  });
});
