import { describe, expect, it } from "vitest";
import { buildReply, emptyDraft, lettersFrom, replyQuestions } from "./letters.js";

const item = (seq: number, kind: string, value: Record<string, unknown>) => ({
  id: `i${seq}`,
  threadId: "t",
  seq,
  kind,
  body: value,
  createdAt: `2026-11-08T10:0${seq}:00Z`,
});

describe("lettersFrom", () => {
  it("groups each side's run into one letter and keeps queued input apart", () => {
    const letters = lettersFrom([
      item(1, "user", {
        input: [{ type: "text", text: "Split the planner out" }],
        queueState: "sent",
      }),
      item(2, "thought", { text: "Looking" }),
      item(3, "tool", { title: "Read" }),
      item(4, "tool", { title: "Edit" }),
      item(5, "message", { text: "## Done\n\nThe planner moved." }),
      item(6, "user", { input: [{ type: "text", text: "Thanks" }], queueState: "sent" }),
      item(7, "user", { input: [{ type: "text", text: "Also this" }], queueState: "queued" }),
    ]);
    expect(letters.map((letter) => [letter.from, letter.items.length, letter.queued])).toEqual([
      ["you", 1, false],
      ["agent", 4, false],
      ["you", 1, false],
      ["you", 1, true],
    ]);
    expect(letters[1]).toMatchObject({ summary: "Done", tools: 2 });
  });

  it("sums up a letter by the main agent's notice, not its notes to itself", () => {
    const [, letter] = lettersFrom([
      item(1, "user", { input: [{ type: "text", text: "[Zoltbot] Zolt, this is a wake-up" }] }),
      item(2, "note", { code: "chief_notify", text: "The deploy needs your OK." }),
      item(3, "message", { text: "Notified; nothing else to do." }),
    ]);
    expect(letter?.summary).toBe("The deploy needs your OK.");
  });
});

const ask = (id: string, createdAt: string, items: Record<string, unknown>[], extra = {}) => ({
  id,
  threadId: "t",
  type: "question",
  state: "pending",
  version: 2,
  createdAt,
  items,
  ...extra,
});

describe("replies", () => {
  const interactions = [
    ask("b", "2026-11-08T10:02:00Z", [
      {
        id: "q1",
        prompt: "Batch Later into a digest?",
        options: [
          { id: "0", label: "Digest" },
          { id: "1", label: "Separate" },
        ],
      },
      { id: "q2", prompt: "Allow once on the notification?" },
    ]),
    ask("a", "2026-11-08T10:01:00Z", [{ id: "q1", prompt: "Per device or per account?" }]),
    ask("s", "2026-11-08T10:03:00Z", [{ id: "q1", prompt: "Token?", secret: true }]),
    ask("x", "2026-11-08T10:03:00Z", [{ id: "q1", prompt: "Elsewhere" }], { threadId: "other" }),
  ];

  it("numbers pending questions oldest first and leaves secret ones on their card", () => {
    expect(
      replyQuestions(interactions, "t").map((q) => [q.n, q.interaction.id, q.item.id]),
    ).toEqual([
      [1, "a", "q1"],
      [2, "b", "q1"],
      [3, "b", "q2"],
    ]);
  });

  it("writes one letter with quotes, answers, free text and what was skipped", () => {
    const questions = replyQuestions(interactions, "t");
    const draft = {
      ...emptyDraft(questions),
      picks: { 2: ["0"] },
      other: { 1: "Per account, with a laptop override." },
      quotes: ["The planner now lives in packages/daemon."],
      extra: "Also rename the setting.",
    };
    const reply = buildReply(questions, draft);
    expect(reply.body).toBe(
      [
        "> Q1 · Per device or per account?\n\nPer account, with a laptop override.",
        "> Q2 · Batch Later into a digest?\n\nDigest",
        "> The planner now lives in packages/daemon.",
        "Also rename the setting.",
        "Not answered yet: Q3.",
      ].join("\n\n"),
    );
    expect(reply.answers).toEqual([
      {
        interactionId: "a",
        version: 2,
        answers: { q1: { other: "Per account, with a laptop override." } },
      },
      { interactionId: "b", version: 2, answers: { q1: { options: ["0"] } } },
    ]);
    expect(reply.skipped).toEqual([3]);
  });

  it("leaves questions that are not quoted pending", () => {
    const questions = replyQuestions(interactions, "t");
    const reply = buildReply(questions, {
      ...emptyDraft(questions),
      quoted: [1],
      other: { 1: "Per account" },
    });
    expect(reply.answers.map((answer) => answer.interactionId)).toEqual(["a"]);
    expect(reply.skipped).toEqual([]);
  });

  it("skips a whole request when nothing in it was answered", () => {
    const questions = replyQuestions(interactions, "t");
    const reply = buildReply(questions, { ...emptyDraft(questions), quoted: [2, 3] });
    expect(reply.answers).toEqual([{ interactionId: "b", version: 2 }]);
    expect(reply.body).toBe("Not answered yet: Q2, Q3.");
  });
});
