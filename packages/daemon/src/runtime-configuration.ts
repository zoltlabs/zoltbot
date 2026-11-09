import { isDeepStrictEqual } from "node:util";
import { type DomainState, scopeLineage } from "@zoltbot/core";
import type { EntityKind } from "@zoltbot/protocol";
import {
  compareSessions,
  hasInheritedNativeHistory,
  parse,
  SessionSchema,
} from "@zoltbot/protocol";

export const runtimeConfigurationKinds: readonly EntityKind[] = [
  "thread",
  "compareMember",
  "compare",
  "agent",
  "agentDefinition",
  "project",
  "subproject",
  "task",
  "knowledge",
];
function select(row: Record<string, unknown>, keys: readonly string[]) {
  return Object.fromEntries(keys.map((key) => [key, row[key]]));
}
function configuration(state: DomainState, threadId: string) {
  const thread = state.thread?.find((row) => row.id === threadId);
  const profile = state.agent?.find((row) => row.id === thread?.agentId);
  const definition = state.agentDefinition?.find((row) => row.id === profile?.definitionId);
  const project = state.project?.find((row) => row.id === thread?.projectId);
  const task = state.task?.find((row) => row.id === thread?.taskId);
  if (
    !thread ||
    thread.archived ||
    !profile ||
    profile.archived ||
    !definition ||
    (thread.projectId && (!project || project.archived)) ||
    (thread.taskId && !task)
  )
    throw new Error("runtime_configuration_changed");
  return {
    thread: select(thread, [
      "id",
      "agentId",
      "projectId",
      "taskId",
      "node",
      "kind",
      "archived",
      "fork",
    ]),
    profile: select(profile, [
      "id",
      "definitionId",
      "kind",
      "permissionProfile",
      "model",
      "effort",
      "instructions",
      "roleText",
      "archived",
    ]),
    definition,
    compareCeiling: state.compare?.some((row) => row.summaryThreadId === threadId)
      ? "read_only"
      : state.compareMember?.find((row) => row.threadId === threadId)?.ceiling,
    project:
      project &&
      select(project, ["id", "roots", "goal", "instructions", "constraints", "archived"]),
    task,
    lineage: thread.node ? scopeLineage(state, thread.node) : undefined,
  };
}
/** Fence authority across asynchronous credential lookup and native startup. */
export function runtimeConfigurationFence(state: DomainState, threadId: string) {
  const initial = structuredClone(configuration(state, threadId));
  return (current: DomainState) => {
    if (!isDeepStrictEqual(initial, configuration(current, threadId)))
      throw new Error("runtime_configuration_changed");
  };
}

export interface Previous {
  nativeId: string;
  cwd: string;
  provider: string;
  privateContextRequired?: true;
  firstPromptPending?: boolean;
  configuration?: unknown;
}

/** No local native turn has been dispatched, including earlier connections to the same native session. */
export function firstNativePromptPending(state: DomainState, threadId: string, nativeId: string) {
  if (hasInheritedNativeHistory(state.thread?.find((row) => row.id === threadId))) return false;
  const sessions = new Set(
    (state.session ?? [])
      .filter((session) => session.threadId === threadId && session.nativeId === nativeId)
      .map((session) => session.id),
  );
  return !(state.turn ?? []).some((turn) => sessions.has(turn.sessionId));
}

export function previousForThread(state: DomainState, threadId: string): Previous | undefined {
  const row = (state.session ?? [])
    .filter((s) => s.threadId === threadId && s.nativeId)
    .sort(compareSessions)[0];
  if (!row) return undefined;
  const session = parse(SessionSchema, row);
  const privateContextRequired = (state.session ?? []).some(
    (s) =>
      s.threadId === threadId &&
      s.nativeId === session.nativeId &&
      state.settings?.some((r) => r.key === `runtime.private.${s.id}` && r.value === true),
  );
  return {
    nativeId: session.nativeId as string,
    cwd: session.cwd,
    provider: session.provider,
    firstPromptPending: firstNativePromptPending(state, threadId, session.nativeId as string),
    configuration: state.settings?.find((r) => r.key === `runtime.configuration.${session.id}`)
      ?.value,
    ...(privateContextRequired ? { privateContextRequired: true } : {}),
  };
}
