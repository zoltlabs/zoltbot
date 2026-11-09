import { randomUUID } from "node:crypto";
import type { DomainState } from "@zoltbot/core";
import type { ToolActor, ToolInvocation } from "@zoltbot/hostmcp";
import {
  applyWriteDecision,
  defaultWriteCaps,
  evaluateWrite,
  type KnowledgeWriteDecision,
  type KnowledgeWriteInput,
  type KnowledgeWriteSession,
} from "@zoltbot/knowledge";
import {
  KnowledgeItemSchema,
  type KnowledgeWriteReason,
  parse,
  type Scope,
  ScopeSchema,
} from "@zoltbot/protocol";
import type { Store } from "@zoltbot/store";
import type { RuntimeContext } from "./api.js";
import { refreshTaint } from "./knowledge-taint.js";

const kinds = [
  "goal",
  "decision",
  "constraint",
  "requirement",
  "preference",
  "lesson",
  "open_question",
  "artifact_ref",
  "glossary",
] as const;
const sourceKinds = ["task", "thread", "file", "url", "deliverable"] as const;
/** Indirect tool (12 section 4.5a). Kept out of the direct surfaces counted by T4. */
export const knowledgeWriteToolDefinition = {
  name: "team_write_knowledge",
  description:
    "Write durable facts to shared knowledge, never progress notes. Prefer revising an existing item. Knowledge is shared with other agents; the daemon decides applied or proposed.",
  inputSchema: {
    type: "object" as const,
    properties: {
      op: { type: "string", enum: ["create", "revise", "confirm"] },
      id: { type: "string", maxLength: 200 },
      expectedRevision: { type: "integer", minimum: 1 },
      scope: { type: "string", enum: ["here", "project", "user"] },
      kind: { type: "string", enum: [...kinds] },
      title: { type: "string", maxLength: 200 },
      body: { type: "string", maxLength: 1200 },
      tags: { type: "array", maxItems: 10, items: { type: "string", maxLength: 50 } },
      key: { type: "string", maxLength: 100 },
      evidence: {
        type: "array",
        maxItems: 10,
        items: {
          type: "object",
          properties: {
            kind: { type: "string", enum: [...sourceKinds] },
            ref: { type: "string", maxLength: 500 },
            label: { type: "string", maxLength: 200 },
          },
          required: ["kind", "ref"],
          additionalProperties: false,
        },
      },
      reason: { type: "string", maxLength: 300 },
    },
    required: ["op", "evidence", "reason"],
    additionalProperties: false,
  },
};
const why: Record<KnowledgeWriteReason, string> = {
  secret_detected: "contains a secret; nothing was stored",
  cap_reached: "this session's knowledge write limit is reached",
  no_evidence: "this kind needs at least one evidence link",
  scope_denied: "outside this session's knowledge scope",
  stale_revision: "the item changed; read it again and retry with its current revision",
  not_durable: "reads as progress; write durable facts only",
  previously_rejected: "a person already rejected this write",
  duplicate: "matched an existing item",
  user_scope: "user knowledge needs a person's approval",
  protected_item: "changes a person's or confirmed item; sent for review",
  tainted: "this session read untrusted content; sent for review",
  grant_required: "needs a knowledge_write grant above this node; sent for review",
  own_node: "applied at this session's node as unverified",
  low_risk: "applied as unverified",
  granted: "applied as unverified under a grant",
  confirmed: "already verified; evidence attached",
  not_found: "item not found",
};
export interface KnowledgeWriteResult {
  result: "applied" | "proposed" | "merged" | "rejected";
  id?: string;
  revision?: number;
  why: string;
}
/** Result text stays within 400 characters (12 section 4.5a). */
export function compactWriteResult(value: KnowledgeWriteResult): KnowledgeWriteResult {
  const result = { ...value };
  while (JSON.stringify(result).length > 400) result.why = result.why.slice(0, -10);
  return result;
}
const text = (value: unknown, max: number) =>
  typeof value === "string" && value.length <= max ? value : undefined;

/** Shape validation only. Policy decisions belong to evaluateWrite. */
function normalize(state: DomainState, raw: unknown, projectId: string): KnowledgeWriteInput {
  const args = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const allowed = new Set(Object.keys(knowledgeWriteToolDefinition.inputSchema.properties));
  if (Object.keys(args).some((key) => !allowed.has(key)))
    throw new Error("invalid_knowledge_write");
  const op = args.op as KnowledgeWriteInput["op"];
  if (!["create", "revise", "confirm"].includes(op)) throw new Error("invalid_knowledge_write");
  const scope = (args.scope ?? "here") as NonNullable<KnowledgeWriteInput["scope"]>;
  if (!["here", "project", "user"].includes(String(scope)))
    throw new Error("invalid_knowledge_write");
  const evidence = Array.isArray(args.evidence) ? args.evidence.slice(0, 10) : undefined;
  const reason = text(args.reason, 300);
  if (!evidence || reason === undefined) throw new Error("invalid_knowledge_write");
  // Agents cite by reference only; task and thread references must stay in the project.
  const sources = evidence.flatMap((entry) => {
    const source = entry as Record<string, unknown>;
    const kind = source.kind as (typeof sourceKinds)[number];
    const ref = text(source.ref, 500);
    if (!sourceKinds.includes(kind) || !ref?.trim()) return [];
    if (kind === "task" || kind === "thread") {
      const row = state[kind]?.find((entry) => entry.id === ref);
      if (!row || row.projectId !== projectId) return [];
    }
    const label = text(source.label, 200);
    return [{ kind, ref, ...(label ? { label } : {}) }];
  });
  const existing = op === "create" ? undefined : state.knowledge?.find((row) => row.id === args.id);
  const item = existing ? parse(KnowledgeItemSchema, existing) : undefined;
  if (
    op !== "create" &&
    (typeof args.id !== "string" || !Number.isSafeInteger(args.expectedRevision))
  )
    throw new Error("invalid_knowledge_write");
  const kind = (args.kind ?? item?.kind) as KnowledgeWriteInput["kind"];
  const title = op === "confirm" ? item?.title : text(args.title, 200);
  const body = op === "confirm" ? item?.body : text(args.body, 1200);
  if (op !== "confirm" || item) {
    if (!kinds.includes(kind) || !title?.trim() || !body?.trim())
      throw new Error("invalid_knowledge_write");
  }
  const tags = Array.isArray(args.tags)
    ? args.tags
        .filter((tag): tag is string => typeof tag === "string" && tag.length <= 50)
        .slice(0, 10)
    : undefined;
  const key = text(args.key, 100);
  return {
    op,
    ...(typeof args.id === "string" ? { id: args.id } : {}),
    ...(Number.isSafeInteger(args.expectedRevision)
      ? { expectedRevision: Number(args.expectedRevision) }
      : {}),
    scope,
    kind: kinds.includes(kind) ? kind : "lesson",
    title: title ?? "",
    body: body ?? "",
    ...(tags ? { tags } : {}),
    ...(key ? { key } : {}),
    evidence: sources,
    reason,
  };
}

function written(store: Store, sessionId: string) {
  const rows = store.database
    .prepare(
      "SELECT outcome, COUNT(*) AS n FROM knowledge_writes_aux WHERE session_id=? GROUP BY outcome",
    )
    .all(sessionId) as { outcome: string; n: number }[];
  const count = (outcome: string) => rows.find((row) => row.outcome === outcome)?.n ?? 0;
  return { applied: count("applied") + count("merged"), proposed: count("proposed") };
}
function scopeOfNode(state: DomainState, id: string): Scope | undefined {
  if (state.project?.some((row) => row.id === id)) return { type: "project", id };
  if (state.subproject?.some((row) => row.id === id)) return { type: "subproject", id };
  return undefined;
}

/** The writing session's authority, rebuilt from durable state on every call. */
export function writeSession(
  store: Store,
  state: DomainState,
  actor: Pick<ToolActor, "agentId" | "threadId" | "sessionId">,
  secretDetected: boolean,
): KnowledgeWriteSession & { projectId: string } {
  const thread = state.thread?.find(
    (row) => row.id === actor.threadId && row.agentId === actor.agentId && !row.archived,
  );
  const session = state.session?.find(
    (row) => row.id === actor.sessionId && row.threadId === actor.threadId,
  );
  if (!thread || !session || typeof thread.projectId !== "string")
    throw new Error("knowledge_scope_unavailable");
  const projectId = thread.projectId;
  const taskId = typeof thread.taskId === "string" ? thread.taskId : undefined;
  const node = parse(
    ScopeSchema,
    taskId ? { type: "task", id: taskId } : (thread.node ?? { type: "project", id: projectId }),
  );
  const agent = state.agent?.find((row) => row.id === actor.agentId);
  const grants = (state.grant ?? []).flatMap((row) =>
    row.holderAgentId === actor.agentId &&
    row.capability === "knowledge_write" &&
    !row.revokedAt &&
    typeof row.target === "string"
      ? (scopeOfNode(state, row.target) ?? [])
      : [],
  );
  // The chief of staff has a default knowledge_write grant on its project (12 section 6.2).
  if (agent?.kind === "chief_of_staff") grants.push({ type: "project", id: projectId });
  const cap = state.settings?.find((row) => row.key === `knowledge.writeCap.${projectId}`)?.value as
    | { applied?: number; proposed?: number }
    | undefined;
  return {
    sessionId: actor.sessionId,
    agentId: actor.agentId,
    ...(taskId ? { taskId } : {}),
    threadId: actor.threadId,
    node,
    projectId,
    // Rescan before every write so a missed observation can never leave a session trusted.
    tainted: !!refreshTaint(store, actor.sessionId),
    grants,
    written: written(store, actor.sessionId),
    caps: {
      applied: Number.isSafeInteger(cap?.applied) ? Number(cap?.applied) : defaultWriteCaps.applied,
      proposed: Number.isSafeInteger(cap?.proposed)
        ? Number(cap?.proposed)
        : defaultWriteCaps.proposed,
    },
    secretDetected,
  };
}

const kindsLoaded = [
  "project",
  "subproject",
  "task",
  "thread",
  "session",
  "agent",
  "grant",
  "settings",
  "knowledge",
  "knowledgeProposal",
] as const;

export function knowledgeWrites(context: RuntimeContext) {
  const { store } = context;
  async function write(
    actor: Pick<ToolActor, "agentId" | "threadId" | "sessionId">,
    raw: unknown,
    source: "tool" | "learned",
  ): Promise<KnowledgeWriteResult> {
    const before = store.snapshot([...kindsLoaded]);
    const owner = writeSession(store, before, actor, false);
    const input = normalize(before, raw, owner.projectId);
    // Row 1 runs before anything is stored: the text never reaches the database or event log.
    const secret = await context.privacy.containsSecret([
      input.title,
      input.body,
      input.tags,
      input.key,
      input.reason,
      input.evidence,
    ]);
    const commandId = `knowledge-write:${randomUUID()}`,
      at = new Date().toISOString(),
      seq = store.lastSeq();
    const receipt = store.dispatch(commandId, (snapshot) => {
      const session = writeSession(store, snapshot, actor, secret);
      const decision: KnowledgeWriteDecision = evaluateWrite(snapshot, session, input);
      const applied = applyWriteDecision(session, input, decision, {
        commandId,
        at,
        actor: { kind: "agent", id: actor.agentId },
      });
      const rejected = decision.outcome === "rejected";
      store.database
        .prepare(
          "INSERT INTO knowledge_writes_aux(id,session_id,task_id,thread_id,source,op,outcome,reason,item_id,revision,proposal_id,scope_type,scope_id,kind,title,at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        )
        .run(
          commandId,
          session.sessionId,
          session.taskId ?? null,
          session.threadId ?? null,
          source,
          input.op,
          decision.outcome,
          decision.reason,
          applied.result.id ?? (rejected ? null : (decision.item?.id ?? null)),
          applied.result.revision ?? null,
          applied.result.proposalId ?? null,
          rejected ? null : decision.target.type,
          rejected ? null : decision.target.id,
          rejected ? null : input.kind,
          rejected ? null : input.title.slice(0, 200),
          at,
        );
      return {
        events: applied.events,
        result: {
          result: decision.outcome,
          reason: decision.reason,
          ...(applied.result.id ? { id: applied.result.id } : {}),
          ...(applied.result.proposalId ? { id: applied.result.proposalId } : {}),
          ...(applied.result.revision ? { revision: applied.result.revision } : {}),
        },
      };
    });
    context.publish(store.eventsSince(seq));
    const { reason, ...rest } = receipt.result;
    return compactWriteResult({ ...rest, why: `${reason}: ${why[reason]}` });
  }
  return {
    write,
    call: (call: ToolInvocation) => write(call.actor, call.arguments, "tool"),
    /** `learned` entries on team_report share the policy, capped at five per report. */
    async learned(
      actor: Pick<ToolActor, "agentId" | "threadId" | "sessionId">,
      entries: readonly unknown[],
    ) {
      const results: KnowledgeWriteResult[] = [];
      for (const [index, entry] of entries.entries()) {
        if (index >= 5) {
          results.push({ result: "rejected", why: `cap_reached: ${why.cap_reached}` });
          continue;
        }
        const value = (entry ?? {}) as Record<string, unknown>;
        // A malformed entry is rejected alone; the report it came with was already delivered.
        results.push(
          await write(
            actor,
            {
              op: "create",
              scope: value.scope ?? "project",
              kind: value.kind,
              title: value.title,
              body: value.body,
              evidence: value.evidence ?? [],
              reason: "learned",
            },
            "learned",
          ).catch(() => ({
            result: "rejected" as const,
            why: "invalid_entry: needs kind, title, body and evidence",
          })),
        );
      }
      return results;
    },
  };
}
