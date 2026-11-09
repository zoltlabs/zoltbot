import { observeRuntimeEvent, reserveRuntimeItem } from "@zoltbot/core";
import type { DomainEvent } from "@zoltbot/protocol";
import { expect, it } from "vitest";
import { runtimeFixture } from "../../../tools/fakes/src/runtime-fixture.js";

const context = {
  commandId: "stream",
  at: "2026-10-29T00:00:00Z",
  actor: { kind: "system" as const, id: "runtime" },
};
async function fixture() {
  const f = await runtimeFixture();
  f.queue("queued", "Synthetic input");
  f.store.dispatch("history", (state) => ({
    events: [
      {
        eventId: "other-thread",
        aggregateType: "thread",
        aggregateId: "other",
        type: "thread.created",
        occurredAt: context.at,
        payload: { ...state.thread?.[0], id: "other" },
      },
      ...[
        ["old", "thread", "message", 10],
        ["note", "thread", "note", 11],
        ["latest", "thread", "message", 99],
        ["foreign", "other", "message", 500],
      ].map(([id, threadId, kind, seq]) => ({
        eventId: String(id),
        aggregateType: "item",
        aggregateId: String(id),
        type: "item.created",
        occurredAt: context.at,
        payload: {
          id,
          threadId,
          kind,
          seq,
          body: { text: "Synthetic history" },
          createdAt: context.at,
          updatedAt: context.at,
        },
      })),
    ] as DomainEvent[],
    result: {},
  }));
  f.store.dispatch("ready", (state) => ({
    events: [
      {
        eventId: "ready",
        aggregateType: "session",
        aggregateId: "session",
        type: "session.updated",
        occurredAt: context.at,
        payload: { ...state.session?.[0], state: "ready" },
      },
    ],
    result: {},
  }));
  f.store.dispatch("start", (state) =>
    observeRuntimeEvent(
      state,
      { sessionId: "session", threadId: "thread", event: { t: "turn.started", turnId: "turn" } },
      { ...context, commandId: "start" },
    ),
  );
  return f;
}
it("reads current queue and control metadata plus the latest ordering row without bulk history", async () => {
  const f = await fixture();
  try {
    const state = f.store.runtimeSnapshot("thread");
    expect(state.item?.map((row) => row.id).sort()).toEqual(["latest", "note", "queued"]);
    expect(state.session).toEqual(f.store.snapshot().session);
    const item = f.store.record("item", "old");
    (item?.body as { text: string }).text = "Changed outside store";
    expect(f.store.record("item", "old")?.body).toEqual({ text: "Synthetic history" });
    expect(f.store.record("item", "missing")).toBeUndefined();
  } finally {
    f.close();
  }
});
it("reserves streams transactionally with complete ordering and rejects cross thread identity conflicts", async () => {
  const f = await fixture();
  const produce = (state: ReturnType<typeof f.store.snapshot>) =>
    reserveRuntimeItem(
      state,
      {
        sessionId: "session",
        threadId: "thread",
        itemId: "stream",
        event: {
          t: "text.delta",
          turnId: "turn",
          itemId: "native",
          text: "Raw delta must not persist",
        },
      },
      context,
    );
  try {
    const before = f.store.snapshot();
    expect(() =>
      f.store.dispatch("rollback-stream", produce, {
        items: { ids: ["stream"], latestInThread: "thread" },
        killPoint: "after_projections",
      }),
    ).toThrow("kill point");
    expect(f.store.snapshot()).toEqual(before);
    expect(f.store.receipt("rollback-stream")).toBeUndefined();
    const receipt = f.store.dispatch("reserve-stream", produce, {
      items: { ids: ["stream"], latestInThread: "thread" },
    });
    expect(receipt.result.item).toMatchObject({
      id: "stream",
      seq: 100,
      body: { text: "", streaming: true },
    });
    expect(f.store.record("item", "old")).toEqual(before.item?.find((row) => row.id === "old"));
    expect(() =>
      f.store.dispatch(
        "foreign-stream",
        (state) =>
          reserveRuntimeItem(
            state,
            {
              sessionId: "session",
              threadId: "thread",
              itemId: "foreign",
              event: { t: "text.delta", turnId: "turn", itemId: "native", text: "ignored" },
            },
            context,
          ),
        { items: { ids: ["foreign"], latestInThread: "thread" } },
      ),
    ).toThrow("runtime_item_conflict");
    const snapshot = f.store.snapshot();
    f.store.rebuild();
    expect(f.store.snapshot()).toEqual(snapshot);
  } finally {
    f.close();
  }
});
