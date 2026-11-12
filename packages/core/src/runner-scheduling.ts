import type { Task } from "@zoltbot/protocol";

export function queuedTasks<T extends Pick<Task, "id" | "state" | "createdAt">>(
  tasks: readonly T[],
): T[] {
  return tasks
    .filter((task) => task.state === "queued")
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
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
