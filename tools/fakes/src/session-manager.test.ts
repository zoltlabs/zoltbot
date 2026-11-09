import { type AgentSession, AsyncQueue } from "@zoltbot/adapters-sdk";
import { handle } from "@zoltbot/core";
import type { AgentEvent, InteractionAnswer } from "@zoltbot/protocol";
import { expect, it } from "vitest";
import { InteractionEngine } from "../../../packages/daemon/src/interaction-engine.js";
import { type RuntimeHost, SessionManager } from "../../../packages/daemon/src/session-manager.js";
import { referenceCapabilities } from "./capabilities.js";
import { at, runtimeFixture } from "./runtime-fixture.js";

class Native implements AgentSession {
  readonly capabilities: typeof referenceCapabilities;
  readonly queue = new AsyncQueue<AgentEvent>();
  closes = 0;
  constructor(
    readonly nativeId = "native",
    events = true,
  ) {
    this.capabilities = {
      ...referenceCapabilities,
      compaction: { ...referenceCapabilities.compaction, events },
    };
    void this.queue.push({
      t: "session.ready",
      nativeId,
      capabilities: this.capabilities,
      providerVersion: "fixture",
    });
  }
  events() {
    return this.queue;
  }
  async send() {
    return { disposition: "handled" as const };
  }
  async interrupt() {}
  async respond(_id: string, _answer: InteractionAnswer) {}
  async setModel() {}
  async setMode() {}
  async compact() {}
  async rename() {}
  async contextUsage() {
    return undefined;
  }
  async close() {
    this.closes++;
    this.queue.close();
  }
}
async function fixture() {
  const test = await runtimeFixture();
  test.store.dispatch("close-seed", (state) =>
    handle(
      state,
      { type: "transition", kind: "session", id: "session", to: "closed" },
      { commandId: "close-seed", at, actor: { kind: "system", id: "runtime" } },
    ),
  );
  return test;
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
it("single flights concurrent opens and reserves durable ownership before launching native work", async () => {
  const test = await fixture();
  let opens = 0,
    prepares = 0;
  const natives: Native[] = [];
  const manager = new SessionManager({
    store: test.store,
    publish() {},
    host: {
      async prepare() {
        prepares++;
        await tick();
        return {
          cwd: test.root,
          estimate: (text) => text.length,
          async open() {
            opens++;
            expect(
              test.store.snapshot().session?.filter((row) => row.state === "starting"),
            ).toHaveLength(1);
            const native = new Native();
            natives.push(native);
            return native;
          },
        };
      },
    },
  });
  try {
    const first = manager.ensure("thread"),
      second = manager.ensure("thread");
    expect(first === second).toBe(true);
    const worker = await first;
    await tick();
    expect((await manager.ensure("thread")) === worker).toBe(true);
    expect(prepares).toBe(1);
    expect(opens).toBe(1);
    expect(test.store.snapshot().session?.filter((row) => row.state === "ready")).toHaveLength(1);
  } finally {
    await manager.close();
    test.close();
  }
  expect(natives[0]?.closes).toBe(1);
});
it("records failed open cleanup, masks unexpected provider errors, and permits a repaired retry", async () => {
  const test = await fixture();
  let opens = 0;
  const manager = new SessionManager({
    store: test.store,
    publish() {},
    host: {
      async prepare() {
        return {
          cwd: test.root,
          estimate: (text) => text.length,
          async open() {
            if (++opens === 1) throw new Error("synthetic-private-provider-error");
            return new Native();
          },
        };
      },
    },
  });
  try {
    await expect(manager.ensure("thread")).rejects.toThrow("runtime_open_failed");
    expect(test.store.snapshot().session?.filter((row) => row.state === "failed")).toHaveLength(1);
    expect(JSON.stringify(test.store.snapshot())).not.toContain("synthetic-private-provider-error");
    await manager.ensure("thread");
    await tick();
    expect(opens).toBe(2);
  } finally {
    await manager.close();
    test.close();
  }
});
it("closes a native handle returned during shutdown without retaining an owner", async () => {
  const test = await fixture();
  let resolveOpen: (value: Native) => void = () => {},
    entered = false;
  const manager = new SessionManager({
    store: test.store,
    publish() {},
    host: {
      async prepare() {
        return {
          cwd: test.root,
          estimate: (text) => text.length,
          open() {
            entered = true;
            return new Promise<Native>((resolve) => {
              resolveOpen = resolve;
            });
          },
        };
      },
    },
  });
  try {
    const opening = manager.ensure("thread").then(
      () => "unexpected_open",
      (error) => (error as Error).message,
    );
    while (!entered) await tick();
    const closing = manager.close(),
      native = new Native();
    resolveOpen(native);
    await closing;
    expect(await opening).toBe("runtime_closed");
    expect(native.closes).toBe(1);
    expect(
      test.store
        .snapshot()
        .session?.some((row) => ["starting", "ready", "running"].includes(String(row.state))),
    ).toBe(false);
    await expect(manager.ensure("thread")).rejects.toThrow("runtime_closed");
  } finally {
    await manager.close();
    test.close();
  }
});
it("resumes the last native identity in its original cwd and refuses a silent workspace change", async () => {
  const test = await fixture(),
    modes: string[] = [];
  let changeCwd = false;
  const host: RuntimeHost = {
    async prepare(input) {
      if (modes.length)
        expect(input.previous).toEqual({
          nativeId: "native",
          cwd: test.root,
          provider: "reference",
          firstPromptPending: true,
        });
      return {
        cwd: changeCwd ? `${test.root}/different` : test.root,
        estimate: (text) => text.length,
        async open(request) {
          modes.push(request.mode);
          if (request.mode === "resume") expect(request.nativeId).toBe("native");
          return new Native();
        },
      };
    },
  };
  const manager = new SessionManager({ store: test.store, host, publish() {} });
  try {
    const first = await manager.ensure("thread");
    await tick();
    await first.close();
    const resumed = await manager.ensure("thread");
    await tick();
    await resumed.close();
    expect(modes).toEqual(["new", "resume"]);
    changeCwd = true;
    await expect(manager.ensure("thread")).rejects.toThrow("native_cwd_changed");
    expect(modes).toHaveLength(2);
  } finally {
    await manager.close();
    test.close();
  }
});
it("masks preparation errors before exposing them to daemon callers", async () => {
  const test = await fixture(),
    manager = new SessionManager({
      store: test.store,
      publish() {},
      host: {
        async prepare() {
          throw new Error("synthetic-private-preparation-error");
        },
      },
    });
  try {
    await expect(manager.ensure("thread")).rejects.toThrow("runtime_open_failed");
  } finally {
    await manager.close();
    test.close();
  }
});
it("records a failed resume even if the rejected native handle also fails cleanup", async () => {
  const test = await fixture();
  let opens = 0;
  const manager = new SessionManager({
    store: test.store,
    publish() {},
    host: {
      async prepare() {
        return {
          cwd: test.root,
          estimate: (text) => text.length,
          async open() {
            if (++opens === 1) return new Native();
            const native = new Native("changed-native-id");
            native.close = async () => {
              native.queue.close();
              throw new Error("synthetic-private-cleanup-error");
            };
            return native;
          },
        };
      },
    },
  });
  try {
    const first = await manager.ensure("thread");
    await tick();
    await first.close();
    await expect(manager.ensure("thread")).rejects.toThrow("resume_identity_changed");
    expect(test.store.snapshot().session?.filter((row) => row.state === "failed")).toHaveLength(1);
    await expect(manager.ensure("thread")).rejects.toThrow("runtime_cleanup_required");
  } finally {
    await expect(manager.close()).rejects.toThrow("runtime_close_failed");
    test.close();
  }
});

it.each([
  "error",
  "auth_required",
  "eof",
] as const)("quarantines autonomous %s when native cleanup cannot be confirmed", async (failure) => {
  const test = await fixture(),
    native = new Native();
  let opens = 0;
  native.close = async () => {
    native.closes++;
    native.queue.close();
    throw new Error("synthetic-private-cleanup-error");
  };
  const manager = new SessionManager({
    store: test.store,
    publish() {},
    host: {
      async prepare() {
        return {
          cwd: test.root,
          estimate: (text) => text.length,
          async open() {
            opens++;
            return native;
          },
        };
      },
    },
  });
  try {
    const worker = await manager.ensure("thread");
    await tick();
    if (failure === "eof") native.queue.close();
    else await native.queue.push({ t: "status", state: failure });
    await tick();
    await expect(worker.close()).rejects.toThrow("runtime_cleanup_required");
    await expect(manager.ensure("thread")).rejects.toThrow("runtime_cleanup_required");
    await expect(manager.ensure("thread")).rejects.toThrow("runtime_cleanup_required");
    expect(test.store.snapshot().session?.find((row) => row.nativeId === "native")?.endReason).toBe(
      "runtime_cleanup_required",
    );
    test.store.rebuild();
    const replacement = new SessionManager({
      store: test.store,
      publish() {},
      host: {
        async prepare() {
          throw new Error("unexpected_prepare");
        },
      },
    });
    await expect(replacement.ensure("thread")).rejects.toThrow("runtime_cleanup_required");
    await replacement.close();
    expect(opens).toBe(1);
    expect(JSON.stringify(test.store.snapshot())).not.toContain("synthetic-private-cleanup-error");
  } finally {
    await expect(manager.close()).rejects.toThrow("runtime_close_failed");
    test.close();
  }
});

it("keeps private answers out of SQLite and requires restored privacy before native resume", async () => {
  const test = await fixture(),
    native = new Native();
  let opens = 0,
    restored = false;
  let engine: InteractionEngine;
  const manager = new SessionManager({
    store: test.store,
    publish() {},
    interactions: async () => engine,
    host: {
      async prepare(input, redactor) {
        if (input.previous?.privateContextRequired && restored) {
          redactor.register("synthetic-private-managed-value");
          redactor.hideFrames();
        }
        return {
          cwd: test.root,
          estimate: (text) => text.length,
          privateContextRestored: restored,
          async open() {
            opens++;
            return opens === 1 ? native : new Native();
          },
        };
      },
    },
  });
  engine = new InteractionEngine({
    store: test.store,
    publish() {},
    host: manager.interactionHost,
  });
  try {
    const worker = await manager.ensure("thread");
    await tick();
    await native.queue.push({ t: "turn.started", turnId: "private-turn" });
    await native.queue.push({
      t: "interaction.requested",
      interaction: {
        id: "private",
        nativeRef: "native-private",
        agentId: "profile",
        threadId: "thread",
        turnId: "private-turn",
        type: "question",
        items: [{ id: "q", prompt: "Private value", secret: true }],
        chain: [],
        urgency: "blocking",
      },
    });
    for (
      let tries = 0;
      tries < 200 && !test.store.snapshot().interaction?.some((row) => row.state === "pending");
      tries++
    )
      await tick();
    const request = test.store.snapshot().interaction?.find((row) => row.state === "pending");
    if (!request) throw new Error("fixture_private_request_missing");
    let delivered: InteractionAnswer | undefined;
    native.respond = async (_id, answer) => {
      delivered = answer;
    };
    await engine.answer(
      String(request.id),
      Number(request.version),
      {
        action: "accept",
        answers: { q: { value: "synthetic-private-managed-value" } },
        by: { kind: "human", id: "owner" },
        at,
      },
      "private:answer",
      { kind: "human", id: "owner" },
    );
    expect(delivered?.answers?.q?.value).toBe("synthetic-private-managed-value");
    expect(JSON.stringify(test.store.snapshot())).not.toContain("synthetic-private-managed-value");
    expect(
      test.store
        .snapshot()
        .settings?.some(
          (row) => String(row.key).startsWith("runtime.private.") && row.value === true,
        ),
    ).toBe(true);
    await worker.close();
    await expect(manager.ensure("thread")).rejects.toThrow("runtime_private_context_required");
    expect(opens).toBe(1);
    restored = true;
    await manager.ensure("thread");
    expect(opens).toBe(2);
  } finally {
    await engine.stopTimers();
    await manager.close();
    test.close();
  }
});
it("physically stops a timed out native turn before parking its held request", async () => {
  const test = await fixture(),
    native = new Native();
  let now = at;
  let engine: InteractionEngine;
  const manager = new SessionManager({
    store: test.store,
    publish() {},
    interactions: async () => engine,
    host: {
      async prepare() {
        return {
          cwd: test.root,
          estimate: (text) => text.length,
          async open() {
            return native;
          },
        };
      },
    },
  });
  engine = new InteractionEngine({
    store: test.store,
    publish() {},
    host: manager.interactionHost,
    now: () => now,
  });
  try {
    await manager.ensure("thread");
    await tick();
    await native.queue.push({ t: "turn.started", turnId: "timed-turn" });
    await native.queue.push({
      t: "interaction.requested",
      interaction: {
        id: "timed",
        nativeRef: "native-timed",
        agentId: "profile",
        threadId: "thread",
        turnId: "timed-turn",
        type: "question",
        items: [{ id: "q", prompt: "Answer" }],
        chain: [],
        urgency: "blocking",
        timeout: { seconds: 1, onTimeout: "park" },
      },
    });
    for (
      let tries = 0;
      tries < 200 && !test.store.snapshot().interaction?.some((row) => row.state === "pending");
      tries++
    )
      await tick();
    now = "2026-10-28T12:00:02Z";
    await engine.tick();
    expect(native.closes).toBe(1);
    expect(test.store.snapshot().turn?.[0]).toMatchObject({
      status: "interrupted",
      stopReason: "interaction_timeout",
    });
    expect(test.store.snapshot().interaction?.[0]).toMatchObject({
      state: "expired",
      resolution: { feedback: "interaction_timeout" },
    });
  } finally {
    await engine.stopTimers();
    await manager.close();
    test.close();
  }
});

it("holds queued chat until native compaction finishes and does not repeat a replayed command", async () => {
  for (const events of [true, false]) {
    const test = await fixture(),
      native = new Native("native", events);
    let finish: () => void = () => {},
      sends = 0,
      compacts = 0;
    native.send = async () => {
      sends++;
      return { disposition: "handled" };
    };
    native.compact = async () => {
      compacts++;
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
    };
    const manager = new SessionManager({
      store: test.store,
      publish() {},
      host: {
        async prepare() {
          return {
            cwd: test.root,
            estimate: (text) => text.length,
            async open() {
              return native;
            },
          };
        },
      },
    });
    let compacting: Promise<{ ok: true }> | undefined;
    try {
      const worker = await manager.ensure("thread");
      await tick();
      const session = test.store.snapshot().session?.find((row) => row.state === "ready");
      if (!session) throw new Error("fixture_session_missing");
      compacting = manager.compact(String(session.id), undefined, "manual:once");
      test.queue("queued", "hello");
      await worker.wake();
      expect(sends).toBe(0);
      if (events) {
        await native.queue.push({ t: "compaction", state: "done", trigger: "manual" });
        await tick();
      }
      finish();
      await compacting;
      for (let i = 0; i < 200 && !sends; i++) await tick();
      expect(sends).toBe(1);
      expect(await manager.compact(String(session.id), undefined, "manual:once")).toEqual({
        ok: true,
      });
      expect(compacts).toBe(1);
    } finally {
      finish();
      await compacting;
      await manager.close();
      test.close();
    }
  }
});
it("holds a lost manual compaction acknowledgement as uncertain and never retries it", async () => {
  for (const failClose of [false, true]) {
    const test = await fixture(),
      native = new Native();
    let compacts = 0;
    native.compact = async () => {
      compacts++;
      throw new Error("synthetic-private-compaction-error");
    };
    if (failClose)
      native.close = async () => {
        native.closes++;
        native.queue.close();
        throw new Error("synthetic-private-close-error");
      };
    const manager = new SessionManager({
      store: test.store,
      publish() {},
      host: {
        async prepare() {
          return {
            cwd: test.root,
            estimate: (text) => text.length,
            async open() {
              return native;
            },
          };
        },
      },
    });
    try {
      await manager.ensure("thread");
      await tick();
      const session = test.store.snapshot().session?.find((row) => row.state === "ready");
      if (!session) throw new Error("fixture_session_missing");
      await expect(manager.compact(String(session.id), undefined, "manual:lost")).rejects.toThrow(
        "compaction_delivery_uncertain",
      );
      await expect(manager.compact(String(session.id), undefined, "manual:lost")).rejects.toThrow(
        "compaction_delivery_uncertain",
      );
      expect(compacts).toBe(1);
      expect(native.closes).toBe(1);
      expect(
        test.store
          .snapshot()
          .item?.find((row) => (row.body as Record<string, unknown>).code === "manual_compaction")
          ?.body,
      ).toMatchObject({ state: "uncertain" });
      expect(JSON.stringify(test.store.snapshot())).not.toContain(
        "synthetic-private-compaction-error",
      );
    } finally {
      if (failClose) await expect(manager.close()).rejects.toThrow("runtime_close_failed");
      else await manager.close();
      test.close();
    }
  }
});

it("fences native interrupt by turn and receipt, holding queued work until both completion and acknowledgement", async () => {
  const test = await fixture(),
    native = new Native();
  let interrupts = 0,
    sends = 0,
    release = () => {};
  native.interrupt = async () => {
    interrupts++;
    await new Promise<void>((resolve) => {
      release = resolve;
    });
  };
  native.send = async () => {
    sends++;
    return { disposition: "handled" };
  };
  const manager = new SessionManager({
    store: test.store,
    publish() {},
    host: {
      async prepare() {
        return {
          cwd: test.root,
          estimate: (value) => value.length,
          async open() {
            return native;
          },
        };
      },
    },
  });
  let stopping: Promise<{ ok: true }> | undefined;
  try {
    const worker = await manager.ensure("thread");
    await tick();
    await native.queue.push({ t: "turn.started", turnId: "native-turn" });
    for (let i = 0; i < 200 && !test.store.snapshot().turn?.length; i++) await tick();
    const turnId = String(test.store.snapshot().turn?.[0]?.id);
    await expect(manager.interrupt("thread", "stale", "stop:stale")).rejects.toThrow(
      "interrupt_turn_changed",
    );
    expect(interrupts).toBe(0);
    stopping = manager.interrupt("thread", turnId, "stop:once");
    const duplicate = manager.interrupt("thread", turnId, "stop:once");
    test.queue("queued-after-stop", "later", "steer");
    await worker.wake();
    expect(sends).toBe(0);
    expect(
      test.store
        .snapshot()
        .item?.find((row) => (row.body as Record<string, unknown>).code === "turn_interrupt"),
    ).toBeDefined();
    await native.queue.push({ t: "turn.done", turnId: "native-turn", status: "interrupted" });
    await tick();
    expect(sends).toBe(0);
    release();
    await stopping;
    await duplicate;
    for (let i = 0; i < 200 && !sends; i++) await tick();
    expect(sends).toBe(1);
    expect(interrupts).toBe(1);
    await native.queue.push({ t: "turn.started", turnId: "later-turn" });
    await tick();
    expect(await manager.interrupt("thread", turnId, "stop:once")).toEqual({ ok: true });
    expect(interrupts).toBe(1);
    await expect(manager.interrupt("thread", "different", "stop:once")).rejects.toThrow(
      "command_receipt_conflict",
    );
  } finally {
    release();
    await stopping;
    await manager.close();
    test.close();
  }
});
it("closes uncertain interrupted sessions without leaking errors or replaying the native command", async () => {
  const test = await fixture(),
    native = new Native();
  let interrupts = 0;
  native.interrupt = async () => {
    interrupts++;
    throw new Error("synthetic-private-interrupt-error");
  };
  const manager = new SessionManager({
    store: test.store,
    publish() {},
    host: {
      async prepare() {
        return {
          cwd: test.root,
          estimate: (value) => value.length,
          async open() {
            return native;
          },
        };
      },
    },
  });
  try {
    await manager.ensure("thread");
    await tick();
    await native.queue.push({ t: "turn.started", turnId: "native-turn" });
    for (let i = 0; i < 200 && !test.store.snapshot().turn?.length; i++) await tick();
    const turnId = String(test.store.snapshot().turn?.[0]?.id);
    await expect(manager.interrupt("thread", turnId, "stop:lost")).rejects.toThrow(
      "interrupt_delivery_uncertain",
    );
    await expect(manager.interrupt("thread", turnId, "stop:lost")).rejects.toThrow(
      "interrupt_delivery_uncertain",
    );
    expect(interrupts).toBe(1);
    expect(native.closes).toBe(1);
    expect(test.store.snapshot().turn?.[0]?.status).toBe("interrupted");
    expect(JSON.stringify(test.store.snapshot())).not.toContain(
      "synthetic-private-interrupt-error",
    );
  } finally {
    await manager.close();
    test.close();
  }
});

it("holds steering after the interrupt receipt until the native turn actually ends", async () => {
  const test = await fixture(),
    native = new Native();
  let sends = 0;
  native.send = async () => {
    sends++;
    return { disposition: "handled" };
  };
  const manager = new SessionManager({
    store: test.store,
    publish() {},
    host: {
      async prepare() {
        return {
          cwd: test.root,
          estimate: (value) => value.length,
          async open() {
            return native;
          },
        };
      },
    },
  });
  try {
    const worker = await manager.ensure("thread");
    await tick();
    await native.queue.push({ t: "turn.started", turnId: "native-turn" });
    for (let i = 0; i < 200 && !test.store.snapshot().turn?.length; i++) await tick();
    const turnId = String(test.store.snapshot().turn?.[0]?.id);
    await manager.interrupt("thread", turnId, "stop:receipt-first");
    test.queue("waiting-steer", "later", "steer");
    await worker.wake();
    expect(sends).toBe(0);
    expect(test.store.snapshot().turn?.[0]?.status).toBe("running");
    await native.queue.push({ t: "turn.done", turnId: "native-turn", status: "interrupted" });
    for (let i = 0; i < 200 && !sends; i++) await tick();
    expect(sends).toBe(1);
    expect(
      test.store
        .snapshot()
        .item?.find((row) => (row.body as Record<string, unknown>).code === "turn_interrupt")?.body,
    ).toMatchObject({ state: "completed", confirmation: "native_event" });
  } finally {
    await manager.close();
    test.close();
  }
});
