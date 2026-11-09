import { body, text } from "@zoltbot/ui/chat/types";
import { chiefWakePrefix } from "@zoltbot/ui/chief/data";
import { type ArtifactCard, artifactOccurrences, artifactReference } from "./artifacts.js";
import { diffTotals } from "./interactions.js";
import type { Row, Snapshot } from "./transport.js";

// Thread items as transcript rows. Interactive tools and interaction items read as one compact
// line, subagent items nest under the tool that started them, and plan items are left to the
// pinned checklist. Only normalized fields are read (I4).

export interface TranscriptRow {
  id: string;
  kind: "user" | "message" | "thought" | "tool" | "interaction" | "artifact" | "other";
  text: string;
  streaming: boolean;
  artifact?: ArtifactCard;
  compareId?: string;
  wake?: boolean;
  wakeEvidence?: string;
  artifactReference?: string;
  unanchored?: boolean;
  status?: "running" | "ok" | "failed";
  added?: number;
  removed?: number;
  /** Items a subagent produced under this tool, in order. */
  children?: TranscriptRow[];
  /** For interaction rows: still waiting for the person. */
  pending?: boolean;
  /** For your messages: how they reached the agent ("Queued", "Steered"), when worth saying. */
  delivery?: string;
  /** For your messages: still waiting in the queue, so it can be taken back and edited. */
  queued?: boolean;
  /** For your sent messages: the turn they started, so a new chat can start from before it. */
  turnId?: string;
  /** Zoltbot's own notice to the agent (a wake-up, the brief), shown as an event. */
  event?: "brief" | "wake" | "notice";
  /** Zolt's morning brief: a message in the turn the brief wake-up started. */
  brief?: boolean;
}

/** What happened to a message you sent, read from the item, never from the send result. */
export function deliveryLabel(value: Row): string | undefined {
  const state = text(value.queueState);
  if (state === "queued") return "Queued";
  if (state === "sending") return "Sending";
  if (state === "uncertain") return "Delivery needs review";
  if (state === "failed") return value.errorCode === "cancelled" ? "Cancelled" : "Not sent";
  if (value.deliveryMode === "steer") return "Steered";
  if (state === "handled") return "Command handled";
  return undefined;
}

export function toolTitle(item: Row): string {
  const value = body(item);
  const input = (value.input ?? {}) as Row;
  const running = value.status === "running";
  const target = text(value.title) || text(input.command) || text(input.path);
  const verb: Record<string, [string, string]> = {
    read: ["Reading", "Read"],
    edit: ["Editing", "Edited"],
    execute: ["Running", "Ran"],
    search: ["Searching", "Searched"],
    fetch: ["Fetching", "Fetched"],
    agent: ["Delegating", "Delegated"],
  };
  const words = verb[text(value.kind)];
  if (words && target) return `${running ? words[0] : words[1]} ${target}`;
  if (text(value.title)) return text(value.title);
  return [text(value.name) || "Tool", target].filter(Boolean).join(" ");
}

const askedLabels: Record<string, string> = {
  question: "Asked a question",
  plan: "Proposed a plan",
  approval: "Asked for approval",
  form: "Asked for details",
  gate: "Asked for sign-off",
};
/** "Asked a question · Answered" for an interaction row, from its saved state. */
export function interactionLine(interaction: Row | undefined): string {
  const type = text(interaction?.type);
  const asked = askedLabels[type] ?? "Asked you something";
  if (!interaction) return asked;
  const resolution = (interaction.resolution ?? {}) as Row;
  const action = text(resolution.action);
  const state = text(interaction.state);
  const outcome =
    state === "pending"
      ? "Waiting for you"
      : state === "expired" || action === "expire" || action === "timeout"
        ? "Ended"
        : state === "cancelled" || action === "cancel"
          ? "Skipped"
          : action === "decline"
            ? type === "plan"
              ? "Sent back"
              : type === "approval"
                ? "Denied"
                : "Declined"
            : type === "plan"
              ? "Approved"
              : type === "approval"
                ? "Allowed"
                : "Answered";
  return `${asked} · ${outcome}`;
}

/** +N −M over patch or before/after diffs, the same count the approval card shows. */
function diffCounts(value: Row) {
  const { added, removed } = diffTotals(
    Array.isArray(value.diffs) ? (value.diffs as Row[]) : undefined,
  );
  return added || removed ? { added, removed } : {};
}

function userText(value: Row) {
  const parts = Array.isArray(value.input) ? (value.input as Row[]) : [];
  return parts
    .map((part) =>
      part.type === "image"
        ? "Photo"
        : part.type === "file"
          ? text(part.path).split("/").pop()
          : text(part.text),
    )
    .join("\n");
}

export function transcript(snapshot: Snapshot, threadId: string): TranscriptRow[] {
  const items = (snapshot.entities.item ?? [])
    .filter((item) => item.threadId === threadId)
    .sort((a, b) => Number(a.seq) - Number(b.seq));
  const interactions = new Map(
    (snapshot.entities.interaction ?? []).map((row) => [text(row.id), row]),
  );
  // An interactive tool links to its interaction through interaction.nativeRef.
  const byNativeRef = new Map(
    (snapshot.entities.interaction ?? [])
      .filter((row) => row.threadId === threadId && text(row.nativeRef))
      .map((row) => [text(row.nativeRef), row]),
  );
  const shownInteractions = new Set(
    items
      .filter((item) => item.kind === "interaction")
      .map((item) => text(body(item).interactionId)),
  );
  // Turns that already show an interaction item do not also need the interactive tool line.
  const askedTurns = new Set(
    items
      .filter((item) => item.kind === "interaction" && text(item.turnId))
      .map((item) => text(item.turnId)),
  );
  const briefTurns = new Set(
    items
      .filter((item) => text(item.id).startsWith(`${chiefWakePrefix}brief:`) && text(item.turnId))
      .map((item) => text(item.turnId)),
  );
  const rows = new Map<string, TranscriptRow>();
  const byNative = new Map<string, TranscriptRow>();
  const top: TranscriptRow[] = [];
  for (const item of items) {
    const value = body(item);
    const base = { id: text(item.id), streaming: value.streaming === true };
    let row: TranscriptRow | undefined;
    if (item.kind === "plan") continue;
    if (item.kind === "user") {
      const said = userText(value);
      // Zoltbot's own notices to an agent are events, not your words (desktop MessageRow).
      if (value.origin !== "agent" && said.startsWith("[Zoltbot] ")) {
        const woke = text(item.id).startsWith(chiefWakePrefix);
        const lines = said.slice("[Zoltbot] ".length).split("\n");
        top.push({
          ...base,
          kind: "other",
          event: text(item.id).startsWith(`${chiefWakePrefix}brief:`)
            ? "brief"
            : woke
              ? "wake"
              : "notice",
          // A wake-up's first line only tells the agent it is one; the rest is why.
          text: (woke ? lines.slice(1) : lines).join("\n").trim(),
        });
        continue;
      }
      const reference = artifactReference(snapshot, value.artifactTarget);
      const delivery = value.origin === "agent" ? undefined : deliveryLabel(value);
      row = {
        ...base,
        kind: "user",
        text: said,
        ...(reference ? { artifactReference: reference } : {}),
        ...(delivery ? { delivery } : {}),
        ...(value.queueState === "queued" ? { queued: true } : {}),
        // Only a message that reached the agent marks a point a new chat can start from.
        ...(value.origin !== "agent" &&
        text(item.turnId) &&
        ["sent", "handled", ""].includes(text(value.queueState))
          ? { turnId: text(item.turnId) }
          : {}),
      };
    } else if (item.kind === "message" || item.kind === "thought")
      row = {
        ...base,
        kind: item.kind,
        text: text(value.text),
        ...(item.kind === "message" && briefTurns.has(text(item.turnId)) ? { brief: true } : {}),
      };
    else if (item.kind === "interaction") {
      const interaction = interactions.get(text(value.interactionId));
      row = {
        ...base,
        kind: "interaction",
        text: interactionLine(interaction),
        pending: interaction?.state === "pending",
      };
    } else if (item.kind === "tool" && value.interactive === true) {
      const linked = byNativeRef.get(text(value.nativeItemId));
      // The interaction item already shows this request, so the tool needs no second line.
      if (linked ? shownInteractions.has(text(linked.id)) : askedTurns.has(text(item.turnId)))
        continue;
      row = {
        ...base,
        kind: "interaction",
        text: linked ? interactionLine(linked) : toolTitle(item),
        pending: linked ? linked.state === "pending" : value.status === "running",
      };
    } else if (item.kind === "tool") {
      const status =
        value.status === "running" ? "running" : value.status === "ok" ? "ok" : "failed";
      row = { ...base, kind: "tool", text: toolTitle(item), status, ...diffCounts(value) };
    } else if (item.kind === "note" && value.code === "chief_notify") {
      // What the main agent sent you reads as its message.
      row = { ...base, kind: "message", text: text(value.text) };
    } else if (item.kind === "note" && value.code === "wake") {
      row = {
        ...base,
        kind: "other",
        text: text(value.text),
        wake: true,
        ...(text(value.evidenceUrl) ? { wakeEvidence: text(value.evidenceUrl) } : {}),
      };
    } else if (item.kind === "note" && value.code === "compare") {
      row = {
        ...base,
        kind: "other",
        compareId: text(value.compareId),
        text: `Compared ${String(value.count)} answers · continued here. The other answers are kept as side chats.`,
      };
    } else row = { ...base, kind: "other", text: text(value.text) || text(item.kind) };
    rows.set(row.id, row);
    if (text(value.nativeItemId)) byNative.set(text(value.nativeItemId), row);
    const parentId = text(value.parentItemId);
    const parent = parentId ? (rows.get(parentId) ?? byNative.get(parentId)) : undefined;
    if (parent && parent !== row) {
      parent.children ??= [];
      parent.children.push(row);
    } else top.push(row);
  }
  const roots = new Map<string, TranscriptRow>();
  const indexRoot = (row: TranscriptRow, root: TranscriptRow) => {
    roots.set(row.id, root);
    for (const child of row.children ?? []) indexRoot(child, root);
  };
  for (const row of top) indexRoot(row, row);
  const anchors = new Map<string, string>();
  for (const item of items) {
    const root = roots.get(text(item.id));
    if (root && text(item.turnId)) anchors.set(text(item.turnId), root.id);
  }
  const after = new Map<string, TranscriptRow[]>();
  const unanchored: TranscriptRow[] = [];
  for (const occurrence of artifactOccurrences(snapshot, threadId)) {
    const anchor = anchors.get(occurrence.turnId);
    const row: TranscriptRow = {
      id: occurrence.id,
      kind: "artifact",
      text: occurrence.artifact.title,
      streaming: false,
      artifact: occurrence.artifact,
      ...(!anchor ? { unanchored: true } : {}),
    };
    if (anchor) after.set(anchor, [...(after.get(anchor) ?? []), row]);
    else unanchored.push(row);
  }
  return [...top.flatMap((row) => [row, ...(after.get(row.id) ?? [])]), ...unanchored];
}

/** "3 steps · 1 running" for a collapsed subagent group. */
export function childSummary(children: readonly TranscriptRow[]): string {
  const running = children.filter((row) => row.status === "running").length;
  const failed = children.filter((row) => row.kind === "tool" && row.status === "failed").length;
  return [
    `${children.length} ${children.length === 1 ? "step" : "steps"}`,
    running ? `${running} running` : "",
    failed ? `${failed} failed` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}
