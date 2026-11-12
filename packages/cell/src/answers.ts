import type { CellTokenClaims } from "@zoltbot/cloud-contracts";
import { handle } from "@zoltbot/core";
import {
  type Interaction,
  type InteractionAnswer,
  parse,
  privateAnswerValues,
  TaskSchema,
} from "@zoltbot/protocol";
import { type RunnerCommand, RunnerCommandSchema } from "@zoltbot/runner-protocol";
import type { Store } from "@zoltbot/store/portable";
import { CellLeases, type LeaseRecord } from "./leases.js";
import { attachment } from "./sockets.js";

interface Delivery {
  id: string;
  task_id: string;
  lease_id: string;
  runner_id: string;
  body: string;
  private_value: number;
  created_at: number;
  state: "pending" | "complete" | "failed";
}
export interface PreparedAnswer {
  packet: RunnerCommand;
  privateValue: boolean;
}
/** Ordinary answers retry from SQLite. Private values exist only in the current request. */
export class CellAnswers {
  private readonly leases: CellLeases;
  constructor(
    private readonly store: Store,
    private readonly ctx?: Pick<DurableObjectState, "getWebSockets">,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.leases = new CellLeases(store);
    store.database.exec(
      "CREATE TABLE IF NOT EXISTS cell_answer_deliveries(id TEXT PRIMARY KEY,task_id TEXT NOT NULL,lease_id TEXT NOT NULL,runner_id TEXT NOT NULL,body TEXT NOT NULL,private_value INTEGER NOT NULL,created_at INTEGER NOT NULL,sent_at INTEGER,state TEXT NOT NULL DEFAULT 'pending'); CREATE INDEX IF NOT EXISTS cell_answer_deliveries_pending ON cell_answer_deliveries(runner_id,state,created_at)",
    );
  }
  private socket(lease: LeaseRecord): WebSocket | undefined {
    if (this.leases.offline(lease.taskId, this.now())) return;
    const owner = parse(TaskSchema, this.store.record("task", lease.taskId)).createdBy.id;
    return this.ctx?.getWebSockets("runner").find((socket) => {
      const data = attachment(socket);
      try {
        this.leases.require(lease.taskId, lease.leaseId, lease.runnerId, data.claims);
      } catch {
        return false;
      }
      return (
        socket.readyState === WebSocket.OPEN &&
        data.runnerId === lease.runnerId &&
        data.claims.device === lease.runnerId &&
        data.claims.sub === owner &&
        data.claims.exp * 1000 > this.now()
      );
    });
  }
  /** Called inside the same Store.dispatch as the redacted core resolution. */
  prepare(
    request: Interaction,
    answer: InteractionAnswer,
    redacted: InteractionAnswer,
    commandId: string,
  ): PreparedAnswer {
    if (!request.taskId) throw new Error("scope_unavailable");
    const task = parse(TaskSchema, this.store.record("task", request.taskId));
    const lease = this.leases.get(task.id);
    if (!lease || task.createdBy.id !== answer.by.id) throw new Error("runner_unavailable");
    const privateValue = privateAnswerValues(request, answer).size > 0;
    if (privateValue && !this.socket(lease)) throw new Error("runner_unavailable");
    const packet = parse(RunnerCommandSchema, {
      taskId: task.id,
      leaseId: lease.leaseId,
      commandId: `answer:${commandId}:${request.id}`,
      command: {
        type: "answer_interaction",
        interactionId: request.id,
        version: request.version,
        ...(request.nativeRef ? { nativeRef: request.nativeRef } : {}),
        answer,
      },
    });
    const durable = privateValue
      ? { ...packet, command: { ...packet.command, answer: redacted } }
      : packet;
    this.store.database
      .prepare(
        "INSERT INTO cell_answer_deliveries(id,task_id,lease_id,runner_id,body,private_value,created_at) VALUES(?,?,?,?,?,?,?)",
      )
      .run(
        packet.commandId,
        task.id,
        lease.leaseId,
        lease.runnerId,
        JSON.stringify(durable),
        privateValue ? 1 : 0,
        this.now(),
      );
    return { packet, privateValue };
  }
  sendPrivate(prepared: readonly PreparedAnswer[]) {
    for (const { packet, privateValue } of prepared) {
      if (!privateValue) continue;
      try {
        const lease = this.leases.get(packet.taskId);
        const socket = lease && this.socket(lease);
        if (!socket) throw new Error("runner_unavailable");
        socket.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id: `runner-answer:${packet.commandId}`,
            method: "runner.command",
            params: packet,
          }),
        );
        this.store.database
          .prepare("UPDATE cell_answer_deliveries SET sent_at=? WHERE id=?")
          .run(this.now(), packet.commandId);
      } catch {
        this.settle(packet.commandId, false);
      }
    }
  }
  pending(taskId: string): boolean {
    return !!this.store.database
      .prepare("SELECT id FROM cell_answer_deliveries WHERE task_id=? AND state='pending' LIMIT 1")
      .get(taskId);
  }
  deliver(socket: WebSocket, replay = false) {
    const data = attachment(socket);
    if (!data.runnerId || data.claims.kind === "client" || socket.readyState !== WebSocket.OPEN)
      return;
    const rows = this.store.database
      .prepare(
        "SELECT * FROM cell_answer_deliveries WHERE runner_id=? AND state='pending' AND private_value=0 AND (? OR sent_at IS NULL OR sent_at<=?) ORDER BY created_at,id LIMIT 8",
      )
      .all(data.runnerId, replay ? 1 : 0, this.now() - 15000) as Delivery[];
    for (const row of rows) {
      this.leases.require(row.task_id, row.lease_id, row.runner_id, data.claims);
      socket.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: `runner-answer:${row.id}`,
          method: "runner.command",
          params: JSON.parse(row.body),
        }),
      );
      this.store.database
        .prepare("UPDATE cell_answer_deliveries SET sent_at=? WHERE id=?")
        .run(this.now(), row.id);
    }
  }
  receive(
    claims: CellTokenClaims,
    runnerId: string,
    response: { id: string | number; result?: unknown; error?: unknown },
  ): boolean {
    if (typeof response.id !== "string" || !response.id.startsWith("runner-answer:")) return false;
    const id = response.id.slice("runner-answer:".length);
    const row = this.store.database
      .prepare("SELECT * FROM cell_answer_deliveries WHERE id=?")
      .get(id) as Delivery | undefined;
    if (!row || row.runner_id !== runnerId) throw new Error("forbidden");
    this.leases.require(row.task_id, row.lease_id, runnerId, claims);
    const result = response.result;
    const ok =
      !!result &&
      typeof result === "object" &&
      Object.keys(result).length === 1 &&
      "ok" in result &&
      result.ok === true;
    if (!ok && !response.error) throw new Error("forbidden");
    this.settle(id, ok);
    return true;
  }
  private settle(id: string, ok: boolean) {
    const row = this.store.database
      .prepare("SELECT * FROM cell_answer_deliveries WHERE id=?")
      .get(id) as Delivery | undefined;
    if (!row || row.state === "complete" || (row.state === "failed" && !ok)) return;
    const commandId = `answer-delivery:${ok ? "complete" : "failed"}:${id}`;
    this.store.dispatch(
      commandId,
      (state) => {
        const task = parse(TaskSchema, this.store.record("task", row.task_id));
        const packet = parse(RunnerCommandSchema, JSON.parse(row.body));
        const context = {
          commandId,
          at: new Date(this.now()).toISOString(),
          actor: { kind: "system" as const, id: "cell" },
        };
        this.store.database
          .prepare("UPDATE cell_answer_deliveries SET state=? WHERE id=?")
          .run(ok ? "complete" : "failed", id);
        const noteId = `answer-delivery-note:${id}`;
        const note = this.store.record("item", noteId);
        if (ok)
          return note
            ? handle(
                { ...state, item: [note] },
                {
                  type: "update",
                  kind: "item",
                  id: noteId,
                  changes: {
                    body: {
                      ...(note.body as Record<string, unknown>),
                      code: "interaction_reply_confirmed",
                      text: "Your answer reached the agent.",
                    },
                    updatedAt: context.at,
                  },
                },
                context,
              )
            : { events: [], result: {} };
        const latest = this.store.database
          .prepare("SELECT max(seq) AS seq FROM item_records WHERE thread_id=?")
          .get(String(task.threadId)) as { seq: number | null };
        if (packet.command.type !== "answer_interaction") throw new Error("forbidden");
        return handle(
          state,
          {
            type: "create",
            kind: "item",
            value: {
              id: noteId,
              threadId: task.threadId,
              kind: "note",
              seq: (latest.seq ?? 0) + 1,
              createdAt: context.at,
              updatedAt: context.at,
              body: {
                code: "interaction_reply_failed",
                interactionId: packet.command.interactionId,
                text: "Your answer was saved, but delivery was not confirmed. Review the native session before forwarding it as a message.",
              },
            },
          },
          context,
        );
      },
      { scope: { taskId: row.task_id }, kinds: ["task", "thread"] },
    );
  }
  /** Private values cannot be replayed after eviction; report an uncertain handoff explicitly. */
  alarm(): number | undefined {
    const rows = this.store.database
      .prepare(
        "SELECT id FROM cell_answer_deliveries WHERE state='pending' AND private_value=1 AND created_at<=? ORDER BY created_at,id LIMIT 8",
      )
      .all(this.now() - 30000) as { id: string }[];
    for (const row of rows) this.settle(row.id, false);
    const next = this.store.database
      .prepare(
        "SELECT min(created_at) AS at FROM cell_answer_deliveries WHERE state='pending' AND private_value=1",
      )
      .get() as { at: number | null };
    return next.at === null ? undefined : next.at + 30000;
  }
}
