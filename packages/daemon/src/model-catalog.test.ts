import { expect, it } from "vitest";
import { modelCatalog } from "./model-catalog.js";

it("offers each agent the models its newest session reported", () => {
  const session = (id: string, startedAt: string, list: unknown[], effort: string[]) => ({
    id,
    provider: "claude",
    startedAt,
    capabilities: { models: { selectable: true, list }, effort },
  });
  expect(
    modelCatalog({
      agentDefinition: [
        { id: "claude", adapter: "claude" },
        { id: "codex", adapter: "codex" },
        { id: "old", adapter: "claude", archived: true },
      ],
      session: [
        session("a", "2026-11-01T00:00:00.000Z", [{ id: "sonnet", name: "Sonnet" }], []),
        session("b", "2026-11-02T00:00:00.000Z", [{ id: "opus", name: "Opus" }], ["high"]),
        { id: "c", provider: "claude", startedAt: "2026-11-03T00:00:00.000Z", capabilities: {} },
      ],
    }).items,
  ).toEqual([
    {
      definitionId: "claude",
      adapter: "claude",
      selectable: true,
      models: [{ id: "opus", name: "Opus" }],
      effort: ["high"],
      seenAt: "2026-11-02T00:00:00.000Z",
    },
    { definitionId: "codex", adapter: "codex", selectable: false, models: [], effort: [] },
  ]);
});
