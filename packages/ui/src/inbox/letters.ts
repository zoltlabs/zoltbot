import type { ReplyAnswer } from "@zoltbot/protocol";
import { body, type Row, text } from "../chat/types.js";

/** One side's run of turns between the other side's: what a mail client shows as one message. */
export interface Letter {
  id: string;
  from: "you" | "agent";
  items: Row[];
  at: string;
  /** First line, for a collapsed letter. */
  summary: string;
  tools: number;
  /** Still waiting to reach the agent. */
  queued: boolean;
}

const queuedStates = new Set(["queued", "sending", "uncertain"]);

export function itemText(item: Row) {
  const value = body(item);
  if (item.kind === "user")
    return (Array.isArray(value.input) ? (value.input as Row[]) : [])
      .map((part) => text(part.text))
      .filter(Boolean)
      .join("\n");
  return text(value.text);
}

const firstLine = (value: string) =>
  value
    .split("\n")
    .map((line) => line.replace(/^[>#*\-\s]+/, "").trim())
    .find(Boolean) ?? "";

/** Groups a thread's items, oldest first, into letters. Thoughts and tool calls stay in their letter. */
export function lettersFrom(items: Row[]): Letter[] {
  const letters: Letter[] = [];
  for (const item of [...items].sort((a, b) => Number(a.seq) - Number(b.seq))) {
    const from = item.kind === "user" ? "you" : "agent",
      queued = from === "you" && queuedStates.has(text(body(item).queueState)),
      last = letters.at(-1);
    if (!last || last.from !== from || last.queued !== queued)
      letters.push({
        id: text(item.id),
        from,
        items: [item],
        at: text(item.createdAt),
        summary: "",
        tools: 0,
        queued,
      });
    else last.items.push(item);
  }
  for (const letter of letters) {
    letter.tools = letter.items.filter((item) => item.kind === "tool").length;
    const words = letter.items
      .filter((item) => item.kind === "user" || item.kind === "message")
      .map(itemText)
      .filter(Boolean);
    // A notice from the main agent is what that letter is for; the rest is its notes.
    const notice = letter.items.findLast(
      (item) => item.kind === "note" && body(item).code === "chief_notify",
    );
    letter.summary =
      firstLine(notice ? itemText(notice) : (words.at(-1) ?? words[0] ?? "")) ||
      (letter.tools ? "Worked" : "");
  }
  return letters;
}

/** One question item from a pending request, numbered across the thread as Q1, Q2… */
export interface QuestionRef {
  n: number;
  interaction: Row;
  item: Row;
}

/** The thread's pending questions a reply can answer. Secret items stay on their own card. */
export function replyQuestions(interactions: Row[] | undefined, threadId: string): QuestionRef[] {
  let n = 0;
  return (interactions ?? [])
    .filter(
      (row) =>
        row.threadId === threadId &&
        row.state === "pending" &&
        row.type === "question" &&
        !(Array.isArray(row.items) ? (row.items as Row[]) : []).some((item) => item.secret),
    )
    .sort((a, b) => text(a.createdAt).localeCompare(text(b.createdAt)))
    .flatMap((interaction) =>
      (Array.isArray(interaction.items) ? (interaction.items as Row[]) : []).map((item) => ({
        n: ++n,
        interaction,
        item,
      })),
    );
}

export interface Draft {
  /** Picked option ids and typed text, per question number. */
  picks: Record<number, string[]>;
  other: Record<number, string>;
  /** Question numbers quoted into the reply. */
  quoted: number[];
  /** Plain-text quotes taken from letters. */
  quotes: string[];
  extra: string;
}

export const emptyDraft = (questions: QuestionRef[]): Draft => ({
  picks: {},
  other: {},
  quoted: questions.map((question) => question.n),
  quotes: [],
  extra: "",
});

const quote = (value: string) =>
  value
    .trim()
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");

function answerText(question: QuestionRef, draft: Draft) {
  const options = Array.isArray(question.item.options) ? (question.item.options as Row[]) : [];
  const labels = (draft.picks[question.n] ?? []).map(
    (id) => text(options.find((option) => text(option.id) === id)?.label) || id,
  );
  return [...labels, draft.other[question.n]?.trim() ?? ""].filter(Boolean).join(", ");
}

/**
 * The letter and the structured answers one send carries. Every quoted question is answered or,
 * when left empty, skipped; questions not quoted stay pending.
 */
export function buildReply(questions: QuestionRef[], draft: Draft) {
  const blocks: string[] = [],
    skipped: number[] = [];
  const byInteraction = new Map<string, ReplyAnswer>();
  for (const question of questions) {
    if (!draft.quoted.includes(question.n)) continue;
    const id = text(question.interaction.id),
      entry = byInteraction.get(id) ?? {
        interactionId: id,
        version: Number(question.interaction.version),
      };
    byInteraction.set(id, entry);
    const answer = answerText(question, draft);
    if (!answer) {
      skipped.push(question.n);
      continue;
    }
    blocks.push(`${quote(`Q${question.n} · ${text(question.item.prompt)}`)}\n\n${answer}`);
    const picks = draft.picks[question.n] ?? [],
      other = draft.other[question.n]?.trim();
    entry.answers = {
      ...entry.answers,
      [text(question.item.id)]: {
        ...(picks.length ? { options: picks } : {}),
        ...(other ? { other } : {}),
      },
    };
  }
  for (const value of draft.quotes) if (value.trim()) blocks.push(quote(value));
  if (draft.extra.trim()) blocks.push(draft.extra.trim());
  if (skipped.length) blocks.push(`Not answered yet: ${skipped.map((n) => `Q${n}`).join(", ")}.`);
  // A request with several items is answered whole: one skipped item leaves the rest answered.
  return { body: blocks.join("\n\n"), answers: [...byInteraction.values()], skipped };
}
