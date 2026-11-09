import {
  type ApprovalRule,
  ApprovalRuleSchema,
  parse,
  type RuleDraft,
  RuleDraftSchema,
  terms,
  tokenizeCommand,
} from "@zoltbot/protocol";

export interface RuleFields {
  scope: "agent" | "project" | "global";
  scopeId: string;
  tool: string;
  prefix: string;
  decision: "allow" | "deny";
  expiry: "never" | "hour" | "day" | "week";
}
export function ruleDraft(fields: RuleFields, now: number): RuleDraft {
  const prefix = tokenizeCommand(fields.prefix);
  if (!prefix || prefix.length > 256 || prefix.some((arg) => arg.length > 512))
    throw new Error("invalid_rule_prefix");
  if (fields.scope !== "global" && !fields.scopeId) throw new Error("rule_scope_required");
  const duration = { never: 0, hour: 3600000, day: 86400000, week: 604800000 }[fields.expiry];
  return parse(RuleDraftSchema, {
    scope: fields.scope,
    ...(fields.scope !== "global" ? { scopeId: fields.scopeId } : {}),
    decision: fields.decision,
    matcher: { tool: fields.tool, kind: "execute", command: { prefix } },
    ...(duration ? { expiresAt: new Date(now + duration).toISOString() } : {}),
  });
}
/**
 * Prefills a rule from the provider's suggestion. The matcher is kept as proposed; only the scope
 * is the human's choice. Invalid suggestions throw so the UI does not offer them.
 */
export function suggestedRule(
  suggestion: unknown,
  scope: RuleFields["scope"],
  scopeId: string | undefined,
): RuleDraft {
  if (scope !== "global" && !scopeId) throw new Error("rule_scope_required");
  return parse(RuleDraftSchema, {
    scope,
    ...(scope !== "global" ? { scopeId } : {}),
    decision: "allow",
    matcher: suggestion,
  });
}
export function validSuggestion(suggestion: unknown): suggestion is RuleDraft["matcher"] {
  try {
    suggestedRule(suggestion, "global", undefined);
    return true;
  } catch {
    return false;
  }
}
export function rulePage(value: unknown): { items: ApprovalRule[]; cursor?: string } {
  if (!value || typeof value !== "object" || !Array.isArray((value as { items?: unknown }).items))
    throw new Error("invalid_rule_page");
  const page = value as { items: unknown[]; cursor?: unknown };
  if (page.items.length > 200 || (page.cursor !== undefined && typeof page.cursor !== "string"))
    throw new Error("invalid_rule_page");
  return {
    items: page.items.map((row) => parse(ApprovalRuleSchema, row)),
    ...(typeof page.cursor === "string" ? { cursor: page.cursor } : {}),
  };
}
export function matcherLabel(rule: Pick<RuleDraft, "matcher">): string {
  const matcher = rule.matcher;
  if (matcher.command)
    return matcher.command.prefix
      .map((arg) => (/\s|["\\]/.test(arg) ? JSON.stringify(arg) : arg))
      .join(" ");
  if (matcher.paths) return `${matcher.tool}: ${matcher.paths.join(", ")}`;
  if (matcher.host) return `${matcher.tool}: ${matcher.host}`;
  if (matcher.mcp) return `${matcher.mcp.server} / ${matcher.mcp.tool}`;
  return matcher.tool;
}
export function ruleStatus(rule: ApprovalRule, now: number): "Active" | "Revoked" | "Expired" {
  if (rule.revokedAt) return "Revoked";
  return rule.expiresAt && Date.parse(rule.expiresAt) <= now ? "Expired" : "Active";
}
export function ruleError(error: unknown): string {
  const code = error instanceof Error ? error.message : "";
  if (code.includes("private_value_requires_secure_field"))
    return "Private values cannot be saved in approval rules.";
  if (code.includes("destructive_rule_forbidden"))
    return "This command needs individual approval. Choose a narrower rule.";
  if (code.includes("invalid_rule_prefix"))
    return "Enter one command prefix without chaining, redirects, or substitutions.";
  if (code.includes("rule_scope_required") || code.includes("rule_scope_unavailable"))
    return `Choose an available ${terms.profile.one} or ${terms.workspace.one} for this rule.`;
  if (code.includes("invalid_rule_expiry")) return "Choose a future expiry for this rule.";
  if (code.includes("command_receipt_conflict"))
    return "These details changed. Review them again before saving.";
  return "The request could not be completed. Reconnect and retry with the same details.";
}
