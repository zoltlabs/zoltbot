import { expect, it } from "vitest";
import { handle } from "./commands.js";
import { answerInteractions } from "./interactions.js";

const at = "2026-10-28T12:00:00Z",
  actor = { kind: "human" as const, id: "owner" };
const request = {
  id: "request",
  agentId: "profile",
  threadId: "thread",
  type: "question",
  state: "pending",
  version: 1,
  urgency: "blocking",
  chain: [],
  createdAt: at,
  items: [
    { id: "private", prompt: "Private", secret: true },
    { id: "public", prompt: "Public", allowOther: true },
  ],
};
it("rejects private values copied between requests in one answer batch", () => {
  const secret = "synthetic-private-batch-value";
  const privateRequest = { ...request, id: "private-only", items: [request.items[0]] };
  const publicRequest = { ...request, id: "public-only", items: [request.items[1]] };
  expect(() =>
    answerInteractions(
      { interaction: [privateRequest, publicRequest] },
      [
        {
          id: "private-only",
          version: 1,
          answer: { action: "accept", answers: { private: { value: secret } }, by: actor, at },
        },
        {
          id: "public-only",
          version: 1,
          answer: { action: "accept", answers: { public: { other: secret } }, by: actor, at },
        },
      ],
      { commandId: "batch", actor, at },
    ),
  ).toThrow("private_value_requires_secure_field");
});
it.each([
  "feedback",
  "public",
])("rejects a private value repeated in %s before producing durable events", (field) => {
  const secret = "synthetic-private-duplicate-value";
  const answer = {
    action: "accept" as const,
    answers: {
      private: { value: secret },
      public: { other: field === "public" ? `Contains ${secret}` : "Safe answer" },
    },
    ...(field === "feedback" ? { feedback: `Contains ${secret}` } : {}),
    by: actor,
    at,
  };
  expect(() =>
    handle(
      { interaction: [request] },
      { type: "answer", id: "request", version: 1, answer },
      { commandId: "answer", at, actor },
    ),
  ).toThrow("private_value_requires_secure_field");
});
