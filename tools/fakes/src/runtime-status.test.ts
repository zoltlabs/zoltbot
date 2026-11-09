import { handle } from "@zoltbot/core";
import { expect, it } from "vitest";
import { SessionManager } from "../../../packages/daemon/src/session-manager.js";
import { at, runtimeFixture } from "./runtime-fixture.js";

it("persists a safe authentication reason when native open rejects before returning a handle", async () => {
  const fixture = await runtimeFixture();
  fixture.store.dispatch("close-seed", (state) =>
    handle(
      state,
      { type: "transition", kind: "session", id: "session", to: "closed" },
      { commandId: "close-seed", at, actor: { kind: "system", id: "runtime" } },
    ),
  );
  const manager = new SessionManager({
    store: fixture.store,
    publish() {},
    host: {
      async prepare() {
        return {
          cwd: fixture.root,
          estimate: (text) => text.length,
          async open() {
            throw new Error("auth_required");
          },
        };
      },
    },
  });
  try {
    await expect(manager.ensure("thread")).rejects.toThrow("auth_required");
    const failed = fixture.store.snapshot().session?.find((row) => row.state === "failed");
    expect(failed).toMatchObject({ endReason: "auth_required" });
    expect(failed?.endedAt).toEqual(expect.any(String));
  } finally {
    await manager.close();
    fixture.close();
  }
});
