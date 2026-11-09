import { threadMailbox, type Wake, type WakeInput } from "@zoltbot/protocol";
import { describe, expect, it } from "vitest";
import { applyEvents, type DomainState } from "./projectors.js";
import { cancelWake, fireWake, localWakeMatch, saveWake } from "./wakes.js";

const at = "2026-11-09T12:00:00.000Z";
const ctx = (id = "save", time = at) => ({
  commandId: id,
  at: time,
  actor: { kind: "system" as const, id: "test" },
});
const thread = (id: string) => ({
  id,
  agentId: "a",
  projectId: "p",
  kind: "side",
  title: id,
  titleSource: "human",
  pinned: false,
  archived: false,
  createdAt: at,
  lastActivityAt: at,
});
const seed = (): DomainState => ({
  thread: [thread("a"), thread("b")],
  agent: [{ id: "a", permissionProfile: "read_only" }],
  session: [{ id: "s", threadId: "a", background: [{ id: "j", state: "running" }] }],
  turn: [{ id: "t", threadId: "b", status: "running" }],
});
const input = (changes: Partial<WakeInput> = {}): WakeInput => ({
  threadId: "a",
  condition: { kind: "job", sessionId: "s", jobId: "j", outcome: "finished" },
  fallbackAt: "2026-11-10T12:00:00.000Z",
  behavior: "resume",
  continuation: "Review test results",
  ...changes,
});
function armed(i = input()) {
  const state = seed();
  return applyEvents(state, saveWake(state, i, "w", ctx()).events);
}
describe("one-shot wake subscriptions", () => {
  it("queues one system continuation and an evidence note atomically", () => {
    const state = armed();
    const outcome = fireWake(state, "w", 1, ctx("fire"), { reason: "Tests failed" });
    const next = applyEvents(state, outcome.events),
      wake = outcome.result as Wake;
    expect(wake.status).toBe("queued");
    expect(next.item?.filter((i) => i.kind === "user")).toHaveLength(1);
    expect(next.item?.find((i) => i.kind === "user")?.body).toMatchObject({
      origin: "system",
      mode: "queue",
      queueState: "queued",
    });
    expect(new Set(next.item?.map((i) => i.seq)).size).toBe(2);
    expect(
      fireWake(next, "w", wake.revision, ctx("again"), { reason: "duplicate" }).events,
    ).toEqual([]);
  });
  it("Resume now queues the saved continuation as a system input after explicit human release", () => {
    const out = fireWake(
      armed(),
      "w",
      1,
      { ...ctx("manual"), actor: { kind: "human", id: "owner" } },
      undefined,
      true,
    );
    expect(out.result).toMatchObject({ status: "queued", reason: "Resumed now by you" });
    const state = applyEvents(armed(), out.events);
    expect(state.item?.find((i) => i.kind === "user")?.body).toMatchObject({
      origin: "system",
      queueState: "queued",
    });
  });
  it("fallback resurfaces without claiming success or running an agent", () => {
    const out = fireWake(armed(), "w", 1, ctx("fallback", "2026-11-11T12:00:00.000Z"));
    expect(out.result).toMatchObject({
      status: "consumed",
      reason: expect.stringContaining("not been confirmed"),
    });
    expect(
      out.events.some(
        (e) => e.aggregateType === "item" && (e.payload as { kind: string }).kind === "user",
      ),
    ).toBe(false);
    const state = applyEvents(armed(), out.events);
    expect(
      threadMailbox(
        {
          thread: state.thread?.find((t) => t.id === "a") as never,
          pending: false,
          working: false,
        },
        new Date("2026-11-11T12:00:00Z"),
      ),
    ).toBe("review");
  });
  it("defers for active turns and pending approvals, then resumes the saved reason", () => {
    const state = armed();
    state.turn?.push({ id: "busy", threadId: "a", status: "running" });
    const first = fireWake(state, "w", 1, ctx("first"), { reason: "Job completed" });
    expect(first.result).toMatchObject({ status: "ready" });
    const next = applyEvents(state, first.events);
    next.turn = [];
    next.interaction = [{ threadId: "a", state: "pending" }];
    expect(fireWake(next, "w", 2, ctx("pending")).result).toMatchObject({ status: "ready" });
    next.interaction = [];
    expect(fireWake(next, "w", 2, ctx("idle")).result).toMatchObject({
      status: "queued",
      reason: "Job completed",
    });
  });
  it("distinguishes finished from successful and never equates task review with completion", () => {
    const state = armed();
    const wake = state.wake?.[0] as Wake;
    state.session = [{ id: "s", threadId: "a", background: [{ id: "j", state: "failed" }] }];
    expect(localWakeMatch(state, wake)?.reason).toContain("failed");
    expect(
      localWakeMatch(state, {
        ...wake,
        condition: { ...input().condition, outcome: "passed" } as Wake["condition"],
      }),
    ).toBeUndefined();
    state.task = [{ id: "task", threadId: "b", state: "review" }];
    expect(
      localWakeMatch(state, {
        ...wake,
        condition: { kind: "task", taskId: "task", outcome: "finished" },
      }),
    ).toBeUndefined();
  });
  it("matches only new human messages in another chat within the workspace", () => {
    const state = armed(
      input({
        behavior: "inbox",
        condition: { kind: "topic", projectId: "p", phrase: "Woodworking" },
      }),
    );
    const wake = state.wake?.[0] as Wake;
    const item = {
      id: "mention",
      kind: "user",
      threadId: "b",
      createdAt: "2026-11-09T13:00:00.000Z",
      body: { origin: "system", input: [{ type: "text", text: "WOODWORKING" }] },
    };
    state.item = [item];
    expect(localWakeMatch(state, wake)).toBeUndefined();
    item.body.origin = "agent";
    expect(localWakeMatch(state, wake)).toBeUndefined();
    item.body.origin = "human";
    expect(localWakeMatch(state, wake)?.evidenceUrl).toBe("#chat/b");
    item.threadId = "a";
    expect(localWakeMatch(state, wake)).toBeUndefined();
  });
  it("rejects self/cyclic dependencies, duplicate waits, stale edits, and invalid fallbacks", () => {
    const state = seed();
    state.turn?.push({ id: "self", threadId: "a", status: "running" });
    expect(() =>
      saveWake(
        state,
        input({ condition: { kind: "turn", turnId: "self", outcome: "finished" } }),
        "w",
        ctx(),
      ),
    ).toThrow("self_dependency");
    const first = saveWake(
      state,
      input({ condition: { kind: "turn", turnId: "t", outcome: "finished" } }),
      "w",
      ctx(),
    );
    const next = applyEvents(state, first.events);
    expect(() =>
      saveWake(
        next,
        input({ threadId: "b", condition: { kind: "turn", turnId: "self", outcome: "finished" } }),
        "w2",
        ctx(),
      ),
    ).toThrow("cycle");
    expect(() => saveWake(next, input(), "w2", ctx())).toThrow("already_waiting");
    expect(() => cancelWake(next, "w", 9, ctx())).toThrow("stale_revision");
    expect(() => saveWake(seed(), input({ fallbackAt: at }), "w", ctx())).toThrow(
      "future_fallback",
    );
  });
  it("resurfaces for review if permissions changed while waiting", () => {
    const state = armed();
    if (state.agent?.[0]) state.agent[0].permissionProfile = "full_access";
    const out = fireWake(state, "w", 1, ctx("changed"), { reason: "Tests finished" });
    expect(out.result).toMatchObject({
      status: "needs_attention",
      error: expect.stringContaining("permissions changed"),
    });
    expect(
      out.events.some(
        (e) => e.aggregateType === "item" && (e.payload as { kind: string }).kind === "user",
      ),
    ).toBe(false);
  });
  it("cancels archived targets without executing", () => {
    const state = armed();
    const target = state.thread?.find((t) => t.id === "a");
    if (target) target.archived = true;
    expect(fireWake(state, "w", 1, ctx(), { reason: "done" }).result).toMatchObject({
      status: "cancelled",
    });
  });
});
