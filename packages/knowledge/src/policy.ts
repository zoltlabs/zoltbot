import { createHash } from "node:crypto";
import type { DomainState } from "@zoltbot/core";
import {
  type KnowledgeItem,
  KnowledgeItemSchema,
  type KnowledgeWriteReason,
  parse,
  type Scope,
} from "@zoltbot/protocol";
import { authorizedScopes, projectOf, sameScope, userScope } from "./commands.js";
import { queryTerms } from "./retrieval.js";

/** File 12 section 4.5a input, validated by the daemon before evaluation. */
export interface KnowledgeWriteInput {
  op: "create" | "revise" | "confirm";
  id?: string;
  expectedRevision?: number;
  scope?: "here" | "project" | "user";
  kind: KnowledgeItem["kind"];
  title: string;
  body: string;
  tags?: string[];
  key?: string;
  evidence: KnowledgeItem["sources"];
  reason: string;
}
export interface KnowledgeWriteSession {
  sessionId: string;
  agentId: string;
  taskId?: string;
  threadId?: string;
  /** The session's own task or chat node. */
  node: Scope;
  tainted: boolean;
  /** Nodes holding a knowledge_write grant. Never contains the user scope. */
  grants: readonly Scope[];
  written: { applied: number; proposed: number };
  caps: { applied: number; proposed: number };
  /** Computed by the daemon from the vault, the session redactor and secret patterns. */
  secretDetected: boolean;
}
export type KnowledgeWriteDecision =
  | { outcome: "rejected"; reason: KnowledgeWriteReason; target?: Scope }
  | {
      outcome: "applied" | "proposed" | "merged";
      reason: KnowledgeWriteReason;
      target: Scope;
      item?: KnowledgeItem;
      fingerprint: string;
      conflicts: string[];
    };

export const defaultWriteCaps = { applied: 5, proposed: 5 };
const evidenceKinds = new Set(["lesson", "preference", "decision", "constraint", "requirement"]);
const guardedKinds = new Set(["decision", "constraint", "requirement"]);
const normalize = (text: string) => queryTerms(text).join(" ");
const overlap = (a: string, b: string) => {
  const left = new Set(queryTerms(a)),
    right = new Set(queryTerms(b));
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const term of left) if (right.has(term)) shared++;
  return shared / Math.max(left.size, right.size);
};
const negation = /\b(?:never|not|no|don't|dont|avoid|without|stop)\b/i;
/** Present progressive or "currently" phrasing about the session's own work (12 section 6.6). */
const progress =
  /\b(?:currently|right now|in progress|i am|i'm|we are|we're|working on|still)\b|\b(?:now|next)\s+\w+ing\b/i;

export function knowledgeFingerprint(target: Scope, input: KnowledgeWriteInput) {
  return createHash("sha256")
    .update(
      JSON.stringify([
        target.type,
        target.id,
        input.op,
        input.id ?? "",
        input.kind,
        normalize(input.title),
        normalize(input.body),
      ]),
    )
    .digest("hex")
    .slice(0, 32);
}
function targetScope(
  state: DomainState,
  session: KnowledgeWriteSession,
  input: KnowledgeWriteInput,
) {
  if (input.scope === "user") return userScope;
  if (input.scope === "project") return projectOf(authorizedScopes(state, session.node));
  return session.node;
}

/**
 * The daemon-owned write policy of file 12 section 6.2. Rows are evaluated in order and the
 * first match decides. Preconditions that only apply to revise and confirm (the item exists in
 * the session's chain and the revision matches), rejection memory and the not durable filter run
 * after row 3 because they need no state beyond the target and are always rejections.
 */
export function evaluateWrite(
  state: DomainState,
  session: KnowledgeWriteSession,
  input: KnowledgeWriteInput,
): KnowledgeWriteDecision {
  // Row 1: never look further at text that carries a secret.
  if (session.secretDetected) return { outcome: "rejected", reason: "secret_detected" };
  // Row 2: both buckets full. A single full bucket is checked once the outcome is known.
  if (
    session.written.applied >= session.caps.applied &&
    session.written.proposed >= session.caps.proposed
  )
    return { outcome: "rejected", reason: "cap_reached" };
  // Row 3.
  if ((evidenceKinds.has(input.kind) || input.op === "confirm") && !input.evidence.length)
    return { outcome: "rejected", reason: "no_evidence" };
  const chain = authorizedScopes(state, session.node);
  const inChain = (scope: Scope) => chain.some((entry) => sameScope(entry, scope));
  const items = (state.knowledge ?? []).map((row) => parse(KnowledgeItemSchema, row));
  let existing: KnowledgeItem | undefined;
  let target: Scope | undefined;
  if (input.op === "create") target = targetScope(state, session, input);
  else {
    existing = items.find((row) => row.id === input.id);
    if (!existing || !inChain(existing.scope) || existing.status === "archived")
      return { outcome: "rejected", reason: "scope_denied" };
    if (existing.revision !== input.expectedRevision)
      return { outcome: "rejected", reason: "stale_revision", target: existing.scope };
    target = existing.scope;
  }
  if (!target || !inChain(target)) return { outcome: "rejected", reason: "scope_denied" };
  const above = !sameScope(target, session.node);
  const fingerprint = knowledgeFingerprint(target, input);
  if (
    (state.knowledgeProposal ?? []).some(
      (row) => row.fingerprint === fingerprint && row.state === "rejected",
    )
  )
    return { outcome: "rejected", reason: "previously_rejected", target };
  if (above && input.op !== "confirm" && progress.test(`${input.title}\n${input.body}`))
    return { outcome: "rejected", reason: "not_durable", target };
  const capped = (decision: KnowledgeWriteDecision): KnowledgeWriteDecision => {
    if (decision.outcome === "rejected") return decision;
    const bucket = decision.outcome === "proposed" ? "proposed" : "applied";
    return session.written[bucket] >= session.caps[bucket]
      ? { outcome: "rejected", reason: "cap_reached", target }
      : decision;
  };
  const decide = (
    outcome: "applied" | "proposed" | "merged",
    reason: KnowledgeWriteReason,
    item?: KnowledgeItem,
    conflicts: string[] = [],
  ) => capped({ outcome, reason, target, fingerprint, conflicts, ...(item ? { item } : {}) });
  const targetChain = target.type === "user" ? [userScope] : authorizedScopes(state, target);
  const visible = items.filter(
    (row) =>
      row.status === "active" &&
      row.id !== existing?.id &&
      targetChain.some((scope) => sameScope(scope, row.scope)),
  );
  // Row 4: duplicates merge instead of multiplying. A same-key write with different content is
  // a conflict (row 6), not a duplicate.
  if (input.op === "create") {
    const text = `${input.title} ${input.body}`;
    // Opposite polarity is never a duplicate; it is a conflict (row 6).
    const duplicate = visible.find(
      (row) =>
        negation.test(row.body) === negation.test(input.body) &&
        ((row.kind === input.kind && normalize(row.title) === normalize(input.title)) ||
          overlap(`${row.title} ${row.body}`, text) >= 0.8 ||
          (!!input.key && row.key === input.key && overlap(row.body, input.body) >= 0.5)),
    );
    if (duplicate) return decide("merged", "duplicate", duplicate);
  }
  // Row 5.
  if (target.type === "user") return decide("proposed", "user_scope", existing);
  // Row 6: a person's or a confirmed item is never overwritten in place.
  if (input.op === "revise" && existing && existing.verification !== "unverified")
    return decide("proposed", "protected_item", existing);
  const conflicts = visible.filter(
    (row) =>
      row.verification !== "unverified" &&
      ((input.key && row.key === input.key) ||
        (overlap(`${row.title} ${row.body}`, `${input.title} ${input.body}`) >= 0.5 &&
          negation.test(row.body) !== negation.test(input.body))),
  );
  if (conflicts.length)
    return decide(
      "proposed",
      "protected_item",
      existing,
      conflicts.map((row) => row.id),
    );
  // Confirmation needs an independent session (12 section 6.5).
  if (input.op === "confirm" && existing) {
    if (existing.verification !== "unverified") return decide("merged", "confirmed", existing);
    const writer = existing.sources.some(
      (source) =>
        (source.kind === "task" && source.ref === session.taskId) ||
        (source.kind === "thread" && source.ref === session.threadId) ||
        source.sessionId === session.sessionId,
    );
    if (writer) return { outcome: "rejected", reason: "scope_denied", target };
  }
  // Row 7.
  if (session.tainted && (above || input.op === "confirm"))
    return decide("proposed", "tainted", existing);
  // Row 8. Grants cover the granted node and everything below it, never the user scope.
  if (above && guardedKinds.has(input.kind)) {
    const granted = session.grants.some(
      (grant) => grant.type !== "user" && targetChain.some((scope) => sameScope(scope, grant)),
    );
    if (!granted) return decide("proposed", "grant_required", existing);
    return decide("applied", "granted", existing);
  }
  // Row 9.
  return decide("applied", above ? "low_risk" : "own_node", existing);
}
