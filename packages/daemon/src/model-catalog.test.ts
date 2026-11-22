import { expect, it } from "vitest";
import { modelCatalog } from "./model-catalog.js";

const session = (
  id: string,
  threadId: string,
  provider: string,
  startedAt: string,
  list: unknown[],
  effort: string[] = [],
) => ({
  id,
  threadId,
  provider,
  startedAt,
  capabilities: { models: { selectable: true, list }, effort },
});

it("offers each agent the models its newest session reported", () => {
  expect(
    modelCatalog({
      agentDefinition: [
        { id: "claude", adapter: "claude" },
        { id: "codex", adapter: "codex" },
        { id: "old", adapter: "claude", archived: true },
      ],
      agent: [{ id: "a1", definitionId: "claude" }],
      thread: [{ id: "t1", agentId: "a1" }],
      session: [
        session("a", "t1", "claude", "2026-11-01T00:00:00.000Z", [
          { id: "sonnet", name: "Sonnet" },
        ]),
        session(
          "b",
          "t1",
          "claude",
          "2026-11-02T00:00:00.000Z",
          [{ id: "opus", name: "Opus" }],
          ["high"],
        ),
        {
          id: "c",
          threadId: "t1",
          provider: "claude",
          startedAt: "2026-11-03T00:00:00.000Z",
          capabilities: {},
        },
      ],
    } as never).items,
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

it("keeps agents that share an adapter apart", () => {
  const items = modelCatalog({
    agentDefinition: [
      { id: "cursor", adapter: "acp" },
      { id: "antigravity", adapter: "acp" },
    ],
    agent: [{ id: "a-cursor", definitionId: "cursor" }],
    thread: [{ id: "t-cursor", agentId: "a-cursor" }],
    session: [
      session("s", "t-cursor", "acp", "2026-11-02T00:00:00.000Z", [
        { id: "composer-2.5", name: "composer-2.5" },
      ]),
    ],
  } as never).items;
  expect(items.find((item) => item.definitionId === "cursor")?.models).toEqual([
    { id: "composer-2.5", name: "composer-2.5" },
  ]);
  expect(items.find((item) => item.definitionId === "antigravity")?.models).toEqual([]);
});
