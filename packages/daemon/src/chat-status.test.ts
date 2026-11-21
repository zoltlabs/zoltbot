import { chatStatusKey, readChatStatus } from "@zoltbot/protocol";
import { expect, it } from "vitest";
import { forkFixture } from "../../../tools/fakes/src/fork-fixture.js";
import type { RuntimeContext } from "./api.js";
import { chatSignalTools } from "./chat-signal-tools.js";
import { PrivateInputGuard } from "./private-input.js";
import { settingsApi } from "./settings-api.js";

async function fixture() {
  const f = await forkFixture();
  const privacy = new PrivateInputGuard({ store: f.store, publish() {} });
  const published: unknown[] = [];
  const publish = (e: unknown[]) => published.push(...e);
  const signal = chatSignalTools({ store: f.store, privacy, publish } as unknown as RuntimeContext);
  f.put("turn", { ...f.store.record("turn", "source-turn"), status: "running" });
  const stored = () =>
    f.store.snapshot(["settings"]).settings?.find((r) => r.key === chatStatusKey("thread"))?.value;
  const call = (args: unknown, key: string, turnId = "source-turn") =>
    signal({
      actor: { threadId: "thread", agentId: "agent", sessionId: "session", turnId },
      arguments: args,
      idempotencyKey: key,
    } as never);
  return { ...f, call, published, stored };
}

it("sets the running turn's status line in one clean line", async () => {
  const f = await fixture();
  try {
    expect(await f.call({ status: "Reading   the\ninvoices" }, "k1")).toEqual({ ok: true });
    expect(readChatStatus(f.stored(), "source-turn")).toBe("Reading the invoices");
    // Another turn doesn't see this turn's line, so the line clears when the turn ends.
    expect(readChatStatus(f.stored(), "next-turn")).toBeUndefined();
    const events = f.published.length;
    await f.call({ action: "status", status: "Reading the invoices" }, "k2");
    expect(f.published.length).toBe(events);
    await f.call({ status: "x".repeat(60) }, "k3");
    expect(readChatStatus(f.stored(), "source-turn")).toHaveLength(60);
    expect(await f.call({ action: "status" }, "k4")).toEqual({ error: "status_required" });
    expect(await f.call({ status: "  " }, "k5")).toEqual({ error: "status_required" });
    expect(await f.call({ status: "Working" }, "k6", "")).toEqual({
      error: "turn_required",
    });
    // A late call from a finished turn can't replace the line.
    expect(await f.call({ status: "Late" }, "k7", "old-turn")).toEqual({
      error: "turn_not_running",
    });
    // The line is shown on every device, so it can't carry a credential.
    expect(await f.call({ status: `Using ${"sk-"}${"x".repeat(16)}` }, "k8")).toEqual({
      error: "private_value",
    });
    expect(readChatStatus(f.stored(), "source-turn")).toHaveLength(60);
  } finally {
    f.close();
  }
});

it("keeps status rows out of settings.set", async () => {
  const f = await fixture();
  try {
    const settings = settingsApi({ store: f.store, publish() {} } as never);
    await expect(
      settings("settings.set", { key: chatStatusKey("thread"), value: {} }, "s1"),
    ).rejects.toThrow();
  } finally {
    f.close();
  }
});
