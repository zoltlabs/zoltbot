import { messageReactionsKey } from "@zoltbot/protocol";
import { expect, it } from "vitest";
import { forkFixture } from "../../../tools/fakes/src/fork-fixture.js";
import type { RuntimeContext } from "./api.js";
import { chatSignalTools } from "./chat-signal-tools.js";
import { messageReactionsApi } from "./message-reactions-api.js";
import { PrivateInputGuard } from "./private-input.js";
import { settingsApi } from "./settings-api.js";

async function fixture() {
  const f = await forkFixture();
  const privacy = new PrivateInputGuard({ store: f.store, publish() {} });
  const published: unknown[] = [];
  const publish = (e: unknown[]) => published.push(...e);
  const api = messageReactionsApi({
    store: f.store,
    privacy,
    redactor: { text: (t: string) => t.replaceAll("SECRET", "[redacted]") },
    publish,
  });
  const signal = chatSignalTools({ store: f.store, privacy, publish } as unknown as RuntimeContext);
  f.put("item", {
    ...f.store.record("item", "source-message"),
    id: "asked",
    kind: "user",
    turnId: "source-turn",
    seq: 99,
    body: { input: [{ type: "text", text: "Fix the build" }] },
  });
  const stored = () =>
    f.store.snapshot(["settings"]).settings?.find((r) => r.key === messageReactionsKey("thread"))
      ?.value;
  const actor = {
    threadId: "thread",
    agentId: "agent",
    sessionId: "session",
    turnId: "source-turn",
  };
  const call = (args: unknown, key: string) =>
    signal({ actor, arguments: args, idempotencyKey: key } as never);
  return { ...f, api, call, published, stored };
}

it("sets, changes and clears the owner's reaction", async () => {
  const f = await fixture();
  try {
    const react = (emoji: string | null, id: string) =>
      f.api("message.react", { threadId: "thread", itemId: "source-message", emoji }, id);
    await react("👍", "r1");
    await react("🎉", "r2");
    expect(f.stored()).toEqual([
      expect.objectContaining({ itemId: "source-message", actor: "owner", emoji: "🎉" }),
    ]);
    const events = f.published.length;
    await react("🎉", "r3");
    expect(f.published.length).toBe(events);
    await react(null, "r4");
    expect(f.stored()).toEqual([]);
    await expect(react("💩", "r5")).rejects.toThrow("invalid_reaction");
    await expect(
      f.api("message.react", { threadId: "thread", itemId: "nowhere", emoji: "👍" }, "r6"),
    ).rejects.toThrow("message_not_found");
    await expect(react("👍", "SECRET")).rejects.toThrow("invalid_command_id");
  } finally {
    f.close();
  }
});

it("lets the agent react to the person's latest message in its own chat", async () => {
  const f = await fixture();
  try {
    expect(await f.call({ emoji: "👀" }, "k1")).toEqual({ ok: true });
    expect(await f.call({ action: "react", emoji: "✅" }, "k2")).toEqual({ ok: true });
    expect(f.stored()).toEqual([
      expect.objectContaining({ itemId: "asked", actor: "agent", emoji: "✅" }),
    ]);
    // Agents react only to the person's messages, with an emoji from the set.
    expect(await f.call({ itemId: "source-message", emoji: "👍" }, "k3")).toEqual({
      error: "message_not_found",
    });
    expect(await f.call({ emoji: "💩" }, "k4")).toEqual({ error: "invalid_reaction" });
    expect(await f.call({ action: "dance", emoji: "👍" }, "k5")).toEqual({
      error: "unknown_action",
    });
  } finally {
    f.close();
  }
});

it("keeps reaction rows out of settings.set", async () => {
  const f = await fixture();
  try {
    const settings = settingsApi({ store: f.store, publish() {} } as never);
    await expect(
      settings("settings.set", { key: messageReactionsKey("thread"), value: [] }, "s1"),
    ).rejects.toThrow();
  } finally {
    f.close();
  }
});
