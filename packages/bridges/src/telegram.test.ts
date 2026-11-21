import { describe, expect, it, vi } from "vitest";
import type { InboundMessage } from "./adapter.js";
import { createTelegramAdapter } from "./telegram.js";

/** A fake Bot API: getUpdates hands out queued updates once, then waits like a long poll. */
function fakeTelegram(options: { refuse?: boolean } = {}) {
  const queue: Record<string, unknown>[] = [];
  const sent: Record<string, unknown>[] = [];
  const calls: string[] = [];
  let next = 1;
  let wake: (() => void) | undefined;
  const fetch = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = String(input);
    const reply = (result: unknown) => new Response(JSON.stringify({ ok: true, result }));
    if (options.refuse) return new Response(JSON.stringify({ ok: false }), { status: 401 });
    if (url.includes("/file/bot")) return new Response(new Uint8Array([1, 2, 3]));
    const method = url.split("/").at(-1) as string;
    calls.push(method);
    const body = JSON.parse(String(init?.body ?? "{}"));
    if (method === "getMe") return reply({ id: 42, is_bot: true, username: "zolt_bot" });
    if (method === "deleteWebhook") return reply(true);
    if (method === "getFile") return reply({ file_path: "photos/1.jpg", file_size: 3 });
    if (method === "sendMessage") {
      sent.push(body);
      return reply({});
    }
    if (method === "getUpdates") {
      const ready = queue.filter((update) => Number(update.update_id) >= body.offset);
      if (ready.length) return reply(ready);
      await new Promise<void>((resolve) => {
        wake = resolve;
        init?.signal?.addEventListener("abort", () => resolve());
      });
      if (init?.signal?.aborted) throw new DOMException("aborted", "AbortError");
      return reply(queue.filter((update) => Number(update.update_id) >= body.offset));
    }
    return new Response("{}", { status: 400 });
  }) as unknown as typeof globalThis.fetch;
  const push = (message: Record<string, unknown>) => {
    queue.push({ update_id: next++, message: { message_id: next, date: 0, ...message } });
    wake?.();
  };
  return { fetch, push, sent, calls };
}

const person = { id: 7, is_bot: false, first_name: "Sam", last_name: "Lee" };

async function connected(options: { refuse?: boolean } = {}) {
  const telegram = fakeTelegram(options);
  const adapter = createTelegramAdapter({
    token: "123:abc",
    apiBase: "https://telegram.test",
    fetch: telegram.fetch,
  });
  const inbound: InboundMessage[] = [];
  adapter.onMessage((message) => inbound.push(message));
  return { telegram, adapter, inbound };
}

describe("Telegram bridge", () => {
  it("names the bot and passes on direct messages with the sender's name", async () => {
    const { telegram, adapter, inbound } = await connected();
    await adapter.start();
    expect(adapter.account?.()).toBe("@zolt_bot");
    telegram.push({ from: person, chat: { id: 7, type: "private" }, text: "/start ABC123" });
    await vi.waitFor(() => expect(inbound).toHaveLength(1));
    expect(inbound[0]).toMatchObject({
      place: { id: "7", direct: true },
      sender: { id: "7", name: "Sam Lee" },
      text: "/start ABC123",
      reply: { chat: 7 },
    });
    await adapter.stop();
  });

  it("in a group, answers only mentions and replies to the bot", async () => {
    const { telegram, adapter, inbound } = await connected();
    await adapter.start();
    const group = { id: -100, type: "supergroup", title: "Ops" };
    telegram.push({ from: person, chat: group, text: "just chatting" });
    telegram.push({ from: { ...person, id: 8, is_bot: true }, chat: group, text: "@zolt_bot hi" });
    telegram.push({ from: person, chat: group, text: "@zolt_bot is it up?" });
    telegram.push({
      from: person,
      chat: group,
      text: "thanks",
      reply_to_message: { message_id: 1, from: { id: 42 } },
    });
    await vi.waitFor(() => expect(inbound).toHaveLength(2));
    expect(inbound.map((message) => message.text)).toEqual(["is it up?", "thanks"]);
    expect(inbound[0]?.place).toEqual({ id: "-100", label: "Ops", direct: false });
    await adapter.stop();
  });

  it("brings photos along as attachments", async () => {
    const { telegram, adapter, inbound } = await connected();
    await adapter.start();
    telegram.push({
      from: person,
      chat: { id: 7, type: "private" },
      caption: "this one",
      photo: [{ file_id: "small" }, { file_id: "large", file_size: 3 }],
    });
    await vi.waitFor(() => expect(inbound).toHaveLength(1));
    expect(inbound[0]?.text).toBe("this one");
    expect(inbound[0]?.attachments?.[0]).toMatchObject({
      name: "photo.jpg",
      mimeType: "image/jpeg",
    });
    expect([...(inbound[0]?.attachments?.[0]?.data ?? [])]).toEqual([1, 2, 3]);
    await adapter.stop();
  });

  it("replies to the message that asked, split to Telegram's limit", async () => {
    const { telegram, adapter } = await connected();
    await adapter.start();
    await adapter.send({ chat: 7, message: 3 }, { text: "x".repeat(5000) });
    expect(telegram.sent).toHaveLength(2);
    expect(telegram.sent[0]).toMatchObject({ chat_id: 7, reply_parameters: { message_id: 3 } });
    expect(telegram.sent[1]).not.toHaveProperty("reply_parameters");
    await adapter.stop();
  });

  it("says a refused token is refused, without the token in the error", async () => {
    const { adapter } = await connected({ refuse: true });
    const error = await adapter.start().catch((caught: unknown) => caught);
    expect(error).toMatchObject({ problem: "token_refused" });
    expect(String((error as Error).message)).not.toContain("123:abc");
  });
});
