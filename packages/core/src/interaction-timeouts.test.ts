import { expect, it } from "vitest";
import { timeoutInteraction } from "./interaction-timeouts.js";
import { applyEvents } from "./projectors.js";

const at = "2026-10-27T12:00:00.000Z";
const context = {
  commandId: "timeout",
  at: "2026-10-27T12:00:11.000Z",
  actor: { kind: "system" as const, id: "timeouts" },
};
const request = {
  id: "one",
  agentId: "profile",
  threadId: "thread",
  type: "question",
  items: [{ id: "q", prompt: "Choose", options: [{ id: "safe", label: "Safe" }], default: "safe" }],
  chain: [],
  urgency: "blocking",
  version: 1,
  state: "pending",
  createdAt: at,
  timeout: { seconds: 10, onTimeout: "use_default" },
};
it("uses an explicit question default only after the deadline and attributes it to the system", () => {
  const state = { interaction: [request] };
  expect(timeoutInteraction(state, "one", { ...context, at }).events).toEqual([]);
  const outcome = timeoutInteraction(state, "one", context);
  expect(applyEvents(state, outcome.events).interaction?.[0]).toMatchObject({
    state: "answered",
    resolution: {
      action: "accept",
      automatic: true,
      by: context.actor,
      answers: { q: { options: ["safe"] } },
    },
  });
  expect(() =>
    timeoutInteraction(state, "one", { ...context, actor: { kind: "agent", id: "chief" } }),
  ).toThrow("system_timeout_required");
});
it("never defaults an approval or a secret into acceptance", () => {
  for (const changed of [
    { type: "approval" },
    { items: [{ ...request.items[0], secret: true }] },
  ]) {
    const state = { interaction: [{ ...request, ...changed }] };
    const outcome = timeoutInteraction(state, "one", context);
    expect(outcome.result).toMatchObject({ action: "park" });
    expect(applyEvents(state, outcome.events).interaction?.[0]).toMatchObject({
      state: "expired",
      resolution: { action: "expire" },
    });
  }
});
it("parks only the timed out request and leaves other pending questions intact", () => {
  const state = {
    interaction: [
      { ...request, items: [{ id: "q", prompt: "No default" }] },
      { ...request, id: "other" },
    ],
  };
  const next = applyEvents(state, timeoutInteraction(state, "one", context).events);
  expect(next.interaction?.find((row) => row.id === "one")?.state).toBe("expired");
  expect(next.interaction?.find((row) => row.id === "other")?.state).toBe("pending");
});
it("rejects an approval when its timeout policy requests rejection", () => {
  const state = {
    interaction: [{ ...request, type: "approval", timeout: { seconds: 10, onTimeout: "reject" } }],
  };
  const next = applyEvents(state, timeoutInteraction(state, "one", context).events);
  expect(next.interaction?.[0]).toMatchObject({
    state: "answered",
    resolution: { action: "decline", automatic: true },
  });
});
it("never applies a default when the clock timestamp is invalid", () => {
  expect(
    timeoutInteraction({ interaction: [request] }, "one", {
      ...context,
      at: "2026-99-27T12:00:11.000Z",
    }).events,
  ).toEqual([]);
});
it("parks the linked running task and turn together with the expired request", () => {
  const state = {
    interaction: [
      { ...request, taskId: "task", turnId: "turn", timeout: { seconds: 10, onTimeout: "park" } },
    ],
    task: [
      {
        id: "task",
        rootId: "task",
        title: "Work",
        brief: "Work",
        acceptance: "Checked",
        expectedDeliverable: "Report",
        workspaceMode: "worktree",
        state: "running",
        revision: 1,
        attempt: 1,
        maxAttempts: 1,
        reviewRequired: true,
        executionLocation: "local",
        createdBy: { kind: "human", id: "owner" },
        createdAt: at,
        updatedAt: at,
      },
    ],
    turn: [
      {
        id: "turn",
        threadId: "thread",
        sessionId: "session",
        status: "running",
        origin: "human",
        startedAt: at,
      },
    ],
  };
  const outcome = timeoutInteraction(state, "one", context);
  const next = applyEvents(state, outcome.events);
  expect(outcome.events).toHaveLength(3);
  expect(next.task?.[0]).toMatchObject({ state: "blocked", holdReason: "interaction_timeout" });
  expect(next.turn?.[0]).toMatchObject({
    status: "interrupted",
    stopReason: "interaction_timeout",
  });
});
