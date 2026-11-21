// I5: WhatsApp Business over the Cloud API. Replies go straight to Meta's Graph API from the Mac.
// Meta only delivers incoming messages to a public webhook, so they arrive through the Zoltbot
// cloud relay: it checks Meta's signature and holds them until the Mac pulls. Without a relay
// (no Zoltbot account yet) the bridge says it needs one.
import { createHmac, timingSafeEqual } from "node:crypto";
import {
  type BridgeAdapter,
  BridgeError,
  type InboundMessage,
  type OutboundMessage,
  type ReplyTarget,
} from "./adapter.js";
import { splitText } from "./router.js";

export const WHATSAPP_TEXT_LIMIT = 4096;
/** The one place the Graph API version lives; check Meta's changelog when bumping it. */
export const GRAPH_VERSION = "v21.0";
const GRAPH = `https://graph.facebook.com/${GRAPH_VERSION}`;
/** Graph error codes: a bad or expired token; a wrong id or missing permission; rate limits. */
const TOKEN_CODES = new Set([190]);
const SETUP_CODES = new Set([100, 10, 200]);
const RATE_CODES = new Set([4, 80007, 130429, 131056]);
/** Outside the 24-hour window, or a number that can't get WhatsApp messages. */
const UNREACHABLE_CODES = new Set([131047, 131026]);
const MAX_WAIT_S = 30;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Json = Record<string, unknown>;
const text = (value: unknown) => (typeof value === "string" ? value : "");

/** Meta's subscribe handshake: echo the challenge only for our verify token. */
export function verifyWebhook(query: URLSearchParams, verifyToken: string): string | undefined {
  if (!verifyToken || query.get("hub.mode") !== "subscribe") return undefined;
  const given = Buffer.from(query.get("hub.verify_token") ?? "");
  const wanted = Buffer.from(verifyToken);
  if (given.length !== wanted.length || !timingSafeEqual(given, wanted)) return undefined;
  return query.get("hub.challenge") ?? undefined;
}

/**
 * True when the raw body bytes were signed with the app secret, as X-Hub-Signature-256 says.
 * Check the bytes as received: Meta signs them before any parsing.
 */
export function signedByMeta(
  body: Uint8Array | string,
  header: string | null,
  appSecret: string,
): boolean {
  const hex = header?.startsWith("sha256=") ? header.slice(7) : "";
  if (!appSecret || !/^[0-9a-f]{64}$/i.test(hex)) return false;
  const given = Buffer.from(hex, "hex");
  const wanted = createHmac("sha256", appSecret).update(body).digest();
  return given.length === wanted.length && timingSafeEqual(given, wanted);
}

/** The text messages in one webhook delivery, for the phone number this bridge owns. */
export function whatsappMessages(payload: unknown, phoneNumberId: string): InboundMessage[] {
  const found: InboundMessage[] = [];
  for (const entry of ((payload as Json)?.entry as Json[] | undefined) ?? [])
    for (const change of (entry.changes as Json[] | undefined) ?? []) {
      const value = (change.value ?? {}) as Json;
      if (text((value.metadata as Json | undefined)?.phone_number_id) !== phoneNumberId) continue;
      const names = new Map(
        ((value.contacts as Json[] | undefined) ?? []).map((contact) => [
          text(contact.wa_id),
          text((contact.profile as Json | undefined)?.name),
        ]),
      );
      for (const message of (value.messages as Json[] | undefined) ?? []) {
        const from = text(message.from);
        const interactive = (message.interactive ?? {}) as Json;
        // Media isn't fetched yet; say it was there rather than pass a caption without it.
        const media = ["image", "video", "document", "audio", "sticker"].find(
          (kind) => message.type === kind,
        );
        const caption = media ? text((message[media] as Json | undefined)?.caption) : "";
        const body =
          text((message.text as Json | undefined)?.body) ||
          text((interactive.button_reply as Json | undefined)?.title) ||
          text((interactive.list_reply as Json | undefined)?.title) ||
          text((message.button as Json | undefined)?.text) ||
          (media ? `[${media} not passed on]${caption ? ` ${caption}` : ""}` : "");
        if (!from || !text(message.id) || !body) continue;
        found.push({
          id: text(message.id),
          place: { id: from, label: "", direct: true },
          sender: { id: from, name: names.get(from) || `+${from}` },
          text: body,
          reply: { to: from, message: text(message.id) },
        });
      }
    }
  return found;
}

/**
 * What the Mac needs from the cloud relay: a long pull of deliveries whose signature it checked.
 * Delivery is at least once; the daemon drops repeats by message id.
 */
export interface WhatsappRelay {
  /**
   * Resolves with deliveries after `cursor`, or after a while with none. Passing a cursor
   * acknowledges everything up to it; no cursor resumes after the relay's last acknowledgement,
   * so a reconnect neither replays the backlog nor skips anything.
   */
  pull(input: { cursor?: string; signal: AbortSignal }): Promise<{
    cursor: string;
    deliveries: unknown[];
  }>;
}

export interface WhatsappOptions {
  accessToken: string;
  phoneNumberId: string;
  relay?: WhatsappRelay;
  /** For tests: a fake Graph API. */
  apiBase?: string;
  fetch?: typeof fetch;
}

export function createWhatsappAdapter(options: WhatsappOptions): BridgeAdapter {
  const base = options.apiBase ?? GRAPH;
  const request = options.fetch ?? fetch;
  let onMessage: ((message: InboundMessage) => void) | undefined;
  let onDisconnect: ((error?: unknown) => void) | undefined;
  let running: AbortController | undefined;
  let number = "";
  let cursor: string | undefined;

  async function call(path: string, body?: Json): Promise<Json> {
    let response: Response;
    try {
      response = await request(`${base}${path}`, {
        method: body ? "POST" : "GET",
        headers: {
          authorization: `Bearer ${options.accessToken}`,
          ...(body ? { "content-type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new BridgeError("network");
    }
    const json = (await response.json().catch(() => ({}))) as Json;
    if (response.ok) return json;
    // Graph puts the reason in the body; the HTTP status is often just 400.
    const code = Number((json.error as Json | undefined)?.code);
    if (response.status === 401 || TOKEN_CODES.has(code)) throw new BridgeError("token_refused");
    if (response.status === 429 || RATE_CODES.has(code)) {
      const error = new BridgeError("network", "ratelimited");
      Object.assign(error, { retryAfter: Number(response.headers.get("retry-after")) || 5 });
      throw error;
    }
    if (UNREACHABLE_CODES.has(code))
      throw new BridgeError("network", `whatsapp_unreachable_${code}`);
    if (response.status === 403 || SETUP_CODES.has(code))
      throw new BridgeError("setup_incomplete", `whatsapp_${code || response.status}`);
    throw new BridgeError("network", `whatsapp_${response.status}`);
  }

  async function send(path: string, body: Json) {
    let waited = 0;
    for (;;) {
      try {
        return await call(path, body);
      } catch (error) {
        const wait = (error as { retryAfter?: number }).retryAfter;
        if (!wait || waited + wait > MAX_WAIT_S) throw error;
        waited += wait;
        await sleep(wait * 1000);
      }
    }
  }

  async function poll(relay: WhatsappRelay, controller: AbortController) {
    while (!controller.signal.aborted) {
      try {
        const batch = await relay.pull({
          ...(cursor ? { cursor } : {}),
          signal: controller.signal,
        });
        for (const delivery of batch.deliveries)
          for (const message of whatsappMessages(delivery, options.phoneNumberId))
            onMessage?.(message);
        cursor = batch.cursor;
      } catch (error) {
        if (controller.signal.aborted) return;
        running = undefined;
        onDisconnect?.(error instanceof BridgeError ? error : new BridgeError("network"));
        return;
      }
    }
  }

  return {
    async start() {
      const phone = await call(
        `/${encodeURIComponent(options.phoneNumberId)}?fields=display_phone_number,verified_name`,
      );
      number = text(phone.verified_name) || text(phone.display_phone_number);
      // Replies work without the relay; receiving doesn't.
      if (!options.relay) throw new BridgeError("needs_account");
      const controller = new AbortController();
      running = controller;
      void poll(options.relay, controller);
    },
    async stop() {
      running?.abort();
      running = undefined;
    },
    async send(target: ReplyTarget, message: OutboundMessage) {
      let first = true;
      for (const part of splitText(message.text, WHATSAPP_TEXT_LIMIT)) {
        await send(`/${encodeURIComponent(options.phoneNumberId)}/messages`, {
          messaging_product: "whatsapp",
          to: target.to,
          type: "text",
          text: { body: part, preview_url: false },
          ...(first && target.message ? { context: { message_id: target.message } } : {}),
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
    account: () => number || undefined,
  };
}
