import { STAFF_ALLOWANCE_OPTION, STAFF_APPROVAL_ITEM } from "@zoltbot/protocol";
import { text } from "@zoltbot/ui/chat/types";
import type { AnswerDraft } from "./interactions.js";
import type { Row } from "./transport.js";

// Staff approvals: a manager asks to add, change or archive one employee and the owner answers
// the approval. The request and its preview live in the interaction's context, as on the Mac
// (zolt/staff-view.ts).

export type StaffKind = "add" | "change" | "archive";
export interface StaffField {
  label: string;
  before?: string;
  after?: string;
}
export interface StaffCardData {
  requestId: string;
  version: number;
  action: StaffKind;
  state: "pending" | "approved" | "declined";
  title: string;
  name: string;
  /** The chat that asked. */
  threadId: string;
  requestedBy: string;
  requestedByThread: string;
  fields: StaffField[];
  moves: { title: string; to: string }[];
  running: number;
  sharedWith: number;
  /** For an add: what ticking "Let … add more without asking" grants. */
  allowance: { max: number; models: string[]; folders: string[] } | null;
}

const record = (value: unknown): Row =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Row) : {};
const rows = (value: unknown): Row[] => (Array.isArray(value) ? (value as Row[]) : []);
const strings = (value: unknown) => (Array.isArray(value) ? value.map(text).filter(Boolean) : []);
const KINDS: StaffKind[] = ["add", "change", "archive"];

function staffOf(interaction: Row | undefined): Row | undefined {
  const stored = record(record(record(interaction?.context).toolInput).staffChange);
  return stored.preview ? stored : undefined;
}
export const isStaffApproval = (interaction: Row | undefined) => staffOf(interaction) !== undefined;

export function toStaffCard(interaction: Row): StaffCardData | undefined {
  const stored = staffOf(interaction);
  if (!stored) return undefined;
  const preview = record(stored.preview);
  const action = KINDS.find((kind) => kind === preview.kind);
  if (!action) return undefined;
  const resolution = record(interaction.resolution);
  const offer = record(preview.allowanceOffer);
  const requester = record(preview.requestedBy);
  return {
    requestId: text(interaction.id),
    version: Number(interaction.version) || 1,
    action,
    state:
      interaction.state === "pending"
        ? "pending"
        : interaction.state === "answered" && resolution.action === "accept"
          ? "approved"
          : "declined",
    title: text(interaction.title) || "Team change",
    name: text(preview.name),
    threadId: text(interaction.threadId),
    requestedBy: text(requester.name),
    requestedByThread: text(requester.threadId) || text(interaction.threadId),
    fields: rows(preview.fields).map((row) => ({
      label: text(row.label),
      ...(text(row.before) ? { before: text(row.before) } : {}),
      ...(text(row.after) ? { after: text(row.after) } : {}),
    })),
    moves: rows(preview.moves).map((row) => ({ title: text(row.title), to: text(row.to) })),
    running: Number(preview.running) || 0,
    sharedWith: Number(preview.sharedWith) || 0,
    allowance:
      typeof offer.max === "number"
        ? { max: offer.max, models: strings(offer.models), folders: strings(offer.folders) }
        : null,
  };
}

/**
 * The rows an approval shows. An add already names the employee in its title, so its Name row
 * goes; the rest keep the daemon's order with Reports to after Role, as the card reads.
 */
export function cardFields(card: StaffCardData): StaffField[] {
  if (card.action !== "add") return card.fields;
  const order = ["Role", "Reports to", "Model", "Can edit", "First task"];
  const rank = (label: string) => {
    const at = order.indexOf(label);
    return at < 0 ? order.length : at;
  };
  return card.fields
    .filter((row) => row.label !== "Name")
    .sort((a, b) => rank(a.label) - rank(b.label));
}

/** "Add Juno to Web?" */
export const askTitle = (card: StaffCardData) =>
  card.title.endsWith("?") ? card.title : `${card.title}?`;

export function approveLabel(card: StaffCardData) {
  return card.action === "add"
    ? `Add ${card.name}`
    : card.action === "archive"
      ? `Archive ${card.name}`
      : "Apply";
}

/** The answer a card sends; ticking the box grants the offered allowance. */
export function staffAnswer(approve: boolean, grantAllowance: boolean): AnswerDraft {
  if (!approve) return { action: "decline", choice: "reject_once" };
  return {
    action: "accept",
    choice: "allow_once",
    ...(grantAllowance
      ? { answers: { [STAFF_APPROVAL_ITEM]: { options: [STAFF_ALLOWANCE_OPTION] } } }
      : {}),
  };
}

/**
 * A follow-up `staff.allowance` call when the person changed the offered number, so the manager
 * can add exactly that many. Undefined when the grant already says it.
 */
export function allowanceChange(card: StaffCardData, grant: boolean, max: number) {
  if (!grant || !card.allowance || max === card.allowance.max) return undefined;
  return {
    threadId: card.requestedByThread,
    max,
    models: card.allowance.models,
    folders: card.allowance.folders,
  };
}
