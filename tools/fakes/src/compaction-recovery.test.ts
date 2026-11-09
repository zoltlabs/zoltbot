import {
  handle,
  observeRuntimeEvent,
  requestNativeCompaction,
  settleNativeCompaction,
} from "@zoltbot/core";
import { recover } from "@zoltbot/daemon";
import { expect, it } from "vitest";
import { at, runtimeFixture } from "./runtime-fixture.js";

it("rolls back every compaction claim kill point and holds unproven operations after restart", async () => {
  for (const phase of ["sending", "acknowledged", "completed"] as const) {
    const test = await runtimeFixture(),
      system = { commandId: "setup", at, actor: { kind: "system" as const, id: "runtime" } };
    try {
      test.store.dispatch("capabilities", (state) =>
        handle(
          state,
          {
            type: "update",
            kind: "session",
            id: "session",
            changes: { capabilities: { compaction: { manual: true, events: true } } },
          },
          { ...system, commandId: "capabilities" },
        ),
      );
      test.store.dispatch("ready", (state) =>
        handle(state, { type: "transition", kind: "session", id: "session", to: "ready" }, system),
      );
      const before = test.store.snapshot(),
        seq = test.store.lastSeq();
      const claim = (state: typeof before) =>
        requestNativeCompaction(state, "session", "compact", "attempt", {
          ...system,
          commandId: "claim",
          actor: { kind: "human", id: "owner" },
        });
      for (const killPoint of [
        "before_events",
        "after_events",
        "after_projections",
        "after_receipt",
      ] as const) {
        expect(() => test.store.dispatch("claim", claim, { killPoint })).toThrow("kill point");
        expect(test.store.snapshot()).toEqual(before);
        expect(test.store.lastSeq()).toBe(seq);
      }
      test.store.dispatch("claim", claim);
      let replayed = false;
      test.store.dispatch("claim", (state) => {
        replayed = true;
        return claim(state);
      });
      expect(replayed).toBe(false);
      if (phase !== "sending")
        test.store.dispatch("acknowledge", (state) =>
          settleNativeCompaction(state, "compact", "attempt", "acknowledged", {
            ...system,
            commandId: "acknowledge",
          }),
        );
      if (phase === "completed")
        test.store.dispatch("observed", (state) =>
          observeRuntimeEvent(
            state,
            {
              sessionId: "session",
              threadId: "thread",
              itemId: "observed",
              event: { t: "compaction", state: "done", trigger: "manual" },
            },
            { ...system, commandId: "observed" },
          ),
        );
      recover(test.store, "boot:one", at);
      expect(test.store.snapshot().item?.find((row) => row.id === "compact")?.body).toMatchObject({
        state: phase === "completed" ? "completed" : "uncertain",
      });
      const recovered = test.store.snapshot();
      test.store.rebuild();
      expect(test.store.snapshot()).toEqual(recovered);
      recover(test.store, "boot:two", at);
      expect(test.store.snapshot()).toEqual(recovered);
    } finally {
      test.close();
    }
  }
});
