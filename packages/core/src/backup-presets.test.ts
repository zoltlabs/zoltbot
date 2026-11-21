import { describe, expect, it } from "vitest";
import { freeModels, isFreeModel } from "./backup-presets.js";

describe("A7 free backup presets", () => {
  it("reads free from the provider, else from the id or name", () => {
    expect(isFreeModel({ id: "big-model", name: "Big", free: true })).toBe(true);
    expect(isFreeModel({ id: "x:free", name: "X", free: false })).toBe(false);
    expect(isFreeModel({ id: "vendor/model:free", name: "Model" })).toBe(true);
    expect(isFreeModel({ id: "model-free", name: "Model" })).toBe(true);
    expect(isFreeModel({ id: "m", name: "Model (free)" })).toBe(true);
    expect(isFreeModel({ id: "freeform", name: "Freeform" })).toBe(false);
    expect(isFreeModel({ id: "writer", name: "Distraction free" })).toBe(false);
    expect(isFreeModel({ id: "opus", name: "Opus" })).toBe(false);
  });

  it("offers free models only on tools with a sign-in", () => {
    const catalog = [
      {
        definitionId: "tool",
        models: [
          { id: "a:free", name: "A" },
          { id: "b", name: "B" },
        ],
      },
      { definitionId: "gone", models: [{ id: "c:free", name: "C" }] },
      { definitionId: "twin", models: [{ id: "a:free", name: "A" }] },
    ];
    const accounts = [
      { id: "default:tool", definitionId: "tool", isDefault: true },
      { id: "work", definitionId: "tool", isDefault: false },
      { id: "default:twin", definitionId: "twin", isDefault: true },
    ];
    expect(freeModels(catalog, accounts)).toEqual([
      { accountId: "default:tool", model: "a:free", name: "A" },
    ]);
  });
});
