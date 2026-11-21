import { describe, expect, it } from "vitest";
import { modelSearchScore } from "./model-search";

const models = [
  { name: "Opus 5.5", provider: "Claude" },
  { name: "Sonnet 5.5", provider: "Claude" },
  { name: "GPT-5.5 Codex", provider: "Codex" },
  { name: "Mini", provider: "Personal" },
];
const rank = (query: string) =>
  models
    .map((model) => ({ ...model, score: modelSearchScore(query, model.name, model.provider) }))
    .filter((model) => model.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((model) => model.name);

describe("A8 model search ranking", () => {
  it("ranks a name that starts with the query first", () => {
    // "Personal" contains "son" too, but a name match outranks a provider match.
    expect(rank("son")).toEqual(["Sonnet 5.5", "Mini"]);
  });

  it("matches the provider name", () => {
    expect(rank("claude")).toEqual(["Opus 5.5", "Sonnet 5.5"]);
  });

  it("matches letters in order when no word does", () => {
    expect(rank("snt")).toEqual(["Sonnet 5.5"]);
  });

  it("needs every word to match", () => {
    expect(rank("claude codex")).toEqual([]);
    expect(rank("codex 5.5")).toEqual(["GPT-5.5 Codex"]);
  });

  it("prefers a word start over a match inside a word", () => {
    expect(modelSearchScore("codex", "GPT-5.5 Codex")).toBeGreaterThan(
      modelSearchScore("odex", "GPT-5.5 Codex"),
    );
  });

  it("keeps every model for an empty query", () => {
    expect(rank("  ")).toHaveLength(4);
  });
});
