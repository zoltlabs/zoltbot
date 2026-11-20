// @vitest-environment node
import { describe, expect, it } from "vitest";
import { changesSpend, toSpendView } from "./spend-view";

const entities = {
  project: [{ id: "p1", name: "Website" }],
  agent: [{ id: "a1", name: "Researcher" }],
  thread: [
    { id: "t1", title: "Release notes", projectId: "p1", agentId: "a1" },
    { id: "t2", title: "", agentId: "a1" },
  ],
  session: [
    { id: "s1", threadId: "t1", model: "sonnet" },
    { id: "s2", threadId: "t2", model: "opus" },
  ],
  usage: [
    { id: "u0", sessionId: "s1", recordedAt: "2026-01-01T00:00:00Z", costUsd: 9, costKnown: true },
    {
      id: "u1",
      sessionId: "s1",
      projectId: "p1",
      recordedAt: "2026-01-05T10:00:00Z",
      inputTokens: 100,
      outputTokens: 20,
      costUsd: 0.5,
      costKnown: true,
    },
    {
      id: "u2",
      sessionId: "s2",
      recordedAt: "2026-01-04T10:00:00Z",
      inputTokens: 7,
      costKnown: false,
    },
  ],
  settings: [
    { key: "budget.project.p1", value: { usd: 25 } },
    { key: "theme", value: "dark" },
  ],
};

describe("spend view", () => {
  it("re-reads for usage, budgets and names, not other settings", () => {
    expect(changesSpend("usage", [{}])).toBe(true);
    expect(changesSpend("settings", [{ key: "budget.project.p1" }])).toBe(true);
    expect(changesSpend("settings", [{ key: "theme" }])).toBe(false);
    expect(changesSpend("thread", [{}])).toBe(true);
    expect(changesSpend("knowledge", [{}])).toBe(false);
  });

  it("ties records to their chat, project and model, oldest first, from the start date", () => {
    const view = toSpendView({ entities }, "2026-01-02T00:00:00Z");
    expect(view.rows).toEqual([
      {
        at: "2026-01-04T10:00:00Z",
        botId: "t2",
        botName: "Researcher",
        projectId: null,
        projectName: "",
        model: "opus",
        costUsd: 0,
        costKnown: false,
        tokens: 7,
      },
      {
        at: "2026-01-05T10:00:00Z",
        botId: "t1",
        botName: "Release notes",
        projectId: "p1",
        projectName: "Website",
        model: "sonnet",
        costUsd: 0.5,
        costKnown: true,
        tokens: 120,
      },
    ]);
  });

  it("reads project budgets from settings", () => {
    const view = toSpendView({ entities }, "2026-01-02T00:00:00Z");
    expect(view.budgets).toEqual([{ projectId: "p1", usd: 25 }]);
    expect(view.projects).toEqual([{ id: "p1", name: "Website" }]);
  });
});
