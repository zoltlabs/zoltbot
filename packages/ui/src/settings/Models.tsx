import type { QuickConnection, QuickSettings } from "@zoltbot/protocol";
import { useCallback, useEffect, useState } from "react";
import { type ChatConnection, type Row, text } from "../chat/types.js";
import { QuickConnections } from "../quick-chat/QuickConnections.js";
import { useShell } from "../state.js";
import "../quick-chat/quick-chat.css";

type Catalog = {
  definitionId: string;
  selectable: boolean;
  models: { id: string; name: string }[];
  effort: string[];
};
export function ModelSettings({ connection }: { connection: ChatConnection }) {
  const [catalog, setCatalog] = useState<Catalog[]>([]);
  const [providers, setProviders] = useState<QuickConnection[]>([]);
  const [settings, setSettings] = useState<QuickSettings>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const online = connection.status === "online";
  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [models, quick] = await Promise.all([
        connection.call("model.catalog", {}) as Promise<{ items: Catalog[] }>,
        connection.call("quickConnection.list", {}) as Promise<{
          items: QuickConnection[];
          settings: QuickSettings;
        }>,
      ]);
      setCatalog(models.items);
      setProviders(quick.items);
      setSettings(quick.settings);
      setLoaded(true);
    } catch {
      setError("Could not load models. Check the host connection and retry.");
    } finally {
      setLoading(false);
    }
  }, [connection.call]);
  useEffect(() => {
    if (online) void load();
  }, [online, load]);
  return (
    <>
      <section className="zb-card settings-panel" aria-label="AI providers">
        <h3>AI providers</h3>
        {!online ? <output>Reconnect to your host to manage providers.</output> : null}
        {loading ? <output>Loading providers…</output> : null}
        {error ? (
          <div role="alert">
            <p>{error}</p>
            <button
              className="btn"
              type="button"
              disabled={!online || loading}
              onClick={() => void load()}
            >
              Retry
            </button>
          </div>
        ) : null}
        {loaded ? (
          <fieldset className="settings-provider-controls" disabled={!online || loading}>
            <legend className="sr-only">AI provider connections</legend>
            <QuickConnections
              connection={connection}
              connections={providers}
              settings={settings}
              hostName={providers[0]?.host.name ?? "This host"}
              onChanged={() => void load()}
            />
          </fieldset>
        ) : null}
      </section>
      <section className="zb-card settings-panel" aria-label="Workspace model defaults">
        <h3>Workspace defaults</h3>
        <p className="settings-hint">Used for new workspace chats.</p>
        {(connection.snapshot.entities.agent ?? [])
          .filter((row) => !row.archived && !row.hidden)
          .map((profile) => (
            <ProfileModel
              key={text(profile.id)}
              profile={profile}
              connection={connection}
              catalog={catalog.find((entry) => entry.definitionId === profile.definitionId)}
            />
          ))}
        {!(connection.snapshot.entities.agent ?? []).some((row) => !row.archived && !row.hidden) ? (
          <button
            className="btn"
            type="button"
            onClick={() => useShell.getState().navigate("Doctor")}
          >
            Connect a coding agent
          </button>
        ) : null}
      </section>
    </>
  );
}
function ProfileModel({
  profile,
  catalog,
  connection,
}: {
  profile: Row;
  catalog: Catalog | undefined;
  connection: ChatConnection;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  async function save(changes: Row) {
    setPending(true);
    setError("");
    try {
      await connection.call("agent.update", { id: profile.id, changes }, crypto.randomUUID());
    } catch {
      setError("Could not save. Reconnect to your host and try again.");
    } finally {
      setPending(false);
    }
  }
  const disabled = pending || connection.status !== "online";
  return (
    <div className="settings-model-row">
      <div>
        <h4>{text(profile.name)}</h4>
      </div>
      {catalog?.selectable && catalog.models.length ? (
        <div className="settings-model-values">
          <label>
            <span className="sr-only">Model for {text(profile.name)}</span>
            <select
              value={text(profile.model)}
              disabled={disabled}
              onChange={(event) => void save({ model: event.target.value, effort: "" })}
            >
              <option value="">Tool default</option>
              {text(profile.model) &&
              !catalog.models.some((model) => model.id === profile.model) ? (
                <option value={text(profile.model)}>{text(profile.model)} (unavailable)</option>
              ) : null}
              {catalog.models.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.name}
                </option>
              ))}
            </select>
          </label>
          {catalog.effort.length ? (
            <label>
              <span className="sr-only">Reasoning effort for {text(profile.name)}</span>
              <select
                value={text(profile.effort)}
                disabled={disabled}
                onChange={(event) => void save({ effort: event.target.value })}
              >
                <option value="">Default effort</option>
                {catalog.effort.map((effort) => (
                  <option key={effort} value={effort}>
                    {effort}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
        </div>
      ) : (
        <span className="settings-hint">
          {text(profile.model) ||
            (catalog?.selectable === false && catalog.models.length
              ? "Managed by coding tool"
              : "Connect a chat to load available models")}
        </span>
      )}
      {error ? <p role="alert">{error}</p> : null}
    </div>
  );
}
