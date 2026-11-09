import { readFileSync } from "node:fs";
import path from "node:path";
import { type Daemon, startDaemon } from "@zoltbot/daemon";
import { expect, it } from "vitest";
import { DaemonClient } from "../../../packages/ui/src/connection.js";
import { ReferenceSession } from "./reference-adapter.js";
import { runtimeFixture } from "./runtime-fixture.js";

async function until(predicate: () => boolean) {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("stream_fixture_deadline");
}
it("reconnects to safe live text without persisting deltas or advancing the durable cursor", async () => {
  const test = await runtimeFixture();
  let daemon: Daemon | undefined,
    native: ReferenceSession | undefined,
    first: DaemonClient | undefined,
    second: DaemonClient | undefined;
  let stopObserving: (() => void) | undefined;
  let sawReservation = false;
  try {
    daemon = await startDaemon({
      dataDir: path.join(test.root, "daemon"),
      runtimeHost: {
        async prepare(_input, redactor) {
          redactor.register("synthetic-private-live-value");
          redactor.hideFrames();
          return {
            cwd: test.root,
            estimate: (text) => text.length,
            async open(request) {
              native = await new ReferenceSession(
                {
                  identity: { agentId: "profile", threadId: "thread" },
                  mode: request.mode,
                  ...(request.nativeId ? { nativeId: request.nativeId } : {}),
                  cwd: test.root,
                  permissionProfile: "read_only",
                  hostMcp: { url: "http://127.0.0.1:1", token: "fixture-only" },
                },
                undefined,
                3000,
                redactor,
              ).open();
              return native;
            },
          };
        },
      },
    });
    for (const kind of ["agentDefinition", "agent", "thread"] as const)
      for (const value of test.store.snapshot()[kind] ?? [])
        daemon.dispatch({ type: "create", kind, value }, `seed:${kind}`);
    const info = { url: daemon.url, token: daemon.token };
    first = new DaemonClient(async () => info);
    await first.start();
    stopObserving = first.subscribe((state) => {
      if (
        state.snapshot.entities.item?.some((row) => {
          const body = row.body as Record<string, unknown>;
          return body.streaming === true && body.text === "";
        })
      )
        sawReservation = true;
    });
    await first.call(
      "turn.send",
      { threadId: "thread", input: [{ type: "text", text: "stream_pause" }], mode: "queue" },
      "stream:send",
    );
    const partial = (client: DaemonClient) =>
      client.state.snapshot.entities.item?.find(
        (row) => (row.body as Record<string, unknown>).streaming === true,
      );
    await until(() =>
      Boolean(
        first && (partial(first)?.body as Record<string, unknown> | undefined)?.text === "visible ",
      ),
    );
    expect(sawReservation).toBe(true);
    expect(partial(first)?.body).toMatchObject({ text: "visible ", streaming: true });
    expect(daemon.store.snapshot().item?.find((row) => row.kind === "message")?.body).toMatchObject(
      { text: "", streaming: true },
    );
    second = new DaemonClient(async () => info);
    await second.start();
    expect(partial(second)?.body).toMatchObject({ text: "visible ", streaming: true });
    const cursor = daemon.store.lastSeq();
    expect(second.state.snapshot.seq).toBe(cursor);
    first.stop();
    if (!native) throw new Error("fixture_native_missing");
    await native.advanceStream();
    expect(second.state.snapshot.seq).toBe(cursor);
    expect(daemon.store.lastSeq()).toBe(cursor);
    await native.advanceStream();
    await until(() => second?.state.snapshot.entities.turn?.[0]?.status === "completed");
    const final = second.state.snapshot.entities.item?.find((row) => row.kind === "message");
    expect(final?.body).toMatchObject({ text: "visible [redacted] done" });
    expect((final?.body as Record<string, unknown>).streaming).toBeUndefined();
    expect(final?.id).toBe(daemon.store.snapshot().item?.find((row) => row.kind === "message")?.id);
    expect(JSON.stringify(second.state.snapshot)).not.toContain("synthetic-private-");
    expect(JSON.stringify(daemon.store.snapshot())).not.toContain("synthetic-private-");
    expect(readFileSync(native.process.frameFile, "utf8")).not.toContain("synthetic-private-");
  } finally {
    stopObserving?.();
    first?.stop();
    second?.stop();
    await daemon?.close();
    test.close();
  }
});
