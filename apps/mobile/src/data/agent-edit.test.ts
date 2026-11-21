import { describe, expect, it } from "vitest";
import {
  agentChanges,
  catalogModels,
  modelAfterToolChange,
  modelLabel,
  ROLE_MAX,
} from "./agent-edit";

const draft = {
  name: " Ada ",
  definitionId: "claude",
  model: "",
  role: "",
  instructions: "Be brief",
  style: "neutral" as const,
  fastMode: false,
};
const base = { role: "", model: "", style: "neutral" as const };

describe("catalogModels", () => {
  it("reads the tool's models and skips bad rows", () => {
    const catalog = {
      items: [
        { definitionId: "codex", models: [{ id: "gpt", name: "GPT" }] },
        { definitionId: "claude", models: [{ id: "opus", name: "" }, { name: "x" }, null] },
      ],
    };
    expect(catalogModels(catalog, "claude")).toEqual([{ id: "opus", name: "opus" }]);
    expect(catalogModels(catalog, "gemini")).toEqual([]);
    expect(catalogModels(undefined, "claude")).toEqual([]);
  });

  it("labels models", () => {
    const models = [{ id: "opus", name: "Opus" }];
    expect(modelLabel(models, "")).toBe("Tool default");
    expect(modelLabel(models, "opus")).toBe("Opus");
    expect(modelLabel(models, "custom")).toBe("custom");
  });

  it("drops a model the new tool doesn't list", () => {
    const models = [{ id: "opus", name: "Opus" }];
    expect(modelAfterToolChange(models, "gpt")).toBe("");
    expect(modelAfterToolChange(models, "opus")).toBe("opus");
    expect(modelAfterToolChange([], "gpt")).toBe("gpt");
  });
});

describe("agentChanges", () => {
  it("sends only what changed beyond the basics", () => {
    expect(agentChanges(draft, base, false)).toEqual({
      name: "Ada",
      definitionId: "claude",
      instructions: "Be brief",
    });
  });

  it("sets, trims, caps and clears the role", () => {
    expect(agentChanges({ ...draft, role: " Reviews PRs " }, base, false).roleText).toBe(
      "Reviews PRs",
    );
    expect(agentChanges({ ...draft, role: "x".repeat(400) }, base, false).roleText).toHaveLength(
      ROLE_MAX,
    );
    expect(agentChanges(draft, { ...base, role: "Old" }, false)).toMatchObject({ roleText: "" });
  });

  it("sends the model, style and fast mode when they apply", () => {
    expect(
      agentChanges({ ...draft, model: "opus", style: "warm", fastMode: true }, base, true),
    ).toMatchObject({ model: "opus", style: "warm", fastMode: true });
    expect(agentChanges(draft, { ...base, model: "opus" }, false)).toMatchObject({ model: "" });
  });
});
