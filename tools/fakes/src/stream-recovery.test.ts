import { handle, observeRuntimeEvent, reserveRuntimeItem } from "@zoltbot/core";
import { recover } from "@zoltbot/daemon";
import { expect, it } from "vitest";
import { at, runtimeFixture } from "./runtime-fixture.js";

it("marks interrupted stream placeholders on recovery without persisting private text", async () => {
  const test = await runtimeFixture(),
    context = { commandId: "start", at, actor: { kind: "system" as const, id: "runtime" } };
  try {
    test.store.dispatch("ready", (state) =>
      handle(
        state,
        { type: "transition", kind: "session", id: "session", to: "ready" },
        { ...context, commandId: "ready" },
      ),
    );
    test.store.dispatch("start", (state) =>
      observeRuntimeEvent(
        state,
        { sessionId: "session", threadId: "thread", event: { t: "turn.started", turnId: "turn" } },
        context,
      ),
    );
    test.store.dispatch("reserve", (state) =>
      reserveRuntimeItem(
        state,
        {
          sessionId: "session",
          threadId: "thread",
          itemId: "partial",
          event: {
            t: "text.delta",
            turnId: "turn",
            itemId: "native",
            text: "synthetic-private-partial",
          },
        },
        { ...context, commandId: "reserve" },
      ),
    );
    recover(test.store, "boot:one", at);
    const snapshot = test.store.snapshot();
    expect(snapshot.item?.[0]?.body).toMatchObject({
      text: "",
      streaming: false,
      partial: true,
      interrupted: true,
    });
    expect(JSON.stringify(snapshot)).not.toContain("synthetic-private-partial");
    test.store.rebuild();
    expect(test.store.snapshot()).toEqual(snapshot);
    recover(test.store, "boot:two", at);
    expect(test.store.snapshot()).toEqual(snapshot);
  } finally {
    test.close();
  }
});
