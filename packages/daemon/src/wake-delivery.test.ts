import { applyEvents, type DomainState, fireWake, saveWake } from "@zoltbot/core";
import { expect, it } from "vitest";
import { rejectChangedWake } from "./runtime-dispatch.js";

it("rejects a queued wake when permissions widen during asynchronous provider preflight", () => {
  const at = new Date().toISOString(),
    ctx = { commandId: "wake", at, actor: { kind: "system" as const, id: "test" } };
  let state: DomainState = {
    thread: [
      {
        id: "thread",
        agentId: "a",
        kind: "main",
        title: "Chat",
        titleSource: "human",
        pinned: false,
        archived: false,
        createdAt: at,
        lastActivityAt: at,
      },
    ],
    agent: [{ id: "a", permissionProfile: "read_only" }],
    session: [{ id: "s", threadId: "thread", background: [{ id: "j", state: "completed" }] }],
  };
  state = applyEvents(
    state,
    saveWake(
      state,
      {
        threadId: "thread",
        condition: { kind: "job", sessionId: "s", jobId: "j", outcome: "passed" },
        fallbackAt: new Date(Date.now() + 86400000).toISOString(),
        behavior: "resume",
        continuation: "Review results",
      },
      "w",
      ctx,
    ).events,
  );
  state = applyEvents(
    state,
    fireWake(state, "w", 1, { ...ctx, commandId: "fire" }, { reason: "Tests completed" }).events,
  );
  const item = state.item?.find((i) => i.kind === "user");
  expect(item).toBeDefined();
  expect(
    rejectChangedWake(state, item ?? {}, () => {
      throw new Error("must not reject original grant");
    }),
  ).toBe(false);
  if (state.agent?.[0]) state.agent[0].permissionProfile = "full_access";
  expect(
    rejectChangedWake(state, item ?? {}, (work) => {
      const out = work(state, { ...ctx, commandId: "reject" });
      state = applyEvents(state, out.events);
    }),
  ).toBe(true);
  expect(state.item?.find((i) => i.id === item?.id)?.body).toMatchObject({ queueState: "failed" });
});
