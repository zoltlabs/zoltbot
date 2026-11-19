import {
  STAFF_ALLOWANCE_OPTION,
  STAFF_ALLOWANCE_PREFIX,
  STAFF_APPROVAL_ITEM,
} from "@zoltbot/protocol";
import type { ConversationMessage } from "../shared/ipc";
import type {
  StaffActionInput,
  StaffCard,
  StaffKind,
  StaffOverview,
  StaffPerson,
} from "../shared/staff";
import { companyTree } from "./company-tree";
import type { Row, Snapshot } from "./daemon-client";

const text = (value: unknown): string => (typeof value === "string" ? value : "");
const record = (value: unknown): Row =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Row) : {};
const list = (value: unknown): Row[] => (Array.isArray(value) ? (value as Row[]) : []);
const KINDS: StaffKind[] = ["add", "change", "archive"];

/** The stored staff request behind an approval, or undefined for any other approval. */
function staffOf(interaction: Row): Row | undefined {
  const stored = record(record(record(interaction.context).toolInput).staffChange);
  return stored.preview ? stored : undefined;
}
export const isStaffApproval = (interaction: Row) => staffOf(interaction) !== undefined;

export function toStaffCard(interaction: Row): StaffCard | undefined {
  const stored = staffOf(interaction);
  if (!stored) return undefined;
  const preview = record(stored.preview);
  const action = KINDS.find((kind) => kind === preview.kind);
  if (!action) return undefined;
  const resolution = record(interaction.resolution);
  const state =
    interaction.state === "pending"
      ? "pending"
      : interaction.state === "answered" && resolution.action === "accept"
        ? "approved"
        : "declined";
  const offer = record(preview.allowanceOffer);
  return {
    kind: "staff",
    requestId: text(interaction.id),
    action,
    state,
    title: text(interaction.title) || "Team change",
    name: text(preview.name),
    projectId: text(preview.projectId),
    botId: text(interaction.threadId),
    requestedBy: text(record(preview.requestedBy).name),
    fields: list(preview.fields).map((row) => ({
      label: text(row.label),
      ...(text(row.before) ? { before: text(row.before) } : {}),
      ...(text(row.after) ? { after: text(row.after) } : {}),
    })),
    moves: list(preview.moves).map((row) => ({ title: text(row.title), to: text(row.to) })),
    running: Number(preview.running) || 0,
    sharedWith: Number(preview.sharedWith) || 0,
    allowance: typeof offer.max === "number" ? offer.max : null,
  };
}

/** Adds each staff approval this chat asked for as a card, where it was asked. */
export function withStaffCards(
  snapshot: Snapshot,
  threadId: string,
  messages: ConversationMessage[],
): ConversationMessage[] {
  const cards = (snapshot.entities.interaction ?? [])
    .filter((row) => row.threadId === threadId)
    .map((row) => ({ row, card: toStaffCard(row) }))
    .filter((entry): entry is { row: Row; card: StaffCard } => entry.card !== undefined);
  if (!cards.length) return messages;
  const result = messages.slice();
  for (const { row, card } of cards) {
    const createdAt = text(row.createdAt);
    const index = result.findIndex((message) => message.createdAt > createdAt);
    result.splice(index < 0 ? result.length : index, 0, {
      id: `card:staff:${card.requestId}`,
      author: "assistant",
      source: "system",
      text: "",
      createdAt,
      status: "completed",
      card,
    } as ConversationMessage);
  }
  return result;
}

/** The project a staff row belongs to, so its panel and the Tasks page refresh. */
export function staffProject(kind: string, row: Row): string | undefined {
  if (kind === "interaction" && isStaffApproval(row))
    return text(record(record(staffOf(row)).preview).projectId);
  if (kind === "settings" && text(row.key).startsWith(STAFF_ALLOWANCE_PREFIX))
    return text(record(row.value).projectId);
  return undefined;
}

/** Pending approvals (one project, or every project) and the people of a project. */
export function toStaffOverview(snapshot: Snapshot, projectId: string | null): StaffOverview {
  const interactions = snapshot.entities.interaction ?? [];
  const approvals = interactions
    .filter((row) => row.state === "pending")
    .map(toStaffCard)
    .filter((card): card is StaffCard => !!card && (!projectId || card.projectId === projectId))
    .sort((a, b) => a.requestId.localeCompare(b.requestId));
  if (!projectId) return { approvals, people: [] };
  const pending = new Map<string, StaffKind>();
  for (const card of approvals) {
    const target = text(
      record(record(staffOf(interactions.find((r) => r.id === card.requestId) ?? {})).request)
        .threadId,
    );
    if (target && card.action !== "add") pending.set(target, card.action);
  }
  const profiles = new Map((snapshot.entities.agent ?? []).map((row) => [text(row.id), row]));
  const teams = new Map((snapshot.entities.subproject ?? []).map((row) => [text(row.id), row]));
  const allowance = (threadId: string) => {
    const value = record(
      (snapshot.entities.settings ?? []).find(
        (row) => row.key === `${STAFF_ALLOWANCE_PREFIX}${threadId}`,
      )?.value,
    );
    return typeof value.max === "number" && value.max > 0
      ? { max: value.max, used: Number(value.used) || 0 }
      : null;
  };
  const tree = companyTree(snapshot).entries.filter((entry) => entry.projectId === projectId);
  const people = (snapshot.entities.thread ?? [])
    .filter(
      (thread) =>
        thread.archived !== true &&
        thread.projectId === projectId &&
        (thread.kind === "manager" || thread.kind === "side"),
    )
    .map((thread): StaffPerson => {
      const id = text(thread.id);
      const node = record(thread.node);
      const team = node.type === "subproject" ? teams.get(text(node.id)) : undefined;
      const profile = profiles.get(text(thread.agentId));
      const role =
        tree.find((entry) => entry.thread.id === id)?.role === "ceo"
          ? "ceo"
          : thread.kind === "manager"
            ? "manager"
            : "employee";
      return {
        botId: id,
        name: text(thread.title) || text(profile?.name) || "Untitled chat",
        role,
        teamId: team ? text(team.id) : null,
        teamName: text(team?.name),
        model: text(profile?.model),
        roleText: text(profile?.roleText),
        instructions: text(profile?.instructions),
        archiving: thread.archiveWhenIdle === true,
        pending: pending.get(id) ?? null,
        allowance: thread.kind === "manager" ? allowance(id) : null,
      };
    })
    .sort(
      (a, b) =>
        ["ceo", "manager", "employee"].indexOf(a.role) -
          ["ceo", "manager", "employee"].indexOf(b.role) ||
        a.teamName.localeCompare(b.teamName) ||
        a.name.localeCompare(b.name),
    );
  return { approvals, people };
}

export function parseStaffAction(value: unknown): StaffActionInput {
  const input = record(value);
  const need = (field: string) => {
    const found = input[field];
    if (typeof found !== "string" || !found.trim()) throw new Error(`${field} is required.`);
    return found;
  };
  const optional = (field: string, limit: number) => {
    const found = input[field];
    if (found === undefined) return {};
    if (typeof found !== "string" || found.length > limit) throw new Error(`${field} is invalid.`);
    return { [field]: found };
  };
  if (input.action === "approve")
    return {
      action: "approve",
      requestId: need("requestId"),
      grantAllowance: input.grantAllowance === true,
    };
  if (input.action === "decline") return { action: "decline", requestId: need("requestId") };
  if (input.action === "change")
    return {
      action: "change",
      threadId: need("threadId"),
      ...optional("name", 150),
      ...optional("role", 300),
      ...optional("model", 100),
      ...optional("instructions", 4000),
    };
  if (input.action === "archive")
    return {
      action: "archive",
      threadId: need("threadId"),
      ...(input.moveTo === undefined ? {} : { moveTo: need("moveTo") }),
    };
  if (input.action === "allowance") {
    if (!Number.isInteger(input.max) || Number(input.max) < 0 || Number(input.max) > 20)
      throw new Error("max is invalid.");
    return { action: "allowance", threadId: need("threadId"), max: Number(input.max) };
  }
  throw new Error("Unknown staff action.");
}

const OWNER = { kind: "human", id: "local-owner" };
/**
 * Sends a staff action to the daemon. Clicking Approve, Decline, Save or Archive is the owner's
 * confirmation. An answer's command id repeats for a repeated click, so it runs once.
 */
export async function runStaffAction(
  call: (method: string, params: unknown, commandId?: string) => Promise<unknown>,
  interactions: Row[],
  input: StaffActionInput,
): Promise<void> {
  if (input.action === "approve" || input.action === "decline") {
    const interaction = interactions.find((row) => row.id === input.requestId);
    if (!interaction || interaction.state !== "pending")
      throw new Error("This request was already answered.");
    const at = new Date().toISOString();
    await call(
      "interaction.answer",
      {
        id: input.requestId,
        version: interaction.version,
        answer:
          input.action === "approve"
            ? {
                action: "accept",
                choice: "allow_once",
                ...(input.grantAllowance
                  ? { answers: { [STAFF_APPROVAL_ITEM]: { options: [STAFF_ALLOWANCE_OPTION] } } }
                  : {}),
                by: OWNER,
                at,
              }
            : { action: "decline", by: OWNER, at },
      },
      `shell:staff:${input.requestId}:${input.action}`,
    );
    return;
  }
  if (input.action === "allowance") {
    await call(
      "staff.allowance",
      { threadId: input.threadId, max: input.max },
      `shell:staff-allowance:${input.threadId}:${input.max}:${Date.now()}`,
    );
    return;
  }
  const { action, ...request } = input;
  await call(
    "staff.apply",
    { request: { kind: action, ...request } },
    `shell:staff:${action}:${input.threadId}:${JSON.stringify(request).length}:${Date.now()}`,
  );
}
