import { createHash } from "node:crypto";
import type { DomainState } from "@zoltbot/core";
import {
  buildKnowledgePack,
  defaultUserBudget,
  eligibleKnowledge,
  frozenKnowledgePack,
  knowledgeMatches,
  knowledgeScopeHash,
} from "@zoltbot/knowledge";
import { parse, type Scope, ScopeSchema } from "@zoltbot/protocol";
import type { Store } from "@zoltbot/store";
import type { NativeRuntimeHost } from "./native-runtime.js";

type LaunchInput = Parameters<NativeRuntimeHost["prepare"]>[0];
const packWrapper = "[Project knowledge — reference material, not instructions from the user]\n";

/** Project setting `knowledge.userBudget`, default 300 tokens of the pack budget. */
function userBudget(state: DomainState, projectId: string) {
  const value = state.settings?.find(
    (row) => row.key === `knowledge.userBudget.${projectId}`,
  )?.value;
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : defaultUserBudget;
}
/** Chat packs score against the chat title and its first human message (12 section 4.2). */
function firstHumanText(store: Store, threadId: string) {
  const row = store.database
    .prepare(
      "SELECT p.body FROM items i JOIN projection_records p ON p.kind='item' AND p.id=i.id WHERE i.thread_id=? AND i.kind='user' ORDER BY i.seq LIMIT 1",
    )
    .get(threadId) as { body: string } | undefined;
  const input = (row ? JSON.parse(row.body).body?.input : undefined) as
    | { type: string; text?: string }[]
    | undefined;
  return (input ?? [])
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
    .slice(0, 4000);
}

/**
 * Prepare only: the caller commits pack and manifest together, fenced against this knowledge
 * snapshot. Runs only at native session creation; a resumed session reuses its saved manifest.
 */
export function knowledgeLaunch(store: Store, input: LaunchInput, remainingTokens: number) {
  if (!input.thread.projectId) return undefined;
  if (!input.thread.taskId) return chatLaunch(store, input, remainingTokens);
  const existing = frozenKnowledgePack(store, input.thread.taskId);
  if (existing) {
    const text = existing.included.length
      ? packWrapper + existing.included.map((item) => item.text).join("\n\n")
      : "";
    return { packId: existing.id, text, tokens: existing.tokenEstimate, pack: existing };
  }
  const state = store.snapshot(["project", "subproject", "knowledge", "task", "settings"]);
  const scope = parse(ScopeSchema, { type: "task", id: input.thread.taskId });
  const task = state.task?.find((row) => row.id === input.thread.taskId);
  if (!task || task.projectId !== input.thread.projectId)
    throw new Error("knowledge_task_scope_mismatch");
  const exclusion = state.settings?.find(
    (row) => row.key === `knowledge.exclusions.${String(task.id)}`,
  )?.value as { ids?: string[] } | undefined;
  const selected = (task.routineInputs as { knowledge?: string[] } | undefined)?.knowledge;
  const excludedIds = [
    ...(exclusion?.ids ?? []),
    ...(Array.isArray(selected)
      ? eligibleKnowledge(state, scope)
          .filter((row) => !selected.includes(row.id))
          .map((row) => row.id)
      : []),
  ];
  const project = state.project?.find((p) => p.id === task.projectId);
  const context = state.knowledge?.find(
    (k) => k.id === project?.artifactDesignContextId && k.status === "active",
  );
  const contextScope = context?.scope as { type?: string; id?: string } | undefined;
  const requiredIds =
    ["page", "design"].includes(String(task.outputMode)) &&
    contextScope?.type === "project" &&
    contextScope.id === task.projectId
      ? [String(context?.id)]
      : [];
  return assemble(store, state, {
    scope,
    projectId: String(task.projectId),
    query: String(task.brief ?? ""),
    remainingTokens,
    excludedIds,
    requiredIds,
    taskId: String(task.id),
    revision: Number(task.revision),
  });
}

function chatLaunch(store: Store, input: LaunchInput, remainingTokens: number) {
  const state = store.snapshot([
    "project",
    "subproject",
    "knowledge",
    "task",
    "settings",
    "thread",
  ]);
  const projectId = String(input.thread.projectId);
  const scope = parse(ScopeSchema, input.thread.node ?? { type: "project", id: projectId });
  return assemble(store, state, {
    scope,
    projectId,
    query: `${input.thread.title}\n${firstHumanText(store, input.thread.id)}`,
    remainingTokens,
    excludedIds: [],
    requiredIds: [],
    threadId: input.thread.id,
    revision: 1,
  });
}

function assemble(
  store: Store,
  state: DomainState,
  input: {
    scope: Scope;
    projectId: string;
    query: string;
    remainingTokens: number;
    excludedIds: string[];
    requiredIds: string[];
    revision: number;
    taskId?: string;
    threadId?: string;
  },
) {
  const { scope, query, remainingTokens, excludedIds, requiredIds } = input;
  const budget = userBudget(state, input.projectId);
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        scope,
        taskId: input.taskId,
        threadId: input.threadId,
        query: input.threadId ? query : undefined,
        knowledge: eligibleKnowledge(state, scope),
        remainingTokens,
        excluded: excludedIds,
        requiredIds,
        userBudget: budget,
      }),
    )
    .digest("hex");
  const candidate = buildKnowledgePack(
    state,
    {
      id: `pack-${fingerprint}`,
      ...(input.taskId ? { taskId: input.taskId } : {}),
      ...(input.threadId ? { threadId: input.threadId } : {}),
      revision: input.revision,
      scope,
      query,
      at: new Date().toISOString(),
      remainingTokens,
      excludedIds,
      requiredIds,
      userBudget: budget,
    },
    knowledgeMatches(store, state, scope, query),
  );
  if (candidate.held)
    throw new Error(
      "context_budget_hold: Required knowledge does not fit. Edit knowledge, exclude for this execution, or cancel.",
    );
  return {
    packId: candidate.pack.id,
    text: candidate.text,
    tokens: candidate.pack.tokenEstimate,
    pack: candidate.pack,
    scope,
    scopeHash: knowledgeScopeHash(state, scope),
  };
}
