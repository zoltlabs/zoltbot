// R2: the editor's Copy, Rotate and Send test for a routine's web address. These run only for
// the owner on this Mac: agents and phones never see an address.
import { eventRoutine } from "@zoltbot/core";
import type { Store } from "@zoltbot/store";
import type { HookCloud } from "./webhook-event-source.js";

const methods = new Set(["routine.webhookAddress", "routine.webhookTest"]);

export function webhookAddressApi(options: { store: Store; hookCloud: HookCloud | undefined }) {
  return {
    handles: (method: string) => methods.has(method),
    async api(method: string, params: Record<string, unknown>) {
      const routine = eventRoutine(options.store.snapshot(), String(params.id));
      const source = routine.event?.source;
      if (source?.kind !== "webhook.received") throw new Error("webhook_routine_required");
      const cloud = options.hookCloud;
      if (!cloud?.address || !cloud.test) throw new Error("webhook_sign_in_required");
      if (method === "routine.webhookTest") {
        await cloud.test(source.resource);
        return { ok: true };
      }
      if (params.rotate !== undefined && typeof params.rotate !== "boolean")
        throw new Error("invalid_params");
      return cloud.address(source.resource, { rotate: params.rotate === true });
    },
  };
}
