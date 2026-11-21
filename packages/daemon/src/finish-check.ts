// C11: when a turn ends on a promise ("I'll run the tests now") with nothing done after it, the
// agent gets one "Continue." so the work happens without the person asking. At most once for each
// message the person sends, and never in forks, asides, task chats or read-only agents.
import { type DomainState, queueSystemNotice } from "@zoltbot/core";
import type { DomainEvent } from "@zoltbot/protocol";
import type { Store } from "@zoltbot/store";

/** Settings row that turns the check off for one agent. Absent means on. */
export const continueSettingKey = (agentId: string) => `agent.continue.${agentId}`;

/** The text sent to the agent. Short on purpose: it counts toward the injected-text budget (I9). */
export const CONTINUE_TEXT = "Continue.";

const PROMISE =
  /^(?:i['’]ll|i will|let me|next,? i|next step:? i['’]ll|now,? i['’]ll|now,? let me|i['’]m (?:now )?going to)\b/i;
// Sign-offs and promises to hold back are not unfinished work.
const SIGN_OFF =
  /^(?:let me know|i['’]ll (?:wait|stop|leave|be here|hold|keep an eye)|i will (?:not|wait|stop|leave|be here|hold)|i won['’]t)\b/i;

/** Whether a reply's last sentence promises work the turn never did. Questions never count. */
export function endsOnPromise(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || trimmed.endsWith("?")) return false;
  const lines = trimmed.split(/\n+/).filter((line) => line.trim());
  const last = (lines.at(-1) ?? "").replace(/^[\s>*\-•\d.)]+/, "");
  const sentences = last.split(/(?<=[.!…])\s+/).filter(Boolean);
  const final = (sentences.at(-1) ?? "").trim();
  return PROMISE.test(final) && !SIGN_OFF.test(final) && !final.includes("?");
}

type Row = Record<string, unknown>;
const text = (value: unknown) => (typeof value === "string" ? value : "");
const fromOwner = (row: Row) => {
  const origin = (row.body as Row | undefined)?.origin;
  return origin === undefined || origin === "human";
};

/**
 * The owner message this turn answered, when the turn left a promise behind and should be
 * continued. Undefined when nothing should happen. `state` needs the thread's user items and its
 * latest item (`store.runtimeSnapshot`), not its whole history.
 */
export function unfinishedTurn(state: DomainState, turnId: string): Row | undefined {
  const turn = state.turn?.find((row) => row.id === turnId);
  if (!turn || turn.status !== "completed") return undefined;
  const thread = state.thread?.find((row) => row.id === turn.threadId);
  if (!thread || thread.archived || thread.fork || thread.taskId) return undefined;
  if (thread.kind !== "main" && thread.kind !== "side") return undefined;
  const agent = state.agent?.find((row) => row.id === thread.agentId);
  if (!agent || agent.permissionProfile === "read_only") return undefined;
  const off = state.settings?.find((row) => row.key === continueSettingKey(String(agent.id)));
  if (off?.value === false) return undefined;
  // Only the thread's latest turn, and only once nothing else is running there.
  const turns = (state.turn ?? []).filter((row) => row.threadId === thread.id);
  if (turns.some((row) => row.status === "running" || text(row.startedAt) > text(turn.startedAt)))
    return undefined;
  if (
    state.interaction?.some(
      (row) => row.threadId === thread.id && (row.turnId === turnId || row.state === "pending"),
    )
  )
    return undefined;
  const items = (state.item ?? [])
    .filter((row) => row.threadId === thread.id)
    .sort((a, b) => Number(a.seq) - Number(b.seq));
  // The reply must be the last thing in the chat: no tool call, question or new message after it.
  const reply = items.at(-1);
  if (!reply || reply.kind !== "message" || reply.turnId !== turnId) return undefined;
  if (!endsOnPromise(text((reply.body as Row)?.text))) return undefined;
  // The input that started the turn must be the person's own, not a teammate's or a notice.
  const input = items.findLast((row) => row.kind === "user" && Number(row.seq) < Number(reply.seq));
  return input && fromOwner(input) ? input : undefined;
}

interface Options {
  store: Store;
  publish(events: DomainEvent[]): void;
  wake(threadId: string): Promise<unknown>;
  now?: () => string;
  onError?: (code: string) => void;
}

/** Watches finished turns and queues the one follow-up. */
export function finishCheck(options: Options) {
  let closed = false;
  const system = { kind: "system" as const, id: "finish-check" };
  function check(turnId: string) {
    const turn = options.store.record("turn", turnId);
    if (!turn) return;
    const threadId = String(turn.threadId);
    const owner = unfinishedTurn(options.store.runtimeSnapshot(threadId), turnId);
    if (!owner) return;
    const commandId = `finish-check:${String(owner.id)}`;
    if (options.store.receipt(commandId)) return;
    const at = options.now?.() ?? new Date().toISOString();
    const before = options.store.lastSeq();
    options.store.dispatch(
      commandId,
      (current) => {
        // Checked again inside the write, so a message sent meanwhile wins.
        if (unfinishedTurn(current, turnId)?.id !== owner.id)
          return { events: [], result: undefined };
        return queueSystemNotice(
          current,
          { threadId, text: CONTINUE_TEXT, notice: { kind: "continue" } },
          `${commandId}:input`,
          { commandId, at, actor: system },
        );
      },
      { items: { ids: [], latestInThread: threadId, controlsInThread: threadId } },
    );
    const events = options.store.eventsSince(before);
    if (!events.length) return;
    options.publish(events);
    void options.wake(threadId).catch(() => options.onError?.("finish_check_wake_failed"));
  }
  return {
    /** Work is deferred so publishing never nests. */
    observe(events: readonly DomainEvent[]) {
      if (closed) return;
      const done = events
        .filter(
          (event) =>
            event.aggregateType === "turn" &&
            (event.payload as { status?: unknown }).status === "completed",
        )
        .map((event) => event.aggregateId);
      if (!done.length) return;
      setImmediate(() => {
        if (closed) return;
        for (const turnId of done) {
          try {
            check(turnId);
          } catch {
            options.onError?.("finish_check_failed");
          }
        }
      });
    },
    close() {
      closed = true;
    },
  };
}
