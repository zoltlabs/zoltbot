// I3: Telegram over Bot API long polling, so no public web address is needed. The owner gets a
// token from @BotFather. Agents answer direct chats and, in groups, messages that mention the bot
// or reply to it. Photos come along as attachments.
import {
  type BridgeAdapter,
  BridgeError,
  type InboundAttachment,
  type InboundMessage,
  type OutboundMessage,
  type ReplyTarget,
} from "./adapter.js";
import { splitText } from "./router.js";

export const TELEGRAM_TEXT_LIMIT = 4096;
/** Bot API downloads stop at 20 MB; anything near that is too big to hand an agent anyway. */
export const TELEGRAM_MAX_FILE = 5 * 1024 * 1024;
const POLL_SECONDS = 25;

type Json = Record<string, unknown>;
const text = (value: unknown) => (typeof value === "string" ? value : "");

export interface TelegramOptions {
  token: string;
  /** For tests: a fake Bot API. */
  apiBase?: string;
  fetch?: typeof fetch;
}

export function createTelegramAdapter(options: TelegramOptions): BridgeAdapter {
  const base = options.apiBase ?? "https://api.telegram.org";
  const request = options.fetch ?? fetch;
  let onMessage: ((message: InboundMessage) => void) | undefined;
  let onDisconnect: ((error?: unknown) => void) | undefined;
  let running: AbortController | undefined;
  let username = "";
  let botId = 0;
  let offset = 0;

  async function call(method: string, body: Json, signal?: AbortSignal): Promise<unknown> {
    let response: Response;
    try {
      response = await request(`${base}/bot${options.token}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: signal ?? AbortSignal.timeout(15_000),
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new BridgeError("network");
    }
    // The token itself is never part of an error message.
    if (response.status === 401 || response.status === 404) throw new BridgeError("token_refused");
    // Another program is reading this bot's messages; reconnecting would only split them.
    if (response.status === 409) throw new BridgeError("token_in_use");
    const json = (await response.json().catch(() => ({}))) as Json;
    if (json.ok === true) return json.result;
    throw new BridgeError("network", `telegram_${response.status}`);
  }

  async function download(fileId: string, name: string, mimeType: string, size: number) {
    if (size > TELEGRAM_MAX_FILE) return undefined;
    try {
      const file = (await call("getFile", { file_id: fileId })) as Json;
      const path = text(file.file_path);
      if (!path || Number(file.file_size ?? 0) > TELEGRAM_MAX_FILE) return undefined;
      const response = await request(`${base}/file/bot${options.token}/${path}`, {
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) return undefined;
      const data = new Uint8Array(await response.arrayBuffer());
      if (data.byteLength > TELEGRAM_MAX_FILE) return undefined;
      return { name, mimeType, data } satisfies InboundAttachment;
    } catch {
      return undefined;
    }
  }

  async function handle(update: Json) {
    const message = update.message as Json | undefined;
    if (!message) return;
    const from = (message.from ?? {}) as Json;
    const chat = (message.chat ?? {}) as Json;
    if (from.is_bot || !from.id || chat.id === undefined) return;
    const direct = chat.type === "private";
    let body = text(message.text) || text(message.caption);
    if (!direct) {
      // In a group, only messages for this bot: a mention, a command to it or a reply to it.
      const mention = `@${username}`;
      const repliedTo = ((message.reply_to_message as Json | undefined)?.from as Json | undefined)
        ?.id;
      const mentioned = username && body.toLowerCase().includes(mention.toLowerCase());
      if (!mentioned && repliedTo !== botId) return;
      if (username) body = body.replace(new RegExp(`@${username}\\b`, "gi"), "").trim();
    }
    const attachments: InboundAttachment[] = [];
    const photos = message.photo as Json[] | undefined;
    const photo = photos?.at(-1);
    if (photo) {
      const file = await download(
        text(photo.file_id),
        "photo.jpg",
        "image/jpeg",
        Number(photo.file_size ?? 0),
      );
      if (file) attachments.push(file);
    }
    // Other files aren't downloaded: anyone can send them, and agents only take images.
    if (!body && !attachments.length) return;
    const name = [text(from.first_name), text(from.last_name)].filter(Boolean).join(" ");
    onMessage?.({
      id: `${chat.id}:${message.message_id}`,
      place: { id: String(chat.id), label: direct ? "" : text(chat.title), direct },
      sender: { id: String(from.id), name: name || text(from.username) || String(from.id) },
      text: body,
      ...(attachments.length ? { attachments } : {}),
      reply: {
        chat: Number(chat.id),
        message: Number(message.message_id),
        // In a forum group, every part of the reply stays in the asking topic.
        ...(message.is_topic_message && message.message_thread_id
          ? { topic: Number(message.message_thread_id) }
          : {}),
      },
    });
  }

  async function poll(controller: AbortController) {
    while (!controller.signal.aborted) {
      let updates: Json[];
      try {
        updates = (await call(
          "getUpdates",
          { offset, timeout: POLL_SECONDS, allowed_updates: ["message"] },
          AbortSignal.any([controller.signal, AbortSignal.timeout((POLL_SECONDS + 10) * 1000)]),
        )) as Json[];
      } catch (error) {
        if (controller.signal.aborted) return;
        running = undefined;
        onDisconnect?.(error instanceof BridgeError ? error : new BridgeError("network"));
        return;
      }
      for (const update of updates) {
        if (controller.signal.aborted) return;
        offset = Math.max(offset, Number(update.update_id) + 1);
        await handle(update).catch(() => {});
      }
    }
  }

  return {
    async start() {
      const me = (await call("getMe", {})) as Json;
      username = text(me.username);
      botId = Number(me.id);
      // A webhook left from another tool would make getUpdates fail.
      await call("deleteWebhook", { drop_pending_updates: false });
      const controller = new AbortController();
      running = controller;
      void poll(controller);
    },
    async stop() {
      running?.abort();
      running = undefined;
    },
    async send(target: ReplyTarget, message: OutboundMessage) {
      let first = true;
      for (const part of splitText(message.text, TELEGRAM_TEXT_LIMIT)) {
        await call("sendMessage", {
          chat_id: target.chat,
          ...(target.topic ? { message_thread_id: target.topic } : {}),
          text: part,
          ...(first && target.message
            ? {
                reply_parameters: { message_id: target.message, allow_sending_without_reply: true },
              }
            : {}),
        });
        first = false;
      }
    },
    onMessage(handler) {
      onMessage = handler;
    },
    onDisconnect(handler) {
      onDisconnect = handler;
    },
    account: () => (username ? `@${username}` : undefined),
  };
}
