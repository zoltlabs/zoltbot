import { createHash } from "node:crypto";
import type { InteractionAnswer } from "@zoltbot/protocol";
import { type ChiefState, chiefThreadId } from "./identity.js";

/** What an approved action does, stored on the approval so the answer can apply it. */
export type ChiefAction =
  | {
      tool: "chief_start_chat";
      chatId: string;
      projectId: string;
      node: { type: "project" | "subproject"; id: string };
      title: string;
      brief: string;
      profileId: string;
    }
  | { tool: "chief_message_chat"; chatId: string; text: string; messageId: string }
  | { tool: "chief_stop_chat"; chatId: string; turnId: string }
  | { tool: "chief_answer"; items: ChiefRelayedAnswer[] };
/** One answer the user stated, checked against the item's version when they confirm. */
export interface ChiefRelayedAnswer {
  interactionId: string;
  version: number;
  title: string;
  summary: string;
  answer: Omit<InteractionAnswer, "by" | "at">;
}

export const verbs: Record<ChiefAction["tool"], string> = {
  chief_start_chat: "start a chat",
  chief_message_chat: "message a chat",
  chief_stop_chat: "stop a chat",
  chief_answer: "send your answers",
};
export const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const text = (value: unknown) => (typeof value === "string" ? value : "");
export const refusal = (error: string, extra: Record<string, unknown> = {}) => ({
  error,
  ...extra,
});
/** Results stay under the dispatcher's 4,000 character bound. */
export function bounded<T extends Record<string, unknown>>(result: T, list: keyof T): T {
  while (JSON.stringify(result).length > 3800 && (result[list] as unknown[]).length) {
    (result as Record<string, unknown>)[list as string] = (result[list] as unknown[]).slice(
      0,
      Math.floor((result[list] as unknown[]).length / 2),
    );
    (result as Record<string, unknown>).truncated = true;
  }
  return result;
}
export function liveThread(state: ChiefState, id: string) {
  const self = chiefThreadId(state);
  return state.thread?.find((row) => row.id === id && !row.archived && row.id !== self);
}
export function describe(state: ChiefState, action: ChiefAction): string {
  const title = (id: string) => `"${text(liveThread(state, id)?.title) || id}"`;
  if (action.tool === "chief_answer")
    return `Send these ${action.items.length === 1 ? "answer" : `${action.items.length} answers`} for you:\n\n${action.items
      .map((item, index) => `${index + 1}. "${item.title}": ${item.summary}`)
      .join("\n")}`;
  if (action.tool === "chief_start_chat") {
    const where =
      action.node.type === "subproject"
        ? text(state.subproject?.find((row) => row.id === action.node.id)?.name)
        : text(state.project?.find((row) => row.id === action.projectId)?.name);
    return `Start chat "${action.title}" in ${where || action.node.id} with this brief:\n\n${action.brief}`;
  }
  if (action.tool === "chief_message_chat")
    return `Send ${title(action.chatId)} this message:\n\n${action.text}`;
  return `Stop the running turn in ${title(action.chatId)}.`;
}

export type Row = Record<string, unknown>;
export const titleOf = (row: Row) =>
  (
    text(row.title) ||
    text((row.items as { prompt?: string }[] | undefined)?.[0]?.prompt) ||
    "Request"
  )
    .replace(/\s+/g, " ")
    .slice(0, 100);
/** Turns a decision the user stated into the answer the app's own buttons would send. */
export function relayedAnswer(
  row: Row,
  input: { decision: "approve" | "decline" | "answer"; choice?: string; text?: string },
): ChiefRelayedAnswer | { error: string; options?: string[] } {
  const items = (row.items ?? []) as {
    id: string;
    secret?: boolean;
    options?: { id: string; label: string }[];
    allowOther?: boolean;
    choices?: { id: string }[];
  }[];
  if (row.state !== "pending") return { error: "not_pending" };
  if (items.some((item) => item.secret)) return { error: "private_answer_open_it" };
  const words = input.text?.trim();
  const feedback = words ? { feedback: words } : {};
  const base = {
    interactionId: text(row.id),
    version: Number(row.version),
    title: titleOf(row),
  };
  if (input.decision === "decline")
    return {
      ...base,
      summary: words ? `decline, saying "${words}"` : "decline",
      answer: { action: "decline", ...feedback },
    };
  if (row.type === "approval" || row.type === "plan") {
    if (input.decision !== "approve") return { error: "approve_or_decline" };
    const once = items.some((item) => item.choices?.some((choice) => choice.id === "allow_once"));
    return {
      ...base,
      summary: words ? `approve once, saying "${words}"` : "approve once",
      answer: { action: "accept", ...(once ? { choice: "allow_once" } : {}), ...feedback },
    };
  }
  if (row.type !== "question" || items.length !== 1) return { error: "open_it_to_answer" };
  const item = items[0] as (typeof items)[number];
  const options = item.options ?? [];
  if (input.choice) {
    const wanted = input.choice.trim().toLowerCase();
    const option = options.find(
      (entry) => entry.id.toLowerCase() === wanted || entry.label.trim().toLowerCase() === wanted,
    );
    if (!option) return { error: "unknown_option", options: options.map((entry) => entry.id) };
    return {
      ...base,
      summary: `answer "${option.label}"`,
      answer: { action: "accept", answers: { [item.id]: { options: [option.id] } } },
    };
  }
  if (!words) return { error: "choice_or_text_required" };
  if (options.length && !item.allowOther)
    return { error: "choose_an_option", options: options.map((entry) => entry.id) };
  return {
    ...base,
    summary: `answer "${words}"`,
    answer: { action: "accept", answers: { [item.id]: { other: words } } },
  };
}
