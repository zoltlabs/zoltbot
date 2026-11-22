import type { ModelList } from "@zoltbot/adapters-sdk";
import type { DomainState } from "@zoltbot/core";

/**
 * The models and effort levels each agent definition offered in its newest session, for pickers
 * that open before a chat has a live session. Nothing here asks a provider: a definition with no
 * session falls back to the models `model.refresh` last listed for it, or to none.
 *
 * A session records only its adapter, which many definitions share (every ACP agent is "acp"), so
 * each session is traced to its definition through its thread's agent.
 */
export function modelCatalog(
  state: DomainState,
  listed: ReadonlyMap<string, ModelList> = new Map(),
) {
  const sessions = [...(state.session ?? [])].sort((a, b) =>
    String(b.startedAt ?? "").localeCompare(String(a.startedAt ?? "")),
  );
  const agentOfThread = new Map((state.thread ?? []).map((row) => [row.id, row.agentId]));
  const definitionOfAgent = new Map((state.agent ?? []).map((row) => [row.id, row.definitionId]));
  const definitionOf = (session: { threadId?: unknown }) =>
    definitionOfAgent.get(agentOfThread.get(session.threadId as string) as string);
  return {
    items: (state.agentDefinition ?? [])
      .filter((definition) => definition.archived !== true)
      .map((definition) => {
        const session = sessions.find((row) => {
          const models = (row.capabilities as { models?: { list?: unknown } } | undefined)?.models;
          return (
            row.provider === definition.adapter &&
            definitionOf(row) === definition.id &&
            Array.isArray(models?.list)
          );
        });
        const cached = session ? undefined : listed.get(String(definition.id));
        const capabilities = (session?.capabilities ??
          (cached
            ? { models: { selectable: true, list: cached.list }, effort: cached.effort }
            : {})) as {
          models?: { selectable?: unknown; list?: { id: string; name: string }[] };
          effort?: unknown;
        };
        return {
          definitionId: definition.id,
          adapter: definition.adapter,
          selectable: capabilities.models?.selectable === true,
          models: capabilities.models?.list ?? [],
          effort: Array.isArray(capabilities.effort)
            ? capabilities.effort.filter((value) => typeof value === "string")
            : [],
          ...(session ? { seenAt: session.startedAt } : {}),
        };
      }),
  };
}
