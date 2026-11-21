import { describe, expect, it } from "vitest";
import type { WorkflowEdge, WorkflowStep } from "../../../../shared/workflows";
import { edgePath, layoutWorkflow, neighbour, STEP_HEIGHT, STEP_WIDTH } from "./workflow-layout";

const steps: WorkflowStep[] = [
  { id: "done", kind: "wait", name: "Pause", wait: { minutes: 5 } },
  { id: "start", kind: "trigger", name: "By hand" },
  { id: "read", kind: "agent", name: "Read", agent: "Ada", brief: "Read." },
  {
    id: "big",
    kind: "condition",
    name: "Big?",
    test: { from: "read", kind: "contains", value: "big" },
  },
  { id: "write", kind: "agent", name: "Write", agent: "Ada", brief: "Write." },
];
const edges: WorkflowEdge[] = [
  { from: "start", to: "read" },
  { from: "read", to: "big" },
  { from: "big", to: "write", port: "true" },
  { from: "big", to: "done", port: "false" },
];

describe("R7 workflow layout", () => {
  it("puts steps in columns by distance from the trigger, in graph order", () => {
    const { placed, width, height } = layoutWorkflow(steps, edges);
    expect(placed.map((entry) => entry.step.id)).toEqual(["start", "read", "big", "write", "done"]);
    const at = Object.fromEntries(placed.map((entry) => [entry.step.id, [entry.x, entry.y]]));
    expect(at.start).toEqual([0, 0]);
    expect(at.read?.[0]).toBeGreaterThan(0);
    expect(at.write?.[0]).toBe(at.done?.[0]);
    expect(at.done?.[1]).toBeGreaterThan(at.write?.[1] ?? 0);
    expect(width).toBe((at.write?.[0] ?? 0) + STEP_WIDTH);
    expect(height).toBe((at.done?.[1] ?? 0) + STEP_HEIGHT);
  });

  it("keeps a saved position", () => {
    const { placed } = layoutWorkflow(
      steps.map((step) => (step.id === "read" ? { ...step, x: 500, y: 300 } : step)),
      edges,
    );
    expect(placed.find((entry) => entry.step.id === "read")).toMatchObject({ x: 500, y: 300 });
  });

  it("moves along edges with left and right, and within a column with up and down", () => {
    const { placed } = layoutWorkflow(steps, edges);
    expect(neighbour(placed, edges, "read", "ArrowRight")).toBe("big");
    expect(neighbour(placed, edges, "read", "ArrowLeft")).toBe("start");
    expect(neighbour(placed, edges, "write", "ArrowDown")).toBe("done");
    expect(neighbour(placed, edges, "done", "ArrowUp")).toBe("write");
    expect(neighbour(placed, edges, "done", "ArrowDown")).toBeUndefined();
    // At a fork, right goes to the nearer branch and left comes back.
    expect(neighbour(placed, edges, "big", "ArrowRight")).toBe("write");
    expect(neighbour(placed, edges, "done", "ArrowLeft")).toBe("big");
  });

  it("draws an edge from one step's right side to the next step's left side", () => {
    const { placed } = layoutWorkflow(steps, edges);
    const [start, read] = placed;
    expect(start && read && edgePath(start, read).startsWith(`M ${STEP_WIDTH} `)).toBe(true);
  });
});
