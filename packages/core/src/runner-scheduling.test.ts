import { expect, it } from "vitest";
import {
  assignRunnerLease,
  heartbeatRunnerLease,
  queuedTasks,
  type RunnerLease,
  requestRunnerWake,
  runnerOffline,
  runnerOfflineMs,
} from "./runner-scheduling.js";

it("keeps queue order by creation time then id without mutating the task collection", () => {
  const tasks = [
    { id: "b", state: "queued" as const, createdAt: "2026-11-11T00:00:00Z" },
    { id: "running", state: "running" as const, createdAt: "2026-11-10T00:00:00Z" },
    { id: "a", state: "queued" as const, createdAt: "2026-11-11T00:00:00Z" },
    { id: "old", state: "queued" as const, createdAt: "2026-11-10T00:00:00Z" },
  ];
  expect(queuedTasks(tasks).map((task) => task.id)).toEqual(["old", "a", "b"]);
  expect(tasks.map((task) => task.id)).toEqual(["b", "running", "a", "old"]);
});
const lease: RunnerLease = {
  taskId: "task",
  runnerId: "runner",
  leaseId: "lease",
  assignedAt: 0,
  heartbeatAt: 0,
};
it("does not reassign an offline native session and fences stale heartbeats", () => {
  expect(assignRunnerLease(undefined, lease)).toEqual(lease);
  expect(assignRunnerLease(lease, { ...lease, assignedAt: 10 })).toEqual(lease);
  expect(runnerOffline(lease, runnerOfflineMs - 1)).toBe(false);
  expect(runnerOffline(lease, runnerOfflineMs)).toBe(true);
  expect(() => assignRunnerLease(lease, { ...lease, runnerId: "other" })).toThrow(
    "runner_lease_conflict",
  );
  expect(() => heartbeatRunnerLease(lease, "other", "lease", 10)).toThrow("runner_lease_mismatch");
  expect(() => heartbeatRunnerLease(lease, "runner", "old", 10)).toThrow("runner_lease_mismatch");
});
it("requests one sandbox wake, waits for a matching heartbeat, and never wakes a Mac", () => {
  expect(requestRunnerWake(lease, "mac", runnerOfflineMs)).toBeUndefined();
  expect(requestRunnerWake(lease, "sandbox", 1)).toBeUndefined();
  const waking = requestRunnerWake(lease, "sandbox", runnerOfflineMs);
  expect(waking?.wakeRequestedAt).toBe(runnerOfflineMs);
  expect(requestRunnerWake(waking as RunnerLease, "sandbox", 2 * runnerOfflineMs)).toBeUndefined();
  const awake = heartbeatRunnerLease(waking as RunnerLease, "runner", "lease", 2 * runnerOfflineMs);
  expect(awake.wakeRequestedAt).toBeUndefined();
  expect(runnerOffline(awake, 2 * runnerOfflineMs)).toBe(false);
  expect(heartbeatRunnerLease(awake, "runner", "lease", 1).heartbeatAt).toBe(2 * runnerOfflineMs);
});
