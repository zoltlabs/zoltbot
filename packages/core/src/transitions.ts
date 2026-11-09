export type Machine = "task" | "interaction" | "delivery" | "session" | "turn" | "workspace";
export const transitions: Record<Machine, Record<string, readonly string[]>> = {
  task: {
    queued: ["running", "cancelled"],
    running: ["blocked", "review", "completed", "failed", "cancelled"],
    blocked: ["running", "cancelled"],
    review: ["completed", "queued", "failed", "cancelled"],
    completed: [],
    failed: ["queued"],
    cancelled: [],
  },
  interaction: {
    pending: ["answered", "cancelled", "expired"],
    answered: [],
    cancelled: [],
    expired: [],
  },
  delivery: {
    queued: ["held", "delivering", "failed", "cancelled"],
    held: ["queued", "failed", "cancelled"],
    delivering: ["queued", "delivered", "failed", "cancelled"],
    delivered: [],
    failed: [],
    cancelled: [],
  },
  session: {
    starting: ["ready", "failed", "closed"],
    ready: ["running", "failed", "closed"],
    running: ["ready", "failed", "closed"],
    closed: [],
    failed: [],
  },
  turn: {
    running: ["completed", "failed", "interrupted"],
    completed: [],
    failed: [],
    interrupted: [],
  },
  workspace: { active: ["orphaned", "removed"], orphaned: ["active", "removed"], removed: [] },
};
export function transition(kind: Machine, from: string, to: string): string {
  if (!transitions[kind][from]?.includes(to))
    throw new Error(`invalid_transition: ${kind} ${from} to ${to}`);
  return to;
}
