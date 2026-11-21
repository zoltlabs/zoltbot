// A1: agent templates on the phone. Picking one makes a new profile from the chosen profile's
// provider and permissions, with the template's role, instructions and effort tier.
import { type AgentTemplateTier, templateEffort } from "@zoltbot/protocol";
import type { Row } from "./transport";

export interface TemplateRow {
  id: string;
  name: string;
  role: string;
  instructions: string;
  modelTier: AgentTemplateTier;
}

/** The templates in a daemon answer, dropping malformed rows. */
export function readTemplates(value: unknown): TemplateRow[] {
  const items = (value as { items?: unknown } | null)?.items;
  if (!Array.isArray(items)) return [];
  return items.filter(
    (row): row is TemplateRow =>
      typeof row?.id === "string" &&
      typeof row.name === "string" &&
      typeof row.role === "string" &&
      typeof row.instructions === "string" &&
      ["fast", "balanced", "best"].includes(row.modelTier),
  );
}

/** The `agent.create` value for a template, based on the profile the person picked. */
export function templateProfile(
  template: TemplateRow,
  base: Row,
  draft: { name: string; role: string; instructions: string },
  id: string,
  at: string,
  efforts: readonly string[] = [],
): Row {
  const name = draft.name.trim() || template.name;
  const effort = templateEffort(template.modelTier, efforts) ?? base.effort;
  return {
    id,
    templateId: template.id,
    name,
    avatar: name.slice(0, 1).toUpperCase(),
    kind: "profile",
    definitionId: base.definitionId,
    ...(typeof base.model === "string" && base.model ? { model: base.model } : {}),
    ...(typeof effort === "string" && effort ? { effort } : {}),
    permissionProfile: base.permissionProfile,
    instructions: draft.instructions,
    ...(draft.role.trim() ? { roleText: draft.role.trim() } : {}),
    hidden: false,
    archived: false,
    createdAt: at,
    updatedAt: at,
  };
}
