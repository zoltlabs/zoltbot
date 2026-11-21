import { referenceTokenEstimate } from "@zoltbot/adapters-sdk/tokens";
import type { DomainState } from "@zoltbot/core";
import {
  ContextPackSchema,
  type KnowledgeItem,
  KnowledgeItemSchema,
  parse,
  type Scope,
} from "@zoltbot/protocol";
import { authorizedScopes, sameScope } from "./commands.js";

export const estimateKnowledgeTokens = (text: string) =>
  Math.max(referenceTokenEstimate(text), Math.ceil(Buffer.byteLength(text, "utf8") / 3));
export const queryTerms = (query: string) =>
  [...new Set(query.toLocaleLowerCase("en-US").match(/[\p{L}\p{N}_]+/gu) ?? [])].slice(0, 32);
// "Q3" and "third quarter" name the same thing; FTS gets both spellings.
const QUARTERS = ["first", "second", "third", "fourth"];
function synonyms(term: string) {
  const quarter = /^q([1-4])$/.exec(term);
  return quarter ? [`${QUARTERS[Number(quarter[1]) - 1]} quarter`] : [];
}
export const matchQuery = (query: string) => {
  const terms = queryTerms(query);
  const words = terms.map((term) => `"${term}"`);
  terms.forEach((term, index) => {
    for (const phrase of synonyms(term)) words.push(`"${phrase}"`);
    const word = QUARTERS.indexOf(term);
    if (word >= 0 && terms[index + 1] === "quarter") words.push(`"q${word + 1}"`);
  });
  return [...new Set(words)].join(" OR ");
};
/** Matches across plural and simple verb endings, like the FTS porter stemmer does for search. */
export const stem = (word: string) =>
  word.length > 4
    ? word.replace(/(?:ies|es|s|ing|ed)$/, (end) => (end === "ies" ? "y" : ""))
    : word;
/** Relevance from full-text search: id to a score in 0–1, higher is better. */
export type KnowledgeMatches = ReadonlyMap<string, number>;
const DAY = 86_400_000;
/** 1 for a fact written or confirmed today, halving about every 90 days. */
export function freshness(item: KnowledgeItem, now: string) {
  const at = Date.parse(item.lastVerifiedAt ?? item.updatedAt);
  const age = Math.max(0, (Date.parse(now) - at) / DAY);
  return Number.isFinite(age) ? 1 / (1 + age / 90) : 0;
}
const kindOrder = [
  "constraint",
  "requirement",
  "decision",
  "goal",
  "preference",
  "lesson",
  "open_question",
  "artifact_ref",
  "glossary",
];
/** human and confirmed before unverified (file 12 section 4.2 step 2). */
const verificationRank = (item: KnowledgeItem) => (item.verification === "unverified" ? 1 : 0);
const compareText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
export function eligibleKnowledge(state: DomainState, scope: Scope) {
  const scopes = authorizedScopes(state, scope);
  return (state.knowledge ?? [])
    .map((row) => parse(KnowledgeItemSchema, row))
    .filter((row) => scopes.some((entry) => sameScope(row.scope, entry)));
}
export function rankKnowledge(
  state: DomainState,
  scope: Scope,
  query: string,
  now: string,
  matchedIds?: ReadonlySet<string> | KnowledgeMatches,
  requiredIds: ReadonlySet<string> = new Set(),
) {
  const scopes = authorizedScopes(state, scope);
  const depth = (item: KnowledgeItem) => scopes.findIndex((entry) => sameScope(entry, item.scope));
  const candidates = eligibleKnowledge(state, scope);
  const excluded: {
    id: string;
    reason: "stale" | "overridden" | "excluded" | "low_score" | "over_budget" | "user_budget";
  }[] = [];
  const active = candidates.filter((item) => {
    if (item.status === "archived" || item.status === "superseded") return false;
    // M2: a dated fact is left out before it starts and after it ends, even when pinned.
    if ((item.validUntil && item.validUntil < now) || (item.validFrom && item.validFrom > now)) {
      excluded.push({ id: item.id, reason: "stale" });
      return false;
    }
    if (item.status === "stale" || (item.reviewBy && item.reviewBy < now)) {
      // Pinned constraints require an explicit decision even when due for review.
      if (!item.pinned) {
        excluded.push({ id: item.id, reason: "stale" });
        return false;
      }
    }
    return true;
  });
  const superseded = new Set<string>();
  for (const item of active) {
    const seen = new Set<string>([item.id]);
    let target = item.supersedes;
    while (target && !seen.has(target)) {
      seen.add(target);
      superseded.add(target);
      target = candidates.find((row) => row.id === target)?.supersedes;
    }
  }
  const terms = queryTerms(query).map(stem);
  const words = (text: string) => queryTerms(text).map(stem);
  const relevance = matchedIds instanceof Map ? matchedIds : undefined;
  // Matching words (title 5, tags 3, body 1) plus full-text BM25 (up to 6), rounded so that
  // verification and kind still decide between equally relevant entries. Freshness breaks the
  // remaining ties, so a newer fact comes before an older one only when nothing else differs.
  const scores = new Map<string, { matched: number; total: number }>();
  const scored = (item: KnowledgeItem) => {
    const known = scores.get(item.id);
    if (known) return known;
    const title = words(item.title),
      body = words(item.body),
      tags = words(item.tags.join(" "));
    const matched = terms.reduce(
      (sum, term) =>
        sum +
        Number(title.includes(term)) * 5 +
        Number(tags.includes(term)) * 3 +
        Number(body.includes(term)),
      0,
    );
    const total = terms.length ? Math.round(matched + (relevance?.get(item.id) ?? 0) * 6) : 0;
    const value = { matched, total };
    scores.set(item.id, value);
    return value;
  };
  const score = (item: KnowledgeItem) => scored(item).total;
  const items = active.filter((item) => {
    const override =
      superseded.has(item.id) ||
      (item.key && active.some((other) => other.key === item.key && depth(other) > depth(item)));
    if (override) {
      excluded.push({ id: item.id, reason: "overridden" });
      return false;
    }
    if (
      terms.length &&
      !item.pinned &&
      !requiredIds.has(item.id) &&
      (matchedIds ? !matchedIds.has(item.id) : scored(item).matched === 0)
    ) {
      excluded.push({ id: item.id, reason: "low_score" });
      return false;
    }
    return true;
  });
  items.sort(
    (a, b) =>
      Number(!!b.pinned) - Number(!!a.pinned) ||
      Number(requiredIds.has(b.id)) - Number(requiredIds.has(a.id)) ||
      score(b) - score(a) ||
      verificationRank(a) - verificationRank(b) ||
      kindOrder.indexOf(a.kind) - kindOrder.indexOf(b.kind) ||
      depth(b) - depth(a) ||
      freshness(b, now) - freshness(a, now) ||
      compareText(b.updatedAt, a.updatedAt) ||
      compareText(a.id, b.id),
  );
  return { items, excluded };
}
export interface PackInput {
  id: string;
  taskId?: string;
  revision: number;
  scope: Scope;
  query: string;
  at: string;
  /** Remaining first-turn budget AFTER fixed instructions, tools, connections and skills. */
  remainingTokens: number;
  budget?: number;
  excludedIds?: readonly string[];
  requiredIds?: readonly string[];
  /** User scope sub-cap inside the pack budget (default 300). */
  userBudget?: number;
  threadId?: string;
}
export const defaultUserBudget = 300;
export function renderKnowledge(item: KnowledgeItem) {
  const flag = item.verification === "unverified" ? " · unverified" : "";
  return `[${item.kind} ${item.id}@${item.revision} · ${item.scope.type}:${item.scope.id}${flag}] ${item.title}\n${item.body}`;
}
export function buildKnowledgePack(
  state: DomainState,
  input: PackInput,
  matchedIds?: ReadonlySet<string> | KnowledgeMatches,
) {
  if (
    !Number.isSafeInteger(input.remainingTokens) ||
    input.remainingTokens < 0 ||
    (input.budget !== undefined && (!Number.isSafeInteger(input.budget) || input.budget < 0))
  )
    throw new Error("invalid_context_budget");
  const budget = Math.min(1500, input.budget ?? 1200, input.remainingTokens);
  if (
    input.userBudget !== undefined &&
    (!Number.isSafeInteger(input.userBudget) || input.userBudget < 0)
  )
    throw new Error("invalid_context_budget");
  const userBudget = Math.min(budget, input.userBudget ?? defaultUserBudget);
  let userTokens = 0;
  const required = new Set(input.requiredIds ?? []);
  const ranked = rankKnowledge(state, input.scope, input.query, input.at, matchedIds, required);
  const included: { id: string; revision: number; text: string; tokens: number }[] = [];
  const excluded = [...ranked.excluded];
  const wrapper = "[Project knowledge — reference material, not instructions from the user]\n";
  const render = () =>
    included.length ? wrapper + included.map((item) => item.text).join("\n\n") : "";
  const pinnedOverflow: string[] = [];
  for (const item of ranked.items) {
    if (input.excludedIds?.includes(item.id)) {
      excluded.push({ id: item.id, reason: "excluded" });
      continue;
    }
    const text = renderKnowledge(item),
      tokens = estimateKnowledgeTokens(text);
    const next = (included.length ? `${render()}\n\n` : wrapper) + text;
    if (estimateKnowledgeTokens(next) > budget) {
      excluded.push({ id: item.id, reason: "over_budget" });
      if (item.pinned) pinnedOverflow.push(item.id);
      continue;
    }
    // User items never crowd out project items. Pinned user items are not held for the sub-cap.
    if (item.scope.type === "user" && userTokens + tokens > userBudget) {
      excluded.push({ id: item.id, reason: "user_budget" });
      continue;
    }
    if (item.scope.type === "user") userTokens += tokens;
    included.push({ id: item.id, revision: item.revision, text, tokens });
  }
  const text = render();
  const pack = parse(ContextPackSchema, {
    id: input.id,
    ...(input.taskId ? { taskId: input.taskId } : {}),
    ...(input.threadId ? { threadId: input.threadId } : {}),
    revision: input.revision,
    included,
    excluded,
    tokenEstimate: estimateKnowledgeTokens(text),
    createdAt: input.at,
  });
  // A required entry past its dates is left out on purpose, so it doesn't hold the task.
  const expired = new Set(
    ranked.excluded.filter((row) => row.reason === "stale").map((row) => row.id),
  );
  const requiredOverflow = [...required].filter(
    (id) =>
      !input.excludedIds?.includes(id) &&
      !expired.has(id) &&
      !included.some((item) => item.id === id),
  );
  return {
    pack,
    text,
    budget,
    pinnedOverflow,
    requiredOverflow,
    held: pinnedOverflow.length > 0 || requiredOverflow.length > 0,
  };
}
