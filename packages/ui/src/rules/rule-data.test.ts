import { expect, it } from "vitest";
import { matcherLabel, type RuleFields, ruleDraft } from "./rule-data.js";

const fields: RuleFields = {
  scope: "agent",
  scopeId: "profile",
  tool: "execute",
  prefix: 'git log --format="%h %s"',
  decision: "allow",
  expiry: "hour",
};
it("builds an explicitly scoped command rule with exact argument boundaries and a fixed expiry", () => {
  const draft = ruleDraft(fields, Date.parse("2026-10-28T12:00:00.000Z"));
  expect(draft).toMatchObject({
    scope: "agent",
    scopeId: "profile",
    expiresAt: "2026-10-28T13:00:00.000Z",
    matcher: { kind: "execute", command: { prefix: ["git", "log", "--format=%h %s"] } },
  });
  expect(matcherLabel(draft)).toBe('git log "--format=%h %s"');
  expect(ruleDraft({ ...fields, scope: "global", expiry: "never" }, 0).scopeId).toBeUndefined();
});
it("refuses ambiguous commands and requires a selected scope before review", () => {
  expect(() => ruleDraft({ ...fields, prefix: "git status; echo unsafe" }, 0)).toThrow(
    "invalid_rule_prefix",
  );
  expect(() => ruleDraft({ ...fields, scopeId: "" }, 0)).toThrow("rule_scope_required");
});
