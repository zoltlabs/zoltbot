// R2: a stand-in for the cloud relay's webhook routes, so the daemon side can be tested before the
// relay exists. Nothing here touches the network.
import type { HookCloud, HookRequest } from "../../../packages/daemon/src/webhook-event-source.js";

export function fakeHookCloud(account = { accountId: "account-1", accountLabel: "Test account" }) {
  const hooks = new Map<string, string>();
  const received = new Map<string, HookRequest[]>();
  let next = 1;
  const cloud: HookCloud = {
    async hook(resource) {
      const hookId = hooks.get(resource);
      return hookId ? { ...account, hookId } : undefined;
    },
    async requests(hookId, since) {
      return (received.get(hookId) ?? []).filter((request) => request.receivedAt >= since);
    },
  };
  return {
    cloud,
    /** Creates (or rotates) the address for `resource`; requests to the old one stop arriving. */
    connect(resource: string) {
      const hookId = `hook-${next++}`;
      hooks.set(resource, hookId);
      return hookId;
    },
    /** A request reaching the address, as the relay would store it. */
    receive(resource: string, request: Omit<HookRequest, "id"> & { id?: string }) {
      const hookId = hooks.get(resource);
      if (!hookId) throw new Error("no_hook");
      const row = { id: request.id ?? `request-${next++}`, ...request };
      received.set(hookId, [...(received.get(hookId) ?? []), row]);
      return row;
    },
  };
}
