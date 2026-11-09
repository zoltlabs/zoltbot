import { expect, it } from "vitest";
import {
  answerInteractions,
  deferInteraction,
  expireInteractions,
  requestInteraction,
} from "./interactions.js";
import { applyEvents } from "./projectors.js";

const context = {
  commandId: "request",
  at: "2026-10-27T12:00:00.000Z",
  actor: { kind: "system" as const, id: "runtime" },
};
const draft = {
  id: "question",
  agentId: "profile",
  threadId: "thread",
  type: "question",
  items: [{ id: "q", prompt: "Which?" }],
  chain: [],
  urgency: "blocking",
};
const base = { thread: [{ id: "thread", agentId: "profile" }] };
it("defers a request without answering or changing its compare and set version", () => {
  const state = applyEvents(base, requestInteraction(base, draft, "timeline-item", context).events);
  const next = applyEvents(
    state,
    deferInteraction(state, "question", { ...context, actor: { kind: "human", id: "owner" } })
      .events,
  );
  expect(next.interaction).toEqual(state.interaction);
  expect(next.settings?.[0]).toMatchObject({ key: "interaction.deferred", value: ["question"] });
  expect(() => deferInteraction(state, "absent", context)).toThrow("interaction_not_pending");
});
it("creates the durable request and a timeline reference together", () => {
  const outcome = requestInteraction(base, draft, "timeline-item", context);
  const state = applyEvents(base, outcome.events);
  expect(state.interaction?.[0]).toMatchObject({ id: "question", state: "pending", version: 1 });
  expect(state.item?.[0]).toMatchObject({
    id: "timeline-item",
    threadId: "thread",
    kind: "interaction",
    seq: 1,
    body: { interactionId: "question" },
  });
  expect(base.thread).toEqual([{ id: "thread", agentId: "profile" }]);
  expect(() =>
    requestInteraction(base, { ...draft, agentId: "other" }, "other-item", context),
  ).toThrow("interaction_thread_mismatch");
});
it("does not replace an existing interaction or timeline item", () => {
  const state = applyEvents(base, requestInteraction(base, draft, "timeline-item", context).events);
  expect(() => requestInteraction(state, draft, "another-item", context)).toThrow(
    "interaction_already_exists",
  );
  expect(() =>
    requestInteraction(state, { ...draft, id: "different" }, "timeline-item", context),
  ).toThrow("item_already_exists");
});
it("expires all selected pending requests and closes the session in one outcome", () => {
  const state = {
    interaction: ["one", "two", "three"].map((id) => ({
      ...draft,
      id,
      version: 1,
      state: "pending",
      createdAt: context.at,
    })),
    session: [
      {
        id: "session",
        threadId: "thread",
        state: "running",
        provider: "codex",
        cwd: "/fixture",
        capabilities: {},
        startedAt: context.at,
      },
    ],
  };
  const outcome = expireInteractions(state, ["thread"], "process_died", context, "session");
  expect(outcome.events).toHaveLength(4);
  expect(
    applyEvents(state, outcome.events).interaction?.every(
      (row) => row.state === "expired" && row.version === 2,
    ),
  ).toBe(true);
  expect(applyEvents(state, outcome.events).session?.[0]).toMatchObject({ state: "closed" });
});
it("answers a batch atomically and rejects a stale member without changing input", () => {
  const state = {
    interaction: ["one", "two"].map((id) => ({
      ...draft,
      id,
      version: 1,
      state: "pending",
      createdAt: context.at,
    })),
  };
  const answer = {
    action: "accept" as const,
    answers: { q: { other: "Choice" } },
    by: { kind: "human" as const, id: "owner" },
    at: context.at,
  };
  const human = { ...context, actor: answer.by };
  const batch = ["one", "two"].map((id) => ({ id, version: 1, answer }));
  const outcome = answerInteractions(state, batch, human);
  expect(
    applyEvents(state, outcome.events).interaction?.every((row) => row.state === "answered"),
  ).toBe(true);
  expect(() =>
    answerInteractions(state, [...batch, { id: "absent", version: 1, answer }], human),
  ).toThrow("not_found");
  expect(state.interaction.every((row) => row.state === "pending")).toBe(true);
  expect(new Set(outcome.events.map((event) => event.eventId)).size).toBe(outcome.events.length);
});
