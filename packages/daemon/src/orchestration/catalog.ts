import type { DomainState } from "@zoltbot/core";
import { ProfileSchema, parse } from "@zoltbot/protocol";
import type { RoleSelection, RoutingContext } from "./routing.js";

export function discoveredAliases(id: string, label: string): string[] {
  const ignored = new Set([
    "gpt",
    "claude",
    "gemini",
    "openai",
    "anthropic",
    "default",
    "latest",
    "preview",
    "stable",
  ]);
  const aliases = new Set<string>();
  for (const value of [id, label]) {
    const tokens = value
      .toLowerCase()
      .split(/[-_/:\s]+/)
      .filter(Boolean);
    for (const [index, token] of tokens.entries()) {
      if (!/^[a-z]{3,}$/.test(token) || ignored.has(token)) continue;
      aliases.add(token);
      const version = tokens[index + 1];
      if (version && /^\d+(?:\.\d+)*$/.test(version)) {
        aliases.add(`${token} ${version}`);
        aliases.add(`${token} ${version.split(".")[0]}.x`);
      }
    }
  }
  return [...aliases];
}

/** No static guessed model names: discovery and observed session capabilities are the catalog. */
export function routingContext(
  state: DomainState,
  threadId: string,
  discovered: {
    definitionId: string;
    models: { id: string; label: string; efforts?: string[] }[];
  }[],
): RoutingContext {
  const thread = state.thread?.find((row) => row.id === threadId && !row.archived);
  if (!thread?.projectId || thread.kind === "task") throw Error("project_chat_required");
  const profiles = (state.agent ?? [])
    .filter((row) => !row.archived)
    .map((row) => parse(ProfileSchema, row));
  const current = profiles.find((row) => row.id === thread.agentId);
  if (!current) throw Error("profile_unavailable");
  const session = (state.session ?? [])
    .filter((row) => row.threadId === threadId)
    .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))[0];
  const currentModel = typeof session?.model === "string" ? session.model : current.model;
  const models = discovered.flatMap((entry) => {
    const session = (state.session ?? [])
      .filter((row) => row.provider === entry.definitionId)
      .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))[0];
    const caps = session?.capabilities as { effort?: string[] } | undefined;
    return entry.models.map((model) => ({
      definitionId: entry.definitionId,
      model: model.id,
      label: model.label,
      aliases: discoveredAliases(model.id, model.label),
      efforts: model.efforts ?? caps?.effort ?? [],
      ready: true,
    }));
  });
  const preferences = (key: string) => {
    const value = state.settings?.find((row) => row.key === key)?.value;
    if (!value) return {};
    if (typeof value !== "object" || Array.isArray(value)) throw Error("invalid_role_preferences");
    return value as Record<string, RoleSelection>;
  };
  return {
    models,
    recent: (state.item ?? [])
      .filter((row) => row.threadId === threadId && ["user", "message"].includes(String(row.kind)))
      .sort((a, b) => Number(a.seq) - Number(b.seq))
      .slice(-6)
      .map((row) => {
        const body = row.body as { text?: string; input?: { type: string; text?: string }[] };
        return `${row.kind}: ${
          body.text ??
          body.input
            ?.filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("\n") ??
          ""
        }`;
      })
      .join("\n")
      .slice(-4000),
    profiles: profiles.map((profile) => ({
      id: profile.id,
      name: profile.name,
      definitionId: profile.definitionId,
      ...(profile.model ? { model: profile.model } : {}),
      ...(profile.effort ? { effort: profile.effort } : {}),
    })),
    project: preferences(`orchestration.roles.${thread.projectId}`),
    app: preferences("orchestration.roles"),
    current: {
      definitionId: current.definitionId,
      ...(currentModel ? { model: currentModel } : {}),
      ...(current.effort ? { effort: current.effort } : {}),
    },
  };
}
