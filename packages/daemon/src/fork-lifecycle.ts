import type { NativeForkTarget } from "@zoltbot/adapters-sdk";
import type { Store } from "@zoltbot/store";
import { assertForkRunnable } from "./fork-policy.js";
import type { Previous } from "./runtime-configuration.js";
import type { RuntimeWorker } from "./runtime-worker.js";

export type ForkLaunch = {
  source: Previous & { sourceThreadId: string };
  target: NativeForkTarget;
};
export function forkLifecycle(host: {
  store: Store;
  opening: Map<string, Promise<RuntimeWorker>>;
  stopped(): boolean;
  holdSource(id: string): () => void;
  open(id: string, fork: ForkLaunch): Promise<RuntimeWorker>;
  nativeId(id: string): string | undefined;
  track<T>(work: Promise<T>): Promise<T>;
}) {
  const leases = new Set<string>();
  return {
    assertNotLeased(id: string) {
      if (leases.has(id)) throw Error("fork_source_busy");
    },
    assertMutable(id: string) {
      this.assertNotLeased(id);
      assertForkRunnable(host.store.snapshot(["thread", "settings"]), id);
    },
    async withSource<T>(id: string, work: () => Promise<T>): Promise<T> {
      this.assertMutable(id);
      if (host.opening.has(id)) throw Error("fork_source_busy");
      leases.add(id);
      const release = host.holdSource(id);
      try {
        return await work();
      } finally {
        release();
        leases.delete(id);
      }
    },
    async child(id: string, source: ForkLaunch["source"], target: NativeForkTarget) {
      if (host.stopped() || host.opening.has(id)) throw Error("fork_source_busy");
      const work = host.open(id, { source, target }).finally(() => host.opening.delete(id));
      host.opening.set(id, work);
      await host.track(work);
      const nativeId = host.nativeId(id);
      if (!nativeId) throw Error("fork_identity_unavailable");
      return nativeId;
    },
  };
}
