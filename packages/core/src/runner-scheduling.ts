import {
  DEFAULT_TASK_RUNNING_LIMIT,
  TASK_RUNNING_LIMIT_SETTING,
  type Task,
} from "@zoltbot/protocol";

export function queuedTasks<T extends Pick<Task, "id" | "state" | "createdAt">>(
  tasks: readonly T[],
): T[] {
  return tasks
    .filter((task) => task.state === "queued")
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}
/**
 * The employee a task belongs to, for the running-task limit. An employee is the profile that
 * executes the task (`ownerAgentId`, the agent record behind its chat) within the task's project:
 * every task chat a profile runs in one project counts toward that one employee, and the same
 * profile in another project is a different employee. A task without an owner profile has no
 * employee, so no limit applies to it.
 */
export function taskEmployee(task: Pick<Task, "projectId" | "ownerAgentId">): string | undefined {
  return task.ownerAgentId ? `${task.projectId ?? ""}/${task.ownerAgentId}` : undefined;
}
/** How many tasks one employee may run at once: the setting when valid, else the default. */
export function taskRunningLimit(
  settings: readonly { key?: unknown; value?: unknown }[] | undefined,
): number {
  const value = settings?.find((row) => row.key === TASK_RUNNING_LIMIT_SETTING)?.value;
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 20
    ? value
    : DEFAULT_TASK_RUNNING_LIMIT;
}
/** Tasks each employee is running now. A blocked task still holds its employee's slot. */
export function runningByEmployee(
  tasks: readonly Pick<Task, "state" | "projectId" | "ownerAgentId">[],
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const task of tasks) {
    const employee = taskEmployee(task);
    if (employee && (task.state === "running" || task.state === "blocked"))
      counts.set(employee, (counts.get(employee) ?? 0) + 1);
  }
  return counts;
}
export const runnerHeartbeatMs = 15_000;
export const runnerOfflineMs = 60_000;
export interface RunnerLease {
  taskId: string;
  runnerId: string;
  leaseId: string;
  assignedAt: number;
  heartbeatAt: number;
  wakeRequestedAt?: number;
}
/** Offline is a presence state, never authority to start another native writer. */
export function assignRunnerLease(
  existing: RunnerLease | undefined,
  next: RunnerLease,
): RunnerLease {
  if (existing) {
    if (
      existing.taskId === next.taskId &&
      existing.runnerId === next.runnerId &&
      existing.leaseId === next.leaseId
    )
      return { ...existing };
    throw new Error("runner_lease_conflict");
  }
  return { ...next };
}
export function runnerOffline(lease: RunnerLease, now: number): boolean {
  return now - lease.heartbeatAt >= runnerOfflineMs;
}
export function heartbeatRunnerLease(
  lease: RunnerLease,
  runnerId: string,
  leaseId: string,
  now: number,
): RunnerLease {
  if (lease.runnerId !== runnerId || lease.leaseId !== leaseId)
    throw new Error("runner_lease_mismatch");
  const { wakeRequestedAt: _wake, ...rest } = lease;
  return { ...rest, heartbeatAt: Math.max(lease.heartbeatAt, now) };
}
/** The caller persists the returned lease before making the wake request. */
export function requestRunnerWake(
  lease: RunnerLease,
  location: "mac" | "sandbox",
  now: number,
): RunnerLease | undefined {
  if (location !== "sandbox" || !runnerOffline(lease, now) || lease.wakeRequestedAt !== undefined)
    return undefined;
  return { ...lease, wakeRequestedAt: now };
}
