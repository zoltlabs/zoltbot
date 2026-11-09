import { writeFileSync } from "node:fs";
import path from "node:path";
import { type AgentSession, AsyncQueue } from "@zoltbot/adapters-sdk";
import { cancelQueuedInput, queueHumanInput } from "@zoltbot/core";
import { Redactor } from "@zoltbot/daemon";
import type { AgentEvent } from "@zoltbot/protocol";
import { expect, it } from "vitest";
import { RuntimeWorker } from "../../../packages/daemon/src/runtime-worker.js";
import { referenceCapabilities } from "./capabilities.js";
import { ReferenceSession } from "./reference-adapter.js";
import { at, runtimeFixture as fixture } from "./runtime-fixture.js";

const ready: AgentEvent = {
  t: "session.ready",
  nativeId: "native",
  providerVersion: "fixture",
  capabilities: referenceCapabilities,
};
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
async function until(predicate: () => boolean) {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("runtime_fixture_deadline");
}
it("drains durable inputs through a real child session, links native turns and records usage", async () => {
  const test = await fixture();
  let worker: RuntimeWorker | undefined;
  const session = await new ReferenceSession({
    identity: { agentId: "profile", threadId: "thread" },
    mode: "new",
    cwd: test.root,
    permissionProfile: "read_only",
    hostMcp: { url: "http://127.0.0.1:1", token: "fixture-only" },
  }).open();
  try {
    test.queue("first", "slow");
    test.queue("second", "usage");
    test.queue("third", "tools");
    test.queue("fourth", "tools");
    worker = new RuntimeWorker({
      store: test.store,
      session,
      sessionId: "session",
      threadId: "thread",
      agentId: "profile",
      redactor: new Redactor(),
      estimate: (text) => text.length,
      publish() {},
      baseline: {
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        cumulative: true,
      },
    });
    worker.start();
    await worker.wake();
    await until(
      () => test.store.snapshot().turn?.filter((row) => row.status === "completed").length === 4,
    );
    const snapshot = test.store.snapshot();
    expect(
      snapshot.item
        ?.filter((row) => row.kind === "user")
        .sort((a, b) => Number(a.seq) - Number(b.seq))
        .map((row) => row.body),
    ).toEqual([
      expect.objectContaining({ queueState: "sent", input: [{ type: "text", text: "slow" }] }),
      expect.objectContaining({ queueState: "sent", input: [{ type: "text", text: "usage" }] }),
      expect.objectContaining({ queueState: "sent", input: [{ type: "text", text: "tools" }] }),
      expect.objectContaining({ queueState: "sent", input: [{ type: "text", text: "tools" }] }),
    ]);
    const turns = snapshot.turn ?? [];
    expect(new Set(turns.map((row) => row.id)).size).toBe(4);
    expect(turns.some((row) => row.id === "t1")).toBe(false);
    for (const item of snapshot.item?.filter((row) => row.kind === "user") ?? [])
      expect(turns.some((turn) => turn.id === item.turnId)).toBe(true);
    expect(
      snapshot.usage?.find(
        (row) => row.turnId === snapshot.item?.find((item) => item.id === "second")?.turnId,
      ),
    ).toMatchObject({
      inputTokens: 10,
      outputTokens: 2,
      costUsd: 0.001,
      costKnown: true,
    });
    expect(snapshot.item?.filter((row) => row.kind === "message")).toHaveLength(4);
    expect(snapshot.item?.filter((row) => row.kind === "tool")).toHaveLength(4);
    test.store.rebuild();
    expect(test.store.snapshot()).toEqual(snapshot);
  } finally {
    await worker?.close();
    await session.close();
    test.close();
  }
});
it("keeps proven native work sent when the send acknowledgement fails afterward", async () => {
  const test = await fixture(),
    events = new AsyncQueue<AgentEvent>();
  let sends = 0;
  const session: Pick<AgentSession, "events" | "send" | "close"> = {
    events: () => events,
    async send() {
      sends++;
      await events.push({ t: "turn.started", turnId: "same-native-id" });
      await tick();
      throw new Error("synthetic_ack_lost");
    },
    async close() {
      events.close();
    },
  };
  let worker: RuntimeWorker | undefined;
  try {
    test.queue("first", "Keep exact input");
    worker = new RuntimeWorker({
      store: test.store,
      session,
      sessionId: "session",
      threadId: "thread",
      agentId: "profile",
      redactor: new Redactor(),
      estimate: (text) => text.length,
      publish() {},
    });
    worker.start();
    await events.push(ready);
    await worker.wake();
    await until(() => sends === 1);
    await tick();
    expect(test.store.snapshot().item?.find((row) => row.id === "first")).toMatchObject({
      turnId: expect.any(String),
      body: { queueState: "sent" },
    });
    await worker.wake();
    expect(sends).toBe(1);
  } finally {
    await worker?.close();
    test.close();
  }
});
it("holds an unproven failed send, closes its native writer and never drains the next input", async () => {
  const test = await fixture(),
    events = new AsyncQueue<AgentEvent>();
  let sends = 0,
    closes = 0;
  const session: Pick<AgentSession, "events" | "send" | "close"> = {
    events: () => events,
    async send() {
      sends++;
      throw new Error("synthetic_private_provider_error");
    },
    async close() {
      closes++;
      events.close();
    },
  };
  let worker: RuntimeWorker | undefined;
  try {
    test.queue("first", "first");
    test.queue("second", "second");
    worker = new RuntimeWorker({
      store: test.store,
      session,
      sessionId: "session",
      threadId: "thread",
      agentId: "profile",
      redactor: new Redactor(),
      estimate: (text) => text.length,
      publish() {},
    });
    worker.start();
    await events.push(ready);
    await worker.wake();
    await until(() => closes > 0);
    expect(test.store.snapshot().item?.find((row) => row.id === "first")?.body).toMatchObject({
      queueState: "uncertain",
      errorCode: "delivery_uncertain",
    });
    expect(test.store.snapshot().item?.find((row) => row.id === "second")?.body).toMatchObject({
      queueState: "queued",
    });
    await worker.wake();
    expect(sends).toBe(1);
    expect(JSON.stringify(test.store.snapshot())).not.toContain("synthetic_private_provider_error");
  } finally {
    await worker?.close();
    test.close();
  }
});
it("buffers split private deltas and publishes only scoped safe content", async () => {
  const test = await fixture(),
    events = new AsyncQueue<AgentEvent>(),
    redactor = new Redactor(["synthetic-private-value"]);
  redactor.hideFrames();
  const visible: string[] = [];
  let worker: RuntimeWorker | undefined;
  try {
    worker = new RuntimeWorker({
      store: test.store,
      session: {
        events: () => events,
        async send() {
          return { disposition: "handled" };
        },
        async close() {
          events.close();
        },
      },
      sessionId: "session",
      threadId: "thread",
      agentId: "profile",
      redactor,
      estimate: (text) => text.length,
      publish() {},
      stream: (update) => visible.push(update.text),
    });
    worker.start();
    await events.push(ready);
    await events.push({ t: "turn.started", turnId: "native" });
    await events.push({
      t: "tool.started",
      turnId: "native",
      itemId: "tool",
      name: "Shell",
      kind: "execute",
      input: { parts: ["synthetic-", "private-value"] },
    });
    await events.push({
      t: "tool.updated",
      itemId: "tool",
      output: "synthetic-",
      content: ["private-value"],
    });
    await events.push({
      t: "tool.done",
      itemId: "tool",
      status: "ok",
      output: ["synthetic-", "private-value"],
    });
    for (const text of ["before synthetic-", "private-", "value after"])
      await events.push({ t: "text.delta", turnId: "native", itemId: "m", text });
    await events.push({
      t: "message.done",
      turnId: "native",
      itemId: "m",
      text: "before synthetic-private-value after",
      phase: "final",
    });
    await events.push({ t: "turn.done", turnId: "native", status: "completed" });
    await until(() => test.store.snapshot().turn?.[0]?.status === "completed");
    expect(JSON.stringify(test.store.snapshot())).not.toContain("synthetic-");
    expect(JSON.stringify(test.store.snapshot())).not.toContain("private-value");
    expect(test.store.snapshot().item?.find((row) => row.kind === "tool")?.body).toMatchObject({
      status: "ok",
      output: "[private tool output omitted]",
    });
    expect(visible.length).toBeGreaterThan(0);
    for (const text of visible) expect(text).not.toContain("synthetic");
    expect(test.store.snapshot().item?.find((row) => row.kind === "message")?.body).toMatchObject({
      text: "before [redacted] after",
    });
  } finally {
    await worker?.close();
    test.close();
  }
});

it.each([
  "error",
  "auth_required",
] as const)("persists idle %s and refuses stray completed turn deltas", async (failure) => {
  const test = await fixture(),
    events = new AsyncQueue<AgentEvent>();
  let closes = 0;
  const visible: string[] = [];
  const worker = new RuntimeWorker({
    store: test.store,
    session: {
      events: () => events,
      async send() {
        return { disposition: "handled" };
      },
      async close() {
        closes++;
        events.close();
      },
    },
    sessionId: "session",
    threadId: "thread",
    agentId: "profile",
    redactor: new Redactor(),
    estimate: (text) => text.length,
    publish() {},
    stream: (update) => visible.push(update.text),
  });
  try {
    worker.start();
    await events.push(ready);
    await events.push({ t: "turn.started", turnId: "native" });
    await events.push({ t: "turn.done", turnId: "native", status: "completed" });
    await events.push({
      t: "text.delta",
      turnId: "native",
      itemId: "late",
      text: "must not publish",
    });
    await events.push({ t: "status", state: failure, detail: "synthetic_private_failure" });
    await until(() => closes > 0);
    expect(visible).toEqual([]);
    expect(test.store.snapshot().session?.[0]?.state).toBe("closed");
    expect(test.store.snapshot().session?.[0]?.endReason).toBe(
      failure === "auth_required" ? "auth_required" : "runtime_process_error",
    );
    expect(JSON.stringify(test.store.snapshot())).not.toContain("synthetic_private_failure");
  } finally {
    await worker.close();
    test.close();
  }
});

it("does not link the next pending input to a duplicated old turn start", async () => {
  const test = await fixture(),
    events = new AsyncQueue<AgentEvent>();
  let sends = 0;
  const worker = new RuntimeWorker({
    store: test.store,
    session: {
      events: () => events,
      async send() {
        sends++;
        return { disposition: "started" };
      },
      async close() {
        events.close();
      },
    },
    sessionId: "session",
    threadId: "thread",
    agentId: "profile",
    redactor: new Redactor(),
    estimate: (text) => text.length,
    publish() {},
  });
  try {
    test.queue("first", "first");
    test.queue("second", "second");
    worker.start();
    await events.push(ready);
    await until(() => sends === 1);
    await events.push({ t: "turn.started", turnId: "native1" });
    await events.push({ t: "turn.done", turnId: "native1", status: "completed" });
    await until(() => sends === 2);
    await events.push({ t: "turn.started", turnId: "native1" });
    await events.push({ t: "turn.started", turnId: "native2" });
    await events.push({ t: "turn.done", turnId: "native2", status: "completed" });
    await until(
      () => test.store.snapshot().turn?.filter((row) => row.status === "completed").length === 2,
    );
    const users = test.store.snapshot().item?.filter((row) => row.kind === "user") ?? [];
    expect(users).toHaveLength(2);
    expect(new Set(users.map((row) => row.turnId)).size).toBe(2);
  } finally {
    await worker.close();
    test.close();
  }
});
it("delivers native steering around waiting normal inputs and keeps queue only steering idle", async () => {
  for (const capability of ["native", "queue_only"] as const) {
    const test = await fixture(),
      events = new AsyncQueue<AgentEvent>(),
      calls: { text: string; mode: string }[] = [];
    const worker = new RuntimeWorker({
      store: test.store,
      session: {
        events: () => events,
        async send(input, mode) {
          calls.push({
            text: input
              .filter((part) => part.type === "text")
              .map((part) => part.text)
              .join(""),
            mode,
          });
          return { disposition: "started" };
        },
        async close() {
          events.close();
        },
      },
      sessionId: "session",
      threadId: "thread",
      agentId: "profile",
      redactor: new Redactor(),
      estimate: (text) => text.length,
      publish() {},
    });
    try {
      test.queue("first", "first");
      test.queue("normal", "normal");
      test.queue("hint", "hint", "steer");
      worker.start();
      await events.push({
        ...ready,
        capabilities: { ...referenceCapabilities, steer: capability },
      });
      await until(() => calls.length === 1);
      await events.push({ t: "turn.started", turnId: "t1" });
      if (capability === "native") await until(() => calls.length === 2);
      else {
        await tick();
        await worker.wake();
        expect(calls).toHaveLength(1);
      }
      if (capability === "native") expect(calls[1]).toEqual({ text: "hint", mode: "steer" });
      await events.push({ t: "turn.done", turnId: "t1", status: "completed" });
      await until(() => calls.some((call) => call.text === "normal"));
      expect(calls.find((call) => call.text === "normal")).toEqual({
        text: "normal",
        mode: "queue",
      });
    } finally {
      await worker.close();
      test.close();
    }
  }
});
it("enforces generated context limits before any native write and preserves the human message", async () => {
  const test = await fixture(),
    events = new AsyncQueue<AgentEvent>();
  let sends = 0;
  const worker = new RuntimeWorker({
    store: test.store,
    session: {
      events: () => events,
      async send() {
        sends++;
        return { disposition: "handled" };
      },
      async close() {
        events.close();
      },
    },
    sessionId: "session",
    threadId: "thread",
    agentId: "profile",
    redactor: new Redactor(),
    estimate: (text) => text.length,
    fixedInjectedTokens: 5000,
    publish() {},
  });
  try {
    test.queue("first", " exact text\n");
    worker.start();
    await events.push(ready);
    await until(() => test.store.snapshot().session?.[0]?.state === "closed");
    expect(sends).toBe(0);
    expect(test.store.snapshot().item?.find((row) => row.id === "first")?.body).toMatchObject({
      queueState: "queued",
      input: [{ type: "text", text: " exact text\n" }],
    });
    expect(
      test.store
        .snapshot()
        .item?.some(
          (row) =>
            row.kind === "note" &&
            (row.body as Record<string, unknown>).code === "injection_budget_exceeded",
        ),
    ).toBe(true);
  } finally {
    await worker.close();
    test.close();
  }
});
it("routes repeated native approval ids through distinct durable requests and original native replies", async () => {
  const test = await fixture();
  let worker: RuntimeWorker | undefined;
  const { InteractionEngine } = await import("../../../packages/daemon/src/interaction-engine.js");
  const session = await new ReferenceSession({
    identity: { agentId: "profile", threadId: "thread" },
    mode: "new",
    cwd: test.root,
    permissionProfile: "read_only",
    hostMcp: { url: "http://127.0.0.1:1", token: "fixture-only" },
  }).open();
  const redactor = new Redactor();
  const engine = new InteractionEngine({
    store: test.store,
    publish() {},
    host: {
      registerSecret(value) {
        redactor.register(value);
        redactor.hideFrames();
      },
      requiresSecretReply() {
        return true;
      },
      async respond(request, answer) {
        if (!worker) throw new Error("fixture_worker_missing");
        await session.respond(worker.nativeInteractionId(request.id), answer);
      },
    },
  });
  try {
    test.queue("first", "approval");
    test.queue("second", "approval");
    worker = new RuntimeWorker({
      store: test.store,
      session,
      sessionId: "session",
      threadId: "thread",
      agentId: "profile",
      redactor,
      estimate: (text) => text.length,
      publish() {},
      interaction(event) {
        if (event.t === "interaction.requested")
          engine.request(event.interaction, `request:${event.interaction.id}`);
        else engine.clear(["thread"], "provider_cleared", `clear:${test.store.lastSeq()}`);
      },
    });
    worker.start();
    const ids: string[] = [];
    for (let index = 0; index < 2; index++) {
      await until(
        () =>
          test.store.snapshot().interaction?.filter((row) => row.state === "pending").length === 1,
      );
      const pending = test.store.snapshot().interaction?.find((row) => row.state === "pending");
      if (!pending) throw new Error("fixture_request_missing");
      ids.push(String(pending.id));
      await engine.answer(
        String(pending.id),
        Number(pending.version),
        { action: "accept", choice: "allow_once", by: { kind: "human", id: "owner" }, at },
        `answer:${index}`,
        { kind: "human", id: "owner" },
      );
    }
    await until(
      () => test.store.snapshot().turn?.filter((row) => row.status === "completed").length === 2,
    );
    expect(new Set(ids).size).toBe(2);
    expect(
      test.store.snapshot().interaction?.filter((row) => row.state === "answered"),
    ).toHaveLength(2);
  } finally {
    await engine.stopTimers();
    await worker?.close();
    await session.close();
    test.close();
  }
});
it("records real idle compaction events before and after a native turn without inventing work", async () => {
  const test = await fixture();
  let worker: RuntimeWorker | undefined;
  const session = await new ReferenceSession({
    identity: { agentId: "profile", threadId: "thread" },
    mode: "new",
    cwd: test.root,
    permissionProfile: "read_only",
    hostMcp: { url: "http://127.0.0.1:1", token: "fixture-only" },
  }).open();
  try {
    worker = new RuntimeWorker({
      store: test.store,
      session,
      sessionId: "session",
      threadId: "thread",
      agentId: "profile",
      redactor: new Redactor(),
      estimate: (text) => text.length,
      publish() {},
    });
    worker.start();
    await until(() => test.store.snapshot().session?.[0]?.state === "ready");
    await session.compact();
    await until(
      () => test.store.snapshot().item?.filter((row) => row.kind === "note").length === 1,
    );
    expect(test.store.snapshot().turn ?? []).toEqual([]);
    test.queue("first", "hello");
    await worker.wake();
    await until(() => test.store.snapshot().turn?.[0]?.status === "completed");
    await session.compact();
    await until(
      () => test.store.snapshot().item?.filter((row) => row.kind === "note").length === 2,
    );
    for (const note of test.store.snapshot().item?.filter((row) => row.kind === "note") ?? []) {
      expect(note.turnId).toBeUndefined();
      expect(note.body).toMatchObject({ code: "context_compacted", trigger: "manual" });
    }
    expect(test.store.snapshot().turn).toHaveLength(1);
    expect(test.store.snapshot().session?.[0]?.state).toBe("ready");
  } finally {
    await worker?.close();
    await session.close();
    test.close();
  }
});

it("loads images ephemerally and rejects unreadable attachments before claiming or writing native input", async () => {
  const test = await fixture(),
    events = new AsyncQueue<AgentEvent>();
  const base64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aE9sAAAAASUVORK5CYII=";
  const file = path.join(test.root, "image.png");
  writeFileSync(file, Buffer.from(base64, "base64"));
  const sent: unknown[] = [];
  const worker = new RuntimeWorker({
    store: test.store,
    sessionId: "session",
    threadId: "thread",
    agentId: "profile",
    redactor: new Redactor(),
    estimate: (text) => text.length,
    publish() {},
    session: {
      events: () => events,
      async send(input) {
        sent.push(input);
        return { disposition: "handled" };
      },
      async close() {
        events.close();
      },
    },
  });
  try {
    for (const [id, imagePath] of [
      ["image", file],
      ["missing", path.join(test.root, "missing.png")],
    ] as const)
      test.store.dispatch(id, (state) =>
        queueHumanInput(
          state,
          {
            threadId: "thread",
            input: [
              { type: "text", text: "  Exact image text\n" },
              { type: "image", path: imagePath, mimeType: "image/png" },
            ],
            mode: "queue",
          },
          id,
          { commandId: id, at, actor: { kind: "human", id: "owner" } },
        ),
      );
    test.queue("after-image", "ordinary");
    worker.start();
    await events.push(ready);
    await worker.wake();
    await until(() => sent.length === 2);
    expect(sent[0]).toEqual([
      { type: "text", text: "  Exact image text\n" },
      { type: "image", base64, mimeType: "image/png" },
    ]);
    const invalid = test.store.snapshot().item?.find((row) => row.id === "missing");
    expect(invalid?.body).toMatchObject({ queueState: "failed", errorCode: "invalid_input" });
    expect(invalid?.body).not.toHaveProperty("attemptId");
    expect(JSON.stringify(test.store.eventsSince(0))).not.toContain(base64);
    expect(test.store.snapshot().item?.find((row) => row.id === "image")?.body).toMatchObject({
      input: [
        { type: "text", text: "  Exact image text\n" },
        { type: "image", path: file, mimeType: "image/png" },
      ],
    });
  } finally {
    await worker.close();
    test.close();
  }
});

it("honors cancellation during asynchronous image loading without closing the native session", async () => {
  const test = await fixture(),
    events = new AsyncQueue<AgentEvent>();
  let sends = 0;
  const file = path.join(test.root, "cancel.png");
  writeFileSync(
    file,
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aE9sAAAAASUVORK5CYII=",
      "base64",
    ),
  );
  const worker = new RuntimeWorker({
    store: test.store,
    sessionId: "session",
    threadId: "thread",
    agentId: "profile",
    redactor: new Redactor(),
    estimate: (text) => text.length,
    publish() {},
    session: {
      events: () => events,
      async send() {
        sends++;
        return { disposition: "handled" };
      },
      async close() {
        events.close();
      },
    },
  });
  try {
    worker.start();
    await events.push(ready);
    await until(() => test.store.snapshot().session?.[0]?.state === "ready");
    await worker.wake();
    await tick();
    test.store.dispatch("image", (state) =>
      queueHumanInput(
        state,
        { threadId: "thread", input: [{ type: "image", path: file }], mode: "queue" },
        "image",
        { commandId: "image", at, actor: { kind: "human", id: "owner" } },
      ),
    );
    const loading = worker.wake();
    test.store.dispatch("cancel-image", (state) =>
      cancelQueuedInput(state, "thread", "image", {
        commandId: "cancel-image",
        at,
        actor: { kind: "human", id: "owner" },
      }),
    );
    await loading;
    expect(sends).toBe(0);
    expect(test.store.snapshot().session?.[0]?.state).toBe("ready");
    test.queue("after-cancel", "ordinary");
    await worker.wake();
    await until(() => sends === 1);
    expect(test.store.snapshot().item?.find((row) => row.id === "image")?.body).toMatchObject({
      errorCode: "cancelled",
      queueState: "failed",
    });
  } finally {
    await worker.close();
    test.close();
  }
});
