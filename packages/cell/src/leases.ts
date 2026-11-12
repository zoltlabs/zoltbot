import type { CellTokenClaims } from "@zoltbot/cloud-contracts";
import {
  assignRunnerLease,
  heartbeatRunnerLease,
  type RunnerLease as LeaseState,
  requestRunnerWake,
  runnerOffline,
} from "@zoltbot/core";
import { parse, TaskSchema } from "@zoltbot/protocol";
import type { Store } from "@zoltbot/store/portable";

export interface LeaseRecord extends LeaseState {
  kind: "mac" | "sandbox";
  lastSeq: number;
  wakePending?: boolean;
  connectionId?: string;
}
/** SQLite owns the lease fence. Neither expiry nor reconnect grants another writer. */
export class CellLeases {
  constructor(private readonly store: Store) {
    store.database.exec(
      "CREATE TABLE IF NOT EXISTS cell_leases(task_id TEXT PRIMARY KEY,runner_id TEXT NOT NULL,lease_id TEXT NOT NULL UNIQUE,body TEXT NOT NULL)",
    );
  }
  get(taskId: string): LeaseRecord | undefined {
    const row = this.store.database
      .prepare("SELECT body FROM cell_leases WHERE task_id=?")
      .get(taskId) as { body: string } | undefined;
    return row ? (JSON.parse(row.body) as LeaseRecord) : undefined;
  }
  all(): LeaseRecord[] {
    return (
      this.store.database.prepare("SELECT body FROM cell_leases ORDER BY task_id").all() as {
        body: string;
      }[]
    ).map((row) => JSON.parse(row.body));
  }
  private save(value: LeaseRecord) {
    this.store.database
      .prepare(
        "INSERT INTO cell_leases(task_id,runner_id,lease_id,body) VALUES(?,?,?,?) ON CONFLICT(task_id) DO UPDATE SET body=excluded.body",
      )
      .run(value.taskId, value.runnerId, value.leaseId, JSON.stringify(value));
  }
  assign(taskId: string, runnerId: string, claims: CellTokenClaims, now = Date.now()): LeaseRecord {
    const task = parse(TaskSchema, this.store.record("task", taskId));
    const kind: LeaseRecord["kind"] = claims.kind === "sandbox_runner" ? "sandbox" : "mac";
    if (
      claims.kind === "client" ||
      claims.device !== runnerId ||
      task.location !== kind ||
      (claims.task && claims.task !== taskId) ||
      task.createdBy.id !== claims.sub
    )
      throw new Error("forbidden");
    const current = this.get(taskId);
    const next: LeaseRecord = {
      taskId,
      runnerId,
      leaseId: current?.leaseId ?? crypto.randomUUID(),
      kind,
      lastSeq: current?.lastSeq ?? 0,
      assignedAt: now,
      heartbeatAt: now,
    };
    const checked = assignRunnerLease(current, next);
    const result = { ...checked, kind, lastSeq: next.lastSeq };
    this.save(result);
    return result;
  }
  require(taskId: string, leaseId: string, runnerId: string, claims: CellTokenClaims): LeaseRecord {
    const lease = this.get(taskId);
    if (
      !lease ||
      lease.leaseId !== leaseId ||
      lease.runnerId !== runnerId ||
      claims.device !== runnerId ||
      claims.kind === "client" ||
      (claims.task && claims.task !== taskId) ||
      lease.kind !== (claims.kind === "sandbox_runner" ? "sandbox" : "mac")
    )
      throw new Error("forbidden");
    return lease;
  }
  heartbeat(
    runnerId: string,
    leaseIds: readonly string[],
    claims: CellTokenClaims,
    now = Date.now(),
    connectionId?: string,
  ) {
    for (const lease of this.all().filter((lease) => lease.runnerId === runnerId)) {
      if (!leaseIds.includes(lease.leaseId)) {
        if (connectionId && lease.connectionId === connectionId) {
          const { connectionId: _connection, ...inactive } = lease;
          this.save(inactive);
        }
        continue;
      }
      this.require(lease.taskId, lease.leaseId, runnerId, claims);
      const { wakePending: _pending, ...current } = lease;
      this.save({
        ...heartbeatRunnerLease(current, runnerId, lease.leaseId, now),
        kind: lease.kind,
        lastSeq: lease.lastSeq,
        ...(connectionId ? { connectionId } : {}),
      });
    }
  }
  /** Called inside the same transaction as event dispatch and its receipt. */
  acknowledge(lease: LeaseRecord, runnerSeq: number) {
    const current = this.get(lease.taskId);
    if (!current || current.leaseId !== lease.leaseId || runnerSeq !== current.lastSeq + 1)
      throw new Error("runner_sequence_gap");
    this.save({ ...current, lastSeq: runnerSeq });
  }
  async checkPresence(
    wake: (taskId: string, operationId: string) => Promise<void>,
    now = Date.now(),
    sleeping: (taskId: string) => boolean = () => false,
  ) {
    let retry = false;
    for (const lease of this.all()) {
      if (!["running", "queued"].includes(String(this.store.record("task", lease.taskId)?.state)))
        continue;
      if (lease.kind === "sandbox" && sleeping(lease.taskId)) continue;
      const next = requestRunnerWake(lease, lease.kind, now);
      if (next || lease.wakePending) {
        const pending = { ...lease, ...next, wakePending: true };
        this.save(pending);
        try {
          await wake(lease.taskId, `wake:${lease.leaseId}:${lease.heartbeatAt}`);
        } catch {
          retry = true;
          continue;
        }
        // Do not overwrite a concurrent heartbeat while the network request was in flight.
        const current = this.get(lease.taskId);
        if (current?.heartbeatAt === lease.heartbeatAt)
          this.save({ ...current, wakePending: false });
      }
    }
    return retry;
  }
  offline(taskId: string, now = Date.now()) {
    const lease = this.get(taskId);
    return !!lease && runnerOffline(lease, now);
  }
}
