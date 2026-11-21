import { describe, expect, it } from "vitest";
import { readTemplates, templateProfile } from "./agent-templates";

const template = {
  id: "qa-tester",
  name: "QA tester",
  role: "Finds bugs before people do",
  instructions: "You test the product.",
  modelTier: "fast" as const,
};
const base = {
  id: "claude",
  definitionId: "claude",
  model: "sonnet",
  effort: "medium",
  permissionProfile: "workspace_write",
};

describe("agent templates on the phone", () => {
  it("keeps only well-formed templates", () => {
    expect(readTemplates({ items: [template, { id: 1 }, null] })).toEqual([template]);
    expect(readTemplates(null)).toEqual([]);
  });

  it("builds a profile from the picked provider and the edited draft", () => {
    const at = "2026-11-21T00:00:00Z";
    const draft = { name: "", role: " Breaks things ", instructions: "Test it." };
    expect(templateProfile(template, base, draft, "p1", at, ["low", "medium", "high"])).toEqual({
      id: "p1",
      templateId: "qa-tester",
      name: "QA tester",
      avatar: "Q",
      kind: "profile",
      definitionId: "claude",
      model: "sonnet",
      effort: "low",
      permissionProfile: "workspace_write",
      instructions: "Test it.",
      roleText: "Breaks things",
      hidden: false,
      archived: false,
      createdAt: at,
      updatedAt: at,
    });
    // Without offered efforts the base profile's effort stays.
    expect(templateProfile(template, base, { ...draft, name: "Quinn" }, "p2", at).effort).toBe(
      "medium",
    );
  });
});
