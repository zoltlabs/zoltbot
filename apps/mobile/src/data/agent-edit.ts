// P10: what the phone's agent editor sends. Kept pure so the sheet stays small and testable.
import type { TalkingStyle } from "@zoltbot/protocol";

/** The desktop's limit for an agent's role. */
export const ROLE_MAX = 300;

export type CatalogModel = { id: string; name: string };

/** The models the Mac has seen this tool offer, or none when it hasn't run yet. */
export function catalogModels(catalog: unknown, definitionId: string): CatalogModel[] {
  const items = (catalog as { items?: unknown } | undefined)?.items;
  if (!Array.isArray(items)) return [];
  const row = items.find(
    (item) => (item as { definitionId?: unknown } | null)?.definitionId === definitionId,
  ) as { models?: unknown } | undefined;
  if (!Array.isArray(row?.models)) return [];
  return row.models.flatMap((model) => {
    const { id, name } = (model ?? {}) as { id?: unknown; name?: unknown };
    return typeof id === "string" && id
      ? [{ id, name: typeof name === "string" && name ? name : id }]
      : [];
  });
}

/** The label for a model id: its catalog name, the id itself, or the tool's default. */
export function modelLabel(models: CatalogModel[], model: string) {
  if (!model.trim()) return "Tool default";
  return models.find((row) => row.id === model.trim())?.name ?? model.trim();
}

export interface AgentDraft {
  name: string;
  definitionId: string;
  model: string;
  role: string;
  instructions: string;
  style: TalkingStyle;
  fastMode: boolean;
}

export interface AgentBase {
  role: string;
  model: string;
  style: TalkingStyle;
}

/**
 * The `agent.update` changes for a draft. The role, style and model go only when they changed;
 * an empty role or model clears it, and an empty model means the tool's default.
 */
export function agentChanges(draft: AgentDraft, base: AgentBase, fastOffered: boolean) {
  const role = draft.role.trim().slice(0, ROLE_MAX);
  const model = draft.model.trim();
  return {
    name: draft.name.trim(),
    definitionId: draft.definitionId,
    instructions: draft.instructions,
    ...(role !== base.role.trim() ? { roleText: role } : {}),
    ...(draft.style !== base.style ? { style: draft.style } : {}),
    ...(model !== base.model.trim() ? { model } : {}),
    ...(fastOffered ? { fastMode: draft.fastMode } : {}),
  };
}

/** After picking another tool: keep the model only when that tool lists it (or lists nothing). */
export function modelAfterToolChange(models: CatalogModel[], model: string) {
  return !models.length || models.some((row) => row.id === model.trim()) ? model : "";
}
