import type { Connection } from "@zoltbot/protocol";
import { terms } from "@zoltbot/protocol";
import { useCallback, useEffect, useId, useState } from "react";
import type { Row } from "../chat/types.js";
import { Button, Field, Input } from "../components/primitives.js";

import { AppCatalog } from "./AppCatalog.js";
import { ConnectionSignIn } from "./ConnectionSignIn.js";
import { serviceName } from "./catalog-data.js";
import "./connections.css";

type Call = (method: string, params: unknown, commandId?: string) => Promise<unknown>;
const labels = {
  not_required: "No sign-in required",
  needs_sign_in: "Needs sign-in",
  connected: "Connected",
};
function errorText(error: unknown) {
  const text = error instanceof Error ? error.message : "";
  if (text.includes("disconnect_changed"))
    return "The connection or its active sessions changed. Reopen Disconnect to review the current list. Nothing was stopped.";
  if (text.includes("version_conflict")) return "This connection changed. Reload and try again.";
  if (text.includes("active_sessions"))
    return "Existing sessions received this connection. Stop them before disconnecting.";
  if (text.includes("execution_confirmation"))
    return "Confirm local command execution before enabling this connection.";
  return "The connection could not be updated. Check its settings and try again.";
}
export function Connections({
  call,
  projects,
  profiles,
  online,
}: {
  call: Call;
  projects: Row[];
  profiles: Row[];
  online: boolean;
}) {
  const id = useId();
  const [items, setItems] = useState<Connection[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [transport, setTransport] = useState("https");
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("[]");
  const [confirmExecution, setConfirmExecution] = useState(false);
  const [projectId, setProjectId] = useState("");
  const [selected, setSelected] = useState<Connection>();
  const [confirmAccess, setConfirmAccess] = useState(false);
  const [disconnect, setDisconnect] = useState<{ item: Connection; sessionIds: string[] }>();
  const [stopSessions, setStopSessions] = useState(false);
  const reload = useCallback(
    async () => setItems(((await call("connection.list", {})) as { items: Connection[] }).items),
    [call],
  );
  const connected = useCallback(async () => {
    await reload();
    setSelected(undefined);
  }, [reload]);
  useEffect(() => {
    if (online) void reload().catch(() => setError("Connections could not be loaded. Try again."));
  }, [online, reload]);
  async function run(action: () => Promise<void>) {
    if (busy || !online) return;
    setBusy(true);
    setError("");
    try {
      await action();
      await reload();
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(false);
    }
  }
  const unavailable = busy || !online;
  return (
    <section
      className="zb-card settings-panel connections-settings"
      aria-labelledby={`${id}-title`}
    >
      <h2 id={`${id}-title`}>Connections</h2>
      <p className="settings-hint">
        Choose which MCP servers profiles can use. Running sessions keep the versions attached at
        start.
      </p>
      <output id={`${id}-status`} aria-live="polite">
        {busy
          ? "Saving connection…"
          : !online
            ? "Connect to the daemon to make changes."
            : "Changes apply to new sessions."}
      </output>
      {error ? <p role="alert">{error}</p> : null}
      <AppCatalog
        call={call}
        projects={projects}
        profiles={profiles}
        online={online}
        onChanged={reload}
      />
      <h3>Connected and installed</h3>
      <ul aria-label="Installed connections">
        {items.map((item) => (
          <li key={item.id}>
            <Button
              variant="ghost"
              onClick={() => {
                setSelected(item);
                setConfirmAccess(false);
              }}
            >
              {serviceName(item.source) ?? item.name}
            </Button>
            <span>
              {" "}
              · {item.enabled ? labels[item.credentialStatus] : "Disabled"} · v{item.version} ·{" "}
              {item.health === "not_checked" ? "Not checked" : item.health}
            </span>
            <p className="settings-hint">
              {serviceName(item.source)
                ? `${String(projects.find((p) => p.id === item.projectId)?.name ?? "Workspace")} · ${item.name}`
                : item.source}{" "}
              ·{" "}
              {item.transport.kind === "https"
                ? serviceName(item.source)
                  ? new URL(item.transport.url).host + new URL(item.transport.url).pathname
                  : new URL(item.transport.url).host
                : "Local command"}{" "}
              · {item.profileIds.length} profiles
            </p>
          </li>
        ))}
      </ul>
      {!items.length ? <p>No connections yet. Choose an app above or add an MCP server.</p> : null}
      <details>
        <summary>Advanced MCP · Add or import a server</summary>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void run(async () => {
              if (!projectId || !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(name)) {
                setError(
                  `Choose a ${terms.workspace.one} and a name using letters, numbers, underscores or hyphens.`,
                );
                return;
              }
              await call(
                "connection.save",
                {
                  value: {
                    id: crypto.randomUUID(),
                    name,
                    projectId,
                    version: 1,
                    transport:
                      transport === "https"
                        ? { kind: "https", url }
                        : { kind: "stdio", command, args: JSON.parse(args) },
                    source: "manual",
                    enabled: false,
                    profileIds: [],
                    schemaTokens: { value: 512, source: "estimated" },
                    credentialStatus: "not_required",
                    health: "not_checked",
                  },
                  expectedVersion: 0,
                  confirmed: false,
                },
                crypto.randomUUID(),
              );
              setName("");
              setUrl("");
            });
          }}
        >
          <h3>Add MCP server</h3>
          <Field label="Name">
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              required
              maxLength={64}
            />
          </Field>
          <Field label="Transport">
            <select
              aria-label="Transport"
              value={transport}
              onChange={(e) => setTransport(e.target.value)}
            >
              <option value="https">Remote HTTPS</option>
              <option value="stdio">Local command</option>
            </select>
          </Field>
          {transport === "https" ? (
            <Field label="Remote URL" hint="HTTPS address without credentials or query parameters.">
              <Input
                aria-label="Remote URL"
                type="url"
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                required
              />
            </Field>
          ) : (
            <>
              <Field label="Executable" hint="Absolute path. No shell command parsing.">
                <Input value={command} onChange={(e) => setCommand(e.target.value)} required />
              </Field>
              <Field
                label="Arguments"
                hint="JSON array of literal arguments. Do not include secrets."
              >
                <Input value={args} onChange={(e) => setArgs(e.target.value)} required />
              </Field>
            </>
          )}
          <Field label={terms.workspace.One}>
            <select
              aria-label={terms.workspace.One}
              value={projectId}
              onChange={(event) => setProjectId(event.target.value)}
              required
            >
              <option value="">Choose {terms.workspace.one}</option>
              {projects
                .filter((p) => !p.archived)
                .map((p) => (
                  <option key={String(p.id)} value={String(p.id)}>
                    {String(p.name)}
                  </option>
                ))}
            </select>
          </Field>
          <Button type="submit" aria-disabled={unavailable} aria-describedby={`${id}-status`}>
            Add disabled connection
          </Button>
        </form>
        <Button
          aria-disabled={unavailable || !projectId}
          onClick={() => {
            if (!projectId) {
              setError("Choose a project before importing detected configuration.");
              return;
            }
            void run(async () => {
              await call("connection.import", { projectId, confirmed: true }, crypto.randomUUID());
            });
          }}
        >
          Import detected HTTPS configuration as disabled
        </Button>
      </details>
      {selected ? (
        <section aria-label={`Access for ${selected.name}`}>
          <h3>{serviceName(selected.source) ?? selected.name} · Profile access</h3>
          {selected.transport.kind === "https" ? (
            <ConnectionSignIn
              key={selected.id}
              connectionId={selected.id}
              service={serviceName(selected.source)}
              call={call}
              onConnected={connected}
            />
          ) : (
            <label>
              <input
                type="checkbox"
                checked={confirmExecution}
                onChange={(e) => setConfirmExecution(e.target.checked)}
              />{" "}
              I approve running {selected.transport.command} with these literal arguments when a
              native session starts.
            </label>
          )}
          <p>
            Only selected {terms.profile.many} in this {terms.workspace.one} can use this connection
            with a supported provider.
          </p>
          <label>
            <input
              type="checkbox"
              checked={selected.enabled}
              onChange={(e) => setSelected({ ...selected, enabled: e.target.checked })}
            />{" "}
            Enabled for new sessions
          </label>
          <fieldset>
            <legend>Profiles that can use this</legend>
            {profiles
              .filter((p) => !p.archived)
              .map((profile) => (
                <label key={String(profile.id)}>
                  <input
                    type="checkbox"
                    checked={selected.profileIds.includes(String(profile.id))}
                    onChange={(e) =>
                      setSelected({
                        ...selected,
                        profileIds: e.target.checked
                          ? [...selected.profileIds, String(profile.id)]
                          : selected.profileIds.filter((p) => p !== profile.id),
                      })
                    }
                  />
                  {String(profile.name)}
                </label>
              ))}
          </fieldset>
          <label>
            <input
              type="checkbox"
              checked={confirmAccess}
              onChange={(e) => setConfirmAccess(e.target.checked)}
            />{" "}
            I approve giving these profiles access to this server’s tools.
          </label>
          <Button
            aria-disabled={unavailable}
            onClick={() =>
              void run(async () => {
                const saved = await call(
                  "connection.save",
                  {
                    value: selected,
                    expectedVersion: selected.version,
                    confirmed: confirmAccess,
                    executionConfirmed: confirmExecution,
                  },
                  crypto.randomUUID(),
                );
                setSelected(saved as Connection);
                setConfirmAccess(false);
              })
            }
          >
            Save access
          </Button>
          <Button
            aria-disabled={unavailable}
            onClick={() =>
              void run(async () => {
                await call("connection.test", { id: selected.id }, crypto.randomUUID());
                setSelected(undefined);
              })
            }
          >
            Test connection
          </Button>
          <Button
            aria-disabled={unavailable}
            onClick={() =>
              void run(async () => {
                const result = (await call("connection.affectedSessions", { id: selected.id })) as {
                  sessionIds: string[];
                };
                setDisconnect({ item: selected, ...result });
                setStopSessions(false);
              })
            }
          >
            Disconnect…
          </Button>
          <Button onClick={() => setSelected(undefined)}>Close details</Button>
        </section>
      ) : null}
      {disconnect ? (
        <section aria-label="Confirm disconnect">
          <h3>Disconnect {disconnect.item.name}?</h3>
          <p>New sessions lose access. This does not revoke authorization at the remote service.</p>
          {disconnect.sessionIds.length ? (
            <>
              <p>{disconnect.sessionIds.length} native sessions received this connection:</p>
              <ul>
                {disconnect.sessionIds.map((session) => (
                  <li key={session}>{session}</li>
                ))}
              </ul>
              <label>
                <input
                  type="checkbox"
                  checked={stopSessions}
                  onChange={(e) => setStopSessions(e.target.checked)}
                />{" "}
                Stop these sessions and disconnect
              </label>
            </>
          ) : (
            <p>No active native sessions received this connection.</p>
          )}
          <Button
            variant="danger"
            aria-disabled={unavailable || (disconnect.sessionIds.length > 0 && !stopSessions)}
            onClick={() => {
              if (disconnect.sessionIds.length && !stopSessions) return;
              void run(async () => {
                await call(
                  "connection.disconnect",
                  {
                    id: disconnect.item.id,
                    confirmed: true,
                    stopSessions,
                    expectedVersion: disconnect.item.version,
                    expectedSessionIds: disconnect.sessionIds,
                  },
                  crypto.randomUUID(),
                );
                setDisconnect(undefined);
                setSelected(undefined);
              });
            }}
          >
            Confirm disconnect
          </Button>
          <Button onClick={() => setDisconnect(undefined)}>Cancel</Button>
        </section>
      ) : null}
      <p className="settings-hint">
        Catalog apps use browser sign-in when their service registration is enabled. Advanced MCP
        remains available for other services.
      </p>
    </section>
  );
}
