import { handle } from "@zoltbot/core";
import type { ForkOperation } from "@zoltbot/protocol";
import { expect, it } from "vitest";
import { forkFixture } from "../../../tools/fakes/src/fork-fixture.js";
import { ForkFakeSession } from "../../../tools/fakes/src/fork-runtime.js";
import { at } from "../../../tools/fakes/src/runtime-fixture.js";
import { forkApi } from "./fork-api.js";
import { forkWorkspaceBusy } from "./fork-workspaces.js";
import { PrivateInputGuard } from "./private-input.js";
import { firstNativePromptPending } from "./runtime-configuration.js";
import { SessionManager } from "./session-manager.js";

async function fixture() {
  const f = await forkFixture();
  const put = f.put;
  let opens = 0;
  const natives: ForkFakeSession[] = [];
  let failure = false;
  let beforeOpen: (() => Promise<void>) | undefined;
  const manager = new SessionManager({
    store: f.store,
    publish() {},
    host: {
      async prepare(input) {
        return {
          cwd: f.root,
          estimate: () => 1,
          configuration: input.previous?.configuration as Record<string, unknown>,
          firstTurnKnowledge: { packId: "knowledge", text: "INHERITED_KNOWLEDGE", tokens: 1 },
          async open(request) {
            opens++;
            await beforeOpen?.();
            if (failure) throw Error("injected_after_dispatch");
            expect(request.mode).toBe(
              input.thread.fork &&
                !f.store
                  .snapshot()
                  .session?.some((r) => r.threadId === input.thread.id && r.nativeId)
                ? "fork"
                : "resume",
            );
            const native = new ForkFakeSession(
              request.fork?.targetNativeId ?? request.nativeId ?? "bad-id",
            );
            natives.push(native);
            return native;
          },
        };
      },
    },
  });
  const privacy = new PrivateInputGuard({ store: f.store, publish() {} });
  const api = forkApi({ store: f.store, manager, privacy, publish() {} });
  return {
    ...f,
    put,
    api,
    manager,
    natives,
    opens: () => opens,
    beforeOpen: (hook: () => Promise<void>) => {
      beforeOpen = hook;
    },
    fail: () => {
      failure = true;
    },
    async clean() {
      await manager.close();
      f.close();
    },
  };
}
it("forks once with independent provenance, frozen display history and no duplicate knowledge on first send", async () => {
  const f = await fixture();
  try {
    const result = (await f.api(
      "thread.fork",
      { id: "thread", title: "Child" },
      "fork-command",
    )) as ForkOperation;
    expect(result.state).toBe("ready");
    expect(result.targetNativeId).not.toBe("parent-native");
    expect(f.store.record("thread", result.childThreadId)).toMatchObject({
      kind: "side",
      fork: {
        sourceThreadId: "thread",
        inheritedHistoryPresent: true,
        permissionCeiling: "read_only",
      },
    });
    expect(await f.api("thread.fork", { id: "thread", title: "Child" }, "fork-command")).toEqual(
      result,
    );
    expect(f.opens()).toBe(1);
    await expect(
      f.api("thread.fork", { id: "thread", title: "Changed" }, "fork-command"),
    ).rejects.toThrow("command_receipt_conflict");
    expect(
      firstNativePromptPending(
        f.store.snapshot(),
        result.childThreadId,
        result.targetNativeId as string,
      ),
    ).toBe(false);
    f.put("item", {
      id: "later",
      threadId: "thread",
      seq: 2,
      kind: "message",
      body: { text: "LATER_NOT_IN_CHILD" },
      createdAt: at,
    });
    expect(await f.api("thread.forkHistory", { id: result.childThreadId })).toMatchObject({
      items: [{ id: "source-message" }],
    });
    const childWorker = await f.manager.ensure(result.childThreadId);
    f.store.dispatch("child-input", (s) =>
      handle(
        s,
        {
          type: "create",
          kind: "item",
          value: {
            id: "human-child",
            threadId: result.childThreadId,
            seq: 1,
            kind: "user",
            body: {
              input: [{ type: "text", text: "ONLY_CHILD_INPUT" }],
              mode: "queue",
              origin: "human",
              queueState: "queued",
            },
            createdAt: at,
            updatedAt: at,
          },
        },
        { commandId: "child-input", at, actor: { kind: "human", id: "owner" } },
      ),
    );
    await childWorker.wake();
    await expect.poll(() => f.natives[0]?.received.length).toBe(1);
    expect(JSON.stringify(f.natives[0]?.received)).not.toContain("INHERITED_KNOWLEDGE");
  } finally {
    await f.clean();
  }
});
it("retains uncertain dispatch and never creates a second native session on replay or restart", async () => {
  const f = await fixture();
  try {
    f.fail();
    const result = (await f.api("thread.fork", { id: "thread" }, "uncertain")) as ForkOperation;
    expect(result.state).toBe("needs_reconciliation");
    expect(f.opens()).toBe(1);
    await f.api("thread.fork", { id: "thread" }, "uncertain");
    const again = forkApi({
      store: f.store,
      manager: f.manager,
      privacy: new PrivateInputGuard({ store: f.store, publish() {} }),
      publish() {},
    });
    expect(await again("thread.fork", { id: "thread" }, "uncertain")).toMatchObject({
      state: "needs_reconciliation",
    });
    expect(f.opens()).toBe(1);
    await expect(f.manager.ensure(result.childThreadId)).rejects.toThrow(
      "fork_needs_reconciliation",
    );
  } finally {
    await f.clean();
  }
});
it("rejects busy sources and unsupported boundaries before dispatch", async () => {
  const f = await fixture();
  try {
    f.put("turn", {
      id: "active",
      threadId: "thread",
      sessionId: "session",
      status: "running",
      origin: "human",
      startedAt: at,
    });
    await expect(f.api("thread.fork", { id: "thread" }, "busy")).rejects.toThrow(
      "fork_requires_idle",
    );
    expect(f.opens()).toBe(0);
  } finally {
    await f.clean();
  }
});
it("preserves history and the ceiling when forking a fork", async () => {
  const f = await fixture();
  try {
    const one = (await f.api("thread.fork", { id: "thread" }, "one")) as ForkOperation;
    const two = (await f.api("thread.fork", { id: one.childThreadId }, "two")) as ForkOperation;
    expect(two.state).toBe("ready");
    expect(await f.api("thread.forkHistory", { id: two.childThreadId })).toMatchObject({
      items: [{ id: "source-message" }],
    });
  } finally {
    await f.clean();
  }
});

it("holds the source against mutation and disconnection while native creation yields", async () => {
  const f = await fixture();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.beforeOpen(() => gate);
  try {
    const pending = f.api("thread.fork", { id: "thread" }, "leased");
    await expect.poll(f.opens).toBe(1);
    expect(() => f.manager.assertMutable("thread")).toThrow("fork_source_busy");
    await expect(f.manager.stopSession("session")).rejects.toThrow("fork_source_busy");
    release();
    expect(await pending).toMatchObject({ state: "ready" });
    expect(() => f.manager.assertMutable("thread")).not.toThrow();
  } finally {
    release();
    await f.clean();
  }
});
it("serializes shared-folder dispatch before a native turn-start event exists", async () => {
  const f = await fixture();
  try {
    const child = (await f.api("thread.fork", { id: "thread" }, "serialized")) as ForkOperation;
    const session = f.store
      .snapshot(["session"])
      .session?.find((s) => s.threadId === child.childThreadId);
    f.put("item", {
      id: "in-transit",
      threadId: "thread",
      seq: 2,
      kind: "user",
      body: { queueState: "sending", input: [{ type: "text", text: "working" }] },
      createdAt: at,
    });
    expect(forkWorkspaceBusy(f.store.snapshot(), child.childThreadId, String(session?.id))).toBe(
      true,
    );
    f.put("item", { ...f.store.record("item", "in-transit"), body: { queueState: "sent" } });
    expect(forkWorkspaceBusy(f.store.snapshot(), child.childThreadId, String(session?.id))).toBe(
      false,
    );
  } finally {
    await f.clean();
  }
});
it("recognizes native history across daemon session incarnations", async () => {
  const f = await fixture();
  try {
    f.put("session", {
      ...f.store.record("session", "session"),
      id: "resumed-session",
      startedAt: "2026-11-06T12:00:00Z",
    });
    f.put("settings", {
      key: "runtime.configuration.resumed-session",
      value: f.store.record("settings", "runtime.configuration.session")?.value,
    });
    expect(await f.api("thread.forkPreview", { id: "thread" })).toMatchObject({ available: true });
  } finally {
    await f.clean();
  }
});
