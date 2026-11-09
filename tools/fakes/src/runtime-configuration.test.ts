import { handle } from "@zoltbot/core";
import { expect, it } from "vitest";
import { SessionManager } from "../../../packages/daemon/src/session-manager.js";
import { ReferenceSession } from "./reference-adapter.js";
import { at, runtimeFixture } from "./runtime-fixture.js";

for (const phase of ["prepare", "open"] as const)
  it(`fences configuration changes during ${phase} before queued input can run`, async () => {
    const f = await runtimeFixture();
    f.store.dispatch("close-seed", (state) =>
      handle(
        state,
        { type: "transition", kind: "session", id: "session", to: "closed" },
        { commandId: "close-seed", at, actor: { kind: "system", id: "runtime" } },
      ),
    );
    f.queue("pending", "must remain queued");
    let release = () => {},
      entered = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let opened = 0,
      closed = 0;
    const manager = new SessionManager({
      store: f.store,
      publish() {},
      host: {
        async prepare() {
          if (phase === "prepare") {
            entered();
            await gate;
          }
          return {
            cwd: f.root,
            estimate: (text: string) => text.length,
            async open(request) {
              opened++;
              const native = await new ReferenceSession({
                identity: { agentId: "profile", threadId: "thread" },
                mode: "new",
                cwd: f.root,
                env: {},
                permissionProfile: "read_only",
                hostMcp: { url: "http://127.0.0.1:1", token: "fixture-only" },
              }).open();
              const close = native.close.bind(native);
              native.close = async () => {
                closed++;
                await close();
              };
              expect(request.mode).toBe("new");
              if (phase === "open") {
                entered();
                await gate;
              }
              return native;
            },
          };
        },
      },
    });
    const opening = manager.ensure("thread");
    const rejected = expect(opening).rejects.toThrow(/^runtime_configuration_changed$/);
    try {
      await started;
      f.store.dispatch("change-profile", (state) =>
        handle(
          state,
          {
            type: "update",
            kind: "agent",
            id: "profile",
            changes: { instructions: "new authority" },
          },
          { commandId: "change-profile", at, actor: { kind: "human", id: "owner" } },
        ),
      );
      release();
      await rejected;
      expect(opened).toBe(phase === "open" ? 1 : 0);
      expect(closed).toBe(opened);
      const state = f.store.snapshot();
      expect(state.turn ?? []).toHaveLength(0);
      expect(state.item?.filter((row) => row.kind === "message")).toHaveLength(0);
      expect(state.item?.find((row) => row.id === "pending")?.body).toMatchObject({
        queueState: "queued",
      });
      expect(state.session?.filter((row) => row.state === "starting")).toHaveLength(0);
    } finally {
      release();
      await manager.close();
      f.close();
    }
  });
