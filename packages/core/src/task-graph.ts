import type { DomainState } from "./projectors.js";

export function validateTaskGraph(state: DomainState, candidate: Record<string, unknown>) {
  const rows = [...(state.task ?? []).filter((r) => r.id !== candidate.id), candidate];
  const byId = new Map(rows.map((r) => [String(r.id), r]));
  for (const row of rows) {
    const links = [row.parentId, ...((row.dependencies as string[] | undefined) ?? [])].filter(
      Boolean,
    );
    for (const id of links) {
      const target = byId.get(String(id));
      if (!target || target.projectId !== row.projectId) throw Error("invalid_task_reference");
    }
  }
  const visit = (id: string, path: Set<string>, done: Set<string>) => {
    if (path.has(id)) throw Error("task_cycle");
    if (done.has(id)) return;
    const row = byId.get(id);
    if (!row) return;
    const next = new Set(path).add(id);
    for (const dep of (row.dependencies as string[] | undefined) ?? []) visit(dep, next, done);
    // A parent waits for its children; combine these edges with dependency edges.
    for (const child of rows.filter((r) => r.parentId === id)) visit(String(child.id), next, done);
    done.add(id);
  };
  const done = new Set<string>();
  for (const id of byId.keys()) visit(id, new Set(), done);
  // Detect parent cycles separately, including trees without execution dependencies.
  for (const row of rows) {
    const seen = new Set([row.id]);
    let parent = row.parentId;
    while (parent) {
      if (seen.has(parent)) throw Error("task_parent_cycle");
      seen.add(parent);
      parent = byId.get(String(parent))?.parentId;
    }
  }
}
export function taskReady(state: DomainState, task: Record<string, unknown>): string | undefined {
  if (task.initiativeId) {
    const initiative = state.initiativeRecord?.find((r) => r.id === task.initiativeId);
    if (initiative?.state === "paused") return "Initiative paused";
    if (initiative?.state === "cancelled") return "Initiative cancelled";
  }
  if (task.planned) return "Planned work: awaiting dispatch";
  const dependencies = (task.dependencies as string[] | undefined) ?? [];
  const broken = dependencies.find((id) => {
    const dep = state.task?.find((r) => r.id === id);
    return dep && ["failed", "cancelled"].includes(String(dep.state));
  });
  if (broken) {
    const dep = state.task?.find((r) => r.id === broken);
    return `Blocked by ${String(dep?.state)} dependency: ${broken}`;
  }
  if (dependencies.some((id) => state.task?.find((r) => r.id === id)?.state !== "completed"))
    return "Waiting for accepted dependencies";
  return undefined;
}
export function requireChildrenAccepted(state: DomainState, id: string) {
  if (
    (state.task ?? []).some(
      (r) => r.parentId === id && r.state !== "completed" && r.state !== "cancelled",
    )
  )
    throw Error("incomplete_children: accept or explicitly cancel remaining children");
}
export function taskProgress(state: DomainState, tasks: Record<string, unknown>[]) {
  const allLeaves = tasks.filter((r) => !state.task?.some((c) => c.parentId === r.id));
  const leaves = allLeaves.filter((r) => r.state !== "cancelled");
  return {
    total: leaves.length,
    queued: leaves.filter((r) => r.state === "queued" && !taskReady(state, r) && !r.holdReason)
      .length,
    running: leaves.filter((r) => r.state === "running").length,
    held: leaves.filter((r) => r.state === "queued" && (!!taskReady(state, r) || !!r.holdReason))
      .length,
    awaitingReview: leaves.filter((r) => r.state === "review").length,
    finished: leaves.filter((r) => ["review", "completed"].includes(String(r.state))).length,
    accepted: leaves.filter((r) => r.state === "completed").length,
    blocked: leaves.filter(
      (r) =>
        r.state === "blocked" || !!taskReady(state, r) || (r.state === "queued" && !!r.holdReason),
    ).length,
    failed: leaves.filter((r) => r.state === "failed").length,
    cancelled: allLeaves.filter((r) => r.state === "cancelled").length,
  };
}
