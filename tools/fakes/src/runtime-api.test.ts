import path from "node:path";
import { type Daemon, startDaemon } from "@zoltbot/daemon";
import { type EntityKind, protocolVersion } from "@zoltbot/protocol";
import { expect, it } from "vitest";
import { runtimeApi } from "../../../packages/daemon/src/runtime-api.js";
import { SessionManager } from "../../../packages/daemon/src/session-manager.js";
import { ReferenceSession } from "./reference-adapter.js";
import { runtimeFixture } from "./runtime-fixture.js";

it("dispatches authenticated durable chat through the daemon to a real native child exactly once", async () => {
  const test = await runtimeFixture();
  let daemon: Daemon | undefined,
    socket: WebSocket | undefined,
    opens = 0;
  const published: Record<string, unknown>[] = [];
  try {
    daemon = await startDaemon({
      dataDir: path.join(test.root, "daemon"),
      runtimeHost: {
        async prepare() {
          return {
            cwd: test.root,
            estimate: (text) => text.length,
            async open(request) {
              opens++;
              return new ReferenceSession({
                identity: { agentId: "profile", threadId: "thread" },
                mode: request.mode,
                ...(request.nativeId ? { nativeId: request.nativeId } : {}),
                cwd: test.root,
                permissionProfile: "read_only",
                hostMcp: { url: "http://127.0.0.1:1", token: "fixture-only" },
              }).open();
            },
          };
        },
      },
    });
    for (const kind of ["agentDefinition", "agent", "thread"] as const)
      for (const value of test.store.snapshot()[kind] ?? [])
        daemon.dispatch({ type: "create", kind: kind as EntityKind, value }, `seed:${kind}`);
    socket = new WebSocket(daemon.url);
    await new Promise<void>((resolve, reject) => {
      socket?.addEventListener("open", () => resolve(), { once: true });
      socket?.addEventListener("error", () => reject(new Error("fixture_socket_failed")), {
        once: true,
      });
    });
    let id = 0;
    const pending = new Map<
      number,
      { resolve(value: Record<string, unknown>): void; reject(error: Error): void }
    >();
    socket.addEventListener("message", (message) => {
      const data = message.data;
      const value = JSON.parse(data.toString()) as {
        id?: number;
        method?: string;
        params?: Record<string, unknown>;
        result?: Record<string, unknown>;
        error?: { message: string };
      };
      if (value.method === "event" && value.params) published.push(value.params);
      if (value.id !== undefined) {
        const waiter = pending.get(value.id);
        pending.delete(value.id);
        if (value.error) waiter?.reject(new Error(value.error.message));
        else waiter?.resolve(value.result ?? {});
      }
    });
    const call = (method: string, params: Record<string, unknown>, commandId?: string) =>
      new Promise<Record<string, unknown>>((resolve, reject) => {
        const key = ++id;
        pending.set(key, { resolve, reject });
        socket?.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id: key,
            method,
            params,
            ...(commandId ? { commandId } : {}),
          }),
        );
      });
    await call("hello", { token: daemon.token, protocolVersion });
    await call("events.subscribe", { fromSeq: 0 });
    const first = { threadId: "thread", input: [{ type: "text", text: "slow" }], mode: "queue" };
    const sent = await call("turn.send", first, "send:first");
    expect(sent.disposition).toBe("queued");
    expect(await call("turn.send", first, "send:first")).toEqual(sent);
    await expect(
      call("turn.send", { ...first, input: [{ type: "text", text: "changed" }] }, "send:first"),
    ).rejects.toThrow("command_receipt_conflict");
    await call("turn.send", { ...first, input: [{ type: "text", text: "usage" }] }, "send:second");
    for (
      let tries = 0;
      tries < 200 &&
      daemon.store.snapshot().turn?.filter((row) => row.status === "completed").length !== 2;
      tries++
    )
      await new Promise((resolve) => setTimeout(resolve, 10));
    expect(daemon.store.snapshot().turn?.filter((row) => row.status === "completed")).toHaveLength(
      2,
    );
    expect(daemon.store.snapshot().item?.filter((row) => row.kind === "user")).toHaveLength(2);
    expect(daemon.store.snapshot().item?.filter((row) => row.kind === "message")).toHaveLength(2);
    await call("snapshot.get", {});
    const usage = daemon.store.snapshot().usage ?? [];
    expect(usage).toHaveLength(2);
    expect(new Set(usage.map((row) => row.turnId)).size).toBe(2);
    expect(usage.find((row) => row.inputTokens !== undefined)).toMatchObject({
      inputTokens: 10,
      costKnown: true,
    });
    expect(usage.find((row) => row.inputTokens === undefined)).toMatchObject({
      injectedTokens: 0,
      costKnown: false,
    });
    const requests: string[] = [];
    for (let index = 0; index < 2; index++) {
      await call(
        "turn.send",
        { ...first, input: [{ type: "text", text: "approval" }] },
        `approval:${index}`,
      );
      for (
        let tries = 0;
        tries < 200 && !daemon.store.snapshot().interaction?.some((row) => row.state === "pending");
        tries++
      )
        await new Promise((resolve) => setTimeout(resolve, 10));
      const request = daemon.store.snapshot().interaction?.find((row) => row.state === "pending");
      if (!request) throw new Error("fixture_approval_missing");
      requests.push(String(request.id));
      await call(
        "interaction.answer",
        {
          id: request.id,
          version: request.version,
          answer: {
            action: "accept",
            choice: "allow_once",
            by: { kind: "human", id: "owner" },
            at: new Date().toISOString(),
          },
        },
        `answer:${index}`,
      );
    }
    for (
      let tries = 0;
      tries < 200 &&
      daemon.store.snapshot().turn?.filter((row) => row.status === "completed").length !== 4;
      tries++
    )
      await new Promise((resolve) => setTimeout(resolve, 10));
    expect(daemon.store.snapshot().turn?.filter((row) => row.status === "completed")).toHaveLength(
      4,
    );
    expect(new Set(requests).size).toBe(2);
    expect(
      daemon.store.snapshot().interaction?.filter((row) => row.state === "answered"),
    ).toHaveLength(2);
    const engine = daemon.interactions;
    if (!engine) throw new Error("fixture_engine_missing");
    engine.request(
      {
        id: "late",
        agentId: "profile",
        threadId: "thread",
        type: "question",
        items: [{ id: "q", prompt: "Question" }],
        chain: [],
        urgency: "blocking",
      },
      "request:late",
    );
    engine.clearRequests(["late"], "provider_cleared", "clear:late");
    const late = { id: "late", version: 2, text: "late human message", confirmed: true };
    const forwarded = await call("interaction.forwardLate", late, "forward:late");
    expect(await call("interaction.forwardLate", late, "forward:late")).toEqual(forwarded);
    for (
      let tries = 0;
      tries < 200 &&
      daemon.store.snapshot().turn?.filter((row) => row.status === "completed").length !== 5;
      tries++
    )
      await new Promise((resolve) => setTimeout(resolve, 10));
    expect(daemon.store.snapshot().turn?.filter((row) => row.status === "completed")).toHaveLength(
      5,
    );
    expect(daemon.store.snapshot().interaction?.find((row) => row.id === "late")?.state).toBe(
      "expired",
    );
    const active = daemon.store.snapshot().session?.find((row) => row.state === "ready");
    if (!active) throw new Error("fixture_session_missing");
    const compact = await call("session.compact", { id: active.id }, "compact:once");
    expect(compact).toEqual({ ok: true });
    expect(await call("session.compact", { id: active.id }, "compact:once")).toEqual(compact);
    expect(
      daemon.store
        .snapshot()
        .item?.filter((row) => (row.body as Record<string, unknown>).code === "context_compacted"),
    ).toHaveLength(1);
    expect(
      daemon.store
        .snapshot()
        .item?.find((row) => (row.body as Record<string, unknown>).code === "manual_compaction")
        ?.body,
    ).toMatchObject({ state: "completed", confirmation: "native_event" });
    expect(daemon.store.snapshot().turn).toHaveLength(5);
    expect(opens).toBe(1);
    expect(published.some((row) => row.aggregateType === "turn")).toBe(true);
    expect(published.some((row) => row.aggregateType === "usage")).toBe(true);
  } finally {
    socket?.close();
    await daemon?.close();
    test.close();
  }
});

it("cancels through a receipt fenced route without opening or touching a native session", async () => {
  const test = await runtimeFixture();
  let opens = 0;
  const manager = new SessionManager({
    store: test.store,
    publish() {},
    host: {
      async prepare() {
        opens++;
        throw new Error("must_not_open");
      },
    },
  });
  try {
    test.queue("pending", "keep exact queued input");
    const api = runtimeApi({ store: test.store, manager, publish() {} });
    expect(api("turn.cancelQueued", { threadId: "thread", id: "pending" }, "cancel:once")).toEqual({
      ok: true,
    });
    expect(api("turn.cancelQueued", { threadId: "thread", id: "pending" }, "cancel:once")).toEqual({
      ok: true,
    });
    expect(() =>
      api("turn.cancelQueued", { threadId: "other", id: "pending" }, "cancel:once"),
    ).toThrow("command_receipt_conflict");
    test.queue("without-native", "offline intent");
    const offline = runtimeApi({ store: test.store, publish() {} });
    expect(
      offline("turn.cancelQueued", { threadId: "thread", id: "without-native" }, "cancel:offline"),
    ).toEqual({ ok: true });
    expect(opens).toBe(0);
    expect(test.store.snapshot().item?.[0]?.body).toMatchObject({
      queueState: "failed",
      errorCode: "cancelled",
    });
  } finally {
    await manager.close();
    test.close();
  }
});
