import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Field, Select } from "../components/primitives.js";
import { SecretForm } from "./SecretForm.js";
import type { CloudSettingsBridge, CloudSettingsStatus, MacExecutionMode } from "./types.js";
import "./cloud.css";

export function CloudSettings({
  bridge,
  onAccountSettings,
}: {
  bridge: CloudSettingsBridge;
  onAccountSettings(): void;
}) {
  const [status, setStatus] = useState<CloudSettingsStatus>(),
    [busy, setBusy] = useState<string>(),
    [error, setError] = useState(""),
    [message, setMessage] = useState("");
  const generation = useRef(0),
    action = useRef(0),
    mounted = useRef(true),
    running = useRef(false);
  const reload = useCallback(async () => {
    const current = ++generation.current;
    action.current++;
    running.current = false;
    setStatus(undefined);
    setBusy(undefined);
    setError("");
    setMessage("");
    try {
      const next = await bridge.status();
      if (mounted.current && generation.current === current) setStatus(next);
    } catch {
      if (mounted.current && generation.current === current)
        setError("Could not load Cloud settings. Check your connection and retry.");
    }
  }, [bridge]);
  useEffect(() => {
    mounted.current = true;
    void reload();
    const stop = bridge.onAccountChanged(() => void reload());
    return () => {
      mounted.current = false;
      generation.current++;
      action.current++;
      stop();
    };
  }, [bridge, reload]);
  const run = async (name: string, perform: () => Promise<CloudSettingsStatus>) => {
    if (running.current) return;
    running.current = true;
    const request = ++action.current,
      current = generation.current;
    setBusy(name);
    setError("");
    setMessage(name === "sign-in" ? "Waiting for Google sign-in…" : "Saving…");
    try {
      const next = await perform();
      if (mounted.current && generation.current === current) {
        setStatus(next);
        setMessage("");
      }
    } catch (error) {
      if (mounted.current && generation.current === current) {
        setMessage("");
        if (!(error instanceof Error && error.message === "sign_in_cancelled"))
          setError("Could not update Cloud settings. Reload settings and retry.");
      }
    } finally {
      if (mounted.current && action.current === request) {
        running.current = false;
        setBusy(undefined);
      }
    }
  };
  const account = status?.configured ? status.account : undefined,
    unavailable = !status?.online || !status.eligible || !account;
  const hours = (seconds: number) =>
    new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(seconds / 3600);
  return (
    <section
      className="zb-card settings-panel cloud-settings"
      aria-labelledby="cloud-settings-title"
    >
      <h2 id="cloud-settings-title">Zoltbot Cloud</h2>
      <output>{!status && !error ? "Loading Cloud settings…" : message}</output>
      {error ? (
        <div>
          <p role="alert">{error}</p>
          <Button onClick={() => void reload()}>Reload settings</Button>
        </div>
      ) : null}
      {status && !status.configured ? <p>Cloud is not available in this version.</p> : null}
      {status?.configured && !account ? (
        <Button
          aria-disabled={!!busy}
          aria-busy={busy === "sign-in" || undefined}
          onClick={() => void run("sign-in", () => bridge.signIn())}
        >
          Continue with Google
        </Button>
      ) : null}
      {busy === "sign-in" ? (
        <Button
          onClick={() =>
            void bridge
              .cancelSignIn()
              .catch(() =>
                setError("Could not cancel sign-in. Retry canceling or finish in the browser."),
              )
          }
        >
          Cancel sign-in
        </Button>
      ) : null}
      {account && status ? (
        <>
          <p>{account.orgName}</p>
          {status.online && !status.eligible ? (
            <div>
              <p>Cloud access is not enabled for this account.</p>
              <Button onClick={onAccountSettings}>Open account settings</Button>
            </div>
          ) : null}
          {!status.online ? <p>Cloud is offline. Reconnect to change settings.</p> : null}
          <label className="r wrap">
            <input
              type="checkbox"
              checked={status.enabled}
              disabled={unavailable}
              aria-disabled={!!busy || undefined}
              onChange={(event) => {
                if (!busy)
                  void run("enable", () =>
                    bridge.setEnabled({
                      sessionId: account.sessionId,
                      enabled: event.target.checked,
                    }),
                  );
              }}
            />
            Enable Zoltbot Cloud
          </label>
          {status.enabled ? (
            <>
              <section className="cloud-settings-group" aria-labelledby="cloud-credentials-title">
                <h3 id="cloud-credentials-title">API keys</h3>
                <SecretForm
                  key={`${account.sessionId}:anthropic`}
                  bridge={bridge}
                  sessionId={account.sessionId}
                  name="anthropic"
                  label="Anthropic API key"
                  disabled={unavailable}
                />
                <SecretForm
                  key={`${account.sessionId}:openai`}
                  bridge={bridge}
                  sessionId={account.sessionId}
                  name="openai"
                  label="OpenAI API key"
                  disabled={unavailable}
                />
                <SecretForm
                  key={`${account.sessionId}:github`}
                  bridge={bridge}
                  sessionId={account.sessionId}
                  name="github"
                  label="GitHub token"
                  disabled={unavailable}
                />
                <p className="settings-hint">
                  Use a GitHub token with contents and pull request write access.
                </p>
              </section>
              <section className="cloud-settings-group" aria-labelledby="cloud-mac-title">
                <h3 id="cloud-mac-title">This Mac</h3>
                <label className="r wrap">
                  <input
                    type="checkbox"
                    checked={status.runTasksOnMac}
                    disabled={unavailable}
                    aria-disabled={!!busy || undefined}
                    onChange={(event) => {
                      if (!busy)
                        void run("runner", () =>
                          bridge.setMacRunner({
                            sessionId: account.sessionId,
                            enabled: event.target.checked,
                          }),
                        );
                    }}
                  />
                  Run cloud tasks on this Mac
                </label>
                <Field label="Run on my Mac">
                  <Select
                    value={status.macExecution}
                    disabled={unavailable}
                    aria-disabled={!!busy || undefined}
                    onChange={(event) => {
                      if (!busy)
                        void run("mac-exec", () =>
                          bridge.setMacExecution({
                            sessionId: account.sessionId,
                            mode: event.target.value as MacExecutionMode,
                          }),
                        );
                    }}
                  >
                    <option value="off">Off</option>
                    <option value="ask">Ask every time</option>
                    <option value="allow_listed">Allow listed commands</option>
                  </Select>
                </Field>
                <p className="settings-hint">
                  Approved command output goes to the cloud task and its model provider.
                </p>
                {status.projects.length ? (
                  <ul className="cloud-folder-list">
                    {status.projects.map((project) => (
                      <li key={project.id}>
                        <strong>{project.name}</strong>
                        {project.folder ? (
                          <p className="cloud-folder-path">{project.folder}</p>
                        ) : null}
                        <Button
                          disabled={unavailable}
                          aria-disabled={!!busy || undefined}
                          aria-label={`${project.folder ? "Change" : "Link"} folder for ${project.name}`}
                          onClick={() =>
                            void run("folder", () =>
                              bridge.linkFolder({
                                sessionId: account.sessionId,
                                projectId: project.id,
                              }),
                            )
                          }
                        >
                          {project.folder ? "Change folder" : "Link folder"}
                        </Button>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </section>
              {status.usage ? (
                <section className="cloud-settings-group" aria-labelledby="cloud-usage-title">
                  <h3 id="cloud-usage-title">Sandbox usage</h3>
                  <p>{`${hours(status.usage.sandboxSeconds)} of ${hours(status.usage.limitSeconds)} sandbox hours used this month.`}</p>
                </section>
              ) : null}
            </>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
