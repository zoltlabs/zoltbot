import { useEffect, useId, useState } from "react";
import { Button, Field, Input } from "../components/primitives.js";

type Call = (method: string, params: unknown, commandId?: string) => Promise<unknown>;
export function ConnectionSignIn({
  connectionId,
  call,
  onConnected,
  service,
}: {
  connectionId: string;
  call: Call;
  onConnected(): void;
  service?: string | undefined;
}) {
  const id = useId();
  const [issuer, setIssuer] = useState("");
  const [clientId, setClientId] = useState("");
  const [authorizationEndpoint, setAuthorization] = useState("");
  const [tokenEndpoint, setToken] = useState("");
  const [scopes, setScopes] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [pending, setPending] = useState<{ id: string; authorizationUrl: string }>();
  const [state, setState] = useState("idle");
  useEffect(() => {
    if (!pending || state !== "waiting") return;
    const timer = setInterval(() => {
      void call("connection.auth.status", { id: pending.id })
        .then((result) => {
          const next = (result as { state: string }).state;
          setState(next);
          if (next === "connected") onConnected();
        })
        .catch(() => setState("failed"));
    }, 1000);
    return () => {
      clearInterval(timer);
      void call("connection.auth.cancel", { id: pending.id }, crypto.randomUUID()).catch(() => {});
    };
  }, [pending, call, state, onConnected]);
  return (
    <details>
      <summary>Sign in / reconnect</summary>
      {service ? (
        <p>
          Reconnect {service} in your browser. This clears profile access so you can review the
          account and grant access again. Running sessions may still hold their previous credential.
        </p>
      ) : (
        <p>
          A pre-registered public OAuth client is required. Use the exact endpoints and scopes
          supplied by the service. No client secret is stored here.
        </p>
      )}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!confirmed || state === "waiting") return;
          setState("starting");
          void (async () => {
            const origins = service
              ? []
              : [
                  ...new Set(
                    [issuer, authorizationEndpoint, tokenEndpoint].map(
                      (url) => new URL(url).origin,
                    ),
                  ),
                ];
            const result = await call(
              "connection.auth.start",
              {
                id: connectionId,
                confirmed,
                ...(service
                  ? {}
                  : {
                      configuration: {
                        issuer,
                        clientId,
                        authorizationEndpoint,
                        tokenEndpoint,
                        scopes: scopes.split(/\s+/).filter(Boolean),
                        origins,
                      },
                    }),
              },
              crypto.randomUUID(),
            );
            setPending(result as { id: string; authorizationUrl: string });
            setState("waiting");
          })().catch(() => setState("failed"));
        }}
      >
        {!service ? (
          <>
            <Field label="Issuer">
              <Input
                type="url"
                required
                value={issuer}
                onChange={(e) => setIssuer(e.target.value)}
              />
            </Field>
            <Field label="Public client ID">
              <Input required value={clientId} onChange={(e) => setClientId(e.target.value)} />
            </Field>
            <Field label="Authorization endpoint">
              <Input
                type="url"
                required
                value={authorizationEndpoint}
                onChange={(e) => setAuthorization(e.target.value)}
              />
            </Field>
            <Field label="Token endpoint">
              <Input
                type="url"
                required
                value={tokenEndpoint}
                onChange={(e) => setToken(e.target.value)}
              />
            </Field>
            <Field
              label="Requested scopes"
              hint="Space separated. Request only the access you need."
            >
              <Input value={scopes} onChange={(e) => setScopes(e.target.value)} />
            </Field>
          </>
        ) : null}
        <label>
          <input
            type="checkbox"
            checked={confirmed}
            onChange={(e) => setConfirmed(e.target.checked)}
          />{" "}
          I approve these destinations and requested scopes.
        </label>
        <Button
          type="submit"
          aria-disabled={!confirmed || state === "waiting"}
          aria-describedby={`${id}-status`}
        >
          Prepare sign-in
        </Button>
      </form>
      <output id={`${id}-status`} aria-live="polite">
        {state === "waiting"
          ? "Waiting for sign-in in your browser."
          : state === "connected"
            ? "Connected. New sessions can use this credential."
            : state === "failed"
              ? "Sign-in failed. Check the registration and try again."
              : state === "cancelled"
                ? "Sign-in cancelled."
                : "Confirm destinations and scopes before signing in."}
      </output>
      {pending && state === "waiting" ? (
        <>
          <a href={pending.authorizationUrl} target="_blank" rel="noreferrer">
            Continue sign-in in browser
          </a>
          <Button
            onClick={() => {
              void call("connection.auth.cancel", { id: pending.id }, crypto.randomUUID()).then(
                () => setState("cancelled"),
              );
            }}
          >
            Cancel sign-in
          </Button>
        </>
      ) : null}
    </details>
  );
}
