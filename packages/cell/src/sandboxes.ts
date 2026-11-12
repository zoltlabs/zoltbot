import {
  SandboxCreateSchema,
  SandboxOperationSchema,
  type SandboxRecord,
  SandboxRecordSchema,
} from "@zoltbot/cloud-contracts";
import { applyEvents, handle, holdTask, resumeTask } from "@zoltbot/core";
import { ProjectSchema, parse, type Task, TaskSchema } from "@zoltbot/protocol";
import type { Store } from "@zoltbot/store/portable";
import type { CellService } from "./service.js";

type Operation = "create" | "wake" | "sleep" | "destroy";
interface PendingOperation {
  id: string;
  task_id: string;
  operation: Operation;
  body: string;
}
/** Durable effect requests contain references/configuration, never injected credentials. */
export class CellSandboxes {
  constructor(
    private readonly store: Store,
    private readonly service: Pick<CellService, "request">,
    private readonly orgId: string,
    private readonly userId: string,
    private readonly now: () => number = () => Date.now(),
    private readonly isActive: () => boolean = () => true,
    private readonly pendingWork: (taskId: string) => boolean = () => false,
  ) {
    store.database.exec(
      "CREATE TABLE IF NOT EXISTS cell_sandbox_maintenance(id INTEGER PRIMARY KEY CHECK(id=1),cursor TEXT NOT NULL,next_at INTEGER); CREATE TABLE IF NOT EXISTS cell_sandboxes(task_id TEXT PRIMARY KEY,body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS cell_sandbox_operations(id TEXT PRIMARY KEY,task_id TEXT NOT NULL,operation TEXT NOT NULL,body TEXT NOT NULL,state TEXT NOT NULL,error_code TEXT,result TEXT); CREATE UNIQUE INDEX IF NOT EXISTS cell_sandbox_pending ON cell_sandbox_operations(task_id) WHERE state='pending'",
    );
  }
  get(taskId: string): SandboxRecord | undefined {
    const row = this.store.database
      .prepare("SELECT body FROM cell_sandboxes WHERE task_id=?")
      .get(taskId) as { body: string } | undefined;
    return row ? parse(SandboxRecordSchema, JSON.parse(row.body)) : undefined;
  }
  private task(taskId: string): Task {
    const task = parse(TaskSchema, this.store.record("task", taskId));
    if (task.location !== "sandbox" || task.createdBy.id !== this.userId)
      throw new Error("forbidden");
    return task;
  }
  private hold(taskId: string, reason: string | undefined) {
    const task = this.task(taskId);
    if (task.state !== "queued" || task.holdReason === reason) return;
    const commandId = `sandbox-hold:${crypto.randomUUID()}`;
    this.store.dispatch(
      commandId,
      (state) =>
        holdTask(state, taskId, reason, {
          commandId,
          at: new Date(this.now()).toISOString(),
          actor: { kind: "system", id: "cell" },
        }),
      { scope: { taskId }, kinds: ["task"] },
    );
  }
  private pending(taskId: string) {
    return this.store.database
      .prepare(
        "SELECT id,task_id,operation,body FROM cell_sandbox_operations WHERE task_id=? AND state='pending'",
      )
      .get(taskId) as PendingOperation | undefined;
  }
  private enqueue(taskId: string, operation: Operation): PendingOperation {
    const previous = this.pending(taskId);
    if (previous) return previous;
    const task = this.task(taskId);
    let body: unknown;
    if (operation === "create") {
      const project = parse(ProjectSchema, this.store.record("project", String(task.projectId)));
      const profile = this.store.record("agent", String(task.ownerAgentId));
      if (!project.cloud) throw new Error("forbidden");
      body = parse(SandboxCreateSchema, {
        orgId: this.orgId,
        userId: this.userId,
        projectId: project.id,
        taskId: task.id,
        ...project.cloud,
        provider: profile?.definitionId,
      });
    } else {
      const sandbox = this.get(taskId);
      if (!sandbox) throw new Error("sandbox_unavailable");
      body = parse(SandboxOperationSchema, {
        orgId: this.orgId,
        taskId,
        sandboxId: sandbox.sandboxId,
      });
    }
    const op = {
      id: `sandbox:${crypto.randomUUID()}`,
      task_id: taskId,
      operation,
      body: JSON.stringify(body),
    };
    this.store.database
      .prepare(
        "INSERT INTO cell_sandbox_operations(id,task_id,operation,body,state) VALUES(?,?,?,?,'pending')",
      )
      .run(op.id, taskId, operation, op.body);
    return op;
  }
  private async apply(op: PendingOperation): Promise<SandboxRecord | undefined> {
    if (!this.isActive()) throw new Error("unauthorized");
    try {
      const path =
        op.operation === "create" || op.operation === "destroy"
          ? "sandboxes"
          : `sandboxes/${op.operation}`;
      const result = parse(
        SandboxRecordSchema,
        await this.service.request(
          path,
          op.operation === "destroy" ? "DELETE" : "POST",
          JSON.parse(op.body),
          { operationId: op.id, timeoutMs: 30000 },
        ),
      );
      if (!this.isActive()) throw new Error("unauthorized");
      if (
        result.orgId !== this.orgId ||
        result.userId !== this.userId ||
        result.taskId !== op.task_id ||
        result.state !==
          (op.operation === "sleep"
            ? "sleeping"
            : op.operation === "destroy"
              ? "destroyed"
              : "running")
      )
        throw new Error("forbidden");
      const commandId = `sandbox-effect:${op.id}`;
      this.store.dispatch(
        commandId,
        (initial) => {
          // An older response must not rewind a later completed lifecycle operation.
          if (this.pending(op.task_id)?.id !== op.id) return { events: [], result: null };
          this.store.database
            .prepare(
              "INSERT INTO cell_sandboxes(task_id,body) VALUES(?,?) ON CONFLICT(task_id) DO UPDATE SET body=excluded.body",
            )
            .run(op.task_id, JSON.stringify(result));
          this.store.database
            .prepare(
              "UPDATE cell_sandbox_operations SET state='complete',error_code=NULL,result=? WHERE id=?",
            )
            .run(JSON.stringify(result), op.id);
          const context = {
            commandId,
            at: new Date(this.now()).toISOString(),
            actor: { kind: "system" as const, id: "cell" },
          };
          let state = initial;
          const task = this.task(op.task_id);
          const held =
            task.state === "queued"
              ? holdTask(state, task.id, undefined, context)
              : { events: [], result: task };
          state = applyEvents(state, held.events);
          if (
            result.state === "running" &&
            op.operation === "wake" &&
            task.state === "blocked" &&
            task.holdReason === "daemon_restarted"
          ) {
            const latest = this.store.database
              .prepare(
                "SELECT id,seq,kind FROM item_records WHERE thread_id=? ORDER BY seq DESC LIMIT 1",
              )
              .get(String(task.threadId)) as { id: string; seq: number; kind: string } | undefined;
            if (latest) state.item = [{ ...latest, threadId: task.threadId, body: {} }];
            const resumed = resumeTask(state, task.id, commandId, context);
            return { events: [...held.events, ...resumed.events], result: null };
          }
          return { events: held.events, result: null };
        },
        { scope: { taskId: op.task_id }, kinds: ["task", "thread", "session", "turn"] },
      );
      const current = this.get(op.task_id);
      return current;
    } catch (error) {
      if (!this.isActive()) throw new Error("unauthorized");
      const code =
        error instanceof Error && error.message === "limit_reached"
          ? "limit_reached"
          : "orchestrator_unavailable";
      this.store.database
        .prepare("UPDATE cell_sandbox_operations SET error_code=? WHERE id=? AND state='pending'")
        .run(code, op.id);
      this.hold(op.task_id, code);
      return undefined;
    }
  }
  async ensure(taskId: string): Promise<SandboxRecord | undefined> {
    const task = this.task(taskId);
    const pending = this.pending(taskId);
    if (pending) return this.apply(pending);
    const current = this.get(taskId);
    if (!current) {
      this.hold(taskId, "sandbox_starting");
      return this.apply(this.enqueue(taskId, "create"));
    }
    if (current.state === "sleeping") return this.apply(this.enqueue(taskId, "wake"));
    if (current.state === "destroyed") throw new Error("sandbox_destroyed");
    if (task.state === "queued") this.hold(taskId, undefined);
    return current;
  }
  async wake(taskId: string, operationId?: string): Promise<void> {
    const current = this.get(taskId);
    if (!current || current.state === "destroyed") throw new Error("sandbox_unavailable");
    // A logical wake retries its saved operation ID, including after an uncertain response.
    let op = this.pending(taskId);
    if (!op) {
      if (
        operationId &&
        this.store.database
          .prepare("SELECT id FROM cell_sandbox_operations WHERE id=? AND state='complete'")
          .get(operationId)
      )
        return;
      op = this.enqueue(taskId, "wake");
      if (operationId) {
        this.store.database
          .prepare("UPDATE cell_sandbox_operations SET id=? WHERE id=?")
          .run(operationId, op.id);
        op = { ...op, id: operationId };
      }
    }
    if (!(await this.apply(op))) throw new Error("orchestrator_unavailable");
  }
  private active(task: Task) {
    if (!task.threadId) return { turn: false, pending: false, at: Date.parse(task.updatedAt) };
    const turn = this.store.database
      .prepare("SELECT id FROM turns WHERE thread_id=? AND status='running' LIMIT 1")
      .get(task.threadId);
    const pending = this.store.database
      .prepare(
        "SELECT max(created_at) AS at FROM interactions WHERE thread_id=? AND state='pending'",
      )
      .get(task.threadId) as { at: string | null };
    const item = this.store.database
      .prepare("SELECT max(updated_at) AS at FROM item_records WHERE thread_id=?")
      .get(task.threadId) as { at: string | null };
    return {
      turn: !!turn,
      pending: !!pending.at,
      at: Math.max(
        Date.parse(task.updatedAt),
        pending.at ? Date.parse(pending.at) : 0,
        item.at ? Date.parse(item.at) : 0,
      ),
    };
  }
  /** Returns the next useful maintenance time rather than keeping sleeping orgs awake. */
  async tick(checkpoint: (taskId: string) => Promise<void>): Promise<number | undefined> {
    const now = this.now();
    const sweep = this.store.database
      .prepare("SELECT cursor,next_at FROM cell_sandbox_maintenance WHERE id=1")
      .get() as { cursor: string; next_at: number | null } | undefined;
    let next: number | undefined = sweep?.next_at ?? undefined;
    const schedule = (at: number) => {
      next = next === undefined ? at : Math.min(next, at);
    };
    // Bound metadata and network effects even when an org has many retained sandboxes.
    const records = this.store.database
      .prepare(
        "SELECT id AS task_id FROM tasks WHERE execution_location='sandbox' AND id>? AND (state='queued' OR EXISTS(SELECT 1 FROM cell_sandboxes WHERE task_id=tasks.id) OR EXISTS(SELECT 1 FROM cell_sandbox_operations WHERE task_id=tasks.id AND state='pending')) ORDER BY id LIMIT 9",
      )
      .all(sweep?.cursor ?? "") as { task_id: string }[];
    for (const row of records.slice(0, 8)) {
      if (!this.isActive()) throw new Error("unauthorized");
      const pending = this.pending(row.task_id);
      if (pending) await this.apply(pending);
      if (this.pending(row.task_id)) {
        schedule(now + 15000);
        continue;
      }
      if (this.task(row.task_id).state === "queued") {
        await this.ensure(row.task_id);
        schedule(now + 15000);
      }
      const sandbox = this.get(row.task_id);
      if (!sandbox || sandbox.state === "destroyed") continue;
      const task = this.task(row.task_id);
      if (["completed", "cancelled", "failed"].includes(task.state)) {
        const destroyAt = Date.parse(task.updatedAt) + 86400000;
        if (now >= destroyAt) {
          const destroyed = await this.apply(this.enqueue(task.id, "destroy"));
          if (destroyed?.state !== "destroyed") schedule(now + 15000);
          continue;
        }
        schedule(destroyAt);
      }
      if (this.pending(task.id)) {
        schedule(now + 15000);
        continue;
      }
      const active = this.active(task);
      const queuedInput =
        task.threadId &&
        this.store.database
          .prepare(
            "SELECT id FROM items WHERE thread_id=? AND kind='user' AND json_extract(body,'$.queueState')='queued' LIMIT 1",
          )
          .get(task.threadId);
      if (sandbox.state === "sleeping") {
        if (
          task.state === "queued" ||
          (["running", "blocked"].includes(task.state) && queuedInput) ||
          (task.state === "blocked" && task.holdReason === "daemon_restarted") ||
          (["running", "review", "blocked"].includes(task.state) && this.pendingWork(task.id))
        ) {
          await this.ensure(task.id);
          schedule(now + 15000);
        }
        continue;
      }
      if (sandbox.state !== "running") {
        schedule(now + 15000);
        continue;
      }
      const expiry = sandbox.expiresAt ? Date.parse(sandbox.expiresAt) - 60000 : undefined;
      const idleAt = active.at + (active.pending ? 1800000 : 1200000);
      const lifetime = expiry !== undefined && now >= expiry;
      const idle =
        task.state !== "queued" &&
        !this.pendingWork(task.id) &&
        now >= idleAt &&
        (!active.turn || (active.pending && sandbox.sleepKeepsProcesses));
      if (lifetime && active.turn && !(active.pending && sandbox.sleepKeepsProcesses)) {
        await checkpoint(task.id);
        schedule(now + 15000);
        continue;
      }
      if (lifetime || idle) {
        const sleeping = await this.apply(this.enqueue(task.id, "sleep"));
        if (!sleeping) schedule(now + 15000);
        if (sleeping && lifetime && ["running", "queued", "blocked"].includes(task.state)) {
          const awakened = await this.ensure(task.id);
          if (!awakened) {
            schedule(now + 15000);
            continue;
          }
          schedule(now + 15000);
        }
      } else {
        if (!active.turn || active.pending) schedule(idleAt);
        if (expiry !== undefined) schedule(expiry);
      }
    }
    if (!this.isActive()) throw new Error("unauthorized");
    if (records.length > 8) {
      this.store.database
        .prepare(
          "INSERT INTO cell_sandbox_maintenance VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET cursor=excluded.cursor,next_at=excluded.next_at",
        )
        .run(records[7]?.task_id, next ?? null);
      return now + 1;
    }
    this.store.database.prepare("DELETE FROM cell_sandbox_maintenance WHERE id=1").run();
    return next;
  }
  checkpoint(taskId: string, effect?: () => void) {
    const task = this.task(taskId);
    if (task.state !== "running") return;
    const commandId = `sandbox-checkpoint:${crypto.randomUUID()}`;
    this.store.dispatch(
      commandId,
      (state) => {
        effect?.();
        return handle(
          state,
          {
            type: "transition",
            kind: "task",
            id: taskId,
            revision: task.revision,
            to: "blocked",
            reason: "daemon_restarted",
          },
          {
            commandId,
            at: new Date(this.now()).toISOString(),
            actor: { kind: "system", id: "cell" },
          },
        );
      },
      { scope: { taskId }, kinds: ["task"] },
    );
  }
}
