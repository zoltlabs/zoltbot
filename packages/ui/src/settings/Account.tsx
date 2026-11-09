import { terms } from "@zoltbot/protocol";
import { useEffect, useState } from "react";
import { Button } from "../components/primitives.js";
import type { AccountStatus } from "../connection.js";

export function AccountSettings() {
  const bridge = window.zoltDesktop?.account;
  const [status, setStatus] = useState<AccountStatus>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirm, setConfirm] = useState<string>();
  useEffect(() => {
    let active = true;
    void bridge
      ?.status()
      .then((value) => {
        if (active) setStatus(value);
      })
      .catch(() => {
        if (active) setError("Could not reach your account. Local work is available.");
      });
    return () => {
      active = false;
    };
  }, [bridge]);
  async function run(action: () => Promise<AccountStatus | undefined>) {
    setBusy(true);
    setError("");
    try {
      const next = await action();
      if (next) setStatus(next);
    } catch {
      setError("Account action could not be completed. Check your connection and retry.");
    } finally {
      setBusy(false);
      setConfirm(undefined);
    }
  }
  if (!bridge) return null;
  return (
    <section className="zb-card settings-panel">
      <h2>Account</h2>
      <p className="settings-hint">
        Sign in for your Zoltbot account. Your local projects stay on this Mac.
      </p>
      {error && <p role="alert">{error}</p>}
      {!status && !error && <output>Checking account…</output>}
      {status && !status.configured && <p>Online accounts are not configured in this build.</p>}
      {status?.configured && !status.signedIn && (
        <Button disabled={busy} onClick={() => void run(() => bridge.signIn())}>
          {busy ? "Waiting for Google sign-in…" : "Continue with Google"}
        </Button>
      )}
      {busy && !status?.signedIn && (
        <Button onClick={() => void bridge.cancel()}>Cancel sign-in</Button>
      )}
      {status?.account && (
        <>
          <p>
            <strong>{status.account.user.name}</strong>
            <br />
            {status.account.user.email}
          </p>
          <p>Organization: {status.account.organizations.map((org) => org.name).join(", ")}</p>
          <h3>Signed-in sessions</h3>
          <ul>
            {status.account.sessions.map((session) => (
              <li key={session.id}>
                {session.device_name} · {session.surface}
                {session.id === status.account?.sessionId ? " · This device" : ""}
                <Button size="sm" disabled={busy} onClick={() => setConfirm(session.id)}>
                  Sign out session
                </Button>
              </li>
            ))}
          </ul>
          <Button
            disabled={busy}
            onClick={() =>
              void run(async () => {
                await bridge.signOut();
                return bridge.status();
              })
            }
          >
            Sign out this Mac
          </Button>
          <Button disabled={busy} onClick={() => setConfirm("all")}>
            Sign out all sessions
          </Button>
          <Button
            disabled={!status.managementUrl}
            onClick={() => {
              if (status.managementUrl)
                void window.zoltDesktop?.openExternal?.(status.managementUrl);
            }}
          >
            Manage account and export
          </Button>
        </>
      )}
      {confirm && (
        <div role="alertdialog" aria-label="Confirm sign out">
          <p>
            {confirm === "all" ? "Sign out all devices and browsers?" : "Sign out this session?"}{" "}
            Local {terms.workspace.many} are kept.
          </p>
          <Button
            disabled={busy}
            onClick={() =>
              void run(() => (confirm === "all" ? bridge.revokeAll() : bridge.revoke(confirm)))
            }
          >
            Confirm sign out
          </Button>
          <Button disabled={busy} onClick={() => setConfirm(undefined)}>
            Cancel
          </Button>
        </div>
      )}
      {error && (
        <Button disabled={busy} onClick={() => void run(() => bridge.status())}>
          Retry
        </Button>
      )}
    </section>
  );
}
