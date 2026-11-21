// I2: Slack over Socket Mode, so no public web address is needed. The app-level token opens the
// socket; the bot token reads names and posts replies. Agents answer DMs and @mentions, in the
// thread of the message that asked.
import WebSocket from "ws";
import {
  type BridgeAdapter,
  BridgeError,
  type InboundMessage,
  type OutboundMessage,
  type ReplyTarget,
} from "./adapter.js";
import { splitText } from "./router.js";

export { SLACK_APP_MANIFEST } from "@zoltbot/protocol";

/** Slack accepts up to 40,000 characters but recommends keeping a message under 4,000. */
export const SLACK_TEXT_LIMIT = 3900;

type Json = Record<string, unknown>;

/** Slack's own escaping: an agent's reply can't ping @channel or dress up a link. */
export const slackEscape = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Incoming text as a person wrote it: mentions as names, links as their address. */
const slackPlain = (value: string, names: Map<string, string>) =>
  value
    .replace(/<@([A-Z0-9]+)(?:\|[^>]*)?>/g, (_all, id: string) => `@${names.get(id) ?? id}`)
    .replace(/<#[A-Z0-9]+\|([^>]*)>/g, "#$1")
    .replace(/<!(here|channel|everyone)(?:\|[^>]*)?>/g, "@$1")
    .replace(/<(https?:[^>|]+)(?:\|[^>]*)?>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

/** Errors the owner has to fix in Slack; retrying won't help. */
const OWNER_ERRORS = [
  "invalid_auth",
  "not_authed",
  "account_inactive",
  "token_revoked",
  "not_allowed_token_type",
  "missing_scope",
];
const HELLO_MS = 10_000;
/** We ping every third of this; this long with no frame or pong means the socket is gone. */
const SILENT_MS = 45_000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const text = (value: unknown) => (typeof value === "string" ? value : "");

export interface SlackOptions {
  appToken: string;
  botToken: string;
  /** For tests: a fake Web API. */
  apiBase?: string;
  fetch?: typeof fetch;
}

export function createSlackAdapter(options: SlackOptions): BridgeAdapter {
  const apiBase = options.apiBase ?? "https://slack.com/api";
  const request = options.fetch ?? fetch;
  let socket: WebSocket | undefined;
  let onMessage: ((message: InboundMessage) => void) | undefined;
  let onDisconnect: ((error?: unknown) => void) | undefined;
  let team = "";
  let botUserId = "";
  let stopped = false;
  const names = new Map<string, string>();
  const channels = new Map<string, string>();
  // Messages are handled one at a time, so a name lookup can't reorder them.
  let handling: Promise<void> = Promise.resolve();

  async function call(method: string, token: string, body?: Json, query?: Json): Promise<Json> {
    const url = new URL(`${apiBase}/${method}`);
    for (const [key, value] of Object.entries(query ?? {}))
      url.searchParams.set(key, String(value));
    let response: Response;
    try {
      response = await request(url, {
        method: body ? "POST" : "GET",
        headers: {
          authorization: `Bearer ${token}`,
          ...(body ? { "content-type": "application/json; charset=utf-8" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new BridgeError("network");
    }
    if (response.status === 429) {
      const error = new BridgeError("network", "ratelimited");
      Object.assign(error, { retryAfter: Number(response.headers.get("retry-after")) || 1 });
      throw error;
    }
    if (response.status >= 500) throw new BridgeError("network");
    const json = (await response.json().catch(() => ({}))) as Json;
    if (json.ok === true) return json;
    const error = text(json.error);
    if (OWNER_ERRORS.includes(error)) throw new BridgeError("token_refused", error);
    throw new BridgeError("network", error || "slack_error");
  }

  // A failed look-up isn't cached, so the next message tries again.
  async function userName(id: string) {
    if (names.has(id)) return names.get(id) as string;
    try {
      const user = (await call("users.info", options.botToken, undefined, { user: id }))
        .user as Json;
      const profile = (user?.profile ?? {}) as Json;
      const name = text(profile.display_name) || text(profile.real_name) || text(user?.name);
      if (name) names.set(id, name);
      return name || id;
    } catch {
      return id;
    }
  }

  async function channelName(id: string) {
    if (channels.has(id)) return channels.get(id) as string;
    try {
      const channel = (
        await call("conversations.info", options.botToken, undefined, { channel: id })
      ).channel as Json;
      if (!text(channel?.name)) return id;
      channels.set(id, `#${text(channel.name)}`);
      return `#${text(channel.name)}`;
    } catch {
      return id;
    }
  }

  async function post(body: Json) {
    try {
      await call("chat.postMessage", options.botToken, body);
    } catch (error) {
      const wait = (error as { retryAfter?: number }).retryAfter;
      if (!wait) throw error;
      await sleep(Math.min(wait, 30) * 1000);
      await call("chat.postMessage", options.botToken, body);
    }
  }

  async function handle(event: Json) {
    // Our own posts, edits, joins and other bots aren't messages to answer; a shared file or a
    // reply also sent to the channel still is.
    const subtype = text(event.subtype);
    if (subtype && subtype !== "file_share" && subtype !== "thread_broadcast") return;
    if (event.bot_id || !event.user || event.user === botUserId) return;
    const direct = event.type === "message" && event.channel_type === "im";
    if (!direct && event.type !== "app_mention") return;
    const channel = text(event.channel);
    const ts = text(event.ts);
    if (!channel || !ts) return;
    const raw = text(event.text).replace(new RegExp(`<@${botUserId}>`, "g"), "");
    const mentioned = [...raw.matchAll(/<@([A-Z0-9]+)/g)].map((match) => match[1] as string);
    const [name, place] = await Promise.all([
      userName(text(event.user)),
      direct ? Promise.resolve("") : channelName(channel),
      ...mentioned.slice(0, 10).map(userName),
    ]);
    const body = slackPlain(raw, names).trim();
    onMessage?.({
      id: `${channel}:${ts}`,
      place: { id: channel, label: place, direct },
      sender: { id: text(event.user), name },
      text: body,
      // A DM is answered in the conversation; a channel message in its thread.
      reply:
        direct && !event.thread_ts ? { channel } : { channel, thread: text(event.thread_ts) || ts },
    });
  }

  return {
    async start() {
      stopped = false;
      const auth = await call("auth.test", options.botToken);
      team = text(auth.team);
      botUserId = text(auth.user_id);
      const opened = await call("apps.connections.open", options.appToken, {});
      const url = text(opened.url);
      if (!url) throw new BridgeError("network");
      await new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(url);
        socket = ws;
        let ready = false;
        let closing: BridgeError = new BridgeError("network");
        const fail = (error: unknown) => {
          if (!ready) reject(error instanceof BridgeError ? error : new BridgeError("network"));
        };
        // No hello, or a socket gone silent after sleep: end it so the supervisor reconnects.
        let silence = setTimeout(() => ws.terminate(), HELLO_MS);
        const heard = () => {
          clearTimeout(silence);
          silence = setTimeout(() => ws.terminate(), SILENT_MS);
        };
        const pinger = setInterval(() => {
          if (ws.readyState === ws.OPEN) ws.ping();
        }, SILENT_MS / 3);
        ws.on("ping", heard);
        ws.on("pong", heard);
        ws.on("error", fail);
        ws.on("close", () => {
          clearTimeout(silence);
          clearInterval(pinger);
          if (!ready) return fail(closing);
          if (socket === ws && !stopped) onDisconnect?.(closing);
        });
        ws.on("message", (data) => {
          heard();
          let envelope: Json;
          try {
            envelope = JSON.parse(String(data)) as Json;
          } catch {
            return;
          }
          if (envelope.envelope_id) ws.send(JSON.stringify({ envelope_id: envelope.envelope_id }));
          if (envelope.type === "hello") {
            ready = true;
            resolve();
          }
          if (envelope.type === "disconnect") {
            // Socket Mode turned off for the app: the owner has to turn it back on.
            if (envelope.reason === "link_disabled")
              closing = new BridgeError("token_refused", "link_disabled");
            ws.close();
          }
          if (envelope.type === "events_api") {
            const event = ((envelope.payload as Json | undefined)?.event ?? {}) as Json;
            handling = handling.then(() => handle(event)).catch(() => {});
          }
        });
      });
    },
    async stop() {
      stopped = true;
      const ws = socket;
      socket = undefined;
      ws?.removeAllListeners("message");
      ws?.removeAllListeners("ping");
      ws?.removeAllListeners("pong");
      ws?.close();
    },
    async send(target: ReplyTarget, message: OutboundMessage) {
      for (const part of splitText(message.text, SLACK_TEXT_LIMIT))
        await post({
          channel: target.channel,
          ...(target.thread ? { thread_ts: target.thread } : {}),
          text: slackEscape(part),
          ...(message.as?.name ? { username: message.as.name.slice(0, 80) } : {}),
          ...(message.as?.iconUrl ? { icon_url: message.as.iconUrl } : {}),
        });
    },
    onMessage(handler) {
      onMessage = handler;
    },
    onDisconnect(handler) {
      onDisconnect = handler;
    },
    account: () => team || undefined,
  };
}
