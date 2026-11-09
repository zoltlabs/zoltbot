import { AgentEventSchema, parse } from "@zoltbot/protocol";
import { expect, it } from "vitest";
import { claudeAnswer, claudeInteraction } from "./interactions.js";

const ids = { id: "request", agentId: "profile", threadId: "thread", turnId: "turn" };
const owner = { kind: "human" as const, id: "owner" };
it("preserves duplicate question text and combines answers without altering native keys", () => {
  const request = {
    subtype: "can_use_tool",
    tool_name: "AskUserQuestion",
    input: {
      questions: [
        {
          header: "First",
          question: "Same",
          multiSelect: true,
          options: [
            { label: "A (Recommended)", description: "A" },
            { label: "B", description: "B" },
          ],
        },
        { header: "Second", question: "Same", options: [] },
      ],
    },
  };
  const draft = claudeInteraction(request, ids);
  expect(draft.items.map((i) => i.id)).toEqual(["q1", "q2"]);
  expect(draft.items[0]?.options?.[0]).toMatchObject({ id: "0", label: "A", recommended: true });
  expect(parse(AgentEventSchema, { t: "interaction.requested", interaction: draft })).toBeDefined();
  const reply = claudeAnswer(request, {
    action: "accept",
    answers: { q1: { options: ["0", "1"] }, q2: { other: "free text" } },
    by: owner,
    at: "2026-10-27T00:00:00Z",
  });
  expect(reply).toMatchObject({
    behavior: "allow",
    updatedInput: {
      questions: request.input.questions,
      answers: { Same: "[1] A (Recommended), B\n[2] free text" },
    },
  });
});
it("denies fabricated approval choices and keeps permission input exact", () => {
  const request = { subtype: "can_use_tool", tool_name: "Bash", input: { command: "git status" } };
  expect(
    claudeAnswer(request, {
      action: "accept",
      choice: "invented",
      by: owner,
      at: "2026-10-27T00:00:00Z",
    }),
  ).toMatchObject({ behavior: "deny" });
  expect(
    claudeAnswer(request, {
      action: "accept",
      choice: "allow_once",
      by: owner,
      at: "2026-10-27T00:00:00Z",
    }),
  ).toEqual({ behavior: "allow", updatedInput: request.input });
});
it("requires concrete plan content before creating a review interaction", () => {
  const request = { subtype: "can_use_tool", tool_name: "ExitPlanMode", input: {} };
  expect(() => claudeInteraction(request, ids)).toThrow("plan_content_unavailable");
  expect(claudeInteraction(request, ids, "# Plan\nBuild and test.")).toMatchObject({
    type: "plan",
    context: { markdown: "# Plan\nBuild and test." },
  });
});

it("normalizes file edits with explicit tool kind and actual input paths for daemon verification", () => {
  const edit = claudeInteraction(
    { subtype: "can_use_tool", tool_name: "Edit", input: { file_path: "/work/src/a.ts" } },
    ids,
  );
  expect(edit.context).toMatchObject({
    toolName: "Edit",
    toolKind: "edit",
    paths: ["/work/src/a.ts"],
  });
  const unknown = claudeInteraction(
    { subtype: "can_use_tool", tool_name: "Unknown", input: { file_path: "/work/src/a.ts" } },
    ids,
  );
  expect(unknown.context?.toolKind).toBeUndefined();
});
