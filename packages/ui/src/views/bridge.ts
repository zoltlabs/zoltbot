import { parse } from "@zoltbot/protocol";
import {
  type appKeys,
  bridgeLimits,
  callSchemas,
  type HostMessage,
  type Permission,
  type Topic,
  type TopicValues,
  ViewMessageSchema,
} from "@zoltbot/view-api";
export type Ready = Extract<HostMessage, { t: "ready" }>;
export interface ViewPort {
  postMessage(value: HostMessage): void;
  close(): void;
}
const required: Record<string, Permission> = {
  "chats.send": "act",
  "chats.interrupt": "act",
  "requests.answer": "approve",
  "storage.get": "read",
  "storage.set": "read",
  "app.open": "read",
};
export class ViewCallError extends Error {
  constructor(
    readonly code: Extract<HostMessage, { t: "result"; ok: false }>["error"]["code"],
    message: string,
  ) {
    super(message);
  }
}
/** This object receives only the host-created port. It never listens to window messages. */
export class ViewBridge {
  private closed = false;
  private connected = false;
  private started: number;
  private pongAt = 0;
  private pingAt = 0;
  private ping = 0;
  private calls: number[] = [];
  private keys: number[] = [];
  private visible = true;
  private topics = new Set<Topic>();
  private data: Partial<TopicValues> = {};
  private sent = new Map<Topic, { at: number; json: string }>();
  constructor(
    private readonly options: {
      port: ViewPort;
      now?(): number;
      ready(): Ready;
      failed(): void;
      call(method: string, params: unknown): Promise<unknown>;
      key(combo: (typeof appKeys)[number]): void;
    },
  ) {
    this.started = this.now();
  }
  get isConnected() {
    return this.connected && !this.closed;
  }
  private now() {
    return this.options.now?.() ?? Date.now();
  }
  private post(value: HostMessage) {
    if (!this.closed) this.options.port.postMessage(value);
  }
  receive(raw: unknown) {
    if (this.closed) return;
    let message: import("@zoltbot/view-api").ViewMessage;
    try {
      const json = JSON.stringify(raw);
      if (!json || new TextEncoder().encode(json).length > bridgeLimits.bytes) return;
      message = parse(ViewMessageSchema, raw);
    } catch {
      return;
    }
    if (message.t === "hello") {
      if (this.connected || !this.options.ready().granted.includes("read")) return;
      this.connected = true;
      this.pongAt = this.now();
      this.post(this.options.ready());
      return;
    }
    if (!this.connected) return;
    if (message.t === "pong") {
      if (message.id === this.ping) this.pongAt = this.now();
      return;
    }
    if (message.t === "key") {
      this.keys = this.keys.filter((at) => at > this.now() - 1000);
      if (this.keys.length < 50) {
        this.keys.push(this.now());
        this.options.key(message.combo);
      }
      return;
    }
    if (message.t === "sub" || message.t === "unsub") {
      if (!this.options.ready().granted.includes("read")) return;
      for (const topic of message.topics) {
        if (message.t === "sub") this.topics.add(topic);
        else {
          this.topics.delete(topic);
          this.sent.delete(topic);
        }
      }
      this.tick();
      return;
    }
    if (message.t === "call") {
      this.calls = this.calls.filter((at) => at > this.now() - 1000);
      if (this.calls.length >= bridgeLimits.callsPerSecond) {
        this.resultError(message.id, "rate_limited", "Too many calls.");
        return;
      }
      this.calls.push(this.now());
      void this.call(message.id, message.method, message.params ?? {});
    }
  }
  private resultError(id: number, code: ViewCallError["code"], message: string) {
    this.post({ t: "result", id, ok: false, error: { code, message } });
  }
  private async call(id: number, method: string, params: unknown) {
    try {
      const permission = required[method],
        schema = callSchemas[method as keyof typeof callSchemas];
      if (!permission || !schema) throw new ViewCallError("invalid", "Unknown view call.");
      if (!this.options.ready().granted.includes(permission))
        throw new ViewCallError("not_granted", `This view needs the ${permission} permission.`);
      try {
        parse(schema, params);
      } catch {
        throw new ViewCallError("invalid", "Invalid call parameters.");
      }
      const value = await this.options.call(method, params);
      this.post({ t: "result", id, ok: true, value });
    } catch (error) {
      this.resultError(
        id,
        error instanceof ViewCallError ? error.code : "unavailable",
        error instanceof Error ? error.message : "The call failed.",
      );
    }
  }
  update(data: TopicValues) {
    this.data = data;
    this.tick();
  }
  event(name: Extract<HostMessage, { t: "event" }>["name"], value: unknown) {
    if (this.connected) this.post({ t: "event", name, value });
  }
  visibility(visible: boolean) {
    if (visible && !this.visible) {
      this.started = this.now();
      this.pongAt = this.now();
      this.pingAt = 0;
    }
    this.visible = visible;
    this.event("visibility", visible);
    if (visible) {
      this.sent.clear();
      this.tick();
    }
  }
  tick() {
    if (this.closed || !this.visible) return;
    const now = this.now();
    if (
      (!this.connected && now - this.started >= 10000) ||
      (this.connected && now - this.pongAt >= 15000)
    ) {
      this.close();
      this.options.failed();
      return;
    }
    if (!this.connected) return;
    if (!this.options.ready().granted.includes("read")) {
      this.close();
      return;
    }
    if (now - this.pingAt >= 5000) {
      this.pingAt = now;
      this.post({ t: "ping", id: ++this.ping });
    }
    if (!this.visible) return;
    for (const topic of this.topics) {
      const value = this.data[topic];
      if (value === undefined) continue;
      const json = JSON.stringify(value),
        previous = this.sent.get(topic);
      if (previous && (now - previous.at < bridgeLimits.topicIntervalMs || previous.json === json))
        continue;
      this.sent.set(topic, { at: now, json });
      this.post({ t: "data", topic, value, at: new Date(now).toISOString() });
    }
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.options.port.close();
    this.topics.clear();
  }
}
