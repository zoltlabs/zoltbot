import type { Connection } from "@zoltbot/protocol";
import { terms } from "@zoltbot/protocol";
import { useCallback, useEffect, useId, useState } from "react";
import type { Row } from "../chat/types.js";
import { Button, Chip, Dialog, Field, Input, Tabs } from "../components/primitives.js";

import { AppCatalog } from "./AppCatalog.js";
import { ConnectionSignIn } from "./ConnectionSignIn.js";
import { serviceName } from "./catalog-data.js";
import { RegistryBrowse } from "./RegistryBrowse.js";
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
  const [loading, setLoading] = useState(false);
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [catalogTab, setCatalogTab] = useState("apps");
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
  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setItems(((await call("connection.list", {})) as { items: Connection[] }).items);
    } finally {
      setLoading(false);
    }
  }, [call]);
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
      <div className="connections-heading">
        <h2 id={`${id}-title`}>Connected apps</h2>
        <Button disabled={!online} onClick={() => setCatalogOpen(true)}>
          Add app
        </Button>
      </div>
      <output id={`${id}-status`} aria-live="polite">
        {busy
          ? "Saving connection…"
          : !online
            ? "Reconnect to your host to manage apps."
            : loading
              ? "Loading connections…"
              : ""}
      </output>
      {error ? (
        <div role="alert">
          <p>{error}</p>
          <Button
            disabled={unavailable}
            onClick={() => {
              setError("");
              void reload().catch(() =>
                setError("Could not load connections. Check your host and retry."),
              );
            }}
          >
            Retry
          </Button>
        </div>
      ) : null}
      <Dialog open={catalogOpen} title="Add app" onClose={() => setCatalogOpen(false)}>
        {catalogOpen ? (
          <Tabs
            label="Where to find apps"
            value={catalogTab}
            onChange={setCatalogTab}
            tabs={[
              {
                id: "apps",
                label: "Featured",
                content: (
                  <AppCatalog
                    call={call}
                    projects={projects}
                    profiles={profiles}
                    online={online}
                    onChanged={reload}
                  />
                ),
              },
              {
                id: "browse",
                label: "Browse",
                content: (
                  <RegistryBrowse
                    call={call}
                    projects={projects}
                    online={online}
                    onChanged={reload}
                  />
                ),
              },
            ]}
          />
        ) : null}
      </Dialog>
      <ul aria-label="Installed connections">
        {items.map((item) => (
          <li key={item.id}>
            <Button
              variant="ghost"
              onClick={() => {
                setSelected(item);
                setConfirmAccess(false);
                setConfirmExecution(false);
              }}
            >
              {serviceName(item.source) ?? item.name}
            </Button>
            <Chip
              tone={
                item.enabled && item.credentialStatus === "needs_sign_in" ? "attention" : "neutral"
              }
            >
              {!item.enabled
                ? "Disabled"
                : item.credentialStatus === "needs_sign_in"
                  ? "Sign in needed"
                  : item.health === "unavailable"
                    ? "Check connection"
                    : labels[item.credentialStatus]}
            </Chip>
            <span className="connection-scope">
              {String(
                projects.find((project) => project.id === item.projectId)?.name ?? "Workspace",
              )}
            </span>
          </li>
        ))}
      </ul>
      {!items.length && !loading && !error && online ? <p>No apps connected.</p> : null}
      <details>
        <summary>Add MCP server</summary>
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
          <Button type="submit" disabled={unavailable} aria-describedby={`${id}-status`}>
            Add server
          </Button>
        </form>
        <Button
          disabled={unavailable || !projectId}
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
          Import detected servers
        </Button>
      </details>
      {selected ? (
        <Dialog
          open
          title={serviceName(selected.source) ?? selected.name}
          onClose={() => {
            if (!busy) setSelected(undefined);
          }}
        >
          <div className="connection-details">
            {error ? <p role="alert">{error}</p> : null}
            <p className="settings-hint">Changes apply to new sessions.</p>
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
              disabled={unavailable}
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
              disabled={unavailable}
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
              disabled={unavailable}
              onClick={() =>
                void run(async () => {
                  const result = (await call("connection.affectedSessions", {
                    id: selected.id,
                  })) as {
                    sessionIds: string[];
                  };
                  setDisconnect({ item: selected, ...result });
                  setStopSessions(false);
                })
              }
            >
              Disconnect…
            </Button>
            <Button disabled={busy} onClick={() => setSelected(undefined)}>
              Done
            </Button>
          </div>
        </Dialog>
      ) : null}
      {disconnect ? (
        <Dialog
          open
          title={`Disconnect ${disconnect.item.name}?`}
          onClose={() => {
            if (!busy) setDisconnect(undefined);
          }}
        >
          <div className="connection-details">
            {error ? <p role="alert">{error}</p> : null}
            <p>
              New sessions lose access. This does not revoke authorization at the remote service.
            </p>
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
              disabled={unavailable || (disconnect.sessionIds.length > 0 && !stopSessions)}
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
            <Button disabled={busy} onClick={() => setDisconnect(undefined)}>
              Cancel
            </Button>
          </div>
        </Dialog>
      ) : null}
    </section>
  );
}
