import { type Daemon, startDaemon } from "@zoltbot/daemon";
import { protocolVersion } from "@zoltbot/protocol";
import { expect, it } from "vitest";
import { ReferenceSession } from "./reference-adapter.js";
import { runtimeFixture } from "./runtime-fixture.js";

it("wakes the original chat through the authenticated API and runs one real provider turn", async () => {
  const f = await runtimeFixture("zoltbot.db");
  let daemon: Daemon | undefined,
    socket: WebSocket | undefined,
    opens = 0;
  try {
    daemon = await startDaemon({
      dataDir: f.root,
      runtimeHost: {
        async prepare() {
          return {
            cwd: f.root,
            estimate: (text) => text.length,
            async open(request) {
              opens++;
              return new ReferenceSession({
                identity: { agentId: "profile", threadId: "thread" },
                mode: request.mode,
                ...(request.nativeId ? { nativeId: request.nativeId } : {}),
                cwd: f.root,
                permissionProfile: "read_only",
                hostMcp: { url: "http://127.0.0.1:1", token: "fixture-only" },
              }).open();
            },
          };
        },
      },
    });
    daemon.dispatch(
      {
        type: "update",
        kind: "session",
        id: "session",
        changes: {
          background: [{ id: "tests", kind: "shell", description: "Tests", state: "completed" }],
        },
      },
      "finished-tests",
    );
    socket = new WebSocket(daemon.url);
    await new Promise<void>((resolve, reject) => {
      socket?.addEventListener("open", () => resolve(), { once: true });
      socket?.addEventListener("error", () => reject(new Error("fixture_socket_failed")), {
        once: true,
      });
    });
    let seq = 0;
    const pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>();
    socket.addEventListener("message", (message) => {
      const v = JSON.parse(String(message.data));
      const waiter = pending.get(v.id);
      if (!waiter) return;
      pending.delete(v.id);
      if (v.error) waiter.reject(new Error(v.error.message));
      else waiter.resolve(v.result);
    });
    const call = (method: string, params: unknown, commandId?: string) =>
      new Promise<unknown>((resolve, reject) => {
        const id = ++seq;
        pending.set(id, { resolve, reject });
        socket?.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id,
            method,
            params,
            ...(commandId ? { commandId } : {}),
          }),
        );
      });
    await call("hello", { token: daemon.token, protocolVersion });
    const input = {
      threadId: "thread",
      condition: { kind: "job", sessionId: "session", jobId: "tests", outcome: "passed" },
      fallbackAt: new Date(Date.now() + 86400000).toISOString(),
      behavior: "resume",
      continuation: "Review the tests",
    };
    await call("wake.save", { input }, "wake-test");
    await call("wake.save", { input }, "wake-test");
    for (
      let i = 0;
      i < 300 && !daemon.store.snapshot(["turn"]).turn?.some((t) => t.status === "completed");
      i++
    )
      await new Promise((resolve) => setTimeout(resolve, 10));
    expect(daemon.store.snapshot(["turn"]).turn).toEqual([
      expect.objectContaining({ threadId: "thread", status: "completed", origin: "system" }),
    ]);
    expect(daemon.store.snapshot(["item"]).item?.filter((i) => i.kind === "user")).toHaveLength(1);
    expect(opens).toBe(1);
  } finally {
    socket?.close();
    await daemon?.close();
    f.close();
  }
});
