import type { Interaction } from "@zoltbot/protocol";
import { expect, it } from "vitest";
import { suggestedRule, validSuggestion } from "../rules/rule-data.js";
import {
  formLinks,
  linkOnlyForm,
  planApproval,
  requestChoices,
  reversibility,
} from "./request-data.js";

const request = (overrides: Partial<Interaction>): Interaction => ({
  id: "i",
  agentId: "p",
  threadId: "h",
  type: "approval",
  items: [{ id: "a", prompt: "Run it?" }],
  chain: [],
  urgency: "blocking",
  version: 1,
  state: "pending",
  createdAt: "2026-11-05T00:00:00Z",
  ...overrides,
});

it("collects choices with native labels and picks the primary plan answer", () => {
  const choices = requestChoices(
    request({
      items: [
        {
          id: "a",
          prompt: "Run?",
          choices: [{ id: "allow_once" }, { id: "allow_session", label: "Bash(npm test:*)" }],
        },
      ],
    }),
  );
  expect(choices.get("allow_session")?.label).toBe("Bash(npm test:*)");
  expect(planApproval(choices, " ")).toEqual({ action: "accept", choice: "allow_once" });
  const plan = new Map([
    ["allow_accept_edits", { id: "allow_accept_edits" }],
    ["allow_once", { id: "allow_once" }],
  ]);
  // Enter never auto-accepts edits: that choice widens permission.
  expect(planApproval(plan, "Keep tests")).toEqual({
    action: "accept",
    choice: "allow_once",
    feedback: "Keep tests",
  });
  const autoOnly = new Map([["allow_accept_edits", { id: "allow_accept_edits" }]]);
  expect(planApproval(autoOnly, "")).toEqual({ action: "accept" });
  expect(planApproval(new Map(), "")).toEqual({ action: "accept" });
});

it("prefills an always-allow rule from the suggestion with the chosen scope", () => {
  const matcher = { tool: "Bash", kind: "execute" as const, command: { prefix: ["npm", "test"] } };
  expect(suggestedRule(matcher, "agent", "p")).toEqual({
    scope: "agent",
    scopeId: "p",
    decision: "allow",
    matcher,
  });
  expect(suggestedRule(matcher, "global", "ignored").scopeId).toBeUndefined();
  expect(() => suggestedRule(matcher, "project", undefined)).toThrow("rule_scope_required");
  expect(validSuggestion(matcher)).toBe(true);
  expect(validSuggestion({ kind: "execute" })).toBe(false);
  expect(validSuggestion(undefined)).toBe(false);
});

it("recognizes link-only forms and extracts safe links", () => {
  const form = request({
    type: "form",
    context: { markdown: "Sign in at https://auth.example.com/start?x=1." },
    items: [{ id: "form", prompt: "Authorize", schema: { type: "object", properties: {} } }],
  });
  expect(linkOnlyForm(form)).toBe(true);
  expect(formLinks(form)).toEqual(["https://auth.example.com/start?x=1"]);
  expect(
    linkOnlyForm(
      request({
        type: "form",
        items: [
          {
            id: "form",
            prompt: "Key",
            schema: { type: "object", properties: { key: { type: "string" } } },
          },
        ],
      }),
    ),
  ).toBe(false);
});

it("labels approvals by how easily the action can be taken back", () => {
  const level = (context: Interaction["context"]) =>
    reversibility(request(context ? { context } : {}))?.level;
  expect(level({ toolKind: "read" })).toBe("read");
  expect(level({ toolKind: "edit", paths: ["a.ts"] })).toBe("undoable");
  expect(level({ toolKind: "delete" })).toBe("permanent");
  expect(level({ toolKind: "execute", command: "pnpm test" })).toBe("permanent");
  expect(level({ toolKind: "execute", command: "git push origin main" })).toBe("external");
  expect(level({ toolKind: "fetch" })).toBe("external");
  expect(
    reversibility(request({ context: { network: { host: "api.github.com", protocol: "https" } } }))
      ?.detail,
  ).toContain("api.github.com");
  expect(level({ toolKind: "other" })).toBeUndefined();
  expect(level(undefined)).toBeUndefined();
});
