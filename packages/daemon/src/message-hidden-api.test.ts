import { messageHiddenKey } from "@zoltbot/protocol";
import { expect, it } from "vitest";
import { forkFixture } from "../../../tools/fakes/src/fork-fixture.js";
import { messageHiddenApi } from "./message-hidden-api.js";
import { PrivateInputGuard } from "./private-input.js";

async function fixture() {
  const f = await forkFixture();
  const privacy = new PrivateInputGuard({ store: f.store, publish() {} });
  const published: unknown[] = [];
  const api = messageHiddenApi({
    store: f.store,
    privacy,
    redactor: { text: (t: string) => t },
    publish: (e) => published.push(...e),
  });
  const stored = () =>
    f.store.snapshot(["settings"]).settings?.find((r) => r.key === messageHiddenKey("thread"))
      ?.value;
  return { ...f, api, published, stored };
}

it("hides a message for display only and shows it again", async () => {
  const f = await fixture();
  try {
    const before = f.store.record("item", "source-message");
    const params = { threadId: "thread", itemId: "source-message" };
    expect(await f.api("message.hide", params, "h1")).toEqual({ hidden: ["source-message"] });
    expect(f.stored()).toEqual(["source-message"]);
    // The message itself is untouched: hiding is display only.
    expect(f.store.record("item", "source-message")).toEqual(before);
    const events = f.published.length;
    expect(await f.api("message.hide", params, "h2")).toEqual({ hidden: ["source-message"] });
    expect(f.published.length).toBe(events);
    expect(await f.api("message.unhide", params, "u1")).toEqual({ hidden: [] });
    expect(await f.api("message.hide", params, "h1")).toEqual({ hidden: ["source-message"] });
    expect(f.stored()).toEqual([]);
  } finally {
    f.close();
  }
});

it("refuses unknown chats and messages", async () => {
  const f = await fixture();
  try {
    await expect(
      f.api("message.hide", { threadId: "missing", itemId: "source-message" }, "a"),
    ).rejects.toThrow("thread_not_found");
    await expect(
      f.api("message.hide", { threadId: "thread", itemId: "nowhere" }, "b"),
    ).rejects.toThrow("message_not_found");
    await expect(f.api("message.hide", { threadId: "thread", itemId: "x" })).rejects.toThrow(
      "command_id_required",
    );
    expect(await f.api("message.pin", {}, "c")).toBeUndefined();
  } finally {
    f.close();
  }
});
