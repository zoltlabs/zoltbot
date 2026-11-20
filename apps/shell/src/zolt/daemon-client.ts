import { type DomainEvent, ItemSchema, parse } from "@zoltbot/protocol";
import WebSocket from "ws";

export type Row = Record<string, unknown>;
export interface Snapshot {
  seq: number;
  entities: Record<string, Row[]>;
  counters: Record<string, number>;
}
export interface DaemonConnectionInfo {
  url: string;
  token: string;
}
export type DaemonStatus = "connecting" | "online" | "offline";

const EMPTY: Snapshot = { seq: 0, entities: {}, counters: {} };
const THREAD_CHILDREN = [
  "item",
  "turn",
  "session",
  "interaction",
  "wake",
  "orchestration",
  "contextPack",
  "compareMember",
];

/**
 * Keeps one daemon connection and an in-memory copy of its snapshot for Electron main.
 * Streamed item updates replace the item in place; sequenced events replace whole rows.
 */
export class DaemonClient {
  snapshot: Snapshot = EMPTY;
  status: DaemonStatus = "connecting";
  error: string | undefined;
  private socket: WebSocket | undefined;
  private nextId = 0;
  private stopped = false;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  private readonly listeners = new Set<(change: SnapshotChange) => void>();

  constructor(private readonly connection: () => Promise<DaemonConnectionInfo>) {}

  onChange(listener: (change: SnapshotChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Reads an artifact file the daemon serves over HTTP on the loopback address. */
  async fetchAsset(kind: "blob" | "manifest", hash: string, limit: number): Promise<Uint8Array> {
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error("artifact_asset_invalid");
    const info = await this.connection();
    const url = new URL(info.url.replace(/^ws:/, "http:"));
    if (url.hostname !== "127.0.0.1") throw new Error("invalid_daemon_address");
    url.pathname = `/artifact-${kind}/${hash}`;
    url.search = "";
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${info.token}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error("artifact_unavailable");
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length > limit) throw new Error("artifact_too_large");
    return bytes;
  }

  rows(kind: string): Row[] {
    return this.snapshot.entities[kind] ?? [];
  }

  async start(): Promise<void> {
    if (this.stopped) return;
    this.setStatus("connecting");
    try {
      const info = await this.connection();
      if (this.stopped) return;
      const socket = new WebSocket(info.url);
      this.socket = socket;
      socket.on("message", (data) => {
        if (this.stopped || socket !== this.socket) return;
        this.receive(String(data));
      });
      socket.on("close", () => {
        if (socket === this.socket) this.disconnected();
      });
      await new Promise<void>((resolve, reject) => {
        socket.once("open", () => resolve());
        socket.once("error", () => reject(new Error("Daemon unavailable")));
      });
      await this.call("hello", { token: info.token, protocolVersion: 1 });
      const replay = (await this.call("events.subscribe", { fromSeq: this.snapshot.seq })) as {
        resync: boolean;
        events: DomainEvent[];
      };
      if (replay.resync || this.status !== "online") {
        const snapshot = (await this.call("snapshot.get", {})) as Snapshot;
        this.snapshot = snapshot;
        this.status = "online";
        this.error = undefined;
        this.emit({ kind: "reset" });
      } else {
        for (const event of replay.events) this.apply(event);
        this.setStatus("online");
      }
    } catch (error) {
      if (!this.stopped)
        this.disconnected(error instanceof Error ? error.message : "Daemon unavailable");
    }
  }

  call(method: string, params: unknown, commandId?: string): Promise<unknown> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN)
      return Promise.reject(new Error("Daemon unavailable"));
    const id = ++this.nextId;
    const request = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
    socket.send(
      JSON.stringify({ jsonrpc: "2.0", id, method, params, ...(commandId ? { commandId } : {}) }),
    );
    return request;
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.retry);
    this.socket?.terminate();
    for (const pending of this.pending.values()) pending.reject(new Error("Connection closed"));
    this.pending.clear();
  }

  /** Applies a daemon message. Public so tests can feed events without a socket. */
  receive(raw: string): void {
    let message: {
      id?: number;
      method?: string;
      params?: unknown;
      result?: unknown;
      error?: { message: string };
    };
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    if (message.method === "event") {
      this.apply(message.params as DomainEvent);
      return;
    }
    if (typeof message.id !== "number") return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.error) pending.reject(new Error(message.error.message));
    else pending.resolve(message.result);
  }

  private apply(event: DomainEvent): void {
    const snapshot = this.snapshot;
    if (!event.seq) {
      if (event.type !== "item.stream") return;
      const item = parse(ItemSchema, event.payload) as Row;
      const rows = snapshot.entities.item ?? [];
      const index = rows.findIndex((row) => row.id === item.id);
      if (index < 0) return;
      const next = rows.slice();
      next[index] = item;
      this.snapshot = { ...snapshot, entities: { ...snapshot.entities, item: next } };
      this.emit({ kind: "rows", aggregateType: "item", rows: [item], streamed: true });
      return;
    }
    if (event.seq <= snapshot.seq) return;
    const entities = { ...snapshot.entities };
    if (event.type === "thread.deleted") {
      entities.thread = (entities.thread ?? []).filter((row) => row.id !== event.aggregateId);
      for (const kind of THREAD_CHILDREN)
        if (entities[kind])
          entities[kind] = entities[kind].filter((row) => row.threadId !== event.aggregateId);
      this.snapshot = { seq: event.seq, entities, counters: counters(entities) };
      this.emit({ kind: "reset" });
      return;
    }
    const body = event.payload as Row;
    const key = (row: Row) =>
      String(event.aggregateType === "compareMember" ? row.threadId : (row.id ?? row.key));
    const rows = entities[event.aggregateType] ?? [];
    const index = rows.findIndex((row) => key(row) === event.aggregateId);
    const next = rows.slice();
    if (index < 0) next.push(body);
    else next[index] = body;
    entities[event.aggregateType] = next;
    this.snapshot = { seq: event.seq, entities, counters: counters(entities) };
    this.emit({ kind: "rows", aggregateType: event.aggregateType, rows: [body], streamed: false });
  }

  private setStatus(status: DaemonStatus, error?: string): void {
    this.status = status;
    this.error = error;
    this.emit({ kind: "status" });
  }

  private emit(change: SnapshotChange): void {
    for (const listener of this.listeners) listener(change);
  }

  private disconnected(error?: string): void {
    for (const pending of this.pending.values()) pending.reject(new Error("Daemon unavailable"));
    this.pending.clear();
    if (this.stopped) return;
    this.setStatus("offline", error);
    clearTimeout(this.retry);
    this.retry = setTimeout(() => void this.start(), 500);
  }
}

export type SnapshotChange =
  | { kind: "reset" }
  | { kind: "status" }
  | { kind: "rows"; aggregateType: string; rows: Row[]; streamed: boolean };

function counters(entities: Record<string, Row[]>): Record<string, number> {
  return {
    pendingInteractions: (entities.interaction ?? []).filter((row) => row.state === "pending")
      .length,
  };
}
