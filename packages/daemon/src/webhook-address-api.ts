// R2: the editor's Copy, Rotate and Send test for a routine's web address. These run only for
// the owner on this Mac: phones are refused before dispatch and agent tools can't name them.
import { eventRoutine } from "@zoltbot/core";
import type { Store } from "@zoltbot/store";
import type { HookCloud } from "./webhook-event-source.js";

const methods = new Set(["routine.webhookAddress", "routine.webhookTest"]);
/** Seconds between test requests to one routine. */
const TEST_COOLDOWN = 10;
/** Recent results by command id, so a retried rotate doesn't make a second address. */
const REMEMBERED = 50;

export function webhookAddressApi(options: {
  store: Store;
  hookCloud: HookCloud | undefined;
  /** Binds the routine to its current address, which pauses it until it's enabled again. */
  rebind(id: string, revision: number, commandId: string): Promise<unknown>;
  now?: () => number;
}) {
  const now = options.now ?? Date.now;
  const tested = new Map<string, number>();
  const results = new Map<string, Promise<unknown>>();
  async function run(method: string, params: Record<string, unknown>, commandId: string) {
    const routine = eventRoutine(options.store.snapshot(), String(params.id));
    const source = routine.event.source;
    if (source.kind !== "webhook.received") throw new Error("webhook_routine_required");
    const cloud = options.hookCloud;
    if (!cloud?.address || !cloud.test) throw new Error("webhook_sign_in_required");
    if (method === "routine.webhookTest") {
      const last = tested.get(routine.id);
      if (last !== undefined && now() - last < TEST_COOLDOWN * 1000)
        throw new Error("webhook_test_rate_limited");
      tested.set(routine.id, now());
      await cloud.test(source.resource);
      return { ok: true };
    }
    if (params.rotate !== undefined && typeof params.rotate !== "boolean")
      throw new Error("invalid_params");
    const rotate = params.rotate === true;
    const found = await cloud.address(source.resource, { rotate });
    // A new address, or one the routine hasn't been bound to yet: bind it in the same command.
    if (found.state === "ready" && (rotate || !routine.event.accountId))
      await options.rebind(routine.id, routine.event.revision, `${commandId}:bind`);
    return found;
  }
  return {
    handles: (method: string) => methods.has(method),
    api(method: string, params: Record<string, unknown>, commandId?: string) {
      if (!commandId) throw new Error("command_id_required");
      const key = `${method}:${commandId}`;
      const known = results.get(key);
      if (known) return known;
      const result = run(method, params, commandId);
      results.set(key, result);
      result.catch(() => results.delete(key));
      if (results.size > REMEMBERED) results.delete(results.keys().next().value as string);
      return result;
    },
  };
}
