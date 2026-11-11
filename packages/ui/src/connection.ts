import { type DomainEvent, ItemSchema, parse } from "@zoltbot/protocol";

export interface ConnectionInfo {
  url: string;
  token: string;
}
export interface DesktopDictationStatus {
  available: boolean;
  onDevice: boolean;
  locale: string;
  microphone: "authorized" | "not_determined" | "denied" | "restricted";
  speech: "authorized" | "not_determined" | "denied" | "restricted";
}
export interface DesktopDictationEvent {
  sessionId: string;
  kind: "partial" | "final" | "error" | "stopped";
  text?: string;
  code?: string;
  message?: string;
  reason?: string;
}
export interface DesktopDictationBridge {
  status(params?: { locale?: string }): Promise<DesktopDictationStatus>;
  requestPermission(params?: { locale?: string }): Promise<DesktopDictationStatus>;
  start(options?: {
    locale?: string;
    onDevice?: boolean;
    source?: "pcm16le" | "microphone";
    contextualStrings?: string[];
  }): Promise<{ sessionId: string }>;
  writeAudio(sessionId: string, pcm16le: Uint8Array): void;
  stop(sessionId: string): Promise<void>;
  cancel(sessionId?: string): Promise<void>;
  onEvent(listener: (event: DesktopDictationEvent) => void): () => void;
}
export interface OnlineArtifact {
  id: string;
  visibility: "private" | "public";
  url: string;
}
export interface DesktopBridge {
  account?: {
    status(): Promise<AccountStatus>;
    signIn(): Promise<AccountStatus>;
    signOut(): Promise<void>;
    cancel(): Promise<void>;
    revoke(id: string): Promise<AccountStatus>;
    revokeAll(): Promise<AccountStatus>;
    export(): Promise<unknown>;
    uploadArtifact(input: {
      hash: string;
      title: string;
      orgId: string;
      confirm: true;
    }): Promise<OnlineArtifact>;
    findArtifact(hash: string, title: string): Promise<OnlineArtifact | null>;
    setArtifactVisibility(input: {
      id: string;
      hash: string;
      title: string;
      visibility: "private" | "public";
      confirm: true;
    }): Promise<OnlineArtifact>;
    copyArtifactLink(id: string): Promise<{ url: string }>;
  };
  platform?: string;
  pickViewFolder?(): Promise<string | null>;
  showViewFolder?(input: { id: string; source: "builtin" | "user" }): Promise<void>;
  prepareView?(hash: string): Promise<{ url: string }>;
  prepareArtifact?(hash: string): Promise<{ url: string }>;
  browserEvidence?(id: string): Promise<Uint8Array>;
  visibleThread?(id?: string): void;
  pickFolders?(): Promise<string[]>;
  filePath?(file: File): string;
  openExternal?(url: string): Promise<void>;
  connection(): Promise<ConnectionInfo>;
  onConnectionChanged(listener: () => void): () => void;
  dictation?: DesktopDictationBridge;
}
export interface AccountStatus {
  managementUrl?: string;
  configured: boolean;
  signedIn: boolean;
  account?: {
    user: { id: string; name: string; email: string };
    organizations: { id: string; name: string; role: string }[];
    sessionId: string;
    sessions: { id: string; device_name: string; surface: string; last_seen_at: string }[];
    capabilities?: { privateArtifacts: boolean };
  };
}
declare global {
  interface Window {
    zoltDesktop?: DesktopBridge;
  }
}
export type Snapshot = {
  seq: number;
  entities: Record<string, Record<string, unknown>[]>;
  counters: Record<string, number>;
};
export interface ConnectionState {
  status: "connecting" | "online" | "offline";
  snapshot: Snapshot;
  error?: string;
}
export function applyStreamEvent(snapshot: Snapshot, event: DomainEvent): Snapshot {
  if (event.seq || event.type !== "item.stream") return snapshot;
  const item = parse(ItemSchema, event.payload);
  const existing = snapshot.entities.item?.find((row) => row.id === item.id);
  if (
    !existing ||
    existing.threadId !== item.threadId ||
    existing.turnId !== item.turnId ||
    existing.kind !== item.kind ||
    existing.seq !== item.seq ||
    (existing.body as Record<string, unknown> | undefined)?.streaming !== true ||
    (item.body as Record<string, unknown> | undefined)?.streaming !== true ||
    !snapshot.entities.turn?.some(
      (row) => row.id === item.turnId && row.threadId === item.threadId && row.status === "running",
    )
  )
    return snapshot;
  return {
    ...snapshot,
    entities: {
      ...snapshot.entities,
      item: (snapshot.entities.item ?? []).map((row) => (row.id === item.id ? item : row)),
    },
  };
}
const empty: Snapshot = { seq: 0, entities: {}, counters: {} };
export class DaemonClient {
  private socket: WebSocket | undefined;
  private nextId = 0;
  private stopped = false;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  private readonly listeners = new Set<(state: ConnectionState) => void>();
  /** Unsequenced events such as Quick Chat updates, which are not part of the snapshot. */
  private readonly eventListeners = new Set<(event: DomainEvent) => void>();
  state: ConnectionState = { status: "connecting", snapshot: empty };
  constructor(private readonly getConnection: () => Promise<ConnectionInfo>) {}
  subscribe(listener: (state: ConnectionState) => void) {
    this.listeners.add(listener);
    listener(this.state);
    return () => {
      this.listeners.delete(listener);
    };
  }
  onEvent(listener: (event: DomainEvent) => void) {
    this.eventListeners.add(listener);
    return () => {
      this.eventListeners.delete(listener);
    };
  }
  private publish(next: ConnectionState) {
    this.state = next;
    for (const listener of this.listeners) listener(next);
  }
  async start() {
    if (this.stopped) return;
    this.publish({ ...this.state, status: "connecting" });
    try {
      const connection = await this.getConnection();
      if (this.stopped) return;
      const socket = new WebSocket(connection.url);
      this.socket = socket;
      socket.addEventListener("message", (message) => {
        try {
          if (this.stopped || socket !== this.socket) return;
          const response = JSON.parse(String(message.data));
          if (response.method === "event") {
            this.apply(response.params as DomainEvent);
            for (const listener of this.eventListeners) listener(response.params as DomainEvent);
            return;
          }
          const pending = this.pending.get(response.id);
          if (pending) {
            this.pending.delete(response.id);
            if (response.error) pending.reject(new Error(response.error.message));
            else pending.resolve(response.result);
          }
        } catch {
          this.publish({ ...this.state, error: "The daemon sent an invalid response." });
        }
      });
      socket.addEventListener("close", () => {
        if (socket === this.socket) this.disconnected();
      });
      await new Promise<void>((resolve, reject) => {
        socket.addEventListener("open", () => resolve(), { once: true });
        socket.addEventListener("error", () => reject(new Error("Daemon unavailable")), {
          once: true,
        });
      });
      await this.call("hello", { token: connection.token, protocolVersion: 1 });
      const replay = (await this.call("events.subscribe", {
        fromSeq: this.state.snapshot.seq,
      })) as { seq: number; resync: boolean; events: DomainEvent[] };
      if (replay.resync || this.state.status !== "online") {
        const snapshot = (await this.call("snapshot.get", {})) as Snapshot;
        this.publish({ status: "online", snapshot });
      } else {
        for (const event of replay.events) this.apply(event);
        this.publish({ ...this.state, status: "online" });
      }
    } catch (error) {
      if (!this.stopped)
        this.disconnected(error instanceof Error ? error.message : "Daemon unavailable");
    }
  }
  private apply(event: DomainEvent) {
    const snapshot = this.state.snapshot;
    if (!event.seq && event.type === "item.stream") {
      const next = applyStreamEvent(snapshot, event);
      if (next !== snapshot) this.publish({ ...this.state, snapshot: next });
      return;
    }
    if (!event.seq || event.seq <= snapshot.seq) return;
    const entities = { ...snapshot.entities };
    const body = event.payload as Record<string, unknown>;
    const rows = (entities[event.aggregateType] ?? []).filter(
      (row) =>
        String(event.aggregateType === "compareMember" ? row.threadId : (row.id ?? row.key)) !==
        event.aggregateId,
    );
    entities[event.aggregateType] = [...rows, body];
    this.publish({
      ...this.state,
      snapshot: {
        seq: event.seq,
        entities,
        counters: {
          ...snapshot.counters,
          pendingInteractions: (entities.interaction ?? []).filter((i) => i.state === "pending")
            .length,
        },
      },
    });
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
  private disconnected(error?: string) {
    for (const pending of this.pending.values()) pending.reject(new Error("Daemon unavailable"));
    this.pending.clear();
    if (this.stopped) return;
    this.publish({ status: "offline", snapshot: this.state.snapshot, ...(error ? { error } : {}) });
    clearTimeout(this.retry);
    this.retry = setTimeout(() => {
      void this.start();
    }, 500);
  }
  stop() {
    this.stopped = true;
    clearTimeout(this.retry);
    this.socket?.close();
    for (const p of this.pending.values()) p.reject(new Error("Connection closed"));
    this.pending.clear();
  }
}
