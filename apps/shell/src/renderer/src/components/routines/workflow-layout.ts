// R7: where each step sits on the workflow canvas. Steps go in columns by how far they are from
// the trigger, unless the workflow saved a position; keyboard moves follow the edges.
import type { WorkflowEdge, WorkflowStep } from "../../../../shared/workflows";

export const STEP_WIDTH = 200;
export const STEP_HEIGHT = 88;
const COLUMN_GAP = 64;
const ROW_GAP = 24;

export interface Placed {
  step: WorkflowStep;
  x: number;
  y: number;
}

/** Steps in an order where each comes after every step that feeds it, then placed in columns. */
export function layoutWorkflow(steps: WorkflowStep[], edges: WorkflowEdge[]) {
  const depth = new Map<string, number>();
  const order: WorkflowStep[] = [];
  const incoming = new Map(steps.map((step) => [step.id, 0]));
  for (const edge of edges) incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1);
  const ready = steps.filter((step) => incoming.get(step.id) === 0);
  for (const step of ready) depth.set(step.id, 0);
  const byId = new Map(steps.map((step) => [step.id, step]));
  while (ready.length) {
    const step = ready.shift() as WorkflowStep;
    order.push(step);
    for (const edge of edges) {
      if (edge.from !== step.id) continue;
      depth.set(edge.to, Math.max(depth.get(edge.to) ?? 0, (depth.get(step.id) ?? 0) + 1));
      const left = (incoming.get(edge.to) ?? 0) - 1;
      incoming.set(edge.to, left);
      const next = byId.get(edge.to);
      if (left === 0 && next) ready.push(next);
    }
  }
  // A cycle can't be published, but anything left over still gets a place.
  for (const step of steps) if (!order.includes(step)) order.push(step);
  const rows = new Map<number, number>();
  const placed: Placed[] = order.map((step) => {
    const column = depth.get(step.id) ?? 0;
    const row = rows.get(column) ?? 0;
    rows.set(column, row + 1);
    return {
      step,
      x: step.x ?? column * (STEP_WIDTH + COLUMN_GAP),
      y: step.y ?? row * (STEP_HEIGHT + ROW_GAP),
    };
  });
  const width = Math.max(0, ...placed.map((entry) => entry.x)) + STEP_WIDTH;
  const height = Math.max(0, ...placed.map((entry) => entry.y)) + STEP_HEIGHT;
  return { placed, width, height };
}

/** A curve from the right side of one step to the left side of the next. */
export function edgePath(from: Placed, to: Placed): string {
  const x1 = from.x + STEP_WIDTH;
  const y1 = from.y + STEP_HEIGHT / 2;
  const x2 = to.x;
  const y2 = to.y + STEP_HEIGHT / 2;
  const bend = Math.max(24, (x2 - x1) / 2);
  return `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`;
}

/** The step an arrow key moves to: along an edge for left and right, within the column for up and down. */
export function neighbour(
  placed: Placed[],
  edges: WorkflowEdge[],
  id: string,
  key: "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown",
): string | undefined {
  const here = placed.find((entry) => entry.step.id === id);
  if (!here) return undefined;
  if (key === "ArrowRight" || key === "ArrowLeft") {
    // At a fork, go to the branch nearest in height.
    const ids = edges
      .filter((edge) => (key === "ArrowRight" ? edge.from === id : edge.to === id))
      .map((edge) => (key === "ArrowRight" ? edge.to : edge.from));
    return placed
      .filter((entry) => ids.includes(entry.step.id))
      .sort((a, b) => Math.abs(a.y - here.y) - Math.abs(b.y - here.y))[0]?.step.id;
  }
  const column = placed
    .filter((entry) => entry.x === here.x)
    .sort((a, b) => a.y - b.y)
    .map((entry) => entry.step.id);
  const index = column.indexOf(id);
  return column[key === "ArrowDown" ? index + 1 : index - 1];
}
