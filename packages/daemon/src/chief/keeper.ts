import { randomUUID } from "node:crypto";
import { applyEvents, type DomainState, handle } from "@zoltbot/core";
import type { DomainEvent } from "@zoltbot/protocol";
import type { Store } from "@zoltbot/store";
import {
  type ChiefState,
  chiefKeys,
  chiefName,
  chiefThreadId,
  settingCommand,
} from "./identity.js";

// Every person has one Zolt. The daemon creates its chat as soon as an agent profile exists,
// refuses to archive or delete it. chief.clear (clear.ts) swaps in a fresh chat.

const system = { kind: "system", id: "chief-keeper" } as const;
const kinds = ["settings", "thread", "agent", "agentDefinition"] as const;

/** A profile to run Zolt with: Claude Code first, since it handles long threads well. */
export function chiefProfile(state: ChiefState): string | undefined {
  const profiles = (state.agent ?? []).filter((row) => !row.archived && !row.hidden);
  const adapter = (row: Record<string, unknown>) =>
    state.agentDefinition?.find((definition) => definition.id === row.definitionId)?.adapter;
  const chosen = profiles.find((row) => adapter(row) === "claude") ?? profiles[0];
  return typeof chosen?.id === "string" ? chosen.id : undefined;
}

/** The thread the chief.thread setting names, whether or not it is live. */
function pointedThread(state: ChiefState) {
  const id = state.settings?.find((row) => row.key === chiefKeys.thread)?.value;
  return typeof id === "string" ? state.thread?.find((row) => row.id === id) : undefined;
}

function chiefChat(state: ChiefState, id: string, agentId: string, at: string) {
  return {
    id,
    agentId,
    kind: "main" as const,
    title: chiefName(state),
    titleSource: "human" as const,
    pinned: false,
    archived: false,
    createdAt: at,
    lastActivityAt: at,
  };
}

/**
 * Events that leave a live chief chat: none when one exists, the pointed chat unarchived when
 * it was archived before archiving was refused, or a new chat when there is none.
 */
export function ensureChiefEvents(
  state: DomainState,
  commandId: string,
  at: string,
  newId: () => string = randomUUID,
): { events: DomainEvent[]; threadId?: string } {
  const live = chiefThreadId(state);
  if (live) return { events: [], threadId: live };
  const context = { commandId, at, actor: system };
  const pointed = pointedThread(state);
  if (pointed?.archived && !pointed.projectId && !pointed.fork && !pointed.taskId) {
    const id = String(pointed.id);
    const { events } = handle(
      state,
      {
        type: "update",
        kind: "thread",
        id,
        changes: { archived: false, archiveWhenIdle: undefined },
      },
      context,
    );
    return { events, threadId: id };
  }
  const agentId = chiefProfile(state);
  if (!agentId) return { events: [] };
  return newChiefChat(state, context, agentId, newId());
}

export function newChiefChat(
  state: DomainState,
  context: { commandId: string; at: string; actor: { kind: "system"; id: string } },
  agentId: string,
  id: string,
): { events: DomainEvent[]; threadId: string } {
  const created = handle(
    state,
    { type: "create", kind: "thread", value: chiefChat(state, id, agentId, context.at) },
    { ...context, commandId: `${context.commandId}:chat` },
  );
  const next = applyEvents(state, created.events);
  const pointer = handle(next, settingCommand(next, chiefKeys.thread, id), {
    ...context,
    commandId: `${context.commandId}:pointer`,
  });
  return { events: [...created.events, ...pointer.events], threadId: id };
}

/** Create Zolt's chat when it is missing. Returns its thread id, or undefined with no profile. */
export function ensureChief(host: {
  store: Store;
  publish(events: DomainEvent[]): void;
  now?: () => Date;
}): string | undefined {
  const snapshot = host.store.snapshot([...kinds]);
  const live = chiefThreadId(snapshot);
  if (live) return live;
  const commandId = `chief:ensure:${randomUUID()}`;
  const at = (host.now?.() ?? new Date()).toISOString();
  const before = host.store.lastSeq();
  const receipt = host.store.dispatch(commandId, (state) => {
    const { events, threadId } = ensureChiefEvents(state, commandId, at);
    return { events, result: { threadId } };
  });
  host.publish(host.store.eventsSince(before));
  return (receipt.result as { threadId?: string }).threadId;
}

/**
 * Every person has one Zolt: create its chat at start, soon after the person changes anything
 * (such as adding their first agent), and on the waker's timer in case it went missing.
 */
export function chiefKeeper(host: {
  store: Store;
  publish(events: DomainEvent[]): void;
  onError?: (code: string) => void;
}) {
  let closed = false;
  let pending: ReturnType<typeof setTimeout> | undefined;
  const keep = () => {
    if (closed) return;
    try {
      ensureChief(host);
    } catch {
      host.onError?.("chief_ensure_failed");
    }
  };
  keep();
  return {
    keep,
    /** After a command from the person, once it has had time to land. */
    soon() {
      if (closed || pending) return;
      pending = setTimeout(() => {
        pending = undefined;
        keep();
      }, 500);
      pending.unref?.();
    },
    close() {
      closed = true;
      if (pending) clearTimeout(pending);
    },
  };
}

/** Whether a thread is Zolt's chat, so it cannot be archived or deleted. */
export function isChiefThread(state: ChiefState, id: string): boolean {
  return chiefThreadId(state) === id;
}

/** Zolt's earlier chats, newest first, as chief.clear recorded them. */
export function previousChiefChats(state: ChiefState): string[] {
  const value = state.settings?.find((row) => row.key === chiefKeys.previous)?.value;
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
}
