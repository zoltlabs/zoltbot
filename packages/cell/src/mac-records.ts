import type { CellTokenClaims } from "@zoltbot/cloud-contracts";
import { type CommandContext, requestInteraction } from "@zoltbot/core";
import {
  type DomainEvent,
  type Interaction,
  type InteractionAnswer,
  InteractionSchema,
  MacApprovalDraftSchema,
  parse,
  TaskSchema,
} from "@zoltbot/protocol";
import {
  type MacExecProgress,
  MacExecProgressSchema,
  type MacExecRequest,
  MacExecRequestSchema,
  type MacExecResult,
  MacExecResultSchema,
} from "@zoltbot/runner-protocol";
import type { Store } from "@zoltbot/store/portable";
import { CellLeases } from "./leases.js";

interface Row {
  id: string;
  task_id: string;
  request_id: string;
  fingerprint: string;
  body: string;
  interaction_id: string;
  state: "pending" | "approved" | "sent" | "complete" | "denied";
  approval: string | null;
  result: string | null;
  reason: string | null;
  sent_at: number | null;
}
export interface PreparedMac {
  deviceId: string;
  mac: string;
  cwd: string;
}
const kinds = ["task", "thread", "session", "turn", "interaction"] as const;
const hash = async (value: unknown) =>
  [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value))),
    ),
  ]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
const stdinHash = async (value: string) =>
  btoa(
    String.fromCharCode(
      ...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))),
    ),
  )
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
const identity = (request: MacExecRequest) => [
  request.requestId,
  request.taskId,
  request.turnId,
  request.userId,
  request.targetDeviceId,
  request.command,
  request.cwd,
  request.timeoutSeconds ?? 600,
  request.stdin ?? "",
];

/** Durable request/approval/result state only. Socket routing and Mac signature verification are separate. */
export class CellMacRecords {
  private readonly leases: CellLeases;
  constructor(
    private readonly store: Store,
    private readonly owner: { orgId: string; userId: string },
    private readonly now = Date.now,
  ) {
    this.leases = new CellLeases(store);
    store.database.exec(`CREATE TABLE IF NOT EXISTS cell_mac_requests (
      id TEXT PRIMARY KEY,task_id TEXT NOT NULL,request_id TEXT NOT NULL,fingerprint TEXT NOT NULL,
      body TEXT NOT NULL,interaction_id TEXT NOT NULL UNIQUE,mac_id TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'pending',approval TEXT,result TEXT,reason TEXT,sent_at INTEGER,
      created_at INTEGER NOT NULL,UNIQUE(task_id,request_id));
      CREATE INDEX IF NOT EXISTS cell_mac_pending ON cell_mac_requests(mac_id,state,created_at);`);
    store.database.exec(
      "CREATE TABLE IF NOT EXISTS cell_runner_connections(runner_id TEXT PRIMARY KEY,connection_id TEXT NOT NULL)",
    );
  }
  private member(claims: CellTokenClaims) {
    if (claims.org !== this.owner.orgId || claims.sub !== this.owner.userId)
      throw new Error("forbidden");
  }
  private row(taskId: string, requestId: string) {
    return this.store.database
      .prepare("SELECT * FROM cell_mac_requests WHERE task_id=? AND request_id=?")
      .get(taskId, requestId) as Row | undefined;
  }
  has(interactionId: string) {
    return !!this.store.database
      .prepare("SELECT id FROM cell_mac_requests WHERE interaction_id=?")
      .get(interactionId);
  }
  private source(claims: CellTokenClaims, connectionId: string, taskId: string) {
    const current = this.store.database
      .prepare("SELECT connection_id FROM cell_runner_connections WHERE runner_id=?")
      .get(claims.device) as { connection_id: string } | undefined;
    const lease = this.leases.get(taskId);
    if (!lease || lease.connectionId !== connectionId || current?.connection_id !== connectionId)
      throw new Error("forbidden");
    this.leases.require(taskId, lease.leaseId, claims.device, claims);
  }
  private progress(row: Row): MacExecProgress {
    if (row.state === "complete")
      return parse(MacExecProgressSchema, {
        state: "complete",
        requestId: row.request_id,
        result: JSON.parse(row.result ?? "null"),
      });
    if (row.state === "denied")
      return parse(MacExecProgressSchema, {
        state: "denied",
        requestId: row.request_id,
        reason: row.reason,
      });
    return row.state === "pending"
      ? { state: "pending", requestId: row.request_id, interactionId: row.interaction_id }
      : { state: "running", requestId: row.request_id };
  }
  private audit(
    context: CommandContext,
    action: string,
    target: string,
    detail: Record<string, unknown>,
  ): DomainEvent {
    const id = crypto.randomUUID();
    return {
      eventId: id,
      commandId: context.commandId,
      aggregateType: "audit",
      aggregateId: id,
      type: "audit.created",
      occurredAt: context.at,
      payload: {
        id,
        actor: context.actor,
        action,
        target,
        result: "allowed",
        detail,
        at: context.at,
      },
    };
  }
  async request(
    source: { claims: CellTokenClaims; connectionId: string },
    raw: MacExecRequest,
    mac: PreparedMac,
  ) {
    const claims = source.claims;
    this.member(claims);
    const request = parse(MacExecRequestSchema, structuredClone(raw));
    if (
      claims.kind !== "sandbox_runner" ||
      claims.task !== request.taskId ||
      request.userId !== claims.sub ||
      request.approval ||
      request.targetDeviceId !== mac.deviceId ||
      request.cwd !== mac.cwd ||
      !mac.cwd.startsWith("/") ||
      request.command.includes("\0") ||
      new TextEncoder().encode(request.stdin ?? "").byteLength > 65536
    )
      throw new Error("forbidden");
    this.source(claims, source.connectionId, request.taskId);
    const fingerprint = await hash(identity(request)),
      id = await hash([claims.org, claims.sub, request.taskId, request.requestId]);
    const inputHash = await stdinHash(request.stdin ?? "");
    this.source(claims, source.connectionId, request.taskId);
    const prior = this.row(request.taskId, request.requestId);
    if (prior) {
      if (prior.fingerprint !== fingerprint) throw new Error("command_conflict");
      return this.progress(prior);
    }
    const task = parse(TaskSchema, this.store.record("task", request.taskId));
    const agentId = task.ownerAgentId;
    const turn = this.store.record("turn", request.turnId),
      session = turn && this.store.record("session", String(turn.sessionId));
    if (
      task.createdBy.id !== claims.sub ||
      task.location !== "sandbox" ||
      task.state !== "running" ||
      !task.threadId ||
      !agentId ||
      turn?.threadId !== task.threadId ||
      turn.status !== "running" ||
      session?.threadId !== task.threadId ||
      session.state !== "running"
    )
      throw new Error("forbidden");
    const interactionId = `mac:${id}`,
      commandId = `mac-request:${id}`;
    this.store.dispatch(
      commandId,
      (state) => {
        const last = this.store.database
          .prepare("SELECT id,seq FROM item_records WHERE thread_id=? ORDER BY seq DESC LIMIT 1")
          .get(task.threadId) as { id: string; seq: number } | undefined;
        state.item = last ? [{ ...last, threadId: task.threadId, kind: "note", body: {} }] : [];
        const context: CommandContext = {
          commandId,
          at: new Date(this.now()).toISOString(),
          actor: { kind: "agent", id: agentId },
        };
        const draft = parse(MacApprovalDraftSchema, {
          v: 1,
          orgId: claims.org,
          userId: claims.sub,
          requestId: request.requestId,
          taskId: task.id,
          turnId: request.turnId,
          targetDeviceId: mac.deviceId,
          scope: "command",
          command: request.command,
          cwd: mac.cwd,
          stdinHash: inputHash,
          timeoutSeconds: request.timeoutSeconds ?? 600,
        });
        const output = requestInteraction(
          state,
          {
            id: interactionId,
            agentId: task.ownerAgentId,
            threadId: task.threadId,
            taskId: task.id,
            turnId: request.turnId,
            type: "approval",
            context: {
              toolName: "mac_exec",
              toolKind: "execute",
              command: request.command,
              cwd: mac.cwd,
              macExec: draft,
              toolInput: {
                mac: mac.mac,
                stdin: request.stdin ?? "",
                timeoutSeconds: request.timeoutSeconds ?? 600,
              },
            },
            items: [
              {
                id: "command",
                prompt: "Run on my Mac",
                choices: [{ id: "allow_once" }, { id: "reject_once" }],
              },
            ],
            chain: [],
            urgency: "blocking",
            nativeRef: `mac-exec:${id}`,
          },
          `mac-item:${id}`,
          context,
        );
        this.store.database
          .prepare(
            "INSERT INTO cell_mac_requests(id,task_id,request_id,fingerprint,body,interaction_id,mac_id,created_at) VALUES(?,?,?,?,?,?,?,?)",
          )
          .run(
            id,
            task.id,
            request.requestId,
            fingerprint,
            JSON.stringify(request),
            interactionId,
            mac.deviceId,
            this.now(),
          );
        output.events.push(
          this.audit(context, "mac.exec.requested", task.id, {
            requestId: request.requestId,
            macDeviceId: mac.deviceId,
          }),
        );
        return { ...output, result: { interactionId } };
      },
      { scope: { taskId: task.id }, kinds },
    );
    const saved = this.row(task.id, request.requestId);
    if (!saved) throw new Error("request_failed");
    return this.progress(saved);
  }
  /** Called in the same Store.dispatch transaction as core interaction resolution. */
  resolve(
    interaction: Interaction,
    answer: InteractionAnswer,
    claims: CellTokenClaims,
    context: CommandContext,
  ) {
    this.member(claims);
    if (
      !this.store.database.inTransaction ||
      claims.kind !== "client" ||
      answer.by.kind !== "human" ||
      answer.by.id !== claims.sub
    )
      throw new Error("forbidden");
    const row = this.store.database
      .prepare("SELECT * FROM cell_mac_requests WHERE interaction_id=?")
      .get(interaction.id) as Row | undefined;
    if (!row || row.state !== "pending") throw new Error("interaction_conflict");
    const task = parse(TaskSchema, this.store.record("task", row.task_id));
    if (task.createdBy.id !== claims.sub || !["running", "blocked", "queued"].includes(task.state))
      throw new Error("forbidden");
    if (answer.action !== "accept") {
      this.store.database
        .prepare("UPDATE cell_mac_requests SET state='denied',reason='declined' WHERE id=?")
        .run(row.id);
      return [this.audit(context, "mac.exec.denied", row.task_id, { requestId: row.request_id })];
    }
    const approval = answer.signedApproval,
      expected = parse(InteractionSchema, interaction).context?.macExec;
    if (
      !approval ||
      !expected ||
      answer.choice !== "allow_once" ||
      approval.payload.signerDeviceId !== claims.device ||
      approval.payload.issuedAt > this.now() + 30000 ||
      approval.payload.expiresAt <= this.now() ||
      approval.payload.expiresAt <= approval.payload.issuedAt ||
      approval.payload.expiresAt - approval.payload.issuedAt > 300000
    )
      throw new Error("forbidden");
    const actual = parse(
      MacApprovalDraftSchema,
      Object.fromEntries(
        Object.entries(approval.payload).filter(
          ([key]) => !["signerDeviceId", "issuedAt", "expiresAt"].includes(key),
        ),
      ),
    );
    for (const key of Object.keys(expected) as (keyof typeof expected)[])
      if (actual[key] !== expected[key]) throw new Error("forbidden");
    this.store.database
      .prepare("UPDATE cell_mac_requests SET state='approved',approval=? WHERE id=?")
      .run(JSON.stringify(approval), row.id);
    return [
      this.audit(context, "mac.exec.approved", row.task_id, {
        requestId: row.request_id,
        deviceId: claims.device,
      }),
    ];
  }
  finish(claims: CellTokenClaims, result: MacExecResult) {
    this.member(claims);
    const value = parse(MacExecResultSchema, result),
      row = this.row(value.taskId, value.requestId);
    if (
      claims.kind !== "mac_runner" ||
      !row ||
      !["approved", "sent", "complete"].includes(row.state) ||
      (JSON.parse(row.body) as MacExecRequest).targetDeviceId !== claims.device
    )
      throw new Error("forbidden");
    const encoded = JSON.stringify(value);
    if (row.state === "complete") {
      if (row.result !== encoded) throw new Error("command_conflict");
      return;
    }
    const commandId = `mac-result:${row.id}`;
    this.store.dispatch(
      commandId,
      () => {
        this.store.database
          .prepare("UPDATE cell_mac_requests SET state='complete',result=? WHERE id=?")
          .run(encoded, row.id);
        const context: CommandContext = {
          commandId,
          at: new Date(this.now()).toISOString(),
          actor: { kind: "system", id: "mac-runner" },
        };
        return {
          events: [
            this.audit(context, "mac.exec.completed", row.task_id, {
              requestId: row.request_id,
              exitCode: value.exitCode,
              durationMs: value.durationMs,
              stdoutBytes: new TextEncoder().encode(value.stdout).byteLength,
              stderrBytes: new TextEncoder().encode(value.stderr).byteLength,
            }),
          ],
          result: { ok: true },
        };
      },
      { scope: { taskId: row.task_id }, kinds: [] },
    );
  }
}
