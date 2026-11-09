import { createHash } from "node:crypto";
import { handle } from "@zoltbot/core";
import type { ToolActor } from "@zoltbot/hostmcp";
import type { RuntimeContext } from "../api.js";
import { refreshTaint } from "../knowledge-taint.js";
import { type ChiefState, chiefKeys, chiefThreadId, setting, settingCommand } from "./identity.js";

// What leads send up to Zolt: ideas, updates and questions.
// Nothing here reaches the person directly; Zolt reads it in its digest and promotes good ideas.

export type ChiefInboxKind = "idea" | "update" | "question";
export interface ChiefInboxEntry {
  id: string;
  kind: ChiefInboxKind;
  fromThread: string;
  fromTitle: string;
  /** "Workspace › Team". */
  place: string;
  text: string;
  at: string;
  /** `new` until Zolt promotes, drops or marks it done; ideas then record your answer. */
  status: "new" | "promoted" | "dropped" | "done";
  /** The sender had read content Zoltbot cannot vouch for. */
  untrusted?: boolean;
  /** The question Zolt raised for a promoted idea. */
  interactionId?: string;
  answer?: "start" | "later" | "never";
}
export const inboxLimits = {
  ideasPerDay: 3,
  perMinute: 10,
  /** Entries kept; the oldest handled ones go first. */
  kept: 100,
};
const text = (value: unknown) => (typeof value === "string" ? value : "");

export function chiefInbox(state: ChiefState): ChiefInboxEntry[] {
  const value = setting(state, chiefKeys.inbox) as { entries?: unknown } | undefined;
  return Array.isArray(value?.entries) ? (value.entries as ChiefInboxEntry[]) : [];
}
/** Keeps every new entry, then the newest handled ones, up to the limit. */
export function trimInbox(entries: ChiefInboxEntry[]): ChiefInboxEntry[] {
  if (entries.length <= inboxLimits.kept) return entries;
  const drop = new Set(
    entries
      .filter((entry) => entry.status !== "new")
      .sort((a, b) => a.at.localeCompare(b.at))
      .slice(0, entries.length - inboxLimits.kept)
      .map((entry) => entry.id),
  );
  return entries.filter((entry) => !drop.has(entry.id)).slice(-inboxLimits.kept);
}

/** `team_message` with `to: "chief"`: any workspace chat can reach Zolt, which has no authority to grant. */
export async function sendToChief(
  context: RuntimeContext,
  actor: ToolActor,
  input: { key: string; text: string; kind: ChiefInboxKind },
) {
  const now = new Date(),
    at = now.toISOString();
  const id = `inbox-${createHash("sha256")
    .update(JSON.stringify([actor.threadId, input.key]))
    .digest("hex")
    .slice(0, 24)}`;
  const untrusted = !!refreshTaint(context.store, actor.sessionId);
  const check = await context.privacy.prepareData(input.text);
  const commandId = `chief-inbox:${id}`,
    before = context.store.lastSeq();
  const receipt = context.store.dispatch<Record<string, unknown>>(commandId, (state) => {
    check(state);
    const chief = chiefThreadId(state);
    if (!chief) return { events: [], result: { error: "no_chief" } };
    const thread = state.thread?.find((row) => row.id === actor.threadId && !row.archived);
    if (!thread || !thread.projectId || thread.id === chief)
      return { events: [], result: { error: "workspace_chat_required" } };
    const entries = chiefInbox(state);
    if (entries.some((entry) => entry.id === id)) return { events: [], result: { id } };
    const mine = entries.filter((entry) => entry.fromThread === actor.threadId);
    if (
      mine.filter((entry) => Date.parse(entry.at) > now.getTime() - 60_000).length >=
      inboxLimits.perMinute
    )
      return { events: [], result: { error: "rate_limited" } };
    const today = now.toLocaleDateString("en-CA");
    if (
      input.kind === "idea" &&
      mine.filter(
        (entry) =>
          entry.kind === "idea" && new Date(entry.at).toLocaleDateString("en-CA") === today,
      ).length >= inboxLimits.ideasPerDay
    )
      return {
        events: [],
        result: { error: "idea_limit", why: "Three ideas a day; send only the best ones." },
      };
    const project = state.project?.find((row) => row.id === thread.projectId);
    const team =
      (thread.node as { type?: string } | undefined)?.type === "subproject"
        ? state.subproject?.find((row) => row.id === (thread.node as { id?: unknown }).id)
        : undefined;
    const entry: ChiefInboxEntry = {
      id,
      kind: input.kind,
      fromThread: text(thread.id),
      fromTitle: text(thread.title) || "Chat",
      place: [text(project?.name), text(team?.name)].filter(Boolean).join(" › "),
      text: input.text.trim().slice(0, 2000),
      at,
      status: "new",
      ...(untrusted ? { untrusted: true } : {}),
    };
    const out = handle(
      state,
      settingCommand(state, chiefKeys.inbox, { entries: trimInbox([...entries, entry]) }),
      { commandId, at, actor: { kind: "agent", id: actor.agentId } },
    );
    return { events: out.events, result: { id } };
  });
  context.publish(context.store.eventsSince(before));
  if (receipt.result.error) return receipt.result;
  return {
    messageId: receipt.result.id,
    to: "chief",
    delivered: "queued",
    note:
      input.kind === "question"
        ? "The main agent reads it when it next runs; any answer comes as a message."
        : "The main agent reviews it on its next turn.",
  };
}
