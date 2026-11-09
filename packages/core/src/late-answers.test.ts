import { expect, it } from "vitest";
import { forwardLateAnswer } from "./late-answers.js";
import { applyEvents } from "./projectors.js";

const context = {
  commandId: "forward",
  at: "2026-10-28T12:00:00.000Z",
  actor: { kind: "human" as const, id: "owner" },
};
const state = {
  thread: [
    {
      id: "thread",
      agentId: "profile",
      kind: "main",
      title: "Chat",
      titleSource: "human",
      pinned: false,
      archived: false,
      createdAt: context.at,
      lastActivityAt: "2026-10-27T00:00:00Z",
    },
  ],
  interaction: [
    {
      id: "request",
      threadId: "thread",
      agentId: "profile",
      state: "expired",
      version: 2,
      items: [{ id: "field", prompt: "Choose" }],
    },
  ],
  item: [{ id: "existing", threadId: "thread", seq: 7 }],
};
const input = {
  id: "request",
  version: 2,
  text: "  My exact answer\nwith a second line  ",
  confirmed: true,
};
it("queues the exact human text and an audit atomically without resolving the expired request", () => {
  const outcome = forwardLateAnswer(state, input, "message", context);
  const next = applyEvents(state, outcome.events);
  expect(next.interaction).toEqual(state.interaction);
  expect(next.thread?.[0]?.lastActivityAt).toBe(context.at);
  expect(next.item?.[1]).toMatchObject({
    id: "message",
    seq: 8,
    kind: "user",
    body: {
      input: [{ type: "text", text: input.text }],
      queueState: "queued",
      sourceInteractionId: "request",
    },
  });
  expect(next.audit?.[0]).toMatchObject({
    action: "interaction.forwardLate",
    actor: context.actor,
    target: "request",
  });
  expect(outcome.result).toEqual({ id: "message", disposition: "queued" });
});
it("requires an explicit human confirmation and the current expired version", () => {
  expect(() => forwardLateAnswer(state, { ...input, confirmed: false }, "m", context)).toThrow(
    "human_confirmation_required",
  );
  expect(() =>
    forwardLateAnswer(state, input, "m", { ...context, actor: { kind: "agent", id: "profile" } }),
  ).toThrow("human_confirmation_required");
  expect(() => forwardLateAnswer(state, { ...input, version: 1 }, "m", context)).toThrow(
    "interaction_conflict",
  );
  for (const status of ["pending", "answered", "cancelled"])
    expect(() =>
      forwardLateAnswer(
        { ...state, interaction: [{ ...state.interaction[0], state: status }] },
        input,
        "m",
        context,
      ),
    ).toThrow("interaction_not_expired");
});
it("refuses private fields, empty messages, archived targets, and duplicate item ids", () => {
  expect(() =>
    forwardLateAnswer(
      {
        ...state,
        interaction: [{ ...state.interaction[0], items: [{ id: "private", secret: true }] }],
      },
      input,
      "m",
      context,
    ),
  ).toThrow("secret_late_forward_forbidden");
  expect(() => forwardLateAnswer(state, { ...input, text: " \n " }, "m", context)).toThrow(
    "empty_message",
  );
  expect(() =>
    forwardLateAnswer(
      { ...state, thread: [{ ...state.thread[0], archived: true }] },
      input,
      "m",
      context,
    ),
  ).toThrow("thread_unavailable");
  expect(() => forwardLateAnswer(state, input, "existing", context)).toThrow("item_already_exists");
});
