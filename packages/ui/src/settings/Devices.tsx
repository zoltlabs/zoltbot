import { useEffect, useId, useMemo, useState } from "react";
import type { Row } from "../chat/types.js";
import { Button, Card, Field, Input } from "../components/primitives.js";
import { deviceError, deviceRows, lastSeen, qrPath, spacedCode } from "./devices-view.js";
import "./devices.css";

type Call = (method: string, params: unknown, commandId?: string) => Promise<unknown>;
interface Offer {
  url: string;
  expiresAt: string;
}

function PairingCode({ offer }: { offer: Offer }) {
  const { path, size } = useMemo(() => qrPath(offer.url), [offer.url]);
  const minutes = Math.max(1, Math.round((Date.parse(offer.expiresAt) - Date.now()) / 60_000));
  return (
    <figure className="device-qr" data-pairing-url={offer.url}>
      <svg
        viewBox={`0 0 ${size} ${size}`}
        role="img"
        aria-label="Pairing QR code"
        shapeRendering="crispEdges"
      >
        <rect width={size} height={size} className="device-qr-light" />
        <path d={path} className="device-qr-dark" />
      </svg>
      <figcaption className="settings-hint">
        Scan this code with the Zoltbot app on your phone. It works once and expires in {minutes}{" "}
        min.
      </figcaption>
    </figure>
  );
}

export function Devices({
  call,
  devices,
  relayUrl,
  online,
}: {
  call: Call;
  devices: readonly Row[];
  relayUrl: string;
  online: boolean;
}) {
  const id = useId();
  const [address, setAddress] = useState(relayUrl);
  const [offer, setOffer] = useState<Offer>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [removing, setRemoving] = useState<string>();
  // The build's relay, used when no address is set here.
  const [defaultRelay, setDefaultRelay] = useState<string>();
  const { pending, paired } = deviceRows(devices);
  useEffect(() => setAddress(relayUrl), [relayUrl]);
  useEffect(() => {
    if (!online) return;
    let current = true;
    call("device.relay", {})
      .then((result) => {
        if (current) setDefaultRelay((result as { defaultUrl?: string }).defaultUrl);
      })
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [call, online]);
  // A phone answered the code, so the code has done its job.
  useEffect(() => {
    if (pending.length) setOffer(undefined);
  }, [pending.length]);
  useEffect(() => {
    if (!offer) return;
    const timer = setTimeout(() => setOffer(undefined), Date.parse(offer.expiresAt) - Date.now());
    return () => clearTimeout(timer);
  }, [offer]);

  async function run(work: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (failure) {
      setError(deviceError(failure));
    } finally {
      setBusy(false);
    }
  }
  const disabled = busy || !online;
  return (
    <section className="zb-card settings-panel devices" aria-labelledby={`${id}-title`}>
      <div>
        <h2 id={`${id}-title`}>Devices</h2>
        <p className="settings-hint">
          Use Zoltbot from your phone. Messages pass through the relay encrypted, so the relay
          cannot read them.
        </p>
      </div>
      <form
        className="device-relay"
        onSubmit={(event) => {
          event.preventDefault();
          void run(async () => {
            await call(
              "settings.set",
              { key: "link.relayUrl", value: address.trim() },
              crypto.randomUUID(),
            );
          });
        }}
      >
        <Field label="Relay address">
          <Input
            type="url"
            value={address}
            placeholder={defaultRelay ?? "wss://relay.example.com"}
            spellCheck={false}
            onChange={(event) => setAddress(event.target.value)}
          />
        </Field>
        <Button type="submit" disabled={disabled || address.trim() === relayUrl}>
          Save address
        </Button>
      </form>
      <p className="settings-hint device-relay-hint">
        {defaultRelay
          ? "Leave it empty to use Zoltbot's relay, or enter your own."
          : "Leave it empty to turn the phone link off."}
      </p>
      {error ? (
        <p className="device-error" role="alert">
          {error}
        </p>
      ) : null}
      {pending.map((device) => (
        <Card
          key={device.id}
          tone="attention"
          className="device-pending"
          aria-labelledby={`${id}-${device.id}`}
        >
          <h3 id={`${id}-${device.id}`}>Allow {device.name}?</h3>
          <p className="settings-hint">Check that your phone shows the same code.</p>
          <output className="device-code" aria-label="Matching code">
            {spacedCode(device.confirmCode)}
          </output>
          <div className="device-actions">
            <Button
              variant="primary"
              disabled={disabled}
              onClick={() =>
                run(async () => {
                  await call(
                    "device.pair.confirm",
                    { id: device.id, allow: true, confirmed: true },
                    crypto.randomUUID(),
                  );
                })
              }
            >
              Allow
            </Button>
            <Button
              disabled={disabled}
              onClick={() =>
                run(async () => {
                  await call(
                    "device.pair.confirm",
                    { id: device.id, allow: false, confirmed: true },
                    crypto.randomUUID(),
                  );
                })
              }
            >
              Deny
            </Button>
          </div>
        </Card>
      ))}
      {offer && !pending.length ? (
        <div className="device-offer">
          <PairingCode offer={offer} />
          <Button onClick={() => setOffer(undefined)}>Cancel</Button>
        </div>
      ) : (
        <div className="device-actions">
          <Button
            variant="primary"
            icon="Plus"
            disabled={disabled || !(relayUrl || defaultRelay) || pending.length > 0}
            onClick={() =>
              run(async () => {
                setOffer((await call("device.pair.start", {})) as Offer);
              })
            }
          >
            Pair a phone
          </Button>
        </div>
      )}
      {paired.length ? (
        <ul className="device-list" aria-label="Paired phones">
          {paired.map((device) => (
            <li key={device.id} className="device-row">
              <div>
                <span className="device-name">{device.name}</span>
                <span className="settings-hint">{lastSeen(device.lastSeenAt)}</span>
              </div>
              {removing === device.id ? (
                <div className="device-actions">
                  <span className="settings-hint">It loses access at once.</span>
                  <Button
                    variant="danger"
                    disabled={disabled}
                    onClick={() =>
                      run(async () => {
                        await call(
                          "device.revoke",
                          { id: device.id, confirmed: true },
                          crypto.randomUUID(),
                        );
                        setRemoving(undefined);
                      })
                    }
                  >
                    Remove {device.name}
                  </Button>
                  <Button onClick={() => setRemoving(undefined)}>Keep</Button>
                </div>
              ) : (
                <Button disabled={disabled} onClick={() => setRemoving(device.id)}>
                  Remove
                </Button>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="settings-hint">No phones paired yet.</p>
      )}
    </section>
  );
}
