import { type CommandContext, type DomainState, type Outcome, scopeLineage } from "@zoltbot/core";
import {
  type KnowledgeItem,
  KnowledgeItemSchema,
  parse,
  parseEvent,
  type Scope,
} from "@zoltbot/protocol";

/** Version 1 has one user scope per installation (D-KNW-1). */
export const userScope: Scope = { type: "user", id: "local" };
/** Project setting `knowledge.inheritUser`, default on. */
export function inheritsUser(state: DomainState, projectId: string) {
  return (
    state.settings?.find((row) => row.key === `knowledge.inheritUser.${projectId}`)?.value !== false
  );
}
function nodeChain(state: DomainState, scope: Scope): Scope[] {
  if (scope.type === "task") {
    const task = state.task?.find((row) => row.id === scope.id);
    if (!task || typeof task.projectId !== "string") throw new Error("scope_unavailable");
    const parent =
      task.node && typeof task.node === "object"
        ? task.node
        : { type: "project", id: task.projectId };
    const lineage = scopeLineage(state, parent);
    if (lineage.project.id !== task.projectId) throw new Error("knowledge_scope_mismatch");
    return [...nodeChain(state, parent as Scope), scope];
  }
  const { project, directions } = scopeLineage(state, scope);
  return [
    { type: "project", id: project.id },
    ...directions.map((row) => ({ type: "subproject" as const, id: row.id })),
  ];
}
/** Broadest first: user (unless the project opts out), project, sub-projects, task. */
export function authorizedScopes(state: DomainState, scope: Scope): Scope[] {
  if (scope.type === "user") {
    if (scope.id !== userScope.id) throw new Error("scope_unavailable");
    return [userScope];
  }
  const chain = nodeChain(state, scope);
  const project = chain[0];
  return project && inheritsUser(state, project.id) ? [userScope, ...chain] : chain;
}
export const projectOf = (scopes: readonly Scope[]) => scopes.find((row) => row.type === "project");
export const sameScope = (a: Scope, b: Scope) => a.type === b.type && a.id === b.id;
export function upsertKnowledge(
  state: DomainState,
  input: unknown,
  expectedRevision: number,
  context: CommandContext,
): Outcome {
  if (context.actor.kind !== "human") throw new Error("human_required");
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)
    throw new Error("invalid_knowledge_revision");
  // Every human edit is a human revision, including edits of agent-written items.
  const value = parse(KnowledgeItemSchema, {
    ...(input as object),
    verification: "human",
    writer: context.actor,
  });
  const scopes = authorizedScopes(state, value.scope);
  const old = state.knowledge?.find((row) => row.id === value.id);
  if ((old?.revision ?? 0) !== expectedRevision) throw new Error("knowledge_revision_conflict");
  if (old && !sameScope(parse(KnowledgeItemSchema, old).scope, value.scope))
    throw new Error("knowledge_scope_immutable");
  if (value.title.length > 200 || value.tags.length > 50 || value.sources.length > 50)
    throw new Error("knowledge_too_large");
  if (!value.title.trim() || !value.body.trim()) throw new Error("knowledge_content_required");
  if (
    value.key &&
    value.status === "active" &&
    (state.knowledge ?? []).some((row) => {
      const other = parse(KnowledgeItemSchema, row);
      return (
        other.id !== value.id &&
        other.key === value.key &&
        other.status === "active" &&
        sameScope(other.scope, value.scope)
      );
    })
  )
    throw new Error("knowledge_duplicate_key");
  if (value.supersedes) {
    const visited = new Set([value.id]);
    let id: string | undefined = value.supersedes;
    while (id) {
      if (visited.has(id)) throw new Error("knowledge_supersedes_cycle");
      visited.add(id);
      const row = state.knowledge?.find((entry) => entry.id === id);
      if (!row) throw new Error("knowledge_source_unavailable");
      const item = parse(KnowledgeItemSchema, row);
      if (!scopes.some((scope) => sameScope(scope, item.scope)))
        throw new Error("knowledge_scope_mismatch");
      id = item.supersedes;
    }
  }
  for (const source of value.sources) {
    if (source.kind !== "task" && source.kind !== "thread") continue;
    const row = state[source.kind]?.find((entry) => entry.id === source.ref);
    // User knowledge is the person's own and may cite work from any of their projects.
    if (!row || (value.scope.type !== "user" && row.projectId !== projectOf(scopes)?.id))
      throw new Error("knowledge_source_unavailable");
    if (source.itemId || source.turnId || source.sessionId || source.sourceText) {
      const previousSources = old ? parse(KnowledgeItemSchema, old).sources : [];
      if (previousSources.some((entry) => JSON.stringify(entry) === JSON.stringify(source)))
        continue;
      const item = state.item?.find(
        (entry) => entry.id === source.itemId && entry.kind === "message",
      );
      const turn = state.turn?.find(
        (entry) => entry.id === source.turnId && entry.sessionId === source.sessionId,
      );
      const body = (item?.body as { text?: unknown })?.text;
      if (
        !item ||
        !turn ||
        item.turnId !== turn.id ||
        item.threadId !== row.threadId ||
        typeof body !== "string" ||
        !source.sourceText ||
        !body.includes(source.sourceText)
      )
        throw new Error("knowledge_provenance_mismatch");
      const input = state.item?.find(
        (entry) =>
          entry.kind === "user" && entry.threadId === row.threadId && entry.turnId === turn.id,
      );
      if (input?.id !== `${source.ref}:r${source.taskRevision}:input`)
        throw new Error("knowledge_provenance_revision_mismatch");
    }
  }
  const next: KnowledgeItem = {
    ...value,
    owner: context.actor,
    revision: expectedRevision + 1,
    createdAt: old ? String(old.createdAt) : context.at,
    updatedAt: context.at,
  };
  return {
    result: next,
    events: [
      parseEvent({
        eventId: `${context.commandId}:0`,
        aggregateType: "knowledge",
        aggregateId: next.id,
        type: old ? "knowledge.updated" : "knowledge.created",
        occurredAt: context.at,
        payload: next,
      }),
    ],
  };
}
