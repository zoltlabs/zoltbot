import type { InteractionAnswer } from "@zoltbot/protocol";
import { type ChiefState, chiefKeys, setting } from "./identity.js";

// Zolt's order and recommendations on Needs you, and how your
// decisions compared with them (2c). One daemon-owned settings row; resolved items are kept a
// while so the agreement rate and lessons can read them.

export type ChiefRank = "now" | "today" | "later";
export const chiefRanks: readonly ChiefRank[] = ["now", "today", "later"];
export interface ChiefRecommendation {
  decision: "approve" | "decline" | "answer";
  /** A question option id, for `answer`. */
  choice?: string;
  /** A drafted reply: the answer text, or feedback sent with an approval. */
  text?: string;
}
export interface ChiefOutcome {
  /** `skipped`: expired, timed out or never recommended; kept out of learning. */
  result: "agreed" | "overruled" | "edited" | "skipped";
  at: string;
  /** What you chose instead, in a few words, when it differs. */
  instead?: string;
  feedback?: string;
  /** Set once a preference proposal used this outcome as evidence. */
  learned?: boolean;
}
export interface ChiefTriage {
  rank: ChiefRank;
  why: string;
  recommend?: ChiefRecommendation;
  at: string;
  threadId: string;
  /** Groups similar items for lessons: type, tool and workspace. */
  kind: string;
  title: string;
  outcome?: ChiefOutcome;
}
export interface ChiefQueue {
  items: Record<string, ChiefTriage>;
}
/** Resolved items kept for learning; pending items are always kept. */
export const keptResolved = 200;

type Row = Record<string, unknown>;
const text = (value: unknown) => (typeof value === "string" ? value : "");

export function chiefQueue(state: ChiefState): ChiefQueue {
  const value = setting(state, chiefKeys.queue) as Partial<ChiefQueue> | undefined;
  return { items: value?.items && typeof value.items === "object" ? { ...value.items } : {} };
}

/** "approval:Bash:coach": similar items share a kind, so repeated overrules form a pattern. */
export function chiefKind(state: ChiefState, interaction: Row): string {
  const thread = state.thread?.find((row) => row.id === interaction.threadId);
  const context = (interaction.context ?? {}) as { toolName?: unknown };
  const idea = (context as { toolInput?: { chiefIdea?: unknown } }).toolInput?.chiefIdea;
  const tool = idea ? "idea" : text(context.toolName) || text(interaction.type);
  return [text(interaction.type), tool.slice(0, 40), text(thread?.projectId) || "none"].join(":");
}

/** Items Zolt may triage or answer: pending, outside its own approvals of chief_answer. */
export function queueCandidates(state: ChiefState): Row[] {
  return (state.interaction ?? []).filter(
    (row) =>
      row.state === "pending" &&
      (row.context as { toolInput?: { chiefAction?: { tool?: string } } } | undefined)?.toolInput
        ?.chiefAction?.tool !== "chief_answer",
  );
}

const rankOrder = (rank: ChiefRank | undefined) =>
  rank === "now" ? 0 : rank === "today" ? 1 : rank === undefined ? 2 : 3;
/** Needs you order: now, today, not yet triaged, later; blocking first, then oldest. */
export function queueOrder(state: ChiefState): Row[] {
  const queue = chiefQueue(state).items;
  return queueCandidates(state).sort(
    (a, b) =>
      rankOrder(queue[text(a.id)]?.rank) - rankOrder(queue[text(b.id)]?.rank) ||
      Number(b.urgency === "blocking") - Number(a.urgency === "blocking") ||
      text(a.createdAt).localeCompare(text(b.createdAt)),
  );
}

/** Ids ranked `later`, which never notify. */
export function laterIds(value: unknown): Set<string> {
  const items = (value as Partial<ChiefQueue> | undefined)?.items;
  return new Set(
    Object.entries(items && typeof items === "object" ? items : {})
      .filter(([, triage]) => triage?.rank === "later" && !triage.outcome)
      .map(([id]) => id),
  );
}

/** How your answer compared with Zolt's recommendation. Undefined when there is nothing to judge. */
export function compareOutcome(
  recommend: ChiefRecommendation | undefined,
  resolution: InteractionAnswer,
): Omit<ChiefOutcome, "at"> | undefined {
  if (!recommend || !["accept", "decline", "cancel"].includes(resolution.action)) return undefined;
  const feedback = resolution.feedback?.trim();
  const accepted = resolution.action === "accept" && resolution.choice !== "reject_once";
  const extra = feedback ? { feedback: feedback.slice(0, 280) } : {};
  if (recommend.decision === "approve")
    return accepted
      ? { result: "agreed", ...extra }
      : { result: "overruled", instead: "declined", ...extra };
  if (recommend.decision === "decline")
    return accepted
      ? { result: "overruled", instead: "approved", ...extra }
      : { result: "agreed", ...extra };
  if (!accepted) return { result: "overruled", instead: "declined", ...extra };
  const answers = Object.values(resolution.answers ?? {});
  const chosen = answers.flatMap((answer) => answer.options ?? []);
  const other = answers.map((answer) => answer.other?.trim()).find(Boolean);
  if (recommend.choice)
    return chosen.includes(recommend.choice)
      ? { result: "agreed", ...extra }
      : {
          result: "overruled",
          instead: (chosen.join(", ") || other || "another answer").slice(0, 120),
          ...extra,
        };
  if (recommend.text && other !== undefined)
    return other === recommend.text.trim()
      ? { result: "agreed", ...extra }
      : { result: "edited", ...extra };
  return { result: "agreed", ...extra };
}

/** Outcomes for newly resolved triaged items and pruning, or undefined when nothing changed. */
export function settleQueue(state: ChiefState, at: string): ChiefQueue | undefined {
  const queue = chiefQueue(state);
  const interactions = new Map((state.interaction ?? []).map((row) => [text(row.id), row]));
  let changed = false;
  for (const [id, triage] of Object.entries(queue.items)) {
    const row = interactions.get(id);
    if (triage.outcome || !row || row.state === "pending") continue;
    const outcome = compareOutcome(triage.recommend, row.resolution as InteractionAnswer);
    queue.items[id] = {
      ...triage,
      outcome: outcome
        ? { ...outcome, at: text((row.resolution as { at?: unknown })?.at) || at }
        : { result: "skipped", at },
    };
    changed = true;
  }
  const resolved = Object.entries(queue.items)
    .filter(([, triage]) => triage.outcome)
    .sort(([, a], [, b]) => text(b.outcome?.at).localeCompare(text(a.outcome?.at)));
  for (const [id] of resolved.slice(keptResolved)) {
    delete queue.items[id];
    changed = true;
  }
  for (const id of Object.keys(queue.items))
    if (!interactions.has(id)) {
      delete queue.items[id];
      changed = true;
    }
  return changed ? queue : undefined;
}

/** Judged outcomes in the last `days`, for "matched your call on 18 of 21". */
export function agreement(queue: ChiefQueue, now: Date, days = 7) {
  const since = now.getTime() - days * 86_400_000;
  let agreed = 0,
    total = 0;
  for (const triage of Object.values(queue.items)) {
    const outcome = triage.outcome;
    if (!outcome || outcome.result === "skipped" || Date.parse(outcome.at) < since) continue;
    total += 1;
    if (outcome.result === "agreed") agreed += 1;
  }
  return { agreed, total };
}

export interface ChiefLessonCandidate {
  kind: string;
  count: number;
  /** Interaction ids to cite with chief_learn. */
  evidence: string[];
  examples: string[];
}
/** Kinds with three or more overrules or edits not yet used for a lesson. */
export function lessonCandidates(queue: ChiefQueue, minimum = 3): ChiefLessonCandidate[] {
  const groups = new Map<string, [string, ChiefTriage][]>();
  for (const entry of Object.entries(queue.items)) {
    const outcome = entry[1].outcome;
    if (!outcome || outcome.learned || !["overruled", "edited"].includes(outcome.result)) continue;
    groups.set(entry[1].kind, [...(groups.get(entry[1].kind) ?? []), entry]);
  }
  return [...groups.entries()]
    .filter(([, rows]) => rows.length >= minimum)
    .map(([kind, rows]) => ({
      kind,
      count: rows.length,
      evidence: rows.map(([id]) => id).slice(0, 10),
      examples: rows.slice(0, 3).map(([, triage]) => {
        const outcome = triage.outcome as ChiefOutcome;
        const said = triage.recommend ? `you said ${triage.recommend.decision}` : "";
        const did = outcome.result === "edited" ? "edited the draft" : outcome.instead;
        return `"${triage.title.slice(0, 60)}": ${[said, did ? `user ${did}` : "", outcome.feedback ? `("${outcome.feedback.slice(0, 80)}")` : ""].filter(Boolean).join(", ")}`;
      }),
    }));
}
