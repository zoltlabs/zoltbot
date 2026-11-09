import { Value } from "@sinclair/typebox/value";
import {
  type DomainEvent,
  type MethodName,
  macOnlyMethods,
  methodCatalog,
  unservedMethods,
} from "@zoltbot/protocol";
import { searchSampleFiles } from "./attachments.js";
import { SampleManagement, sampleManagement } from "./fake-manage.js";
import { sampleSnapshot } from "./sample.js";
import { modeWidens } from "./session.js";
import type { Row, Snapshot, Transport, TransportHandlers } from "./transport.js";

/**
 * Sample data behind the same JSON-RPC surface as zoltd. Params are checked against the real
 * method catalog, so a screen that sends a wrong shape fails here as it would on the Mac.
 */
export class FakeTransport implements Transport {
  readonly kind = "fake";
  private handlers: TransportHandlers | undefined;
  private snapshot: Snapshot;
  private online = true;
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private lastSeenAt: string | undefined;
  private receipts = new Map<string, unknown>();
  private forkHistory = new Map<string, Row[]>();
  private manage: SampleManagement;

  constructor(
    private readonly options: {
      replyDelayMs?: number;
      now?: () => number;
      settings?: Row[];
      onSettings?: (rows: Row[]) => void | Promise<void>;
    } = {},
  ) {
    this.snapshot = sampleSnapshot(this.now());
    Object.assign(this.snapshot.entities, sampleManagement(this.now()));
    this.manage = new SampleManagement({
      rows: (kind) => this.rows(kind),
      find: (kind, id) => this.find(kind, id),
      put: (kind, row, verb) => this.put(kind, row, verb),
      at: () => this.at(),
    });
    if (options.settings) this.snapshot.entities.settings = options.settings;
  }
  private now() {
    return this.options.now?.() ?? Date.now();
  }
  private at() {
    return new Date(this.now()).toISOString();
  }

  start(handlers: TransportHandlers) {
    this.handlers = handlers;
    handlers.status("online");
  }
  stop() {
    this.handlers = undefined;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
  }
  /** Sample only: pretend the Mac went to sleep or came back. */
  setMacOnline(online: boolean) {
    this.online = online;
    if (!online) this.lastSeenAt = this.at();
    this.handlers?.status(
      online ? "online" : "mac_offline",
      this.lastSeenAt ? { lastSeenAt: this.lastSeenAt } : {},
    );
  }

  private rows(kind: string) {
    this.snapshot.entities[kind] ??= [];
    return this.snapshot.entities[kind];
  }
  private find(kind: string, id: unknown) {
    const row = this.rows(kind).find((entry) => entry.id === id);
    if (!row) throw new Error(`No ${kind} ${String(id)}`);
    return row;
  }
  private put(kind: string, row: Row, verb: "created" | "updated" = "updated") {
    const id = String(row.id ?? row.key);
    const rows = this.rows(kind).filter((entry) => String(entry.id ?? entry.key) !== id);
    this.snapshot.entities[kind] = [...rows, row];
    this.snapshot.seq += 1;
    const event: DomainEvent = {
      seq: this.snapshot.seq,
      eventId: `fake-${this.snapshot.seq}`,
      aggregateType: kind,
      aggregateId: id,
      type: `${kind}.${verb}`,
      occurredAt: this.at(),
      payload: row,
    };
    this.handlers?.event(event);
    return row;
  }
  private later(ms: number, run: () => void) {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      if (this.handlers) run();
    }, ms);
    this.timers.add(timer);
  }

  async call(method: string, params: unknown, commandId?: string): Promise<unknown> {
    if (!this.online) throw new Error("Your Mac is offline.");
    const entry = methodCatalog[method as MethodName];
    if (!entry) throw new Error(`Unknown method ${method}`);
    // The same refusals a paired phone gets from zoltd.
    if (macOnlyMethods.includes(method as MethodName))
      throw new Error(`mac_only: ${method} works only on the Mac`);
    if (unservedMethods.includes(method as MethodName))
      throw new Error(`method_unavailable: ${method}`);
    if (!Value.Check(entry.params, params)) throw new Error(`Bad params for ${method}`);
    // Like the store's command receipts: a repeated id answers from the first run.
    if (commandId && this.receipts.has(commandId))
      return structuredClone(this.receipts.get(commandId));
    const result = await this.answer(method, params);
    if (commandId) this.receipts.set(commandId, structuredClone(result));
    return result;
  }

  private async answer(method: string, params: unknown): Promise<unknown> {
    const p = params as Row;
    const now = this.at();
    switch (method) {
      case "snapshot.get":
        return structuredClone(this.snapshot);
      case "events.subscribe":
        return { seq: this.snapshot.seq, resync: false, events: [] };
      case "interaction.answer": {
        const row = this.find("interaction", p.id);
        if (row.state !== "pending" || row.version !== p.version)
          throw new Error("interaction_conflict");
        return this.put("interaction", {
          ...row,
          state: (p.answer as Row).action === "cancel" ? "cancelled" : "answered",
          version: Number(row.version) + 1,
          resolution: p.answer,
          resolvedAt: now,
        });
      }
      case "session.setMode": {
        const session = this.find("session", p.id);
        const modes = ((session.capabilities as Row).modes ?? []) as unknown[];
        if (!modes.includes(p.mode)) throw new Error("unsupported_mode");
        // Like zoltd, a phone cannot widen permission (I13).
        if (modeWidens(session, String(p.mode)))
          throw new Error("mac_only: session.setMode works only on the Mac");
        this.put("session", { ...session, mode: p.mode });
        return { ok: true };
      }
      case "task.review": {
        const task = this.find("task", p.id);
        const accept = p.decision === "accept";
        return this.put("task", {
          ...task,
          state: accept ? "completed" : p.decision === "reject" ? "cancelled" : "running",
          ...(p.decision === "changes" ? { revision: Number(task.revision) + 1 } : {}),
          reviewState: String(p.decision),
          updatedAt: now,
        });
      }
      case "task.cancel":
        return this.put("task", { ...this.find("task", p.id), state: "cancelled", updatedAt: now });
      case "task.retry":
        return this.put("task", { ...this.find("task", p.id), state: "queued", updatedAt: now });
      case "task.create":
        return this.createTask(p, now);
      case "thread.create": {
        const value = p.value as Row;
        return this.put("thread", { ...value, createdAt: now, lastActivityAt: now }, "created");
      }
      case "turn.send":
        return this.send(String(p.threadId), p.input as Row[], now, p.mode === "steer");
      case "message.send": {
        // As zoltd: record the person's message, then deliver it like typing in that chat.
        const message = p.message as Row;
        const thread = this.find("thread", message.thread);
        const to = (message.to as Row[])[0];
        if (message.origin !== "human" || !to || to.id !== thread.agentId)
          throw new Error("message_target_mismatch");
        this.put("message", { ...message, hops: 0, root: message.id }, "created");
        const sent = this.send(
          String(message.thread),
          (message.body as Row[]).filter((part) => part.type === "text"),
          now,
          message.delivery === "steer",
        );
        return {
          messageId: message.id,
          deliveries: [
            {
              id: sent.id,
              messageId: message.id,
              toAgentId: to.id,
              queueOrder: 0,
              state: sent.disposition === "queued" ? "queued" : "delivered",
            },
          ],
        };
      }
      case "message.list":
        return { items: this.rows("message") };
      case "session.setModel":
      case "session.setEffort": {
        // The same checks zoltd makes (core requestSessionModel), on the sample's sessions.
        const session = this.find("session", p.id);
        const capabilities = (session.capabilities ?? {}) as Row;
        const listed = ((capabilities.models ?? {}) as Row).list as Row[] | undefined;
        const model = method === "session.setModel" ? String(p.model) : String(session.model);
        if (!listed?.some((row) => row.id === model)) throw new Error("unsupported_model");
        const effort = typeof p.effort === "string" ? p.effort : undefined;
        if (effort && !(capabilities.effort as string[] | undefined)?.includes(effort))
          throw new Error("unsupported_effort");
        if (this.rows("turn").some((t) => t.sessionId === p.id) && p.cacheWarningAccepted !== true)
          throw new Error("cache_warning_required");
        const { effort: _, ...rest } = session;
        return this.put("session", { ...rest, model, ...(effort ? { effort } : {}) });
      }
      case "thread.forkPreview": {
        const thread = this.find("thread", p.id);
        const destinations = this.rows("agent")
          .filter((agent) => agent.id !== thread.agentId && agent.archived !== true)
          .map((agent) => ({ id: agent.id, name: agent.name, tool: agent.definitionId }));
        const session = this.rows("session").find((row) => row.threadId === p.id);
        const kind = p.kind ?? (p.destinationProfileId ? "copied" : "native");
        const busy = this.rows("turn").some(
          (turn) => turn.threadId === p.id && turn.status === "running",
        );
        if (busy) return { available: false, kind, destinations, reason: "fork_requires_idle" };
        if (kind === "native" && p.destinationProfileId)
          return { available: false, kind, destinations, reason: "native_fork_unverified" };
        const copied = this.rows("item").filter(
          (item) => item.threadId === p.id && (item.kind === "user" || item.kind === "message"),
        ).length;
        return {
          available: true,
          kind,
          destinations,
          cwd: session?.cwd,
          ...(kind === "copied" ? { copiedMessages: copied, omittedMessages: 0 } : {}),
        };
      }
      // The Inbox, as zoltd's inbox-api.ts answers it.
      case "thread.markRead": {
        const thread = this.find("thread", p.id);
        const at = typeof p.at === "string" ? p.at : now;
        // Reads only move forward, so a slow device cannot mark newer work unread.
        return String(thread.lastReadAt ?? "") >= at
          ? thread
          : this.put("thread", { ...thread, lastReadAt: at });
      }
      case "thread.markUnread": {
        const { lastReadAt: _, ...thread } = this.find("thread", p.id);
        const ended = this.rows("turn")
          .filter((turn) => turn.threadId === p.id && turn.endedAt)
          .map((turn) => String(turn.endedAt))
          .sort()
          .at(-1);
        return this.put(
          "thread",
          ended ? { ...thread, lastReadAt: new Date(Date.parse(ended) - 1).toISOString() } : thread,
        );
      }
      case "thread.snooze": {
        const { snoozedUntil: _, ...thread } = this.find("thread", p.id);
        return this.put(
          "thread",
          typeof p.until === "string" ? { ...thread, snoozedUntil: p.until } : thread,
        );
      }
      case "thread.settle":
        return this.settle(String(p.id));
      case "thread.unarchive": {
        const { archiveWhenIdle: _, ...thread } = this.find("thread", p.id);
        return this.put("thread", { ...thread, archived: false });
      }
      case "thread.reply":
        return this.reply(p, now);
      case "thread.forkHistory":
        return { items: this.forkHistory.get(String(p.id)) ?? [] };
      case "session.rewind": {
        const session = this.find("session", p.id);
        const files = this.changedSince(String(session.threadId), String(p.turnId));
        return { canRewind: files.length > 0, files };
      }
      case "thread.fork":
        return this.fork(p, now);
      case "turn.cancelQueued": {
        const item = this.find("item", p.id);
        if (item.threadId !== p.threadId || (item.body as Row).queueState !== "queued")
          throw new Error("queued_input_not_found");
        this.put("item", {
          ...item,
          body: { ...(item.body as Row), queueState: "failed", errorCode: "cancelled" },
          updatedAt: now,
        });
        return { ok: true };
      }
      case "turn.interrupt": {
        this.put("turn", { ...this.find("turn", p.turnId), status: "interrupted", endedAt: now });
        for (const item of this.rows("item"))
          if (item.turnId === p.turnId && (item.body as Row).streaming)
            this.put("item", { ...item, body: { ...(item.body as Row), streaming: false } });
        return { ok: true };
      }
      case "workspace.files":
        this.find("thread", p.threadId);
        return searchSampleFiles(String(p.query), Number(p.limit ?? 20));
      case "project.create":
        return this.put("project", p.value as Row, "created");
      case "project.archive":
        if (!p.confirmed) throw new Error("Confirm archiving this project.");
        this.put("project", { ...this.find("project", p.id), archived: true });
        return { ok: true };
      case "agent.update":
      case "project.update": {
        const kind = method.split(".")[0] as string;
        return this.put(kind, { ...this.find(kind, p.id), ...(p.changes as Row) });
      }
      case "device.list":
        return this.rows("device");
      case "device.revoke":
        this.put("device", { ...this.find("device", p.id), state: "revoked" });
        return { ok: true };
      case "detect.checkLogin":
        return { state: p.definitionId === "claude" ? "signed_in" : "signed_out" };
      case "settings.get":
        return this.rows("settings");
      case "settings.set": {
        // Compare-and-set, as zoltd: `expected: {}` means the key must not exist yet.
        const expected = p.expected as { value?: unknown } | undefined;
        const prior = this.rows("settings").find((row) => row.key === p.key);
        if (expected && stable(prior?.value) !== stable(expected.value))
          throw new Error("setting_conflict");
        const setting = { key: p.key, value: p.value };
        const next = [...this.rows("settings").filter((row) => row.key !== p.key), setting];
        await this.options.onSettings?.(structuredClone(next));
        this.put("settings", setting);
        return { ok: true };
      }
      default: {
        const managed = this.manage.answer(method, p);
        if (managed === undefined)
          throw new Error(`The sample data does not answer ${method} yet.`);
        return managed;
      }
    }
  }

  private createTask(p: Row, now: string) {
    const id = `task-${this.snapshot.seq + 1}`;
    const node = p.node as Row;
    const direction = this.rows("subproject").find((row) => row.id === node.id);
    const projectId = String(direction?.projectId ?? node.id);
    const threadId = `thread-${id}`;
    this.put(
      "thread",
      {
        id: threadId,
        agentId: p.profileId,
        projectId,
        node,
        taskId: id,
        kind: "task",
        title: p.title,
        titleSource: "human",
        pinned: false,
        archived: false,
        createdAt: now,
        lastActivityAt: now,
      },
      "created",
    );
    return this.put(
      "task",
      {
        id,
        projectId,
        node,
        rootId: id,
        title: p.title,
        brief: p.brief,
        acceptance: p.acceptance ?? "",
        expectedDeliverable: "A tested change",
        ownerAgentId: p.profileId,
        threadId,
        workspaceMode: "worktree",
        state: "queued",
        revision: 1,
        attempt: 1,
        maxAttempts: 3,
        reviewRequired: true,
        executionLocation: "local",
        createdBy: { kind: "human", id: "human" },
        createdAt: now,
        updatedAt: now,
      },
      "created",
    );
  }

  /** Archives a quiet thread now; one still working or waiting is archived when it goes quiet. */
  private settle(id: string) {
    const busy =
      this.rows("turn").some((turn) => turn.threadId === id && turn.status === "running") ||
      this.rows("interaction").some((row) => row.threadId === id && row.state === "pending");
    const { archiveWhenIdle: _, snoozedUntil: __, ...thread } = this.find("thread", id);
    if (busy)
      return { thread: this.put("thread", { ...thread, archiveWhenIdle: true }), archived: false };
    return { thread: this.put("thread", { ...thread, archived: true }), archived: true };
  }

  /** One Inbox reply: answers the questions it quotes, then sends the letter as one message. */
  private async reply(p: Row, now: string) {
    const threadId = String(p.threadId);
    const body = typeof p.body === "string" ? p.body.trim() : "";
    const answers = (Array.isArray(p.answers) ? p.answers : []) as Row[];
    if (!body) throw new Error("empty_reply");
    const thread = this.find("thread", threadId);
    for (const entry of answers) {
      const request = this.rows("interaction").find((row) => row.id === entry.interactionId);
      if (!request || request.threadId !== threadId) throw new Error("not_found: interaction");
      if (request.type !== "question") throw new Error("reply_answers_questions_only");
      if (request.state !== "pending" || request.version !== entry.version)
        throw new Error("stale_interaction: answer it again from the newest letter");
    }
    if (thread.archived || thread.archiveWhenIdle) {
      const { archiveWhenIdle: _, ...rest } = thread;
      this.put("thread", { ...rest, archived: false });
    }
    const by = { kind: "human", id: "local-owner" };
    for (const entry of answers) {
      const given = entry.answers as Row | undefined;
      await this.answer("interaction.answer", {
        id: entry.interactionId,
        version: entry.version,
        answer:
          given && Object.keys(given).length
            ? { action: "accept", answers: given, by, at: now }
            : { action: "decline", feedback: "Skipped; see my reply.", by, at: now },
      });
    }
    const sent = this.send(threadId, [{ type: "text", text: body }], now, p.mode === "steer");
    if (p.settle === true) this.settle(threadId);
    return { ...sent, resolved: answers.map((entry) => String(entry.interactionId)) };
  }

  /** Files the thread's tools changed from a turn on, the way a rewind dry run lists them. */
  private changedSince(threadId: string, turnId: string) {
    const items = this.rows("item")
      .filter((item) => item.threadId === threadId)
      .sort((a, b) => Number(a.seq) - Number(b.seq));
    const start = items.findIndex((item) => item.turnId === turnId);
    if (start < 0) throw new Error("rewind_turn_unavailable");
    const paths = items
      .slice(start)
      .flatMap((item) => ((item.body as Row).diffs as Row[] | undefined) ?? [])
      .map((diff) => String(diff.path));
    return [...new Set(paths)];
  }

  /** A fork: a new chat that inherits the items before the boundary message. */
  private fork(p: Row, now: string) {
    const source = this.find("thread", p.id);
    const boundary = p.boundary as Row | undefined;
    const items = this.rows("item")
      .filter((item) => item.threadId === p.id)
      .sort((a, b) => Number(a.seq) - Number(b.seq));
    const end = boundary?.turnId
      ? items.findIndex((item) => item.kind === "user" && item.turnId === boundary.turnId)
      : items.length;
    if (end < 0) throw new Error("fork_boundary_unavailable");
    const operationId = `fork-${this.snapshot.seq + 1}`;
    const childThreadId = `${operationId}-thread`;
    const session = this.rows("session").find((row) => row.threadId === p.id);
    const kind = p.kind === "copied" || p.destinationProfileId ? "copied" : "native";
    this.put(
      "thread",
      {
        ...source,
        ...(p.destinationProfileId ? { agentId: p.destinationProfileId } : {}),
        id: childThreadId,
        title: typeof p.title === "string" ? p.title : `${String(source.title)} · fork`,
        titleSource: "human",
        createdAt: now,
        lastActivityAt: now,
        fork: {
          kind,
          ...(kind === "copied" ? { copiedMessages: end, omittedMessages: 0 } : {}),
          operationId,
          sourceThreadId: String(p.id),
          sourceSessionId: String(session?.id ?? "none"),
          cwd: String(session?.cwd ?? "/"),
          boundary: boundary ?? { kind: "latest" },
          permissionCeiling: "workspace_write",
          inheritedHistoryPresent: end > 0,
        },
      },
      "created",
    );
    // Inherited messages are display history, kept beside the child as zoltd does.
    this.forkHistory.set(childThreadId, structuredClone(items.slice(0, end)));
    return {
      id: operationId,
      kind,
      sourceThreadId: String(p.id),
      childThreadId,
      boundary: boundary ?? { kind: "latest" },
      title: String(this.find("thread", childThreadId).title),
      state: "ready",
      createdAt: now,
    };
  }

  private send(threadId: string, input: Row[], now: string, steer: boolean) {
    const thread = this.find("thread", threadId);
    const running = this.rows("turn").find(
      (turn) => turn.threadId === threadId && turn.status === "running",
    );
    const seq = () =>
      Math.max(
        0,
        ...this.rows("item")
          .filter((i) => i.threadId === threadId)
          .map((i) => Number(i.seq)),
      ) + 1;
    const turnId = `turn-${this.snapshot.seq + 1}`;
    const user = { id: `item-${turnId}-user`, threadId, seq: seq(), kind: "user" };
    if (running) {
      // A running turn: steering lands in it where the agent allows it, else the input waits.
      const session = this.rows("session").find((row) => row.id === running.sessionId);
      const steers = steer && (session?.capabilities as Row | undefined)?.steer === "native";
      const body = { input, mode: steer ? "steer" : "queue", queueState: "queued" };
      this.put("item", { ...user, body, createdAt: now, updatedAt: now }, "created");
      if (steers)
        this.later(this.options.replyDelayMs ?? 900, () => {
          const item = this.find("item", user.id);
          if ((item.body as Row).queueState !== "queued") return;
          this.put("item", {
            ...item,
            turnId: running.id,
            body: { ...(item.body as Row), queueState: "sent", deliveryMode: "steer" },
            updatedAt: this.at(),
          });
        });
      return { id: user.id, disposition: "queued" };
    }
    this.put(
      "item",
      { ...user, turnId, body: { input, queueState: "sent" }, createdAt: now, updatedAt: now },
      "created",
    );
    this.put(
      "turn",
      {
        id: turnId,
        threadId,
        sessionId: `session-${threadId}`,
        status: "running",
        origin: "human",
        startedAt: now,
      },
      "created",
    );
    this.put("thread", { ...thread, lastActivityAt: now });
    const reply = {
      id: `item-${turnId}-reply`,
      threadId,
      turnId,
      seq: seq(),
      kind: "message",
      createdAt: now,
      updatedAt: now,
    };
    const delay = this.options.replyDelayMs ?? 900;
    this.later(delay, () =>
      this.put(
        "item",
        { ...reply, body: { text: "On it. Reading the project first", streaming: true } },
        "created",
      ),
    );
    this.later(delay * 3, () => {
      const turn = this.find("turn", turnId);
      if (turn.status !== "running") return;
      this.put("item", {
        ...reply,
        body: { text: "On it. I read the project and I am ready for the next step." },
        updatedAt: this.at(),
      });
      this.put("turn", { ...turn, status: "completed", endedAt: this.at() });
    });
    // zoltd queues every human input and reports how it was delivered on the item later.
    return { id: user.id, disposition: "queued" };
  }
}

const stable = (value: unknown): string =>
  Array.isArray(value)
    ? `[${value.map(stable).join(",")}]`
    : value && typeof value === "object"
      ? `{${Object.keys(value)
          .sort()
          .map((key) => `${JSON.stringify(key)}:${stable((value as Row)[key])}`)
          .join(",")}}`
      : (JSON.stringify(value) ?? "undefined");
