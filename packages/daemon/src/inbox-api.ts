import type { DomainState } from "@zoltbot/core";
import { handle } from "@zoltbot/core/commands";
import {
  type ActorRef,
  type DomainEvent,
  type InteractionAnswer,
  inboxRows,
  type Mailbox,
  type ReplyAnswer,
  skippedPointer,
  threadFacts,
  type UserInput,
} from "@zoltbot/protocol";
import type { Store } from "@zoltbot/store";

type Row = Record<string, unknown>;
type Call = (
  method: string,
  params: Record<string, unknown>,
  commandId: string,
) => Promise<unknown>;
const owner: ActorRef = { kind: "human", id: "local-owner" };
const system: ActorRef = { kind: "system", id: "inbox" };
const threadMethods = new Set([
  "thread.markRead",
  "thread.markUnread",
  "thread.snooze",
  "thread.settle",
  "thread.unarchive",
  "thread.inbox",
  "thread.reply",
]);
// Mailbox changes come from turns, requests and the thread itself; nothing else moves a thread.
const watched = new Set(["thread", "turn", "interaction"]);
// Inbox reads and writes never need message history.
const noItems = { items: { ids: [] } };

/** The Inbox: thread read state, snooze, settle, the mailbox list and replies. */
export function inboxApi(host: {
  store: Store;
  publish(events: DomainEvent[]): void;
  /** `interaction.batchAnswer`, through the interaction engine so providers hear the answers. */
  answer?: Call;
  /** `turn.send`, through the runtime so the reply is queued or steered like any message. */
  send?: Call;
}) {
  const { store } = host;
  const update = (
    commandId: string,
    id: string,
    next: (thread: Row, state: DomainState) => Row | undefined,
    actor = owner,
  ) => {
    const before = store.lastSeq();
    const receipt = store.dispatch(
      commandId,
      (state) => {
        const thread = state.thread?.find((row) => row.id === id);
        if (!thread) throw new Error("not_found: thread");
        const changes = next(thread, state);
        if (!changes) return { events: [], result: thread };
        return handle(
          state,
          { type: "update", kind: "thread", id, changes },
          { commandId, at: new Date().toISOString(), actor },
        );
      },
      noItems,
    );
    host.publish(store.eventsSince(before));
    return receipt.result as Row;
  };

  const settle = (commandId: string, id: string, actor = owner) => {
    let archived = false;
    const thread = update(
      commandId,
      id,
      (row, state) => {
        const facts = threadFacts(state);
        if (facts.pending(id) || facts.working(id)) {
          if (row.archiveWhenIdle) return undefined;
          return { archiveWhenIdle: true };
        }
        archived = true;
        if (row.archived && !row.archiveWhenIdle) return undefined;
        return { archived: true, archiveWhenIdle: undefined, snoozedUntil: undefined };
      },
      actor,
    );
    return { thread, archived: archived || thread.archived === true };
  };

  const inbox = (params: Record<string, unknown>) => {
    const limit = typeof params.limit === "number" ? params.limit : 50,
      start = Number(params.cursor ?? 0) || 0;
    const { items, counts, more } = inboxRows(store.snapshot(["thread", "turn", "interaction"]), {
      preview: (ids) => {
        const latest = store.latestItems(ids, "message"),
          texts = new Map<string, string>();
        for (const [id, item] of latest) {
          const body = item.body as { text?: unknown } | undefined;
          if (typeof body?.text === "string") texts.set(id, body.text);
        }
        return texts;
      },
      ...(typeof params.mailbox === "string" ? { mailbox: params.mailbox as Mailbox } : {}),
      ...(typeof params.projectId === "string" ? { projectId: params.projectId } : {}),
      start,
      limit,
    });
    return { items, counts, ...(more ? { cursor: String(start + limit) } : {}) };
  };

  /**
   * One reply: answers the questions it quotes, then sends the whole letter as one message.
   * Each step has its own command id under the reply's, so retrying a reply replays what landed.
   */
  const reply = async (params: Record<string, unknown>, commandId: string) => {
    if (!host.answer || !host.send) throw new Error("reply_unavailable");
    const threadId = String(params.threadId),
      body = typeof params.body === "string" ? params.body.trim() : "",
      answers = (Array.isArray(params.answers) ? params.answers : []) as ReplyAnswer[],
      attachments = (Array.isArray(params.attachments) ? params.attachments : []) as UserInput;
    if (!body && !attachments.length) throw new Error("empty_reply");
    const state = store.snapshot(["thread", "interaction"]);
    const thread = state.thread?.find((row) => row.id === threadId);
    if (!thread) throw new Error("not_found: thread");
    // Check every quoted request before changing anything, so a stale reply changes nothing.
    for (const entry of answers) {
      const request = state.interaction?.find((row) => row.id === entry.interactionId);
      if (!request || request.threadId !== threadId) throw new Error("not_found: interaction");
      if (request.type !== "question") throw new Error("reply_answers_questions_only");
      if (request.state !== "pending" || request.version !== entry.version)
        throw new Error("stale_interaction: answer it again from the newest letter");
    }
    if (thread.archived || thread.archiveWhenIdle)
      update(`${commandId}:unarchive`, threadId, () => ({
        archived: false,
        archiveWhenIdle: undefined,
      }));
    const at = new Date().toISOString();
    if (answers.length)
      await host.answer(
        "interaction.batchAnswer",
        {
          items: answers.map((entry) => ({
            id: entry.interactionId,
            version: entry.version,
            answer: (entry.answers && Object.keys(entry.answers).length
              ? { action: "accept", answers: entry.answers, by: owner, at }
              : {
                  action: "decline",
                  feedback: skippedPointer,
                  by: owner,
                  at,
                }) satisfies InteractionAnswer,
          })),
        },
        `${commandId}:answers`,
      );
    const sent = (await host.send(
      "turn.send",
      {
        threadId,
        input: [...(body ? [{ type: "text", text: body }] : []), ...attachments],
        mode: params.mode === "steer" ? "steer" : "queue",
      },
      `${commandId}:send`,
    )) as { id: string; disposition: "started" | "queued" | "handled" };
    if (params.settle === true) settle(`${commandId}:settle`, threadId);
    return { ...sent, resolved: answers.map((entry) => entry.interactionId) };
  };

  // Threads settled while working are archived once their work ends and nothing is waiting.
  let sweeping = false;
  const observe = (events: DomainEvent[]) => {
    if (sweeping || !events.some((event) => watched.has(event.aggregateType))) return;
    queueMicrotask(() => {
      sweeping = true;
      try {
        const state = store.snapshot(["thread", "turn", "interaction"]);
        const facts = threadFacts(state);
        for (const thread of state.thread ?? []) {
          const id = String(thread.id);
          if (!thread.archiveWhenIdle || facts.pending(id) || facts.working(id)) continue;
          settle(`inbox-settle:${id}:${store.lastSeq()}`, id, system);
        }
      } finally {
        sweeping = false;
      }
    });
  };

  const api = async (method: string, params: Record<string, unknown>, commandId?: string) => {
    if (!threadMethods.has(method)) return undefined;
    if (method === "thread.inbox") return inbox(params);
    if (!commandId) throw new Error("command_id_required");
    if (method === "thread.reply") return reply(params, commandId);
    if (typeof params.id !== "string") throw new Error("invalid_params");
    const id = params.id;
    switch (method) {
      case "thread.markRead": {
        const at = typeof params.at === "string" ? params.at : new Date().toISOString();
        // Reads only move forward, so a slow device cannot mark newer work unread.
        return update(commandId, id, (row) =>
          String(row.lastReadAt ?? "") >= at ? undefined : { lastReadAt: at },
        );
      }
      case "thread.markUnread":
        return update(commandId, id, (_row, state) => {
          const endedAt = threadFacts(state).endedAt(id);
          if (!endedAt) return { lastReadAt: undefined };
          return { lastReadAt: new Date(Date.parse(endedAt) - 1).toISOString() };
        });
      case "thread.snooze": {
        const until = typeof params.until === "string" ? params.until : undefined;
        return update(commandId, id, () => ({ snoozedUntil: until }));
      }
      case "thread.settle":
        return settle(commandId, id);
      case "thread.unarchive":
        return update(commandId, id, (row) =>
          row.archived || row.archiveWhenIdle
            ? { archived: false, archiveWhenIdle: undefined }
            : undefined,
        );
    }
    return undefined;
  };
  return { api, observe, settle };
}
