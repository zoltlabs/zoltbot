// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { contextService, shouldAutoCompact } from "./context-service";
import type { DaemonClient } from "./daemon-client";

function fakeClient(usage: { used?: number; size?: number }) {
  const call = vi.fn(async (method: string) =>
    method === "session.context" ? usage : { ok: true },
  );
  const client = {
    status: "online",
    call,
    snapshot: {
      seq: 1,
      counters: {},
      entities: { session: [{ id: "session-1", threadId: "chat", startedAt: "2026-11-20" }] },
    },
  } as unknown as DaemonClient;
  return { client, call };
}

describe("automatic compaction", () => {
  it("compacts only when set to and the context is at least 90% full", () => {
    expect(shouldAutoCompact({ used: 90, size: 100 }, "compact")).toBe(true);
    expect(shouldAutoCompact({ used: 89, size: 100 }, "compact")).toBe(false);
    expect(shouldAutoCompact({ used: 99, size: 100 }, "ask")).toBe(false);
    expect(shouldAutoCompact({ used: 99, size: 100 }, undefined)).toBe(false);
    expect(shouldAutoCompact(null, "compact")).toBe(false);
  });

  it("compacts the chat's latest session after a turn that ends nearly full", async () => {
    const { client, call } = fakeClient({ used: 95_000, size: 100_000 });
    const service = contextService(client, () => "compact");
    expect(await service.afterTurn("chat")).toBe(true);
    expect(call).toHaveBeenCalledWith("session.compact", { id: "session-1" }, expect.any(String));
  });

  it("leaves the chat alone when it asks first or the agent reports no window", async () => {
    const asking = fakeClient({ used: 95_000, size: 100_000 });
    expect(await contextService(asking.client, () => "ask").afterTurn("chat")).toBe(false);
    expect(asking.call).not.toHaveBeenCalled();
    const silent = fakeClient({});
    const service = contextService(silent.client, () => "compact");
    expect(await service.read("chat")).toBeNull();
    expect(await service.afterTurn("chat")).toBe(false);
    expect(silent.call).not.toHaveBeenCalledWith(
      "session.compact",
      expect.anything(),
      expect.anything(),
    );
  });

  it("skips failed turns, a turn that already started and a compaction in flight", async () => {
    const { client, call } = fakeClient({ used: 95_000, size: 100_000 });
    const service = contextService(client, () => "compact");
    expect(await service.afterTurn("chat", "failed")).toBe(false);
    const both = await Promise.all([service.afterTurn("chat"), service.afterTurn("chat")]);
    expect(both).toEqual([true, false]);
    const entities = (client.snapshot as unknown as { entities: Record<string, unknown[]> })
      .entities;
    entities.turn = [{ id: "turn-2", threadId: "chat", status: "running" }];
    expect(await service.afterTurn("chat")).toBe(false);
    expect(call.mock.calls.filter(([method]) => method === "session.compact")).toHaveLength(1);
  });
});
