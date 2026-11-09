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
export const matchQuery = (query: string) =>
  queryTerms(query)
    .map((term) => `"${term}"`)
    .join(" OR ");
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
  matchedIds?: ReadonlySet<string>,
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
  const terms = queryTerms(query);
  const score = (item: KnowledgeItem) =>
    terms.reduce((sum, term) => {
      const title = queryTerms(item.title),
        body = queryTerms(item.body),
        tags = queryTerms(item.tags.join(" "));
      return (
        sum +
        Number(title.includes(term)) * 5 +
        Number(tags.includes(term)) * 3 +
        Number(body.includes(term))
      );
    }, 0);
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
      (matchedIds ? !matchedIds.has(item.id) : score(item) === 0)
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
  matchedIds?: ReadonlySet<string>,
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
  const requiredOverflow = [...required].filter(
    (id) => !input.excludedIds?.includes(id) && !included.some((item) => item.id === id),
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
