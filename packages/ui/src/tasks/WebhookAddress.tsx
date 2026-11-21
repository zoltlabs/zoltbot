// R2: a web-address routine's address, with Copy, Send test and Rotate. The address is made the
// first time it's asked for and kept on this Mac; it's only fetched when the owner asks.
import type { Routine } from "@zoltbot/protocol";
import { useId, useState } from "react";
import type { ChatConnection } from "../chat/types.js";
import { Button, Dialog } from "../components/primitives.js";

type Address = { state: "ready"; url: string } | { state: "elsewhere" };

function addressError(error: unknown) {
  const message = error instanceof Error ? error.message : "";
  if (/sign_in_required|webhook_sign_in_required|accounts_not_configured/.test(message))
    return "Sign in to your Zoltbot account to use web addresses.";
  if (message.includes("webhook_test_rate_limited"))
    return "This web address has had too many requests. Try again in a minute.";
  if (message.includes("webhook_address_missing"))
    return "Get the web address first, then send a test.";
  if (message.includes("webhook_test_failed"))
    return "The test didn't reach the web address. Try again.";
  if (message.includes("too_many_hooks") || message.includes("keychain_unavailable"))
    return "Couldn't save the web address on this Mac. Try again.";
  return "Couldn't reach your Zoltbot account. Try again.";
}

export function WebhookAddress({
  connection,
  routine,
  onChanged,
}: {
  connection: ChatConnection;
  routine: Routine;
  /** After a new address: the routine checks and binds to it, and stays paused. */
  onChanged(): void;
}) {
  const [address, setAddress] = useState<Address>();
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [confirm, setConfirm] = useState(false);
  const label = useId();
  const online = connection.status === "online";

  // Buttons stay enabled while busy, so focus never drops to the page.
  async function run(work: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError("");
    setStatus("");
    try {
      await work();
    } catch (failure) {
      setError(addressError(failure));
    } finally {
      setBusy(false);
    }
  }
  const get = (rotate: boolean) =>
    run(async () => {
      const result = (await connection.call(
        "routine.webhookAddress",
        { id: routine.id, ...(rotate ? { rotate: true } : {}) },
        crypto.randomUUID(),
      )) as Address;
      setAddress(result);
      if (result.state === "ready" && (rotate || !routine.event?.accountId)) onChanged();
      if (rotate) setStatus("New web address ready. Preview and enable the routine to use it.");
    });

  return (
    <section className="webhook-address" aria-labelledby={label}>
      <h3 id={label}>Web address</h3>
      {address?.state === "ready" ? (
        <input
          className="webhook-address-url"
          readOnly
          value={address.url}
          aria-labelledby={label}
          onFocus={(event) => event.currentTarget.select()}
        />
      ) : address?.state === "elsewhere" ? (
        <p>This web address was made on another Mac. Rotate it to use it here.</p>
      ) : null}
      <div className="task-actions">
        {!address ? (
          <Button disabled={!online} onClick={() => get(false)}>
            {routine.event?.accountId ? "Show web address" : "Get web address"}
          </Button>
        ) : null}
        {address?.state === "ready" ? (
          <>
            <Button
              onClick={() =>
                run(async () => {
                  await navigator.clipboard.writeText(address.url);
                  setStatus("Web address copied.");
                })
              }
            >
              Copy web address
            </Button>
            <Button
              disabled={!online}
              onClick={() =>
                run(async () => {
                  await connection.call(
                    "routine.webhookTest",
                    { id: routine.id },
                    crypto.randomUUID(),
                  );
                  setStatus("Test request sent.");
                })
              }
            >
              Send test request
            </Button>
          </>
        ) : null}
        {address ? (
          <Button disabled={!online} onClick={() => setConfirm(true)}>
            Rotate web address…
          </Button>
        ) : null}
      </div>
      <output aria-live="polite">{status}</output>
      {error ? <p role="alert">{error}</p> : null}
      <Dialog
        open={confirm}
        title="Rotate web address?"
        description="The old address stops working, and the routine stays paused until you preview and enable it again."
        onClose={() => setConfirm(false)}
        actions={
          <>
            <Button onClick={() => setConfirm(false)}>Cancel</Button>
            <Button
              variant="primary"
              onClick={() => {
                setConfirm(false);
                void get(true);
              }}
            >
              Rotate
            </Button>
          </>
        }
      />
    </section>
  );
}
