import { afterEach, describe, expect, it, vi } from "vitest";
import { type WebSocket, WebSocketServer } from "ws";
import type { InboundMessage } from "./adapter.js";
import { createSlackAdapter, SLACK_APP_MANIFEST } from "./slack.js";

/** A fake Slack: a Socket Mode server and the few Web API methods the bridge calls. */
async function fakeSlack(options: { refuse?: boolean } = {}) {
  const server = new WebSocketServer({ port: 0 });
  await new Promise((resolve) => server.once("listening", resolve));
  const port = (server.address() as { port: number }).port;
  const sockets: WebSocket[] = [];
  const acks: string[] = [];
  const posts: Record<string, unknown>[] = [];
  const auth: string[] = [];
  server.on("connection", (socket) => {
    sockets.push(socket);
    socket.on("message", (data) => acks.push(JSON.parse(String(data)).envelope_id));
    socket.send(JSON.stringify({ type: "hello" }));
  });
  const fetch = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = url.pathname.split("/").at(-1);
    auth.push(`${method}:${new Headers(init?.headers).get("authorization")}`);
    const reply = (body: unknown) => new Response(JSON.stringify(body));
    if (options.refuse) return reply({ ok: false, error: "invalid_auth" });
    if (method === "auth.test") return reply({ ok: true, team: "Acme", user_id: "UBOT" });
    if (method === "apps.connections.open")
      return reply({ ok: true, url: `ws://127.0.0.1:${port}` });
    if (method === "users.info")
      return reply({ ok: true, user: { name: "sam", profile: { display_name: "Sam Lee" } } });
    if (method === "conversations.info") return reply({ ok: true, channel: { name: "support" } });
    if (method === "chat.postMessage") {
      posts.push(JSON.parse(String(init?.body)));
      return reply({ ok: true });
    }
    return reply({ ok: false, error: "unknown_method" });
  }) as unknown as typeof globalThis.fetch;
  let envelope = 0;
  const event = (body: Record<string, unknown>) => {
    const id = `env-${++envelope}`;
    sockets
      .at(-1)
      ?.send(JSON.stringify({ type: "events_api", envelope_id: id, payload: { event: body } }));
    return id;
  };
  return { server, sockets, acks, posts, auth, fetch, event, close: () => server.close() };
}

const slacks: Awaited<ReturnType<typeof fakeSlack>>[] = [];
afterEach(() => {
  for (const slack of slacks.splice(0)) slack.close();
});

async function connected(options: { refuse?: boolean } = {}) {
  const slack = await fakeSlack(options);
  slacks.push(slack);
  const adapter = createSlackAdapter({
    appToken: "xapp-1",
    botToken: "xoxb-1",
    apiBase: "https://slack.test/api",
    fetch: slack.fetch,
  });
  const inbound: InboundMessage[] = [];
  adapter.onMessage((message) => inbound.push(message));
  return { slack, adapter, inbound };
}

describe("Slack bridge", () => {
  it("connects over Socket Mode and names the workspace", async () => {
    const { slack, adapter } = await connected();
    await adapter.start();
    expect(adapter.account?.()).toBe("Acme");
    expect(slack.auth).toEqual(["auth.test:Bearer xoxb-1", "apps.connections.open:Bearer xapp-1"]);
    await adapter.stop();
  });

  it("acknowledges every event and passes on DMs and mentions with names", async () => {
    const { slack, adapter, inbound } = await connected();
    await adapter.start();
    const dm = slack.event({
      type: "message",
      channel_type: "im",
      channel: "D1",
      user: "U9",
      text: "hi",
      ts: "1.0",
    });
    slack.event({
      type: "app_mention",
      channel: "C1",
      user: "U9",
      text: "<@UBOT> can you check <https://x.test/a|this> &amp; ping <@U9>?",
      ts: "2.0",
      thread_ts: "1.5",
    });
    await vi.waitFor(() => expect(inbound).toHaveLength(2));
    expect(slack.acks).toContain(dm);
    expect(inbound[0]).toMatchObject({
      id: "D1:1.0",
      place: { id: "D1", direct: true },
      sender: { id: "U9", name: "Sam Lee" },
      text: "hi",
      reply: { channel: "D1" },
    });
    expect(inbound[1]).toMatchObject({
      place: { id: "C1", label: "#support", direct: false },
      text: "can you check https://x.test/a & ping @Sam Lee?",
      reply: { channel: "C1", thread: "1.5" },
    });
    await adapter.stop();
  });

  it("ignores its own posts, other bots, edits and channel chatter", async () => {
    const { slack, adapter, inbound } = await connected();
    await adapter.start();
    slack.event({ type: "message", channel_type: "im", channel: "D1", user: "UBOT", ts: "1" });
    slack.event({ type: "message", channel_type: "im", channel: "D1", bot_id: "B1", ts: "2" });
    slack.event({
      type: "message",
      subtype: "message_changed",
      channel_type: "im",
      channel: "D1",
      user: "U9",
      ts: "3",
    });
    slack.event({ type: "message", channel_type: "channel", channel: "C1", user: "U9", ts: "4" });
    slack.event({
      type: "message",
      channel_type: "im",
      channel: "D1",
      user: "U9",
      text: "ok",
      ts: "5",
    });
    await vi.waitFor(() => expect(inbound).toHaveLength(1));
    expect(inbound[0]?.id).toBe("D1:5");
    await adapter.stop();
  });

  it("replies in the thread under the agent's name and splits long replies", async () => {
    const { slack, adapter } = await connected();
    await adapter.start();
    await adapter.send(
      { channel: "C1", thread: "1.5" },
      {
        text: `<!channel> ${"a".repeat(3000)}\n\n${"b".repeat(3000)}`,
        as: { name: "Support desk" },
      },
    );
    expect(slack.posts).toHaveLength(2);
    expect(String(slack.posts[0]?.text).startsWith("&lt;!channel&gt;")).toBe(true);
    expect(slack.posts[0]).toMatchObject({
      channel: "C1",
      thread_ts: "1.5",
      username: "Support desk",
    });
    await adapter.stop();
  });

  it("reports a dropped socket and a refused token", async () => {
    const { slack, adapter } = await connected();
    const dropped = vi.fn();
    adapter.onDisconnect(dropped);
    await adapter.start();
    slack.sockets[0]?.close();
    await vi.waitFor(() => expect(dropped).toHaveBeenCalled());
    expect(dropped.mock.calls[0]?.[0]).toMatchObject({ problem: "network" });

    const disabled = await connected();
    const stoppedFor = vi.fn();
    disabled.adapter.onDisconnect(stoppedFor);
    await disabled.adapter.start();
    disabled.slack.sockets[0]?.send(
      JSON.stringify({ type: "disconnect", reason: "link_disabled" }),
    );
    await vi.waitFor(() => expect(stoppedFor).toHaveBeenCalled());
    expect(stoppedFor.mock.calls[0]?.[0]).toMatchObject({ problem: "setup_incomplete" });

    const refused = await connected({ refuse: true });
    await expect(refused.adapter.start()).rejects.toMatchObject({ problem: "token_refused" });
  });

  it("asks for only the scopes and events the bridge uses", () => {
    expect(SLACK_APP_MANIFEST.settings.socket_mode_enabled).toBe(true);
    expect(SLACK_APP_MANIFEST.settings.event_subscriptions.bot_events).toEqual([
      "app_mention",
      "message.im",
    ]);
  });
});
