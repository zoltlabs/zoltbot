import { expect, it } from "vitest";
import { handle } from "./commands.js";
import { applyEvents, type DomainState } from "./projectors.js";
import {
  cancelTask,
  createTask,
  finishTaskTurn,
  holdTask,
  resumeTask,
  retryTask,
  startTask,
  taskPrompt,
} from "./tasks.js";

const at = "2026-11-02T12:00:00Z";
const human = { kind: "human" as const, id: "local-owner" };
const system = { kind: "system" as const, id: "tasks" };
let n = 0;
const ctx = (actor: typeof human | typeof system = system) => ({
  commandId: `c${++n}`,
  at,
  actor,
});
function fixture(): DomainState {
  return {
    agent: [{ id: "codex", definitionId: "codex", archived: false }],
    project: [
      {
        id: "zolt",
        name: "Zolt",
        goal: "",
        instructions: "",
        constraints: "",
        roots: [],
        hierarchyDepth: 3,
        tags: [],
        requireCodeReview: false,
        skipFinalGateWhenReviewed: false,
        archived: false,
        createdAt: at,
      },
    ],
  };
}
const input = {
  id: "t1",
  title: "Units",
  brief: "Show grams and ounces",
  acceptance: "Both units render",
  profileId: "codex",
  node: { type: "project", id: "zolt" },
};
function created() {
  const state = fixture();
  return applyEvents(state, createTask(state, input, ctx(human)).events);
}
function userTexts(state: DomainState) {
  return (state.item ?? [])
    .filter((row) => row.kind === "user")
    .map((row) => (row.body as { input: { text: string }[] }).input[0]?.text ?? "");
}

it("creates a queued task with its own task thread and no input until it starts", () => {
  const state = created();
  expect(state.task?.[0]).toMatchObject({
    state: "queued",
    revision: 1,
    threadId: "t1:thread",
    workspaceMode: "shared",
    projectId: "zolt",
  });
  expect(state.thread?.[0]).toMatchObject({ id: "t1:thread", kind: "task", taskId: "t1" });
  expect(state.item ?? []).toHaveLength(0);
  expect(() => createTask(fixture(), input, ctx(system))).toThrow("human_task_required");
  expect(() => createTask(fixture(), { ...input, brief: " " }, ctx(human))).toThrow("invalid_task");
  expect(() =>
    createTask(fixture(), { ...input, node: { type: "project", id: "other" } }, ctx(human)),
  ).toThrow("scope_unavailable");
});

it("starts, submits a result, takes review feedback as revision 2 and rejects stale results", () => {
  let state = created();
  state = applyEvents(state, startTask(state, "t1", 1, ctx()).events);
  expect(state.task?.[0]).toMatchObject({ state: "running" });
  expect(userTexts(state)[0]).toContain("Show grams and ounces");
  expect(userTexts(state)[0]).toContain("Acceptance criteria:\nBoth units render");
  state = applyEvents(
    state,
    finishTaskTurn(state, "t1", 1, { status: "completed", text: "Added both units." }, ctx())
      .events,
  );
  expect(state.task?.[0]).toMatchObject({ state: "review" });
  expect(state.taskResult?.[0]).toMatchObject({
    revision: 1,
    summary: "Added both units.",
    auto: true,
  });
  state = applyEvents(
    state,
    handle(
      state,
      { type: "review", id: "t1", revision: 1, decision: "changes", feedback: "Round to 1 dp" },
      ctx(human),
    ).events,
  );
  expect(state.task?.[0]).toMatchObject({ state: "queued", revision: 2, reviewState: "changes" });
  expect(() =>
    finishTaskTurn(state, "t1", 1, { status: "completed", text: "late" }, ctx()),
  ).toThrow("stale_revision");
  state = applyEvents(state, startTask(state, "t1", 2, ctx()).events);
  expect(userTexts(state)[1]).toContain("asked for changes:\nRound to 1 dp");
  expect(userTexts(state)[1]).not.toContain("Show grams and ounces");
  state = applyEvents(
    state,
    finishTaskTurn(state, "t1", 2, { status: "completed", text: "Rounded." }, ctx()).events,
  );
  state = applyEvents(
    state,
    handle(state, { type: "review", id: "t1", revision: 2, decision: "accept" }, ctx(human)).events,
  );
  expect(state.task?.[0]).toMatchObject({ state: "completed", revision: 2 });
  expect(state.taskResult).toHaveLength(2);
});

it("records why a task waits and clears the reason when it starts", () => {
  let state = created();
  state = applyEvents(state, holdTask(state, "t1", "Waiting for Other in /code", ctx()).events);
  expect(state.task?.[0]?.holdReason).toBe("Waiting for Other in /code");
  expect(holdTask(state, "t1", "Waiting for Other in /code", ctx()).events).toHaveLength(0);
  state = applyEvents(state, startTask(state, "t1", 1, ctx()).events);
  expect(state.task?.[0]?.holdReason).toBeUndefined();
});

it("fails a stopped or failed turn, retries as a new revision and resumes after restart", () => {
  let state = created();
  state = applyEvents(state, startTask(state, "t1", 1, ctx()).events);
  expect(resumeTask(state, "t1", "boot-1", ctx()).events).toHaveLength(0);
  // Boot recovery parks running tasks; resume continues them in the same thread.
  const parked = {
    ...(state.task?.[0] as object),
    state: "blocked",
    holdReason: "daemon_restarted",
  };
  state = { ...state, task: [parked] };
  state = applyEvents(state, resumeTask(state, "t1", "boot-1", ctx()).events);
  expect(state.task?.[0]).toMatchObject({ state: "running" });
  expect(state.task?.[0]?.holdReason).toBeUndefined();
  expect(userTexts(state)[1]).toContain("Zoltbot restarted");
  expect(userTexts(state)[1]).toContain("Show grams and ounces");
  state = applyEvents(
    state,
    finishTaskTurn(state, "t1", 1, { status: "failed", text: "", reason: "auth_required" }, ctx())
      .events,
  );
  expect(state.task?.[0]).toMatchObject({
    state: "failed",
    holdReason: "The agent turn failed (auth_required)",
  });
  expect(() => retryTask(state, "t1", 1, ctx(system))).toThrow("human_task_required");
  state = applyEvents(state, retryTask(state, "t1", 1, ctx(human)).events);
  expect(state.task?.[0]).toMatchObject({ state: "queued", revision: 2, reviewState: "retry" });
  expect(taskPrompt(state.task?.[0] as never)).toContain("Try again");
  expect(() => cancelTask(state, "t1", false, ctx(human))).toThrow("confirmation_required");
  state = applyEvents(state, cancelTask(state, "t1", true, ctx(human)).events);
  expect(state.task?.[0]).toMatchObject({ state: "cancelled", holdReason: "Stopped by you" });
});
