import { methodCatalog } from "@zoltbot/protocol";
import type { ConnectionState } from "../../../../packages/ui/src/connection.js";

export interface CloudAccountBinding {
  userId: string;
  sessionId: string;
  orgId: string;
  name: string;
}
export type ConnectionOwner =
  | { kind: "local" }
  | { kind: "cloud"; orgId: string; sessionId: string };
/** Native ports own transports and credentials; none of those cross renderer IPC. */
export interface NativeConnection {
  subscribe(listener: (state: ConnectionState) => void): () => void;
  start(): Promise<void>;
  stop(): void;
  call(method: string, params: unknown, commandId?: string): Promise<unknown>;
}
export interface OwnedConnectionState {
  owner: ConnectionOwner;
  name: string;
  state: ConnectionState;
  readOnly: boolean;
}
interface Entry extends OwnedConnectionState {
  connection: NativeConnection;
  unsubscribe: () => void;
}
const initial = (): ConnectionState => ({
  status: "connecting",
  snapshot: { seq: 0, entities: {}, counters: {} },
});

/** Main-process selection. A Local call never falls back to an org connection. */
export function connectionManager(options: {
  local(): NativeConnection;
  cloud(account: Readonly<CloudAccountBinding>): NativeConnection;
}) {
  const listeners = new Set<(states: OwnedConnectionState[]) => void>();
  let local: Entry | undefined,
    cloud: Entry | undefined,
    account: CloudAccountBinding | undefined,
    closed = false;
  const states = () =>
    structuredClone(
      [local, cloud]
        .filter((entry): entry is Entry => !!entry)
        .map((entry) => ({
          owner: entry.owner,
          name: entry.name,
          state: entry.state,
          readOnly: entry.readOnly,
        })),
    );
  const notify = () => {
    for (const listener of listeners) listener(states());
  };
  const dispose = (entry: Entry | undefined) => {
    if (!entry) return;
    entry.unsubscribe();
    entry.connection.stop();
    // The previous account's display cache must be unreachable before replacement starts.
    entry.state = initial();
  };
  const attach = (entry: Entry, current: () => boolean) => {
    entry.unsubscribe = entry.connection.subscribe((state) => {
      if (!current() || closed) return;
      if (entry.owner.kind === "cloud" && state.error === "unauthorized") {
        cloud = undefined;
        account = undefined;
        dispose(entry);
        notify();
        return;
      }
      entry.state = structuredClone(state);
      entry.readOnly = entry.owner.kind === "cloud" && state.status !== "online";
      notify();
    });
    if (!current() || closed) {
      entry.unsubscribe();
      return;
    }
    // Transports report fixed errors and offline state through subscribe.
    void entry.connection.start().catch(() => {
      if (!current() || closed) return;
      entry.state = { ...entry.state, status: "offline", error: "connection_unavailable" };
      entry.readOnly = entry.owner.kind === "cloud";
      notify();
    });
  };
  const requireEntry = (owner: ConnectionOwner): Entry => {
    if (closed) throw new Error("connection_closed");
    if (owner.kind === "local") {
      if (!local) throw new Error("connection_unavailable");
      return local;
    }
    if (
      !account ||
      !cloud ||
      owner.sessionId !== account.sessionId ||
      owner.orgId !== account.orgId
    )
      throw new Error("account_session_changed");
    if (cloud.readOnly || cloud.state.status !== "online") throw new Error("cloud_offline");
    return cloud;
  };
  const localConnection = options.local();
  local = {
    connection: localConnection,
    owner: { kind: "local" },
    name: "This Mac",
    state: initial(),
    readOnly: false,
    unsubscribe() {},
  };
  const ownedLocal = local;
  attach(ownedLocal, () => local === ownedLocal);
  return Object.freeze({
    states,
    subscribe(listener: (states: OwnedConnectionState[]) => void) {
      listeners.add(listener);
      listener(states());
      return () => {
        listeners.delete(listener);
      };
    },
    /** Call only after native account/membership validation and explicit Cloud opt-in. */
    setAccount(next?: CloudAccountBinding) {
      if (closed) throw new Error("connection_closed");
      if (
        next &&
        account &&
        next.userId === account.userId &&
        next.sessionId === account.sessionId &&
        next.orgId === account.orgId &&
        next.name === account.name
      )
        return;
      const previous = cloud;
      cloud = undefined;
      account = undefined;
      dispose(previous);
      notify();
      if (!next) return;
      const binding = Object.freeze({ ...next });
      // The factory may hold native credentials. Do not expose it through states().
      const connection = options.cloud(binding);
      account = binding;
      const entry: Entry = {
        connection,
        owner: { kind: "cloud", orgId: binding.orgId, sessionId: binding.sessionId },
        name: binding.name,
        state: initial(),
        readOnly: true,
        unsubscribe() {},
      };
      cloud = entry;
      attach(entry, () => cloud === entry);
      notify();
    },
    async call(owner: ConnectionOwner, method: string, params: unknown, commandId?: string) {
      const entry = requireEntry(owner),
        definition = methodCatalog[method as keyof typeof methodCatalog];
      if (
        !Object.hasOwn(methodCatalog, method) ||
        !definition ||
        definition.where === (owner.kind === "local" ? "cloud" : "local")
      )
        throw new Error("method_unavailable");
      // Capture caller-owned input before an asynchronous transport can observe edits.
      const result = await entry.connection.call(method, structuredClone(params), commandId);
      if (closed || (owner.kind === "local" ? local !== entry : cloud !== entry))
        throw new Error("account_session_changed");
      return structuredClone(result);
    },
    close() {
      if (closed) return;
      closed = true;
      const previousLocal = local,
        previousCloud = cloud;
      local = undefined;
      cloud = undefined;
      account = undefined;
      dispose(previousCloud);
      dispose(previousLocal);
      notify();
      listeners.clear();
    },
  });
}
