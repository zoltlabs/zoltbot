import { createHash } from "node:crypto";
import type { CommandContext, DomainState, Outcome } from "@zoltbot/core";
import {
  type KnowledgeItem,
  KnowledgeItemSchema,
  type KnowledgeProposal,
  KnowledgeProposalSchema,
  parse,
  parseEvent,
  type Scope,
} from "@zoltbot/protocol";
import { upsertKnowledge } from "./commands.js";
import type {
  KnowledgeWriteDecision,
  KnowledgeWriteInput,
  KnowledgeWriteSession,
} from "./policy.js";

type Source = KnowledgeItem["sources"][number];
const stableId = (prefix: string, commandId: string) =>
  `${prefix}-${createHash("sha256").update(commandId).digest("hex").slice(0, 24)}`;
const sourceKey = (source: Source) => `${source.kind}:${source.ref}:${source.sessionId ?? ""}`;
function mergeSources(...lists: Source[][]) {
  const seen = new Map<string, Source>();
  for (const source of lists.flat())
    if (!seen.has(sourceKey(source))) seen.set(sourceKey(source), source);
  return [...seen.values()].slice(0, 50);
}
/** Where an agent write happened. Confirmation checks it to require an independent session. */
export function writeProvenance(session: KnowledgeWriteSession): Source {
  return session.taskId
    ? { kind: "task", ref: session.taskId, label: "Agent write", sessionId: session.sessionId }
    : {
        kind: "thread",
        ref: session.threadId ?? session.sessionId,
        label: "Agent write",
        sessionId: session.sessionId,
      };
}
export function knowledgeEvent(
  item: KnowledgeItem,
  created: boolean,
  context: CommandContext,
  index = 0,
) {
  return parseEvent({
    eventId: `${context.commandId}:${index}`,
    aggregateType: "knowledge",
    aggregateId: item.id,
    type: created ? "knowledge.created" : "knowledge.updated",
    occurredAt: context.at,
    payload: parse(KnowledgeItemSchema, item),
  });
}
function proposalEvent(
  proposal: KnowledgeProposal,
  created: boolean,
  context: CommandContext,
  index = 0,
) {
  return parseEvent({
    eventId: `${context.commandId}:${index}`,
    aggregateType: "knowledgeProposal",
    aggregateId: proposal.id,
    type: created ? "knowledgeProposal.created" : "knowledgeProposal.updated",
    occurredAt: context.at,
    payload: parse(KnowledgeProposalSchema, proposal),
  });
}

/** Turn a policy decision into events. Rejections produce none: rejected text is never stored. */
export function applyWriteDecision(
  session: KnowledgeWriteSession,
  input: KnowledgeWriteInput,
  decision: KnowledgeWriteDecision,
  context: CommandContext,
): Outcome & { result: { id?: string; revision?: number; proposalId?: string } } {
  if (decision.outcome === "rejected") return { events: [], result: {} };
  const writer = { kind: "agent" as const, id: session.agentId };
  const provenance = writeProvenance(session);
  const existing = decision.item;
  if (decision.outcome === "proposed") {
    const proposal: KnowledgeProposal = {
      id: stableId("proposal", context.commandId),
      state: "pending",
      op: input.op,
      ...(existing ? { itemId: existing.id, expectedRevision: existing.revision } : {}),
      scope: decision.target,
      kind: input.kind,
      ...(input.key ? { key: input.key } : {}),
      title: input.title,
      body: input.body,
      tags: input.tags ?? [],
      evidence: input.evidence,
      reason: input.reason,
      why: decision.reason,
      writer,
      sessionId: session.sessionId,
      ...(session.taskId ? { taskId: session.taskId } : {}),
      ...(session.threadId ? { threadId: session.threadId } : {}),
      fingerprint: decision.fingerprint,
      conflicts: decision.conflicts,
      createdAt: context.at,
      updatedAt: context.at,
    };
    return {
      events: [proposalEvent(proposal, true, context)],
      result: { proposalId: proposal.id },
    };
  }
  const sources = mergeSources(existing?.sources ?? [], input.evidence, [provenance]);
  let next: KnowledgeItem;
  if (!existing)
    next = {
      id: stableId("knowledge", context.commandId),
      scope: decision.target,
      kind: input.kind,
      ...(input.key ? { key: input.key } : {}),
      title: input.title,
      body: input.body,
      tags: input.tags ?? [],
      owner: writer,
      verification: "unverified",
      writer,
      status: "active",
      sources,
      revision: 1,
      createdAt: context.at,
      updatedAt: context.at,
    };
  else if (input.op === "confirm" && existing.verification === "unverified")
    next = {
      ...existing,
      verification: "confirmed",
      writer,
      sources,
      revision: existing.revision + 1,
      updatedAt: context.at,
      lastVerifiedAt: context.at,
    };
  else if (decision.outcome === "merged" && existing.verification !== "unverified")
    // Evidence is attached; the person's or confirmed text, verification and writer stay.
    next = { ...existing, sources, revision: existing.revision + 1, updatedAt: context.at };
  else
    next = {
      ...existing,
      title: input.title,
      body: input.body,
      ...(input.tags ? { tags: input.tags } : {}),
      verification: "unverified",
      writer,
      sources,
      revision: existing.revision + 1,
      updatedAt: context.at,
    };
  return {
    events: [knowledgeEvent(next, !existing, context)],
    result: { id: next.id, revision: next.revision },
  };
}

const human = (context: CommandContext) => {
  if (context.actor.kind !== "human") throw new Error("human_required");
};
function current(state: DomainState, id: string, expectedRevision: number) {
  const row = state.knowledge?.find((entry) => entry.id === id);
  if (!row) throw new Error("knowledge_not_found");
  const item = parse(KnowledgeItemSchema, row);
  if (item.revision !== expectedRevision) throw new Error("knowledge_revision_conflict");
  return item;
}

/** A person confirms an agent write (12 section 6.5). */
export function confirmKnowledge(
  state: DomainState,
  id: string,
  expectedRevision: number,
  context: CommandContext,
): Outcome {
  human(context);
  const item = current(state, id, expectedRevision);
  if (item.verification !== "unverified") throw new Error("knowledge_not_unverified");
  const next: KnowledgeItem = {
    ...item,
    verification: "confirmed",
    writer: context.actor,
    revision: item.revision + 1,
    updatedAt: context.at,
    lastVerifiedAt: context.at,
  };
  return { result: next, events: [knowledgeEvent(next, false, context)] };
}

/**
 * One action revert (12 section 6.4): restore the previous revision, or archive an item the agent
 * created. Recorded as a human revision; history is never deleted.
 */
export function revertKnowledge(
  state: DomainState,
  history: readonly KnowledgeItem[],
  id: string,
  expectedRevision: number,
  context: CommandContext,
): Outcome {
  human(context);
  const item = current(state, id, expectedRevision);
  if (item.writer.kind !== "agent") throw new Error("knowledge_not_agent_written");
  const previous = history.find((row) => row.revision === item.revision - 1);
  const next: KnowledgeItem = previous
    ? {
        ...previous,
        writer: context.actor,
        revision: item.revision + 1,
        createdAt: item.createdAt,
        updatedAt: context.at,
      }
    : {
        ...item,
        status: "archived",
        writer: context.actor,
        revision: item.revision + 1,
        updatedAt: context.at,
      };
  return { result: next, events: [knowledgeEvent(next, false, context)] };
}

/** Accept (optionally edited or rescoped) or reject a proposal. Accepted items are human. */
export function decideProposal(
  state: DomainState,
  params: {
    id: string;
    decision: "accept" | "reject";
    reason?: string;
    title?: string;
    body?: string;
    scope?: Scope;
  },
  context: CommandContext,
): Outcome {
  human(context);
  const row = state.knowledgeProposal?.find((entry) => entry.id === params.id);
  if (!row) throw new Error("proposal_not_found");
  const proposal = parse(KnowledgeProposalSchema, row);
  if (proposal.state !== "pending") throw new Error("proposal_already_decided");
  const decided = {
    ...proposal,
    decidedBy: context.actor,
    decidedAt: context.at,
    updatedAt: context.at,
  };
  if (params.decision === "reject") {
    const next: KnowledgeProposal = {
      ...decided,
      state: "rejected",
      ...(params.reason ? { rejectionReason: params.reason.slice(0, 300) } : {}),
    };
    return { result: next, events: [proposalEvent(next, false, context)] };
  }
  if (params.scope && proposal.op !== "create") throw new Error("proposal_rescope_create_only");
  const existing = proposal.itemId
    ? parse(
        KnowledgeItemSchema,
        state.knowledge?.find((entry) => entry.id === proposal.itemId) ??
          (() => {
            throw new Error("knowledge_not_found");
          })(),
      )
    : undefined;
  if (existing && existing.revision !== proposal.expectedRevision)
    throw new Error("knowledge_revision_conflict");
  const value = {
    ...(existing ?? {
      id: stableId("knowledge", context.commandId),
      status: "active",
      owner: context.actor,
      revision: 1,
      createdAt: context.at,
      updatedAt: context.at,
    }),
    scope: existing?.scope ?? params.scope ?? proposal.scope,
    kind: existing && proposal.op === "confirm" ? existing.kind : proposal.kind,
    ...(proposal.key ? { key: proposal.key } : {}),
    title: (
      params.title ?? (proposal.op === "confirm" && existing ? existing.title : proposal.title)
    ).slice(0, 200),
    body: params.body ?? (proposal.op === "confirm" && existing ? existing.body : proposal.body),
    tags: existing && proposal.op === "confirm" ? existing.tags : proposal.tags,
    sources: mergeSources(existing?.sources ?? [], proposal.evidence),
  };
  const saved = upsertKnowledge(state, value, existing?.revision ?? 0, {
    ...context,
    commandId: `${context.commandId}:item`,
  });
  const item = parse(KnowledgeItemSchema, saved.result);
  const next: KnowledgeProposal = { ...decided, state: "accepted", resultItemId: item.id };
  const events = [...saved.events, proposalEvent(next, false, context, 1)];
  return { result: next, events };
}
