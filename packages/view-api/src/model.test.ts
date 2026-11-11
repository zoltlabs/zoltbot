import { parse } from "@zoltbot/protocol";
import { describe, expect, it } from "vitest";
import fixture from "./fixtures/snapshot.json" with { type: "json" };
import {
  mapChats,
  mapChecks,
  mapRequests,
  mapTopics,
  mapUsage,
  mapWorkspaces,
  type ViewSnapshot,
} from "./model.js";
import { topicSchemas } from "./topics.js";

const now = new Date("2026-01-02T12:00:00Z");
const snapshot = (): ViewSnapshot => structuredClone(fixture);
function row(state: ViewSnapshot, kind: string, index = 0) {
  const value = state.entities[kind]?.[index];
  if (!value) throw Error("Missing fixture row");
  return value;
}
describe("snapshot mapping", () => {
  it("covers every chat status using the mailbox precedence", () => {
    expect(mapChats(snapshot(), now).map((chat) => chat.status)).toEqual([
      "needs_you",
      "working",
      "review",
      "later",
      "settled",
      "idle",
    ]);
    const state = snapshot();
    row(state, "thread", 0).archived = true;
    expect(mapChats(state, now)[0]?.status).toBe("needs_you");
  });
  it("maps profile, provider, current generation, worktree, activity, delegation and usage", () => {
    expect(mapChats(snapshot(), now)[1]).toMatchObject({
      profile: { id: "profile", name: "Builder" },
      provider: { id: "tool", name: "Example tool" },
      worktree: { id: "folder", kind: "worktree", branch: "work", baseRef: "main" },
      activity: "Running tests",
      parentChatId: "needs",
      problem: { kind: "reconnecting", detail: "Retrying" },
      lastTurn: { status: "running" },
      usage: { costUsd: 0.1, inputTokens: 10, outputTokens: 5 },
    });
  });
  it("maps all runtime problems and last-turn outcomes", () => {
    for (const kind of ["auth_required", "rate_limited", "error", "reconnecting"]) {
      const state = snapshot();
      row(state, "session", 1).runtimeStatus = { state: kind };
      expect(mapChats(state, now)[1]?.problem?.kind).toBe(kind);
    }
    for (const status of ["running", "completed", "failed", "interrupted"]) {
      const state = snapshot();
      row(state, "turn", 0).status = status;
      expect(mapChats(state, now)[1]?.lastTurn?.status).toBe(status);
    }
  });
  it("derives a plan step and omits completed activity", () => {
    const state = snapshot();
    state.entities.item = [
      {
        id: "plan",
        threadId: "working",
        turnId: "run",
        kind: "plan",
        seq: 5,
        body: { entries: [{ step: "Check the result", status: "in_progress" }] },
      },
    ];
    expect(mapChats(state, now)[1]?.activity).toBe("Check the result");
    row(state, "turn", 0).status = "completed";
    expect(mapChats(state, now)[1]).not.toHaveProperty("activity");
  });
  it("marks every widening choice and maps only pending requests oldest first", () => {
    const requests = mapRequests(snapshot());
    expect(requests[0]?.choices.map((choice) => [choice.id, choice.widens])).toEqual([
      ["allow_once", false],
      ["allow_session", true],
      ["allow_accept_edits", true],
      ["allow_rule", true],
      ["reject_rule", true],
      ["reject_once", false],
    ]);
    expect(mapChats(snapshot(), now)[0]?.requestIds).toEqual(["request"]);
    const state = snapshot();
    row(state, "interaction", 0).state = "answered";
    expect(mapRequests(state)).toEqual([]);
  });
  it("maps question options but excludes secret questions", () => {
    const state = snapshot();
    Object.assign(row(state, "interaction", 0), {
      type: "question",
      items: [
        {
          id: "question",
          prompt: "Which?",
          options: [{ id: "one", label: "One", description: "More" }],
          allowOther: true,
        },
        { id: "secret", prompt: "Private input", secret: true },
      ],
    });
    expect(mapRequests(state)[0]?.questions).toEqual([
      { id: "question", label: "Which?", options: [{ id: "one", label: "One" }], freeText: true },
    ]);
  });
  it("maps plan and gate decisions", () => {
    for (const type of ["plan", "gate"]) {
      const state = snapshot();
      Object.assign(row(state, "interaction", 0), {
        type,
        items: [{ id: "review", prompt: "Review" }],
      });
      expect(mapRequests(state)[0]?.choices.map((choice) => choice.id)).toEqual([
        "accept",
        "decline",
      ]);
    }
  });
  it("maps labels without filesystem paths or chat text", () => {
    const result = mapTopics(snapshot(), now);
    expect(mapWorkspaces(snapshot())[0]?.roots).toEqual([{ label: "Example", isRepository: true }]);
    for (const privateText of [
      "/workspace/example",
      "Conversation text omitted",
      '"toolInput"',
      '"input"',
      '"cwd"',
      '"paths"',
    ])
      expect(JSON.stringify(result)).not.toContain(privateText);
    for (const topic of Object.keys(topicSchemas) as (keyof typeof topicSchemas)[])
      expect(() => parse(topicSchemas[topic], result[topic])).not.toThrow();
  });
  it("sums since local midnight, preserves unknown costs, and reads the stored daily budget", () => {
    const state = snapshot();
    expect(mapUsage(state, now)).toMatchObject({
      today: { costUsd: 0.1, costKnown: true },
      budget: { limitUsd: 10, period: "day" },
      activeChats: 2,
    });
    state.entities.usage ??= [];
    state.entities.usage.push({
      sessionId: "current",
      costKnown: false,
      recordedAt: now.toISOString(),
    });
    expect(mapChats(state, now)[1]?.usage).not.toHaveProperty("costUsd");
    expect(mapUsage(state, now).today.costKnown).toBe(false);
    state.entities.settings = [];
    expect(mapUsage(state, now)).not.toHaveProperty("budget");
    const midnight = new Date(now);
    midnight.setHours(0, 0, 0, 0);
    state.entities.usage = [
      { recordedAt: new Date(midnight.getTime() - 1).toISOString(), costKnown: true, costUsd: 100 },
    ];
    expect(mapUsage(state, now).today.costUsd).toBe(0);
  });
  it("maps shipping checks for the task's chat", () => {
    expect(mapChecks(snapshot())).toEqual([
      { chatId: "working", name: "Tests", state: "failing", required: true },
    ]);
    const state = snapshot();
    for (const [raw, expected] of [
      ["SUCCESS", "passing"],
      ["SKIPPED", "skipped"],
      ["QUEUED", "pending"],
      ["ERROR", "failing"],
    ]) {
      state.entities.shipping = [
        { taskId: "child", snapshot: { checks: [{ name: "Check", state: raw }] } },
      ];
      expect(mapChecks(state)[0]?.state).toBe(expected);
    }
  });
  it("handles an empty snapshot without mutating the source", () => {
    expect(mapTopics({ entities: {} }, now)).toMatchObject({
      chats: [],
      requests: [],
      checks: [],
      workspaces: [],
      usage: { activeChats: 0 },
    });
    const state = snapshot(),
      before = structuredClone(state);
    mapTopics(state, now);
    expect(state).toEqual(before);
  });
});
