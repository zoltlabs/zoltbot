import { chatProgressKey, readProgressNotes } from "@zoltbot/protocol";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { forkFixture } from "../../../tools/fakes/src/fork-fixture.js";
import type { RuntimeContext } from "./api.js";
import { chatSignalTools } from "./chat-signal-tools.js";
import { PrivateInputGuard } from "./private-input.js";
import { settingsApi } from "./settings-api.js";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-21T10:00:00.000Z"));
});
afterEach(() => vi.useRealTimers());

async function fixture() {
  const f = await forkFixture();
  const privacy = new PrivateInputGuard({ store: f.store, publish() {} });
  const published: unknown[] = [];
  const signal = chatSignalTools({
    store: f.store,
    privacy,
    publish: (e: unknown[]) => published.push(...e),
  } as unknown as RuntimeContext);
  f.put("turn", { ...f.store.record("turn", "source-turn"), status: "running" });
  const notes = () =>
    readProgressNotes(
      f.store.snapshot(["settings"]).settings?.find((r) => r.key === chatProgressKey("thread"))
        ?.value,
    );
  const call = (args: unknown, key: string, turnId = "source-turn") =>
    signal({
      actor: { threadId: "thread", agentId: "agent", sessionId: "session", turnId },
      arguments: args,
      idempotencyKey: key,
    } as never);
  return { ...f, call, notes, published };
}

it("posts notes for the running turn at most every 30 seconds", async () => {
  const f = await fixture();
  try {
    expect(await f.call({ progress: "Plan: read the notes, then fix the build." }, "k1")).toEqual({
      ok: true,
    });
    expect(await f.call({ progress: "Build fixed" }, "k2")).toEqual({ error: "too_soon:30s" });
    vi.setSystemTime(new Date("2026-11-21T10:00:30.000Z"));
    expect(await f.call({ action: "progress", progress: "Build\n fixed" }, "k3")).toEqual({
      ok: true,
    });
    expect(f.notes().map((n) => [n.turnId, n.text])).toEqual([
      ["source-turn", "Plan: read the notes, then fix the build."],
      ["source-turn", "Build fixed"],
    ]);
    // The same call again (a retry) adds nothing.
    const events = f.published.length;
    vi.setSystemTime(new Date("2026-11-21T10:01:30.000Z"));
    await f.call({ progress: "Build fixed" }, "k3");
    expect(f.notes()).toHaveLength(2);
    expect(f.published.length).toBe(events);
  } finally {
    f.close();
  }
});

it("refuses empty notes, finished turns and private values", async () => {
  const f = await fixture();
  try {
    expect(await f.call({ action: "progress" }, "k1")).toEqual({ error: "progress_required" });
    expect(await f.call({ progress: " " }, "k2")).toEqual({ error: "progress_required" });
    expect(await f.call({ progress: "Late" }, "k3", "old-turn")).toEqual({
      error: "turn_not_running",
    });
    expect(await f.call({ progress: `Using ${"sk-"}${"x".repeat(16)}` }, "k4")).toEqual({
      error: "private_value",
    });
    expect(f.notes()).toEqual([]);
    const settings = settingsApi({ store: f.store, publish() {} } as never);
    await expect(
      settings("settings.set", { key: chatProgressKey("thread"), value: [] }, "s1"),
    ).rejects.toThrow();
  } finally {
    f.close();
  }
});
