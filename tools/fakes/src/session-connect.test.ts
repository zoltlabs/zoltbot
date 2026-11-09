import { handle } from "@zoltbot/core";
import { expect, it } from "vitest";
import { runtimeApi } from "../../../packages/daemon/src/runtime-api.js";
import { SessionManager } from "../../../packages/daemon/src/session-manager.js";
import { ReferenceSession } from "./reference-adapter.js";
import { at, runtimeFixture } from "./runtime-fixture.js";

it("connects saved chat without sending a prompt and never replays a completed connection intent", async () => {
  const fixture = await runtimeFixture();
  let opens = 0;
  fixture.store.dispatch("close-seed", (state) =>
    handle(
      state,
      { type: "transition", kind: "session", id: "session", to: "closed" },
      {
        commandId: "close-seed",
        at,
        actor: { kind: "system", id: "runtime" },
      },
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
          async open(request) {
            opens++;
            return new ReferenceSession({
              identity: { agentId: "profile", threadId: "thread" },
              mode: request.mode,
              ...(request.nativeId ? { nativeId: request.nativeId } : {}),
              cwd: fixture.root,
              permissionProfile: "read_only",
              hostMcp: { url: "http://127.0.0.1:1", token: "fixture-only" },
            }).open();
          },
        };
      },
    },
  });
  const call = runtimeApi({ store: fixture.store, manager, publish() {} });
  const params = { threadId: "thread", previousSessionId: "session" };
  try {
    expect(await call("session.connect", params, "connect-once")).toEqual({ ok: true });
    const worker = await manager.ensure("thread");
    await worker.close();
    expect(await call("session.connect", params, "connect-once")).toEqual({ ok: true });
    expect(opens).toBe(1);
    expect(fixture.store.snapshot().turn ?? []).toHaveLength(0);
    expect(fixture.store.snapshot().item ?? []).toHaveLength(0);
    expect(
      fixture.store.snapshot().audit?.filter((row) => row.action === "session.connect"),
    ).toHaveLength(1);
    expect(() => call("session.connect", params, "new-stale-intent")).toThrow(
      "session_connection_changed",
    );
    expect(() => call("session.connect", { ...params, threadId: "other" }, "connect-once")).toThrow(
      "command_receipt_conflict",
    );
  } finally {
    await manager.close();
    fixture.close();
  }
});
