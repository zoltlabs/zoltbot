import type { DomainEvent } from "@zoltbot/protocol";
import type { ConnectionState, DaemonClient } from "./connection.js";

type Client = Pick<DaemonClient, "subscribe" | "start" | "stop" | "call"> &
  Partial<Pick<DaemonClient, "onEvent">>;
/** Live socket state already uses immutable updates and needs no query-cache deep comparison. */
export class ConnectionSource {
  private client: Client | undefined;
  private cancelNotification: (() => void) | undefined;
  private unsubscribe: (() => void) | undefined;
  private readonly listeners = new Set<() => void>();
  private readonly eventListeners = new Set<(event: DomainEvent) => void>();
  private stopEvents: (() => void) | undefined;
  private state: ConnectionState = {
    status: "connecting",
    snapshot: { seq: 0, entities: {}, counters: {} },
  };
  constructor(
    private readonly create: () => Client,
    private readonly schedule: (notify: () => void) => () => void = (notify) => {
      // Batch already queued socket messages without waiting for an animation frame.
      const channel = new MessageChannel();
      const close = () => {
        channel.port1.close();
        channel.port2.close();
      };
      channel.port1.onmessage = () => {
        close();
        notify();
      };
      channel.port2.postMessage(null);
      return close;
    },
  ) {}
  getSnapshot = (): ConnectionState => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  connect() {
    this.stop();
    const client = this.create();
    this.client = client;
    this.unsubscribe = client.subscribe((state) => {
      if (this.client !== client || this.state === state) return;
      this.state = state;
      if (!this.cancelNotification)
        this.cancelNotification = this.schedule(() => {
          this.cancelNotification = undefined;
          if (this.client !== client) return;
          for (const listener of this.listeners) listener();
        });
    });
    this.stopEvents = client.onEvent?.((event) => {
      if (this.client !== client) return;
      for (const listener of this.eventListeners) listener(event);
    });
    void client.start();
  }
  /** Survives reconnects; listeners re-read state after the connection comes back online. */
  onEvent = (listener: (event: DomainEvent) => void): (() => void) => {
    this.eventListeners.add(listener);
    return () => {
      this.eventListeners.delete(listener);
    };
  };
  stop() {
    this.cancelNotification?.();
    this.cancelNotification = undefined;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.stopEvents?.();
    this.stopEvents = undefined;
    this.client?.stop();
    this.client = undefined;
  }
  call(method: string, params: unknown, commandId?: string): Promise<unknown> {
    return (
      this.client?.call(method, params, commandId) ??
      Promise.reject(new Error("Daemon unavailable"))
    );
  }
}
