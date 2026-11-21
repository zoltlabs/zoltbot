// I1: keeps each enabled bridge connected. A dropped or failed connection retries with backoff;
// a failure the owner must fix (a refused token, no saved token) stops until the bridge changes.
import type { BridgeProblem } from "@zoltbot/protocol";
import { type BridgeAdapter, type InboundMessage, problemOf } from "./adapter.js";

export interface SupervisedBridge {
  id: string;
  enabled: boolean;
  /** Anything that needs a new connection when it changes: the kind, the token reference. */
  fingerprint: string;
}

export type SupervisorStatus =
  | { state: "connected"; account?: string }
  | { state: "reconnecting"; problem: BridgeProblem }
  | { state: "stopped"; problem?: BridgeProblem };

interface Timers {
  set(run: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}
const realTimers: Timers = {
  set: (run, ms) => {
    const handle = setTimeout(run, ms);
    handle.unref?.();
    return handle;
  },
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

interface Running {
  fingerprint: string;
  adapter?: BridgeAdapter | undefined;
  attempt: number;
  timer?: unknown;
  /** Bumped on stop or restart, so a late result from an old connection is ignored. */
  generation: number;
}

export function bridgeSupervisor(options: {
  create(id: string): Promise<BridgeAdapter>;
  onStatus(id: string, status: SupervisorStatus): void;
  onMessage(id: string, message: InboundMessage): void;
  /** First retry after this many ms, doubling to `maxMs`. */
  initialMs?: number;
  maxMs?: number;
  timers?: Timers;
}) {
  const timers = options.timers ?? realTimers;
  const initialMs = options.initialMs ?? 1000;
  const maxMs = options.maxMs ?? 60_000;
  const running = new Map<string, Running>();
  let closed = false;
  let queue: Promise<void> = Promise.resolve();

  const halt = async (entry: Running) => {
    entry.generation += 1;
    if (entry.timer !== undefined) timers.clear(entry.timer);
    entry.timer = undefined;
    const adapter = entry.adapter;
    entry.adapter = undefined;
    await adapter?.stop().catch(() => {});
  };

  const retry = (id: string, entry: Running, problem: BridgeProblem) => {
    if (entry.timer !== undefined) timers.clear(entry.timer);
    const delay = Math.min(maxMs, initialMs * 2 ** Math.min(entry.attempt, 16));
    entry.attempt += 1;
    options.onStatus(id, { state: "reconnecting", problem });
    const generation = entry.generation;
    entry.timer = timers.set(() => {
      entry.timer = undefined;
      if (entry.generation === generation) void connect(id, entry);
    }, delay);
  };

  const connect = async (id: string, entry: Running) => {
    const generation = entry.generation;
    const current = () => !closed && entry.generation === generation && running.get(id) === entry;
    let adapter: BridgeAdapter | undefined;
    try {
      adapter = await options.create(id);
      if (!current()) {
        await adapter.stop().catch(() => {});
        return;
      }
      entry.adapter = adapter;
      adapter.onMessage((message) => {
        if (current()) options.onMessage(id, message);
      });
      adapter.onDisconnect((error) => {
        if (!current() || entry.adapter !== adapter) return;
        entry.adapter = undefined;
        void adapter?.stop().catch(() => {});
        retry(id, entry, problemOf(error));
      });
      await adapter.start();
      // A drop during start already scheduled a retry; this connection is no longer the live one.
      if (!current() || entry.adapter !== adapter) return;
      entry.attempt = 0;
      const account = adapter.account?.();
      options.onStatus(id, { state: "connected", ...(account ? { account } : {}) });
    } catch (error) {
      if (!current() || (adapter && entry.adapter !== adapter)) return;
      if (entry.adapter) await halt(entry).catch(() => {});
      const problem = problemOf(error);
      if (problem === "network") retry(id, entry, problem);
      else options.onStatus(id, { state: "stopped", problem });
    }
  };

  return {
    /** Starts, restarts and stops bridges to match the saved list. */
    sync(bridges: SupervisedBridge[] | (() => SupervisedBridge[])) {
      // One sync at a time, each reading the list when it runs, so a quick second save can't be
      // overtaken by the first one's older token.
      queue = queue.then(() => apply(typeof bridges === "function" ? bridges() : bridges));
      return queue;
    },
    adapter: (id: string) => running.get(id)?.adapter,
    async close() {
      closed = true;
      await queue;
      const entries = [...running.values()];
      running.clear();
      await Promise.all(entries.map(halt));
    },
  };

  async function apply(bridges: SupervisedBridge[]) {
    if (closed) return;
    const wanted = new Map(bridges.filter((bridge) => bridge.enabled).map((b) => [b.id, b]));
    for (const [id, entry] of running) {
      const next = wanted.get(id);
      if (next && next.fingerprint === entry.fingerprint) continue;
      running.delete(id);
      await halt(entry);
      if (!next) options.onStatus(id, { state: "stopped" });
    }
    for (const [id, bridge] of wanted) {
      if (running.has(id)) continue;
      const entry: Running = { fingerprint: bridge.fingerprint, attempt: 0, generation: 0 };
      running.set(id, entry);
      void connect(id, entry);
    }
  }
}
