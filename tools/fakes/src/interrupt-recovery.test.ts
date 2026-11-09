import { handle, observeRuntimeEvent, requestTurnInterrupt } from "@zoltbot/core";
import { recover } from "@zoltbot/daemon";
import { expect, it } from "vitest";
import { at, runtimeFixture } from "./runtime-fixture.js";

it("rolls back stop claims at every kill point and never replays an unconfirmed stop on recovery", async () => {
  const test = await runtimeFixture();
  const system = { commandId: "ready", at, actor: { kind: "system" as const, id: "runtime" } };
  try {
    test.store.dispatch("capabilities", (state) =>
      handle(
        state,
        {
          type: "update",
          kind: "session",
          id: "session",
          changes: { capabilities: { interrupt: "native" } },
        },
        { ...system, commandId: "capabilities" },
      ),
    );
    test.store.dispatch("ready", (state) =>
      handle(state, { type: "transition", kind: "session", id: "session", to: "ready" }, system),
    );
    test.store.dispatch("started", (state) =>
      observeRuntimeEvent(
        state,
        { threadId: "thread", sessionId: "session", event: { t: "turn.started", turnId: "turn" } },
        { ...system, commandId: "started" },
      ),
    );
    const before = test.store.snapshot(),
      seq = test.store.lastSeq();
    const claim = (state: typeof before) =>
      requestTurnInterrupt(state, "thread", "turn", "stop-note", {
        ...system,
        commandId: "stop",
        actor: { kind: "human", id: "owner" },
      });
    for (const killPoint of [
      "before_events",
      "after_events",
      "after_projections",
      "after_receipt",
    ] as const) {
      expect(() => test.store.dispatch("stop", claim, { killPoint })).toThrow("kill point");
      expect(test.store.snapshot()).toEqual(before);
      expect(test.store.lastSeq()).toBe(seq);
    }
    test.store.dispatch("stop", claim);
    recover(test.store, "boot:one", at);
    expect(test.store.snapshot().item?.find((row) => row.id === "stop-note")?.body).toMatchObject({
      state: "uncertain",
    });
    let repeated = false;
    test.store.dispatch("stop", (state) => {
      repeated = true;
      return claim(state);
    });
    expect(repeated).toBe(false);
    const recovered = test.store.snapshot();
    test.store.rebuild();
    expect(test.store.snapshot()).toEqual(recovered);
    recover(test.store, "boot:two", at);
    expect(test.store.snapshot()).toEqual(recovered);
  } finally {
    test.close();
  }
});
