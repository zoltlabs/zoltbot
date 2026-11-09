import type { DomainEvent } from "@zoltbot/protocol";
import { applyStreamEvent } from "@zoltbot/ui/connection";
import { createStore, type StoreApi } from "zustand/vanilla";
import type { LinkStatus, Row, Snapshot, Transport } from "./transport.js";

export interface ClientState {
  kind: Transport["kind"];
  status: LinkStatus;
  /** True once a snapshot arrived, so lists can show saved data while offline. */
  loaded: boolean;
  snapshot: Snapshot;
  lastSeenAt?: string;
  error?: string;
  confirmCode?: string;
  call(method: string, params: unknown, commandId?: string): Promise<unknown>;
}
export type Client = StoreApi<ClientState> & {
  stop(): void;
  /** Unsequenced events such as Quick Chat updates, which are not part of the snapshot. */
  onEvent(listener: (event: DomainEvent) => void): () => void;
};

const empty: Snapshot = { seq: 0, entities: {}, counters: {} };
export const offlineReason = (status: LinkStatus) =>
  status === "offline"
    ? "You are offline."
    : status === "mac_offline"
      ? "Your Mac is offline."
      : "Not connected yet.";

/** Same rules as the desktop DaemonClient: entity events replace the row by id, in seq order. */
export function applyEvent(snapshot: Snapshot, event: DomainEvent): Snapshot {
  if (!event.seq && event.type === "item.stream") return applyStreamEvent(snapshot, event);
  if (!event.seq || event.seq <= snapshot.seq) return snapshot;
  const entities = { ...snapshot.entities };
  const rows = (entities[event.aggregateType] ?? []).filter(
    (row) =>
      String(event.aggregateType === "compareMember" ? row.threadId : (row.id ?? row.key)) !==
      event.aggregateId,
  );
  entities[event.aggregateType] = [...rows, event.payload as Row];
  return {
    seq: event.seq,
    entities,
    counters: {
      ...snapshot.counters,
      pendingInteractions: (entities.interaction ?? []).filter((i) => i.state === "pending").length,
    },
  };
}

export function createClient(transport: Transport): Client {
  let stopped = false;
  const listeners = new Set<(event: DomainEvent) => void>();
  let syncing: Promise<void> | undefined;
  const store = createStore<ClientState>((_, get) => ({
    kind: transport.kind,
    status: "connecting",
    loaded: false,
    snapshot: empty,
    call(method, params, commandId) {
      const { status } = get();
      if (status !== "online") return Promise.reject(new Error(offlineReason(status)));
      return transport.call(method, params, commandId);
    },
  }));
  const sync = async () => {
    const state = store.getState();
    const replay = (await transport.call("events.subscribe", {
      fromSeq: state.snapshot.seq,
    })) as { seq: number; resync: boolean; events: DomainEvent[] };
    if (replay.resync || !state.loaded) {
      const snapshot = (await transport.call("snapshot.get", {})) as Snapshot;
      store.setState({ snapshot, loaded: true });
    } else {
      let snapshot = store.getState().snapshot;
      for (const event of replay.events) snapshot = applyEvent(snapshot, event);
      store.setState({ snapshot });
    }
  };
  transport.start({
    status(status, detail) {
      if (stopped) return;
      if (status !== "online") {
        store.setState({ status, ...detail });
        return;
      }
      // Stay "connecting" until the snapshot is in, so screens never act on stale ids.
      store.setState({ status: "connecting", error: undefined });
      if (syncing) return;
      syncing = sync()
        .then(() => {
          if (!stopped) store.setState({ status: "online", confirmCode: undefined });
        })
        .catch((error: unknown) => {
          if (!stopped)
            store.setState({
              status: "offline",
              error: error instanceof Error ? error.message : "Could not load your work.",
            });
        })
        .finally(() => {
          syncing = undefined;
        });
    },
    event(event) {
      if (stopped) return;
      const snapshot = store.getState().snapshot;
      const next = applyEvent(snapshot, event);
      if (next !== snapshot) store.setState({ snapshot: next });
      for (const listener of listeners) listener(event);
    },
    confirmCode(code) {
      if (!stopped) store.setState({ confirmCode: code });
    },
  });
  return Object.assign(store, {
    stop() {
      stopped = true;
      transport.stop();
    },
    onEvent(listener: (event: DomainEvent) => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  });
}
