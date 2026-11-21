// I1: an in-memory adapter for tests. `deliver` plays a message from the app; `sent` keeps what
// the bridge posted back.
import type { BridgeAdapter, InboundMessage, OutboundMessage, ReplyTarget } from "./adapter.js";

export class FakeBridgeAdapter implements BridgeAdapter {
  readonly sent: { target: ReplyTarget; message: OutboundMessage }[] = [];
  started = 0;
  stopped = 0;
  /** Set to make the next start fail with this error. */
  failNext: unknown;
  private handler: ((message: InboundMessage) => void) | undefined;
  private dropped: ((error?: unknown) => void) | undefined;
  constructor(private readonly name = "Fake workspace") {}
  async start() {
    this.started += 1;
    if (this.failNext !== undefined) {
      const error = this.failNext;
      this.failNext = undefined;
      throw error;
    }
  }
  async stop() {
    this.stopped += 1;
  }
  async send(target: ReplyTarget, message: OutboundMessage) {
    this.sent.push({ target, message });
  }
  onMessage(handler: (message: InboundMessage) => void) {
    this.handler = handler;
  }
  onDisconnect(handler: (error?: unknown) => void) {
    this.dropped = handler;
  }
  account() {
    return this.name;
  }
  deliver(message: InboundMessage) {
    this.handler?.(message);
  }
  drop(error?: unknown) {
    this.dropped?.(error);
  }
}
