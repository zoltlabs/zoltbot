import type { CellTokenClaims } from "@zoltbot/cloud-contracts";
import { InteractionSchema, parse, privateAnswerValues, TaskSchema } from "@zoltbot/protocol";
import { type RunnerCommand, RunnerCommandSchema } from "@zoltbot/runner-protocol";
import type { Store } from "@zoltbot/store/portable";
import { CellLeases } from "./leases.js";
import { attachment } from "./sockets.js";

interface CommandRow {
  id: string;
  task_id: string;
  lease_id: string;
  runner_id: string;
  body: string;
  state: "pending" | "complete" | "failed";
}
/** Commands commit with their triggering core command, then retry until acknowledged. */
export class CellCommands {
  private readonly leases: CellLeases;
  constructor(private readonly store: Store) {
    this.leases = new CellLeases(store);
    store.database.exec(
      "CREATE TABLE IF NOT EXISTS cell_runner_commands(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,task_id TEXT NOT NULL,lease_id TEXT NOT NULL,runner_id TEXT NOT NULL,body TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'pending',sent_at INTEGER,error_code TEXT); CREATE INDEX IF NOT EXISTS cell_runner_commands_pending ON cell_runner_commands(runner_id,state,seq)",
    );
  }
  enqueue(taskId: string, commandId: string, command: RunnerCommand["command"]) {
    const task = parse(TaskSchema, this.store.record("task", taskId));
    const lease = this.leases.get(taskId);
    if (!lease) throw new Error("runner_unavailable");
    if (task.location !== lease.kind) throw new Error("forbidden");
    // Private answers use live delivery; a durable queue must never contain their values.
    if (command.type === "answer_interaction") {
      const interaction = this.store.record("interaction", command.interactionId);
      if (!interaction || interaction.taskId !== taskId) throw new Error("forbidden");
      if (privateAnswerValues(parse(InteractionSchema, interaction), command.answer).size)
        throw new Error("private_answer_requires_live_runner");
    }
    const value = parse(RunnerCommandSchema, {
      taskId,
      leaseId: lease.leaseId,
      commandId,
      command,
    });
    const body = JSON.stringify(value);
    const previous = this.store.database
      .prepare("SELECT body FROM cell_runner_commands WHERE id=?")
      .get(commandId) as { body: string } | undefined;
    if (previous) {
      if (previous.body !== body) throw new Error("command_conflict");
      return value;
    }
    this.store.database
      .prepare(
        "INSERT INTO cell_runner_commands(id,task_id,lease_id,runner_id,body) VALUES(?,?,?,?,?)",
      )
      .run(commandId, taskId, lease.leaseId, lease.runnerId, body);
    return value;
  }
  pending(taskId: string): boolean {
    return !!this.store.database
      .prepare("SELECT id FROM cell_runner_commands WHERE task_id=? AND state='pending' LIMIT 1")
      .get(taskId);
  }
  deliver(socket: WebSocket, replay = false, now = Date.now()) {
    const data = attachment(socket);
    if (!data.runnerId || data.claims.kind === "client" || socket.readyState !== WebSocket.OPEN)
      return;
    const rows = this.store.database
      .prepare(
        "SELECT id,task_id,lease_id,runner_id,body,state FROM cell_runner_commands WHERE runner_id=? AND state='pending' AND (? OR sent_at IS NULL OR sent_at<=?) ORDER BY seq LIMIT 8",
      )
      .all(data.runnerId, replay ? 1 : 0, now - 15000) as CommandRow[];
    for (const row of rows) {
      this.leases.require(row.task_id, row.lease_id, row.runner_id, data.claims);
      socket.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: `runner-command:${row.id}`,
          method: "runner.command",
          params: JSON.parse(row.body),
        }),
      );
      this.store.database
        .prepare("UPDATE cell_runner_commands SET sent_at=? WHERE id=?")
        .run(now, row.id);
    }
  }
  result(
    claims: CellTokenClaims,
    runnerId: string,
    response: { id: string | number; result?: unknown; error?: unknown },
  ) {
    const prefix = "runner-command:";
    if (typeof response.id !== "string" || !response.id.startsWith(prefix))
      throw new Error("method_unavailable");
    const id = response.id.slice(prefix.length);
    const row = this.store.database
      .prepare(
        "SELECT id,task_id,lease_id,runner_id,body,state FROM cell_runner_commands WHERE id=?",
      )
      .get(id) as CommandRow | undefined;
    if (!row || row.runner_id !== runnerId) throw new Error("forbidden");
    this.leases.require(row.task_id, row.lease_id, runnerId, claims);
    if (row.state !== "pending") return;
    const command = parse(RunnerCommandSchema, JSON.parse(row.body)).command;
    // Diff and publication results have separate bounded schemas; do not save arbitrary JSON.
    if (command.type === "collect_diff" || command.type === "push_branch")
      throw new Error("method_unavailable");
    const value = response.result;
    if (
      !(
        value &&
        typeof value === "object" &&
        Object.keys(value).length === 1 &&
        "ok" in value &&
        value.ok === true
      )
    ) {
      if (!response.error) throw new Error("forbidden");
      this.store.database
        .prepare(
          "UPDATE cell_runner_commands SET state='failed',error_code='runner_command_failed' WHERE id=? AND state='pending'",
        )
        .run(id);
      return;
    }
    this.store.database
      .prepare("UPDATE cell_runner_commands SET state='complete' WHERE id=? AND state='pending'")
      .run(id);
  }
}
