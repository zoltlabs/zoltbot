import { messagePinsKey } from "@zoltbot/protocol";
import { expect, it } from "vitest";
import { forkFixture } from "../../../tools/fakes/src/fork-fixture.js";
import { messagePinsApi } from "./message-pins-api.js";
import { PrivateInputGuard } from "./private-input.js";
import { settingsApi } from "./settings-api.js";

async function fixture() {
  const f = await forkFixture();
  const privacy = new PrivateInputGuard({ store: f.store, publish() {} });
  const published: unknown[] = [];
  const api = messagePinsApi({
    store: f.store,
    privacy,
    redactor: { text: (t: string) => t.replaceAll("SECRET", "[redacted]") },
    publish: (e) => published.push(...e),
  });
  const stored = () =>
    f.store.snapshot(["settings"]).settings?.find((r) => r.key === messagePinsKey("thread"))?.value;
  return { ...f, api, privacy, published, stored };
}

it("pins and unpins a message, newest pin first, once per message", async () => {
  const f = await fixture();
  try {
    f.put("item", { ...f.store.record("item", "source-message"), id: "second", seq: 99 });
    const pin = (itemId: string, id: string) =>
      f.api("message.pin", { threadId: "thread", itemId }, id) as Promise<{
        pins: { itemId: string }[];
      }>;
    await pin("source-message", "p1");
    const after = await pin("second", "p2");
    expect(after.pins.map((p) => p.itemId)).toEqual(["second", "source-message"]);
    // Pinning again changes nothing, and a repeated command returns its first result.
    const events = f.published.length;
    expect((await pin("second", "p3")).pins).toEqual(after.pins);
    expect(f.published.length).toBe(events);
    expect(await pin("source-message", "p1")).toEqual({ pins: [expect.anything()] });
    const unpinned = (await f.api(
      "message.unpin",
      { threadId: "thread", itemId: "second" },
      "u1",
    )) as { pins: { itemId: string }[] };
    expect(unpinned.pins.map((p) => p.itemId)).toEqual(["source-message"]);
    expect(f.stored()).toEqual(unpinned.pins);
  } finally {
    f.close();
  }
});

it("refuses unknown chats and messages from another chat", async () => {
  const f = await fixture();
  try {
    await expect(
      f.api("message.pin", { threadId: "missing", itemId: "source-message" }, "a"),
    ).rejects.toThrow("thread_not_found");
    await expect(
      f.api("message.pin", { threadId: "thread", itemId: "nowhere" }, "b"),
    ).rejects.toThrow("message_not_found");
    await expect(f.api("message.pin", { threadId: "thread", itemId: "x" })).rejects.toThrow(
      "command_id_required",
    );
    expect(await f.api("message.other", {}, "c")).toBeUndefined();
  } finally {
    f.close();
  }
});

it("pins only visible messages and refuses redacted command ids", async () => {
  const f = await fixture();
  try {
    f.put("item", {
      ...f.store.record("item", "source-message"),
      id: "tool",
      seq: 98,
      kind: "tool",
    });
    await expect(f.api("message.pin", { threadId: "thread", itemId: "tool" }, "t")).rejects.toThrow(
      "message_not_found",
    );
    await expect(
      f.api("message.pin", { threadId: "thread", itemId: "source-message" }, "SECRET"),
    ).rejects.toThrow("invalid_command_id");
    const events = f.published.length;
    expect(
      await f.api("message.unpin", { threadId: "thread", itemId: "source-message" }, "u"),
    ).toEqual({ pins: [] });
    expect(f.published.length).toBe(events);
  } finally {
    f.close();
  }
});

it("drops pins of messages that are gone", async () => {
  const f = await fixture();
  try {
    f.put("settings", {
      key: messagePinsKey("thread"),
      value: [{ itemId: "gone", pinnedAt: "2026" }],
    });
    expect(
      await f.api("message.pin", { threadId: "thread", itemId: "source-message" }, "p"),
    ).toEqual({ pins: [expect.objectContaining({ itemId: "source-message" })] });
  } finally {
    f.close();
  }
});

it("stops at 50 pins", async () => {
  const f = await fixture();
  try {
    for (let i = 0; i < 50; i++)
      f.put("item", { ...f.store.record("item", "source-message"), id: `i${i}`, seq: 100 + i });
    const full = Array.from({ length: 50 }, (_, i) => ({ itemId: `i${i}`, pinnedAt: "2026" }));
    f.put("settings", { key: messagePinsKey("thread"), value: full });
    await expect(
      f.api("message.pin", { threadId: "thread", itemId: "source-message" }, "a"),
    ).rejects.toThrow("pin_limit");
  } finally {
    f.close();
  }
});

it("keeps the pins row out of settings.set", async () => {
  const f = await fixture();
  try {
    const settings = settingsApi({
      store: f.store,
      privacy: f.privacy,
      redactor: { text: (t: string) => t, value: <T>(v: T) => v } as never,
      publish() {},
    });
    await expect(
      settings("settings.set", { key: messagePinsKey("thread"), value: [] }, "s"),
    ).rejects.toThrow("setting_reserved");
  } finally {
    f.close();
  }
});
