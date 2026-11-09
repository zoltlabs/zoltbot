import {
  createIdentity,
  type Identity,
  linkId,
  relayPaths,
  type ServerFrame,
  signHello,
  toB64,
} from "@zoltbot/link";
import { WebSocket } from "ws";
import { FakePush } from "./push.js";
import { MemoryRegistry } from "./registry.js";
import { createRelay, type RelayOptions } from "./server.js";

// Test helpers: a relay on a free port and a small client that queues what it receives.

export async function startRelay(options: Partial<RelayOptions> = {}) {
  const registry = new MemoryRegistry();
  const push = new FakePush();
  const relay = createRelay({ registry, push, ...options });
  const port = await relay.listen(0, "127.0.0.1");
  return { relay, registry, push, url: `ws://127.0.0.1:${port}` };
}

type Waiter = { match: (frame: ServerFrame) => boolean; resolve: (frame: ServerFrame) => void };

export class Client {
  readonly received: ServerFrame[] = [];
  readonly closed: Promise<{ code: number; reason: string }>;
  private waiters: Waiter[] = [];

  constructor(readonly ws: WebSocket) {
    ws.on("message", (data) => {
      const frame = JSON.parse(data.toString()) as ServerFrame;
      const waiter = this.waiters.find((w) => w.match(frame));
      if (waiter) {
        this.waiters = this.waiters.filter((w) => w !== waiter);
        waiter.resolve(frame);
      } else this.received.push(frame);
    });
    this.closed = new Promise((resolve) =>
      ws.on("close", (code, reason) => resolve({ code, reason: reason.toString() })),
    );
  }

  static open(url: string) {
    const ws = new WebSocket(url);
    const client = new Client(ws);
    return new Promise<Client>((resolve, reject) => {
      ws.once("open", () => resolve(client));
      ws.once("error", reject);
    });
  }

  /** Resolves with the next frame of type `t` (queued or future). */
  next<T extends ServerFrame["t"]>(
    t: T,
    timeoutMs = 2000,
  ): Promise<Extract<ServerFrame, { t: T }>> {
    const match = (frame: ServerFrame) => frame.t === t;
    const index = this.received.findIndex(match);
    if (index >= 0) {
      const [frame] = this.received.splice(index, 1);
      return Promise.resolve(frame as Extract<ServerFrame, { t: T }>);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no ${t} frame`)), timeoutMs);
      this.waiters.push({
        match,
        resolve: (frame) => {
          clearTimeout(timer);
          resolve(frame as Extract<ServerFrame, { t: T }>);
        },
      });
    });
  }

  /** Waits briefly and returns true when no frame of type `t` arrived. */
  async quiet(t: ServerFrame["t"], ms = 150) {
    try {
      await this.next(t, ms);
      return false;
    } catch {
      return true;
    }
  }

  send(frame: unknown) {
    this.ws.send(typeof frame === "string" ? frame : JSON.stringify(frame));
  }

  close() {
    this.ws.close();
  }
}

export interface SignIn {
  identity?: Identity;
  macId?: string;
  offerId?: string;
}

/** Connects, answers the challenge and returns the client before the reply arrives. */
export async function hello(url: string, role: "mac" | "device", options: SignIn = {}) {
  const identity = options.identity ?? createIdentity();
  const client = await Client.open(`${url}${relayPaths[role]}`);
  const { nonce } = await client.next("challenge");
  client.send({
    t: "hello",
    v: 1,
    role,
    publicKey: toB64(identity.publicKey),
    signature: signHello(identity, role, nonce),
    ...(options.macId ? { macId: options.macId } : {}),
    ...(options.offerId ? { offerId: options.offerId } : {}),
  });
  return { client, identity, id: linkId(identity.publicKey) };
}

/** Signs in and waits for `ready`. */
export async function signIn(url: string, role: "mac" | "device", options: SignIn = {}) {
  const session = await hello(url, role, options);
  const ready = await session.client.next("ready");
  if (ready.id !== session.id) throw new Error("ready id does not match");
  return session;
}
