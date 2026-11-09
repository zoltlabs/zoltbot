import { Value } from "@sinclair/typebox/value";
import {
  type ClientFrame,
  fromB64,
  type Identity,
  LinkMessage,
  type LinkSession,
  linkSessionVersion,
  maxFrameBytes,
  PairingOffer,
  parsePairingUrl,
  relayPaths,
  ServerFrame,
  signHello,
  startHandshake,
  toB64,
} from "@zoltbot/link";
import type { DomainEvent } from "@zoltbot/protocol";
import { OutcomeUnknownError, type Transport, type TransportHandlers } from "./transport.js";

// The phone side of the mobile link (D124): sign in to the relay as a device, run the handshake
// with the Mac's key from the QR code, then speak sealed JSON-RPC 2.0 to zoltd.

/** The part of a WebSocket the transport uses, so tests can pass an in-process relay. */
export interface LinkSocket {
  send(text: string): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
}
export type SocketFactory = (url: string) => LinkSocket;

/** What the phone keeps about its Mac after pairing. */
export interface PairedMac {
  relay: string;
  macId: string;
  macKey: string;
  name: string;
}
export interface PendingPairing {
  offerId: string;
  secret: Uint8Array;
  deviceName: string;
}

/** Reads a scanned or pasted zoltbot://pair link. Throws a readable error. */
export function readPairingUrl(text: string): {
  mac: PairedMac;
  pairing: Omit<PendingPairing, "deviceName">;
} {
  let offer: PairingOffer;
  try {
    const parsed = parsePairingUrl(text.trim());
    if (parsed.v !== linkSessionVersion) throw new Error("unsupported_link_version");
    offer = Value.Parse(PairingOffer, parsed);
  } catch (error) {
    if (error instanceof Error && error.message === "unsupported_link_version")
      throw new Error("Update Zoltbot on your Mac and show a new pairing code.");
    throw new Error("That is not a Zoltbot pairing code. Show a new one on your Mac.");
  }
  return {
    mac: { relay: offer.relay, macId: offer.macId, macKey: offer.macKey, name: offer.name },
    pairing: { offerId: offer.offerId, secret: fromB64(offer.secret) },
  };
}

const readMethods =
  /^(?:hello|snapshot\.get|events\.(?:un)?subscribe|detect\.checkLogin)$|\.(?:list|get|history|search)$/;
const notAllowed = "device_not_allowed";
const errorText: Record<string, string> = {
  bad_signature: "The relay did not accept this phone’s key.",
  not_allowed: "Your Mac no longer knows this phone. Pair it again.",
  offer_expired: "The pairing code expired. Show a new one on your Mac.",
  too_large: "A message was too large to send.",
  rate_limited: "Too many requests. Trying again shortly.",
  bad_frame: "The relay could not read a message.",
};

export interface RelayOptions {
  identity: Identity;
  mac: PairedMac;
  /** Only for the first connection, from the QR code. */
  pairing?: PendingPairing;
  socket: SocketFactory;
  /** Called once the person allowed this phone on the Mac, so the app can save the pairing. */
  paired?(): void;
  retryMs?: { base: number; max: number };
  /** How often to ask whether the Mac allowed this phone yet. */
  pairPollMs?: number;
  callTimeoutMs?: number;
  commandId?: () => string;
}

export class RelayTransport implements Transport {
  readonly kind = "relay";
  private handlers: TransportHandlers | undefined;
  private socket: LinkSocket | undefined;
  private session: LinkSession | undefined;
  private finish: ReturnType<typeof startHandshake>["finish"] | undefined;
  private pairing: PendingPairing | undefined;
  private allowed: boolean;
  private nextId = 0;
  private attempts = 0;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private poll: ReturnType<typeof setTimeout> | undefined;
  private fatal = false;
  private readonly pending = new Map<
    number,
    {
      resolve(value: unknown): void;
      reject(error: Error): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  constructor(private readonly options: RelayOptions) {
    this.pairing = options.pairing;
    this.allowed = !options.pairing;
  }

  start(handlers: TransportHandlers) {
    this.handlers = handlers;
    this.connect();
  }
  stop() {
    this.handlers = undefined;
    clearTimeout(this.retry);
    clearTimeout(this.poll);
    this.drop("Connection closed");
    this.socket?.close();
    this.socket = undefined;
  }

  call(method: string, params: unknown, commandId?: string): Promise<unknown> {
    const session = this.session;
    if (!session || !this.socket || !this.allowed)
      return Promise.reject(new Error("Not connected to your Mac."));
    return this.request(session, method, params, commandId);
  }

  private request(session: LinkSession, method: string, params: unknown, given?: string) {
    const id = ++this.nextId;
    const commandId = readMethods.test(method)
      ? undefined
      : (given ?? this.options.commandId?.() ?? `phone-${Date.now().toString(36)}-${id}`);
    const text = JSON.stringify({
      jsonrpc: "2.0",
      id,
      method,
      params,
      ...(commandId ? { commandId } : {}),
    });
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new OutcomeUnknownError("Your Mac did not answer in time."));
      }, this.options.callTimeoutMs ?? 20_000);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.frame({ t: "data", payload: session.seal(text) });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  private frame(frame: ClientFrame) {
    const encoded = JSON.stringify(frame);
    // Sealed data is base64url, so its serialized frame contains only ASCII.
    if (encoded.length > maxFrameBytes)
      throw new Error("This message is too large. Remove an attachment or choose a smaller photo.");
    this.socket?.send(encoded);
  }
  private status(...args: Parameters<TransportHandlers["status"]>) {
    this.handlers?.status(...args);
  }
  private drop(reason: string) {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new OutcomeUnknownError(reason));
    }
    this.pending.clear();
  }

  private connect() {
    if (!this.handlers || this.fatal) return;
    this.status("connecting");
    this.session = undefined;
    this.finish = undefined;
    const url = `${this.options.mac.relay.replace(/\/+$/, "")}${relayPaths.device}`;
    let socket: LinkSocket;
    try {
      socket = this.options.socket(url);
    } catch {
      this.closed();
      return;
    }
    this.socket = socket;
    socket.onmessage = (event) => {
      if (socket !== this.socket) return;
      let frame: unknown;
      try {
        frame = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (Value.Check(ServerFrame, frame)) this.receive(frame);
    };
    socket.onclose = () => {
      if (socket === this.socket) this.closed();
    };
    socket.onerror = () => {};
  }

  private closed() {
    this.socket = undefined;
    this.session = undefined;
    clearTimeout(this.poll);
    this.drop("Connection lost");
    if (!this.handlers || this.fatal) return;
    this.status("offline", { error: "Cannot reach the relay." });
    const { base, max } = this.options.retryMs ?? { base: 1000, max: 30_000 };
    const delay = Math.min(max, base * 2 ** this.attempts);
    this.attempts += 1;
    this.retry = setTimeout(() => this.connect(), delay);
  }

  private handshake() {
    const start = startHandshake(
      this.options.identity,
      fromB64(this.options.mac.macKey),
      this.pairing
        ? {
            offerId: this.pairing.offerId,
            secret: this.pairing.secret,
            name: this.pairing.deviceName,
          }
        : undefined,
    );
    this.finish = start.finish;
    this.frame({ t: "data", payload: start.hello });
  }

  private receive(frame: ServerFrame) {
    const { identity, mac } = this.options;
    switch (frame.t) {
      case "challenge":
        this.frame({
          t: "hello",
          v: 1,
          role: "device",
          publicKey: toB64(identity.publicKey),
          signature: signHello(identity, "device", frame.nonce),
          macId: mac.macId,
          ...(this.pairing ? { offerId: this.pairing.offerId } : {}),
        });
        return;
      case "ready":
        this.attempts = 0;
        this.handshake();
        return;
      case "presence":
        if (frame.id !== mac.macId) return;
        if (frame.online) {
          // The Mac came back: its old session is gone, so open a fresh one.
          if (!this.finish || this.session) this.handshake();
        } else {
          this.session = undefined;
          this.finish = undefined;
          this.drop("Your Mac went offline.");
          this.status("mac_offline", frame.lastSeenAt ? { lastSeenAt: frame.lastSeenAt } : {});
        }
        return;
      case "error":
        if (frame.code === "mac_offline") {
          // The relay dropped our handshake; presence starts a fresh one when the Mac is back.
          this.finish = undefined;
          this.status("mac_offline");
          return;
        }
        if (
          frame.code === "offer_expired" ||
          frame.code === "not_allowed" ||
          frame.code === "bad_signature"
        ) {
          this.fatal = true;
          this.status("offline", { error: errorText[frame.code] });
          this.socket?.close();
          return;
        }
        this.status("offline", { error: errorText[frame.code] ?? frame.message });
        return;
      case "data":
        this.data(frame.payload);
        return;
    }
  }

  private data(payload: unknown) {
    if (payload && typeof payload === "object" && "t" in payload && payload.t === "hs2") {
      if (!("v" in payload) || payload.v !== linkSessionVersion) {
        this.fatal = true;
        this.status("offline", {
          error: "Update Zoltbot on your Mac and iPhone, then pair again.",
        });
        this.socket?.close();
        return;
      }
    }
    if (!Value.Check(LinkMessage, payload)) return;
    if (payload.t === "hs2") {
      if (!this.finish) return;
      let session: ReturnType<ReturnType<typeof startHandshake>["finish"]>;
      try {
        session = this.finish(payload);
      } catch {
        this.fatal = true;
        this.status("offline", { error: "This is not the Mac you paired with." });
        this.socket?.close();
        return;
      }
      this.finish = undefined;
      this.session = session;
      if (this.allowed) this.status("online");
      else {
        this.handlers?.confirmCode?.(session.confirmCode);
        this.status("pairing");
        this.waitForAllow(session);
      }
      return;
    }
    if (payload.t !== "msg" || !this.session) return;
    let message: {
      id?: number;
      method?: string;
      params?: unknown;
      result?: unknown;
      error?: { message?: string };
    };
    try {
      message = JSON.parse(this.session.open(payload));
    } catch {
      return;
    }
    if (message.method === "event") {
      if (this.allowed) this.handlers?.event(message.params as DomainEvent);
      return;
    }
    const entry = typeof message.id === "number" ? this.pending.get(message.id) : undefined;
    if (!entry) return;
    this.pending.delete(message.id as number);
    clearTimeout(entry.timer);
    if (message.error)
      entry.reject(new Error(message.error.message ?? "Your Mac refused the request."));
    else entry.resolve(message.result);
  }

  /**
   * A pending phone holds a session, but zoltd answers every call with device_not_allowed until
   * the person clicks Allow on the Mac. Ask with `hello` until it goes through.
   */
  private waitForAllow(session: LinkSession) {
    this.request(session, "hello", { protocolVersion: 1, token: "" }).then(
      () => {
        if (session !== this.session) return;
        this.allowed = true;
        this.pairing = undefined;
        this.options.paired?.();
        this.status("online");
      },
      (error: Error) => {
        if (session !== this.session) return;
        if (!error.message.startsWith(notAllowed)) {
          this.status("pairing", { error: error.message });
        }
        this.poll = setTimeout(() => this.waitForAllow(session), this.options.pairPollMs ?? 1500);
      },
    );
  }
}
