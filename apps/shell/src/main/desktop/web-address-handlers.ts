// R2: Copy, Send test and Rotate for a routine's web address, on the Routines page. The address
// goes straight to the clipboard from here; the page never holds it.
import { ROUTINE_CHANNELS } from "../../shared/routines";

type Client = { call(method: string, params: unknown, commandId?: string): Promise<unknown> };
type Address = { state: "ready"; url: string } | { state: "elsewhere" };

/** A short code the page turns into words. */
function code(error: unknown) {
  const message = error instanceof Error ? error.message : "";
  if (/sign_in_required|webhook_sign_in_required|accounts_not_configured/.test(message))
    return "web_address_sign_in";
  if (message.includes("webhook_test_rate_limited")) return "web_address_busy";
  if (message.includes("webhook_test_failed")) return "web_address_test_failed";
  if (message.includes("webhook_address_missing")) return "web_address_missing";
  return "web_address_failed";
}

export function webAddressHandlers(options: {
  client: Client;
  copy(text: string): void;
  commandId(): string;
}): Record<string, (input: unknown) => unknown> {
  const { client } = options;
  return {
    [ROUTINE_CHANNELS.routinesWebAddress]: async (input) => {
      const { id, action } = (input ?? {}) as { id?: unknown; action?: unknown };
      if (typeof id !== "string" || !["copy", "test", "rotate"].includes(String(action)))
        throw new Error("Invalid request.");
      try {
        if (action === "test") {
          await client.call("routine.webhookTest", { id }, options.commandId());
          return { state: "sent" };
        }
        const rotate = action === "rotate";
        const found = (await client.call(
          "routine.webhookAddress",
          { id, ...(rotate ? { rotate: true } : {}) },
          options.commandId(),
        )) as Address;
        if (found.state !== "ready") return { state: "elsewhere" };
        // The daemon has already bound the routine to a new address.
        options.copy(found.url);
        return { state: rotate ? "rotated" : "copied" };
      } catch (error) {
        throw new Error(code(error));
      }
    },
  };
}
