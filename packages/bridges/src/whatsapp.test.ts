import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { InboundMessage } from "./adapter.js";
import {
  createWhatsappAdapter,
  signedByMeta,
  verifyWebhook,
  type WhatsappRelay,
  whatsappMessages,
} from "./whatsapp.js";

const delivery = (phoneNumberId: string, id: string, body: string) => ({
  object: "whatsapp_business_account",
  entry: [
    {
      changes: [
        {
          field: "messages",
          value: {
            metadata: { phone_number_id: phoneNumberId },
            contacts: [{ wa_id: "15550001", profile: { name: "Sam Lee" } }],
            messages: [{ id, from: "15550001", type: "text", text: { body } }],
          },
        },
      ],
    },
  ],
});

/** A fake Graph API: the phone number's name and the messages endpoint. */
function fakeGraph(options: { refuse?: boolean } = {}) {
  const sent: Record<string, unknown>[] = [];
  const fetch = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = new URL(String(input));
    if (options.refuse)
      return new Response(JSON.stringify({ error: { code: 190 } }), { status: 400 });
    if (url.pathname === "/BAD")
      return new Response(JSON.stringify({ error: { code: 100, error_subcode: 33 } }), {
        status: 400,
      });
    if (url.pathname === "/PN1")
      return new Response(JSON.stringify({ verified_name: "Acme Support" }));
    if (url.pathname === "/PN1/messages") {
      sent.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ messages: [{ id: "wamid.out" }] }));
    }
    return new Response("{}", { status: 404 });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, sent };
}

/** A fake relay that hands out queued deliveries once each. */
function fakeRelay() {
  const queue: unknown[] = [];
  let wake: (() => void) | undefined;
  const cursors: (string | undefined)[] = [];
  const relay: WhatsappRelay = {
    async pull({ cursor, signal }) {
      cursors.push(cursor);
      if (!queue.length)
        await new Promise<void>((resolve) => {
          wake = resolve;
          signal.addEventListener("abort", () => resolve());
        });
      if (signal.aborted) throw new DOMException("aborted", "AbortError");
      const deliveries = queue.splice(0);
      return { cursor: `c${cursors.length}`, deliveries };
    },
  };
  return {
    relay,
    cursors,
    push: (value: unknown) => {
      queue.push(value);
      wake?.();
    },
  };
}

describe("WhatsApp bridge", () => {
  it("answers Meta's subscribe handshake only for its verify token", () => {
    const query = (token: string) =>
      new URLSearchParams({
        "hub.mode": "subscribe",
        "hub.verify_token": token,
        "hub.challenge": "42",
      });
    expect(verifyWebhook(query("right"), "right")).toBe("42");
    expect(verifyWebhook(query("wrong"), "right")).toBeUndefined();
    expect(verifyWebhook(query(""), "")).toBeUndefined();
  });

  it("accepts only deliveries signed with the app secret", () => {
    const body = JSON.stringify(delivery("PN1", "m1", "hi"));
    const signature = `sha256=${createHmac("sha256", "secret").update(body).digest("hex")}`;
    expect(signedByMeta(body, signature, "secret")).toBe(true);
    expect(signedByMeta(body, signature, "other")).toBe(false);
    expect(signedByMeta(`${body} `, signature, "secret")).toBe(false);
    expect(signedByMeta(body, null, "secret")).toBe(false);
    expect(signedByMeta(body, `${signature}ff`, "secret")).toBe(false);
    expect(signedByMeta(body, signature, "")).toBe(false);
  });

  it("reads text messages for its own number with the sender's profile name", () => {
    expect(whatsappMessages(delivery("PN2", "m1", "hi"), "PN1")).toEqual([]);
    expect(whatsappMessages(delivery("PN1", "m1", "hi"), "PN1")[0]).toMatchObject({
      id: "m1",
      place: { id: "15550001", direct: true },
      sender: { id: "15550001", name: "Sam Lee" },
      text: "hi",
      reply: { to: "15550001", message: "m1" },
    });
  });

  it("needs a Zoltbot account to receive, and says so after checking the token", async () => {
    const graph = fakeGraph();
    const adapter = createWhatsappAdapter({
      accessToken: "EAAG-test",
      phoneNumberId: "PN1",
      apiBase: "https://graph.test",
      fetch: graph.fetch,
    });
    await expect(adapter.start()).rejects.toMatchObject({ problem: "needs_account" });
    expect(adapter.account?.()).toBe("Acme Support");

    const refused = createWhatsappAdapter({
      accessToken: "bad",
      phoneNumberId: "PN1",
      apiBase: "https://graph.test",
      fetch: fakeGraph({ refuse: true }).fetch,
    });
    await expect(refused.start()).rejects.toMatchObject({ problem: "token_refused" });
    const wrongId = createWhatsappAdapter({
      accessToken: "EAAG-test",
      phoneNumberId: "BAD",
      apiBase: "https://graph.test",
      fetch: graph.fetch,
    });
    await expect(wrongId.start()).rejects.toMatchObject({ problem: "setup_incomplete" });
  });

  it("pulls deliveries from the relay and replies in context", async () => {
    const graph = fakeGraph();
    const relay = fakeRelay();
    const adapter = createWhatsappAdapter({
      accessToken: "EAAG-test",
      phoneNumberId: "PN1",
      relay: relay.relay,
      apiBase: "https://graph.test",
      fetch: graph.fetch,
    });
    const inbound: InboundMessage[] = [];
    adapter.onMessage((message) => inbound.push(message));
    await adapter.start();
    relay.push(delivery("PN1", "m1", "is the order out?"));
    await vi.waitFor(() => expect(inbound).toHaveLength(1));
    await vi.waitFor(() => expect(relay.cursors).toContain("c1"));
    await adapter.send(inbound[0]?.reply ?? {}, { text: "Yes, today." });
    expect(graph.sent[0]).toEqual({
      messaging_product: "whatsapp",
      to: "15550001",
      type: "text",
      text: { body: "Yes, today.", preview_url: false },
      context: { message_id: "m1" },
    });
    await adapter.stop();
  });

  it("says media and buttons were sent instead of dropping them", () => {
    const base = delivery("PN1", "m1", "x");
    const value = base.entry[0]?.changes[0]?.value as { messages: Record<string, unknown>[] };
    value.messages = [
      { id: "a", from: "15550001", type: "image", image: { caption: "the dent" } },
      {
        id: "b",
        from: "15550001",
        type: "interactive",
        interactive: { button_reply: { title: "Yes" } },
      },
    ];
    expect(whatsappMessages(base, "PN1").map((message) => message.text)).toEqual([
      "[image not passed on] the dent",
      "Yes",
    ]);
  });
});
