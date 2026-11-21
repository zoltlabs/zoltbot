import { afterEach, describe, expect, it, vi } from "vitest";
import { type WebSocket, WebSocketServer } from "ws";
import type { InboundMessage } from "./adapter.js";
import { createDiscordAdapter, DISCORD_INTENTS } from "./discord.js";

/** A fake Discord: a gateway that says hello, takes Identify and sends READY, plus the REST calls. */
async function fakeDiscord(options: { closeWith?: number; refuse?: boolean } = {}) {
  const server = new WebSocketServer({ port: 0 });
  await new Promise((resolve) => server.once("listening", resolve));
  const port = (server.address() as { port: number }).port;
  const sockets: WebSocket[] = [];
  const identify: Record<string, unknown>[] = [];
  const posts: { path: string; body: Record<string, unknown> }[] = [];
  let seq = 0;
  server.on("connection", (socket) => {
    sockets.push(socket);
    socket.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 60_000 } }));
    socket.on("message", (data) => {
      const frame = JSON.parse(String(data));
      if (frame.op !== 2) return;
      identify.push(frame.d);
      if (options.closeWith) return socket.close(options.closeWith);
      socket.send(
        JSON.stringify({
          op: 0,
          s: ++seq,
          t: "READY",
          d: { user: { id: "BOT", username: "zolt" } },
        }),
      );
    });
  });
  const fetch = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
    const path = new URL(String(input)).pathname.replace("/api/v10", "");
    const reply = (body: unknown) => new Response(JSON.stringify(body));
    if (options.refuse) return new Response("{}", { status: 401 });
    if (path === "/gateway/bot") return reply({ url: `ws://127.0.0.1:${port}` });
    if (path === "/channels/C1") return reply({ id: "C1", name: "ops" });
    if (path === "/channels/LOCKED/messages") return new Response("{}", { status: 403 });
    if (init?.method === "POST") {
      posts.push({ path, body: JSON.parse(String(init.body)) });
      return reply({ id: "sent" });
    }
    return new Response("{}", { status: 404 });
  }) as unknown as typeof globalThis.fetch;
  const dispatch = (message: Record<string, unknown>) =>
    sockets.at(-1)?.send(JSON.stringify({ op: 0, s: ++seq, t: "MESSAGE_CREATE", d: message }));
  return { server, sockets, identify, posts, fetch, dispatch, close: () => server.close() };
}

const servers: Awaited<ReturnType<typeof fakeDiscord>>[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

async function connected(options: { closeWith?: number; refuse?: boolean } = {}) {
  const discord = await fakeDiscord(options);
  servers.push(discord);
  const adapter = createDiscordAdapter({
    token: "bot-token",
    apiBase: "https://discord.test/api/v10",
    fetch: discord.fetch,
  });
  const inbound: InboundMessage[] = [];
  adapter.onMessage((message) => inbound.push(message));
  return { discord, adapter, inbound };
}

const author = { id: "U9", username: "sam", global_name: "Sam Lee" };

describe("Discord bridge", () => {
  it("identifies with the message-content intent and names the bot", async () => {
    const { discord, adapter } = await connected();
    await adapter.start();
    expect(discord.identify[0]).toMatchObject({ token: "bot-token", intents: DISCORD_INTENTS });
    expect(DISCORD_INTENTS & (1 << 15)).toBe(0);
    expect(adapter.account?.()).toBe("zolt");
    await adapter.stop();
  });

  it("passes on DMs and mentions, and ignores bots and unmentioned chatter", async () => {
    const { discord, adapter, inbound } = await connected();
    await adapter.start();
    discord.dispatch({ id: "1", channel_id: "C1", guild_id: "G", author, content: "chatting" });
    discord.dispatch({
      id: "2",
      channel_id: "C1",
      guild_id: "G",
      author: { id: "B2", bot: true },
      content: "<@BOT> hi",
      mentions: [{ id: "BOT" }],
    });
    discord.dispatch({
      id: "3",
      channel_id: "C1",
      guild_id: "G",
      author,
      member: { nick: "Sam (ops)" },
      content: "<@!BOT> is it up?",
      mentions: [{ id: "BOT" }],
    });
    discord.dispatch({ id: "4", channel_id: "D1", author, content: "hello" });
    await vi.waitFor(() => expect(inbound).toHaveLength(2));
    expect(inbound[0]).toMatchObject({
      id: "3",
      place: { id: "C1", label: "#ops", direct: false },
      sender: { id: "U9", name: "Sam (ops)" },
      text: "is it up?",
      reply: { channel: "C1", message: "3" },
    });
    expect(inbound[1]).toMatchObject({ place: { id: "D1", direct: true }, text: "hello" });
    await adapter.stop();
  });

  it("replies to the asking message without pinging anyone, split to 2000 characters", async () => {
    const { discord, adapter } = await connected();
    await adapter.start();
    await adapter.send({ channel: "C1", message: "3" }, { text: `@everyone ${"x".repeat(2500)}` });
    expect(discord.posts).toHaveLength(2);
    expect(discord.posts[0]?.path).toBe("/channels/C1/messages");
    expect(discord.posts[0]?.body).toMatchObject({
      allowed_mentions: { parse: [] },
      message_reference: { message_id: "3" },
    });
    expect(discord.posts[1]?.body).not.toHaveProperty("message_reference");
    await adapter.stop();
  });

  it("reports a dropped gateway, a refused token and a missing intent", async () => {
    const { discord, adapter } = await connected();
    const dropped = vi.fn();
    adapter.onDisconnect(dropped);
    await adapter.start();
    discord.sockets[0]?.close(4000);
    await vi.waitFor(() => expect(dropped).toHaveBeenCalled());
    expect(dropped.mock.calls[0]?.[0]).toMatchObject({ problem: "network" });

    const refused = await connected({ refuse: true });
    await expect(refused.adapter.start()).rejects.toMatchObject({ problem: "token_refused" });
    const intent = await connected({ closeWith: 4014 });
    await expect(intent.adapter.start()).rejects.toMatchObject({ problem: "setup_incomplete" });
  });

  it("answers the bot's role, replies to the bot, and shows other mentions as names", async () => {
    const { discord, adapter, inbound } = await connected();
    await adapter.start();
    discord.sockets[0]?.send(
      JSON.stringify({
        op: 0,
        s: 50,
        t: "GUILD_CREATE",
        d: { id: "G", roles: [{ id: "R1", tags: { bot_id: "BOT" } }, { id: "R2" }] },
      }),
    );
    discord.dispatch({
      id: "5",
      channel_id: "C1",
      guild_id: "G",
      author,
      content: "<@&R1> ask <@222> about it",
      mentions: [{ id: "222", username: "kim" }],
      mention_roles: ["R1"],
    });
    discord.dispatch({
      id: "6",
      channel_id: "C1",
      guild_id: "G",
      author,
      content: "thanks",
      referenced_message: { id: "4", author: { id: "BOT" } },
    });
    discord.dispatch({
      id: "7",
      channel_id: "C1",
      guild_id: "G",
      author,
      content: "<@&R2> not us",
      mention_roles: ["R2"],
    });
    await vi.waitFor(() => expect(inbound).toHaveLength(2));
    expect(inbound.map((message) => message.text)).toEqual(["ask @kim about it", "thanks"]);
    await adapter.stop();
  });

  it("says a missing channel permission is a setup step, not a network fault", async () => {
    const { adapter } = await connected();
    await adapter.start();
    await expect(adapter.send({ channel: "LOCKED" }, { text: "hi" })).rejects.toMatchObject({
      problem: "setup_incomplete",
    });
    await adapter.stop();
  });
});
