// I4: Discord over the gateway WebSocket, so no public web address is needed. Agents answer DMs
// and messages that mention or reply to the bot, as a reply to the message that asked. Discord
// shows a bot the text of exactly those messages, so no privileged intent is needed.
import WebSocket from "ws";
import {
  type BridgeAdapter,
  BridgeError,
  type InboundMessage,
  type OutboundMessage,
  type ReplyTarget,
} from "./adapter.js";
import { splitText } from "./router.js";

export const DISCORD_TEXT_LIMIT = 2000;
/** Guilds, guild messages and direct messages. */
export const DISCORD_INTENTS = (1 << 0) | (1 << 9) | (1 << 12);
/** A refused token, and the Message Content intent left off in the Developer Portal. */
const TOKEN_CLOSE = 4004;
const INTENT_CLOSE = 4014;
/** How long one reply may wait out rate limits before giving up. */
const MAX_WAIT_S = 30;
const READY_MS = 15_000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Json = Record<string, unknown>;
const text = (value: unknown) => (typeof value === "string" ? value : "");

export interface DiscordOptions {
  token: string;
  /** For tests: a fake REST API and gateway. */
  apiBase?: string;
  fetch?: typeof fetch;
}

export function createDiscordAdapter(options: DiscordOptions): BridgeAdapter {
  const apiBase = options.apiBase ?? "https://discord.com/api/v10";
  const request = options.fetch ?? fetch;
  let socket: WebSocket | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let onMessage: ((message: InboundMessage) => void) | undefined;
  let onDisconnect: ((error?: unknown) => void) | undefined;
  let botId = "";
  let botName = "";
  let stopped = false;
  const channels = new Map<string, string>();
  /** Each server's managed role for this bot, so mentioning the role counts too. */
  const botRoles = new Map<string, string>();
  // Messages are handled one at a time, so a name lookup can't reorder them.
  let handling: Promise<void> = Promise.resolve();

  async function call(path: string, body?: Json): Promise<Json> {
    let response: Response;
    try {
      response = await request(`${apiBase}${path}`, {
        method: body ? "POST" : "GET",
        headers: {
          authorization: `Bot ${options.token}`,
          ...(body ? { "content-type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new BridgeError("network");
    }
    if (response.status === 401) throw new BridgeError("token_refused");
    // Missing a permission in that channel: the invite needs it, retrying won't help.
    if (response.status === 403) throw new BridgeError("setup_incomplete", "discord_403");
    if (response.status === 429) {
      const body = (await response.json().catch(() => ({}))) as Json;
      const error = new BridgeError("network", "ratelimited");
      Object.assign(error, { retryAfter: Number(body.retry_after) || 1 });
      throw error;
    }
    if (!response.ok) throw new BridgeError("network", `discord_${response.status}`);
    return (await response.json().catch(() => ({}))) as Json;
  }

  async function channelName(id: string) {
    if (channels.has(id)) return channels.get(id) as string;
    let name = id;
    try {
      const channel = await call(`/channels/${id}`);
      if (text(channel.name)) name = `#${text(channel.name)}`;
    } catch {}
    channels.set(id, name);
    return name;
  }

  async function handle(message: Json) {
    const author = (message.author ?? {}) as Json;
    if (author.bot || !author.id || author.id === botId) return;
    const direct = !message.guild_id;
    const mentions = (message.mentions as Json[] | undefined) ?? [];
    // People often pick the bot's role from autocomplete rather than the bot itself.
    const role = botRoles.get(text(message.guild_id));
    const roleMentioned =
      !!role && ((message.mention_roles as string[] | undefined) ?? []).includes(role);
    const repliedTo =
      ((message.referenced_message as Json | undefined)?.author as Json | undefined)?.id === botId;
    if (!direct && !roleMentioned && !repliedTo && !mentions.some((user) => user.id === botId))
      return;
    const names = new Map(
      mentions.map((user) => [
        text(user.id),
        text((user.member as Json | undefined)?.nick) ||
          text(user.global_name) ||
          text(user.username),
      ]),
    );
    let body = text(message.content).replace(new RegExp(`<@!?${botId}>`, "g"), "");
    if (role) body = body.replaceAll(`<@&${role}>`, "");
    body = body
      .replace(/<@!?(\d+)>/g, (all, id: string) => (names.get(id) ? `@${names.get(id)}` : all))
      .trim();
    if (!body) return;
    const channel = text(message.channel_id);
    const label = direct ? "" : await channelName(channel);
    onMessage?.({
      id: text(message.id),
      place: { id: channel, label, direct },
      sender: {
        id: text(author.id),
        name:
          text((message.member as Json | undefined)?.nick) ||
          text(author.global_name) ||
          text(author.username),
      },
      text: body,
      reply: { channel, message: text(message.id) },
    });
  }

  const clearHeartbeat = () => {
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = undefined;
  };

  return {
    async start() {
      stopped = false;
      const gateway = await call("/gateway/bot");
      const url = text(gateway.url);
      if (!url) throw new BridgeError("network");
      await new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(`${url}/?v=10&encoding=json`);
        socket = ws;
        let ready = false;
        let seq: number | null = null;
        let acked = true;
        const fail = (error: BridgeError) => {
          if (!ready) reject(error);
        };
        const readyTimer = setTimeout(() => ws.terminate(), READY_MS);
        ws.on("error", () => fail(new BridgeError("network")));
        ws.on("close", (code) => {
          clearHeartbeat();
          clearTimeout(readyTimer);
          const error = new BridgeError(
            code === TOKEN_CLOSE
              ? "token_refused"
              : code === INTENT_CLOSE
                ? "setup_incomplete"
                : "network",
          );
          if (!ready) return fail(error);
          if (socket === ws && !stopped) onDisconnect?.(error);
        });
        ws.on("message", (data) => {
          let frame: Json;
          try {
            frame = JSON.parse(String(data)) as Json;
          } catch {
            return;
          }
          if (typeof frame.s === "number") seq = frame.s;
          const payload = (frame.d ?? {}) as Json;
          if (frame.op === 10) {
            const every = Number(payload.heartbeat_interval) || 41_250;
            clearHeartbeat();
            // A heartbeat Discord never acknowledged means the connection is dead.
            heartbeat = setInterval(() => {
              if (!acked) return ws.terminate();
              acked = false;
              ws.send(JSON.stringify({ op: 1, d: seq }));
            }, every);
            ws.send(
              JSON.stringify({
                op: 2,
                d: {
                  token: options.token,
                  intents: DISCORD_INTENTS,
                  properties: { os: "macos", browser: "zoltbot", device: "zoltbot" },
                },
              }),
            );
          }
          if (frame.op === 1) ws.send(JSON.stringify({ op: 1, d: seq }));
          if (frame.op === 11) acked = true;
          // Reconnect or a lost session: start over; the supervisor reconnects.
          if (frame.op === 7 || frame.op === 9) ws.close(4000);
          if (frame.op === 0 && frame.t === "READY") {
            const user = (payload.user ?? {}) as Json;
            botId = text(user.id);
            botName = text(user.username);
            ready = true;
            clearTimeout(readyTimer);
            resolve();
          }
          if (frame.op === 0 && frame.t === "GUILD_CREATE") {
            const role = ((payload.roles as Json[] | undefined) ?? []).find(
              (row) => (row.tags as Json | undefined)?.bot_id === botId,
            );
            if (role) botRoles.set(text(payload.id), text(role.id));
          }
          if (frame.op === 0 && frame.t === "MESSAGE_CREATE")
            handling = handling.then(() => handle(payload)).catch(() => {});
        });
      });
    },
    async stop() {
      stopped = true;
      clearHeartbeat();
      const ws = socket;
      socket = undefined;
      ws?.removeAllListeners("message");
      ws?.close(1000);
    },
    async send(target: ReplyTarget, message: OutboundMessage) {
      let first = true;
      for (const part of splitText(message.text, DISCORD_TEXT_LIMIT)) {
        const body = {
          content: part,
          // An agent's reply never pings @everyone or anyone else.
          allowed_mentions: { parse: [] },
          ...(first && target.message
            ? { message_reference: { message_id: target.message, fail_if_not_exists: false } }
            : {}),
        };
        const path = `/channels/${target.channel}/messages`;
        let waited = 0;
        for (;;) {
          try {
            await call(path, body);
            break;
          } catch (error) {
            const wait = (error as { retryAfter?: number }).retryAfter;
            if (!wait || waited + wait > MAX_WAIT_S) throw error;
            waited += wait;
            await sleep(wait * 1000);
          }
        }
        first = false;
      }
    },
    onMessage(handler) {
      onMessage = handler;
    },
    onDisconnect(handler) {
      onDisconnect = handler;
    },
    account: () => botName || undefined,
  };
}
