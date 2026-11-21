import { type Static, Type } from "@sinclair/typebox";
import { object } from "./common.js";

/**
 * A1: ready-made agents. The daemon ships them as data (`packages/core/src/agent-templates`);
 * picking one fills the normal create form, and the created profile records `templateId`.
 */
export const AGENT_TEMPLATE_TIERS = ["fast", "balanced", "best"] as const;
export type AgentTemplateTier = (typeof AGENT_TEMPLATE_TIERS)[number];

export const AgentTemplateSchema = object({
  id: Type.String({ pattern: "^[a-z0-9-]{1,60}$" }),
  name: Type.String({ minLength: 1, maxLength: 60 }),
  role: Type.String({ minLength: 1, maxLength: 80 }),
  instructions: Type.String({ minLength: 1, maxLength: 2400 }),
  /** Skill ids to suggest. */
  skills: Type.Array(Type.String({ minLength: 1, maxLength: 100 }), { maxItems: 10 }),
  /** Connection catalog ids to suggest; never connected automatically. */
  connections: Type.Array(Type.String({ minLength: 1, maxLength: 60 }), { maxItems: 10 }),
  modelTier: Type.Union(AGENT_TEMPLATE_TIERS.map((tier) => Type.Literal(tier))),
  /** Managers may hire from it. */
  managerFriendly: Type.Boolean(),
});
export type AgentTemplate = Static<typeof AgentTemplateSchema>;

export const agentTemplateMethods = {
  "agent.templates.list": {
    params: object({}),
    result: object({ items: Type.Array(AgentTemplateSchema) }),
  },
};

/**
 * The effort level a tier maps to, from the efforts the agent's provider offers. Adapters list
 * efforts lowest first (`capabilities.effort`), and `model.catalog` keeps their order:
 * fast takes the lowest, best the highest, balanced keeps the provider's default.
 */
export function templateEffort(
  tier: AgentTemplateTier,
  efforts: readonly string[],
): string | undefined {
  if (tier === "balanced" || efforts.length < 2) return undefined;
  return tier === "fast" ? efforts[0] : efforts.at(-1);
}
