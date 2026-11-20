import { describe, expect, it, vi } from "vitest";
import { type CompactionHost, performCompact } from "./session-compaction.js";

describe("performCompact", () => {
  it("refuses while a turn runs, before asking the provider", async () => {
    const compact = vi.fn();
    const dispatch = vi.fn();
    const host = {
      options: {
        store: {
          receipt: () => undefined,
          record: () => ({ threadId: "t1" }),
          snapshot: () => ({ turn: [{ id: "turn1", sessionId: "s1", status: "running" }] }),
          dispatch,
        },
      },
      entries: new Map([["t1", { sessionId: "s1", native: { compact } }]]),
      failedHandles: new Map(),
      stopped: () => false,
      assertMutable: () => undefined,
    } as unknown as CompactionHost;
    await expect(performCompact(host, "s1", undefined, "c1")).rejects.toThrow("session_busy");
    expect(dispatch).not.toHaveBeenCalled();
    expect(compact).not.toHaveBeenCalled();
  });
});
