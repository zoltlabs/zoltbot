import type { Interaction } from "@zoltbot/protocol";
import { expect, it } from "vitest";
import { replyChoices, voiceIntent } from "./voice.js";

const base = {
  agentId: "profile",
  threadId: "thread",
  state: "pending",
  version: 1,
  urgency: "blocking",
  chain: [],
  createdAt: "2026-11-07T12:00:00Z",
};
const approval = {
  ...base,
  id: "approval",
  type: "approval",
  title: "Run the deploy",
  items: [{ id: "run", prompt: "Run", choices: [{ id: "allow_once" }, { id: "reject_once" }] }],
} as Interaction;
const question = {
  ...base,
  id: "question",
  type: "question",
  items: [
    {
      id: "branch",
      prompt: "Which branch?",
      options: [
        { id: "main", label: "Main" },
        { id: "release", label: "Release branch" },
      ],
    },
  ],
} as Interaction;

it("acts on short spoken commands like their keys", () => {
  expect(voiceIntent("Accept.", approval)).toEqual({
    kind: "answer",
    draft: { action: "accept", choice: "allow_once" },
    summary: "Accepted",
  });
  // Zolt's pick wins when it made one.
  expect(voiceIntent("yes", approval, { decision: "decline", text: "Not today" })).toMatchObject({
    draft: { action: "decline", feedback: "Not today" },
  });
  expect(voiceIntent("Reject it!", approval)).toMatchObject({ draft: { action: "decline" } });
  expect(voiceIntent("no", question)).toMatchObject({
    draft: { action: "cancel" },
    summary: "Skipped",
  });
  expect(voiceIntent("next", undefined)).toEqual({ kind: "next" });
  expect(voiceIntent("accept", question, { decision: "answer", choice: "release" })).toMatchObject({
    draft: { answers: { branch: { options: ["release"] } } },
  });
  // A question with no recommendation has nothing to accept.
  expect(voiceIntent("accept", question)).toMatchObject({ kind: "none" });
});

it("treats anything else as a reply to confirm, and never answers private requests", () => {
  expect(voiceIntent("Use the release branch, please", question)).toEqual({
    kind: "reply",
    text: "Use the release branch, please",
  });
  expect(voiceIntent("   ", question)).toMatchObject({ kind: "none" });
  expect(voiceIntent("accept", undefined)).toMatchObject({ kind: "none" });
  const secret = {
    ...question,
    items: [{ id: "key", prompt: "Key", secret: true }],
  } as Interaction;
  expect(voiceIntent("accept", secret)).toMatchObject({ kind: "none" });
});

it("offers what a reply can become", () => {
  expect(replyChoices(approval, "only staging").map((choice) => choice.draft)).toEqual([
    { action: "accept", choice: "allow_once", feedback: "only staging" },
    { action: "decline", feedback: "only staging" },
  ]);
  expect(replyChoices(question, "release branch")).toEqual([
    {
      label: 'Answer "Release branch"',
      draft: { action: "accept", answers: { branch: { options: ["release"] } } },
    },
  ]);
  // Fixed options without "other" cannot take free text.
  expect(replyChoices(question, "use staging")).toEqual([]);
  const open = {
    ...question,
    items: [{ id: "note", prompt: "Anything else?", allowOther: true }],
  } as Interaction;
  expect(replyChoices(open, "Ship it Monday")).toEqual([
    {
      label: "Send this answer",
      draft: { action: "accept", answers: { note: { other: "Ship it Monday" } } },
    },
  ]);
});
