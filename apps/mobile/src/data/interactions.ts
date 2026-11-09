import { checkFlatForm, type Interaction, type InteractionAnswer } from "@zoltbot/protocol";
import { text } from "@zoltbot/ui/chat/types";
import type { Row, Snapshot } from "./transport.js";

// Pure helpers for answering interactions on the phone. Everything reads normalized fields
// (type, items, choices, context), never provider or tool names (I4).

export type InteractionType = Interaction["type"];
export type InteractionItem = Interaction["items"][number];
export type ItemAnswer = NonNullable<InteractionAnswer["answers"]>[string];
/** What a card submits; `by` and `at` are added when it is sent. */
export type AnswerDraft = Omit<InteractionAnswer, "at" | "by">;

const kinds: readonly InteractionType[] = ["question", "approval", "plan", "form", "gate"];
export const interactionType = (row: Row): InteractionType =>
  kinds.includes(row.type as InteractionType) ? (row.type as InteractionType) : "question";

/** Short chip label for each kind, shared by Overview and the chat card. */
export const typeLabels: Record<InteractionType, string> = {
  question: "Question",
  approval: "Approval",
  plan: "Plan",
  form: "Form",
  gate: "Sign-off",
};
export const defaultTitles: Record<InteractionType, string> = {
  question: "A question for you",
  approval: "Approval needed",
  plan: "Review the plan",
  form: "Details needed",
  gate: "Review this request",
};

/** Pending interactions of one thread, oldest first, as protocol rows. */
export function pendingFor(snapshot: Snapshot, threadId: string): Interaction[] {
  return (snapshot.entities.interaction ?? [])
    .filter((row) => row.threadId === threadId && row.state === "pending")
    .sort((a, b) => text(a.createdAt).localeCompare(text(b.createdAt))) as unknown as Interaction[];
}

/** Choice ids offered across all items, with the native label when there is one. */
export function offeredChoices(request: Pick<Interaction, "items">): Map<string, string> {
  const out = new Map<string, string>();
  for (const item of request.items)
    for (const choice of item.choices ?? [])
      if (!out.has(choice.id)) out.set(choice.id, "label" in choice ? text(choice.label) : "");
  return out;
}

/** The approval buttons a card shows, in order. Only offered choices appear (Deny always does). */
export function approvalButtons(request: Pick<Interaction, "items">) {
  const choices = offeredChoices(request);
  const session = choices.get("allow_session");
  return {
    allowOnce: choices.has("allow_once") || choices.size === 0,
    allowSession: choices.has("allow_session"),
    sessionLabel: session ? `Allow for session: ${session}` : "Allow for session",
    acceptEdits: choices.has("allow_accept_edits"),
  };
}

/** Plan buttons: auto-accept edits only when offered; Approve sends allow_once when offered. */
export function planAnswer(
  kind: "approve" | "approve_edits" | "keep_planning" | "reject",
  request: Pick<Interaction, "items">,
  feedback: string,
): AnswerDraft {
  const note = feedback.trim() ? { feedback: feedback.trim() } : {};
  const choices = offeredChoices(request);
  if (kind === "approve_edits") return { action: "accept", choice: "allow_accept_edits", ...note };
  if (kind === "approve")
    return {
      action: "accept",
      ...(choices.has("allow_once") ? { choice: "allow_once" } : {}),
      ...note,
    };
  if (kind === "keep_planning") return { action: "decline", ...note };
  return {
    action: "decline",
    ...(choices.has("reject_once") ? { choice: "reject_once" } : {}),
    ...note,
  };
}

export function approvalAnswer(
  kind: "allow_once" | "allow_session" | "deny",
  feedback = "",
): AnswerDraft {
  if (kind === "deny")
    return {
      action: "decline",
      choice: "reject_once",
      ...(feedback.trim() ? { feedback: feedback.trim() } : {}),
    };
  return { action: "accept", choice: kind };
}

/** Recommended options start selected (one for single choice questions). */
export function initialAnswers(items: readonly InteractionItem[]): Record<string, ItemAnswer> {
  return Object.fromEntries(
    items.map((item) => [
      item.id,
      {
        options: (item.options ?? [])
          .filter((option) => option.recommended)
          .slice(0, item.multi ? undefined : 1)
          .map((option) => option.id),
      },
    ]),
  );
}

/** Radio semantics for single choice (and drops typed text), checkbox semantics for multi. */
export function chooseOption(item: InteractionItem, value: ItemAnswer, id: string): ItemAnswer {
  const selected = value.options ?? [];
  if (!item.multi) return { options: [id] };
  return {
    ...value,
    options: selected.includes(id) ? selected.filter((entry) => entry !== id) : [...selected, id],
  };
}

/** Typing "Other" replaces a single choice; on multi it adds to the checked options. */
export function typeOther(item: InteractionItem, value: ItemAnswer, typed: string): ItemAnswer {
  if (item.secret) return { value: typed };
  return item.multi ? { ...value, other: typed } : { other: typed };
}

export const otherAllowed = (item: InteractionItem) =>
  item.allowOther !== false || !item.options?.length;

export function answered(value: ItemAnswer | undefined): boolean {
  if (!value) return false;
  return (
    Boolean(value.options?.length) ||
    Boolean(value.other?.trim()) ||
    (typeof value.value === "string" && Boolean(value.value.trim()))
  );
}

/** What the review step shows for one item. Secrets never show their value. */
export function answerSummary(item: InteractionItem, value: ItemAnswer | undefined): string {
  if (item.secret) return answered(value) ? "Private answer provided" : "No answer";
  const labels = (item.options ?? [])
    .filter((option) => value?.options?.includes(option.id))
    .map((option) => option.label);
  const other = value?.other?.trim();
  return [...labels, ...(other ? [other] : [])].join(", ") || "No answer";
}

/** Trims typed text and drops empty fields so the daemon gets a clean answer. */
export function questionAnswer(
  items: readonly InteractionItem[],
  answers: Record<string, ItemAnswer>,
): AnswerDraft {
  const out: Record<string, ItemAnswer> = {};
  for (const item of items) {
    const value = answers[item.id] ?? {};
    const other = value.other?.trim();
    out[item.id] = {
      ...(value.options?.length ? { options: value.options } : {}),
      ...(other ? { other } : {}),
      ...(value.value !== undefined ? { value: value.value } : {}),
    };
  }
  return { action: "accept", answers: out };
}

export interface DiffLine {
  type: "add" | "del" | "hunk" | "context";
  text: string;
}
/** A diff as colored lines and +N −M counts; before/after without a patch shows both sides. */
export function diffView(diff: { path: string; before?: string; after?: string; patch?: string }) {
  const lines: DiffLine[] = [];
  if (diff.patch !== undefined) {
    for (const line of diff.patch.split("\n")) {
      if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff "))
        lines.push({ type: "hunk", text: line });
      else if (line.startsWith("@@")) lines.push({ type: "hunk", text: line });
      else if (line.startsWith("+")) lines.push({ type: "add", text: line });
      else if (line.startsWith("-")) lines.push({ type: "del", text: line });
      else lines.push({ type: "context", text: line });
    }
  } else {
    for (const line of diff.before ? diff.before.split("\n") : [])
      lines.push({ type: "del", text: `-${line}` });
    for (const line of diff.after ? diff.after.split("\n") : [])
      lines.push({ type: "add", text: `+${line}` });
  }
  return {
    path: diff.path,
    lines,
    added: lines.filter((line) => line.type === "add").length,
    removed: lines.filter((line) => line.type === "del").length,
  };
}

/** Totals over a list of diffs, for an Overview preview line. */
export function diffTotals(diffs: readonly Row[] | undefined) {
  let added = 0,
    removed = 0;
  for (const diff of diffs ?? []) {
    const view = diffView({
      path: text(diff.path),
      ...(typeof diff.patch === "string" ? { patch: diff.patch } : {}),
      ...(typeof diff.before === "string" ? { before: diff.before } : {}),
      ...(typeof diff.after === "string" ? { after: diff.after } : {}),
    });
    added += view.added;
    removed += view.removed;
  }
  return { files: diffs?.length ?? 0, added, removed };
}

/**
 * A synchronous one-at-a-time latch. React state updates land after the next render, so two
 * fast taps could both see busy === false; this flips immediately.
 */
export function singleFlight() {
  let running = false;
  return {
    enter() {
      if (running) return false;
      running = true;
      return true;
    },
    leave() {
      running = false;
    },
  };
}

/** Error text for a failed answer. The card stays so the person can retry or review. */
export function answerError(error: unknown): string {
  const code = error instanceof Error ? error.message : String(error ?? "");
  if (/conflict|stale|version/i.test(code))
    return "This request changed or was answered on another device. Check the thread before answering again.";
  if (/offline|not connected|did not answer/i.test(code))
    return `${code.replace(/\.$/, "")}. Your answer was not sent.`;
  if (code.includes("private_value_requires_secure_field"))
    return "Keep private values in the masked field. Your draft is kept.";
  return "Your answer could not be confirmed. Your draft is kept, so you can try again.";
}

// Forms: flat JSON Schema objects or one primitive, checked by the same rules as the daemon.

const record = (value: unknown): Row =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Row) : {};
export interface FormField {
  id: string;
  label: string;
  description: string;
  type: "string" | "number" | "integer" | "boolean" | "enum";
  options: unknown[];
  required: boolean;
}
export function formSupported(item: InteractionItem): boolean {
  try {
    checkFlatForm(item.schema, undefined);
    return true;
  } catch {
    return false;
  }
}
export function formFields(item: InteractionItem): FormField[] {
  const schema = record(item.schema);
  const object = schema.type === "object";
  const required = Array.isArray(schema.required) ? schema.required : [];
  const entries = object
    ? Object.entries(record(schema.properties)).map(([id, value]) => [id, record(value)] as const)
    : ([["$", schema]] as const);
  return entries.map(([id, field]) => ({
    id,
    label: text(field.title) || (object ? id : "Value"),
    description: text(field.description),
    type: Array.isArray(field.enum)
      ? "enum"
      : ((["number", "integer", "boolean"].includes(text(field.type))
          ? text(field.type)
          : "string") as FormField["type"]),
    options: Array.isArray(field.enum) ? field.enum : [],
    required: !object || required.includes(id),
  }));
}
/** Valid declared defaults, so an untouched form can still be accepted when they suffice. */
export function formDefaults(item: InteractionItem): unknown {
  const schema = record(item.schema);
  const ok = (field: Row) => {
    try {
      return field.default !== undefined && checkFlatForm(field, field.default);
    } catch {
      return false;
    }
  };
  if (schema.type !== "object") return ok(schema) ? schema.default : undefined;
  return Object.fromEntries(
    Object.entries(record(schema.properties)).flatMap(([id, value]) =>
      ok(record(value)) ? [[id, record(value).default]] : [],
    ),
  );
}
/** Reads a typed field back into the value the schema expects (numbers parse, blanks drop). */
export function fieldValue(field: FormField, typed: string): unknown {
  if (field.type === "number" || field.type === "integer") {
    if (!typed.trim()) return undefined;
    const number = Number(typed);
    return Number.isFinite(number) ? number : typed;
  }
  return typed;
}
/**
 * What a text field shows: the raw typed text while it still reads as the stored value, so
 * drafts like "1." or "-" survive the round trip through a number; else the stored value.
 */
export function fieldText(field: FormField, raw: string | undefined, value: unknown): string {
  if (raw !== undefined && Object.is(fieldValue(field, raw), value)) return raw;
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}
export function setField(item: InteractionItem, current: unknown, id: string, next: unknown) {
  if (record(item.schema).type !== "object") return next;
  const fields = { ...record(current), [id]: next };
  if (next === undefined) delete fields[id];
  return fields;
}
export function readField(item: InteractionItem, current: unknown, id: string): unknown {
  return record(item.schema).type === "object" ? record(current)[id] : current;
}
export function formValid(item: InteractionItem, value: unknown): boolean {
  try {
    return checkFlatForm(item.schema, value);
  } catch {
    return false;
  }
}
export function formAnswer(
  items: readonly InteractionItem[],
  values: Record<string, unknown>,
): AnswerDraft {
  return {
    action: "accept",
    answers: Object.fromEntries(items.map((item) => [item.id, { value: values[item.id] }])),
  };
}
