import { AgentEventSchema, parse } from "@zoltbot/protocol";
import { expect, it } from "vitest";
import { codexAnswer, codexInteraction } from "./interactions.js";

const ids = { id: "i", agentId: "profile", threadId: "thread" };
const owner = { kind: "human" as const, id: "owner" };
it("keeps duplicate question text separate using native question ids", () => {
  const params = {
    turnId: "t",
    isBlocking: true,
    questions: [
      {
        id: "q1",
        header: "First",
        question: "Same",
        isOther: true,
        options: [
          { label: "A (Recommended)", description: "A" },
          { label: "B", description: "B" },
        ],
      },
      { id: "q2", header: "Second", question: "Same", isOther: true },
    ],
  };
  const draft = codexInteraction("item/tool/requestUserInput", params, ids);
  expect(draft.items.map((i) => i.id)).toEqual(["q1", "q2"]);
  expect(draft.items[0]?.options?.[0]).toMatchObject({ id: "0", label: "A", recommended: true });
  expect(parse(AgentEventSchema, { t: "interaction.requested", interaction: draft })).toBeDefined();
  expect(
    codexAnswer("item/tool/requestUserInput", params, {
      action: "accept",
      answers: { q1: { options: ["0", "1"] }, q2: { other: "free text" } },
      by: owner,
      at: "2026-10-27T00:00:00Z",
    }),
  ).toEqual({
    answers: { q1: { answers: ["A (Recommended)", "B"] }, q2: { answers: ["free text"] } },
  });
});
it("never turns a fabricated approval choice into approval", () => {
  expect(
    codexAnswer(
      "item/commandExecution/requestApproval",
      {},
      { action: "accept", choice: "invented", by: owner, at: "2026-10-27T00:00:00Z" },
    ),
  ).toEqual({ decision: "cancel" });
  expect(
    codexAnswer(
      "item/commandExecution/requestApproval",
      {},
      { action: "accept", choice: "allow_once", by: owner, at: "2026-10-27T00:00:00Z" },
    ),
  ).toEqual({ decision: "accept" });
});
it("denies permission widening with an empty grant and grants only the displayed request", () => {
  const params = { permissions: { network: { enabled: true } } };
  expect(
    codexAnswer("item/permissions/requestApproval", params, {
      action: "decline",
      by: owner,
      at: "2026-10-27T00:00:00Z",
    }),
  ).toEqual({ permissions: {}, scope: "turn" });
  expect(
    codexAnswer("item/permissions/requestApproval", params, {
      action: "accept",
      choice: "allow_once",
      by: owner,
      at: "2026-10-27T00:00:00Z",
    }),
  ).toEqual({ permissions: params.permissions, scope: "turn" });
});
