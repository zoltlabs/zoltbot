import { type QuickConnection, type QuickSettings, quickTools } from "@zoltbot/protocol";
import { useState } from "react";
import { Button, Chip, Field, Input, Select } from "../components/primitives.js";
import {
  billingLabel,
  connectionStatus,
  errorText,
  type QuickConnectionProp,
  toolName,
} from "./data.js";
import { QuickServers } from "./QuickServers.js";

const commandId = () => `quick-${crypto.randomUUID()}`;
/**
 * Inference connections for Quick Chat. Every option is paid for by the person: a coding tool
 * they signed in to on this host, their own API key, or their own machine. Zoltbot supplies no
 * credits or keys.
 */
export function QuickConnections({
  connection,
  connections,
  settings,
  hostName,
  onChanged,
}: {
  connection: QuickConnectionProp;
  connections: QuickConnection[];
  settings: QuickSettings | undefined;
  hostName: string;
  onChanged(): void;
}) {
  const [notice, setNotice] = useState<{ tone: "ok" | "danger"; text: string }>();
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<"connections" | "tools" | "fallback">("connections");
  const [keyForm, setKeyForm] = useState({ provider: "openai", label: "", apiKey: "" });
  const [localForm, setLocalForm] = useState({
    label: "",
    baseUrl: "http://127.0.0.1:11434/v1",
    models: "",
  });
  const [fallback, setFallback] = useState({ connectionId: "", model: "", acknowledged: false });
  const run = async (work: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    setNotice(undefined);
    try {
      await work();
      if (done) setNotice({ tone: "ok", text: done });
      onChanged();
    } catch (error) {
      setNotice({ tone: "danger", text: errorText(error) });
    } finally {
      setBusy(false);
    }
  };
  const toolNames: Record<string, string> = {
    antigravity: "Antigravity",
    claude: "Claude Code",
    codex: "Codex",
  };
  const installed = new Set(
    (connection.snapshot.entities.agentDefinition ?? []).map((row) => String(row.id)),
  );
  const removedTools = quickTools.filter(
    (tool) => installed.has(tool) && !connections.some((row) => row.provider === tool),
  );
  const fallbackTarget = connections.find((row) => row.id === fallback.connectionId);
  return (
    <section className="quick-connections" aria-label="Quick Chat connections">
      <nav className="quick-settings-nav" aria-label="Quick Chat settings sections">
        {(["connections", "tools", "fallback"] as const).map((item) => (
          <Button
            key={item}
            size="sm"
            variant={view === item ? "secondary" : "ghost"}
            aria-pressed={view === item}
            onClick={() => setView(item)}
          >
            {item === "connections" ? "Connections" : item === "tools" ? "Tools" : "Fallback"}
          </Button>
        ))}
      </nav>
      {notice ? (
        <p
          role={notice.tone === "danger" ? "alert" : "status"}
          className={`quick-notice ${notice.tone}`}
        >
          {notice.text}
        </p>
      ) : null}
      <div className="quick-settings-section" hidden={view !== "connections"}>
        <p className="quick-muted">
          Signed-in coding tools on {hostName} connect automatically. Usage stays on your own plan
          or key.
        </p>
        <ul className="quick-connection-list">
          {connections.map((row) => (
            <li key={row.id}>
              <div className="grow">
                <strong>{row.label}</strong>
                <span className="quick-muted">
                  {row.models.length} models{row.account ? ` · ${row.account}` : ""}
                  {row.statusDetail ? ` · ${row.statusDetail}` : ""}
                </span>
              </div>
              <Chip tone={row.status === "ready" ? "ok" : "warn"}>
                {connectionStatus[row.status]}
              </Chip>
              <Button
                size="sm"
                disabled={busy}
                onClick={() =>
                  run(
                    () => connection.call("quickConnection.refreshModels", { id: row.id }),
                    "Models refreshed.",
                  )
                }
              >
                Refresh
              </Button>
              <Button
                size="sm"
                variant="danger"
                disabled={busy}
                onClick={() =>
                  run(
                    () =>
                      connection.call(
                        "quickConnection.remove",
                        { id: row.id, confirmed: true },
                        commandId(),
                      ),
                    "Connection removed.",
                  )
                }
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
        {removedTools.length ? (
          <div className="r quick-context-actions">
            {removedTools.map((tool) => (
              <Button
                key={tool}
                size="sm"
                disabled={busy}
                onClick={() =>
                  run(
                    () => connection.call("quickConnection.addTool", { tool }, commandId()),
                    `${toolNames[tool]} added.`,
                  )
                }
              >
                Use {toolNames[tool]}
              </Button>
            ))}
          </div>
        ) : null}
        <details className="quick-more" open={!connections.length}>
          <summary>Add an API key or local model</summary>
          <div className="quick-connection-forms">
            <form
              aria-label="Your API key"
              onSubmit={(event) => {
                event.preventDefault();
                void run(async () => {
                  await connection.call(
                    "quickConnection.saveApiKey",
                    {
                      provider: keyForm.provider,
                      label:
                        keyForm.label ||
                        (keyForm.provider === "openai" ? "My OpenAI key" : "My Anthropic key"),
                      apiKey: keyForm.apiKey,
                      confirmed: true,
                    },
                    commandId(),
                  );
                  setKeyForm({ ...keyForm, apiKey: "" });
                }, "Key saved to the Keychain. Requests bill your provider account.");
              }}
            >
              <h3>Your API key</h3>
              <p className="quick-muted">
                Billed to your own provider account at its published rates.
              </p>
              <Field label="Provider">
                <Select
                  value={keyForm.provider}
                  onChange={(e) => setKeyForm({ ...keyForm, provider: e.target.value })}
                >
                  <option value="openai">OpenAI</option>
                  <option value="anthropic">Anthropic</option>
                </Select>
              </Field>
              <Field label="Name">
                <Input
                  value={keyForm.label}
                  placeholder="My OpenAI key"
                  onChange={(e) => setKeyForm({ ...keyForm, label: e.target.value })}
                />
              </Field>
              <Field
                label="API key"
                hint="Stored in the Mac Keychain. Never shown again or sent to Zoltbot."
              >
                <Input
                  type="password"
                  autoComplete="off"
                  value={keyForm.apiKey}
                  onChange={(e) => setKeyForm({ ...keyForm, apiKey: e.target.value })}
                />
              </Field>
              <Button type="submit" disabled={busy || keyForm.apiKey.length < 8}>
                Save key
              </Button>
            </form>
            <form
              aria-label="Local model"
              onSubmit={(event) => {
                event.preventDefault();
                void run(
                  () =>
                    connection.call(
                      "quickConnection.saveLocal",
                      {
                        label: localForm.label || "Local model",
                        baseUrl: localForm.baseUrl,
                        ...(localForm.models.trim()
                          ? {
                              models: localForm.models
                                .split(",")
                                .map((m) => m.trim())
                                .filter(Boolean),
                            }
                          : {}),
                      },
                      commandId(),
                    ),
                  "Local endpoint saved.",
                );
              }}
            >
              <h3>Local model</h3>
              <p className="quick-muted">
                An OpenAI compatible server such as Ollama or LM Studio.
              </p>
              <Field label="Name">
                <Input
                  value={localForm.label}
                  placeholder="Local model"
                  onChange={(e) => setLocalForm({ ...localForm, label: e.target.value })}
                />
              </Field>
              <Field label="Endpoint URL">
                <Input
                  value={localForm.baseUrl}
                  onChange={(e) => setLocalForm({ ...localForm, baseUrl: e.target.value })}
                />
              </Field>
              <Field
                label="Models"
                hint="Optional, comma separated, when the server cannot list them."
              >
                <Input
                  value={localForm.models}
                  onChange={(e) => setLocalForm({ ...localForm, models: e.target.value })}
                />
              </Field>
              <Button type="submit" disabled={busy || !localForm.baseUrl}>
                Save endpoint
              </Button>
            </form>
          </div>
        </details>
      </div>
      <section aria-label="Tools" className="quick-settings-section" hidden={view !== "tools"}>
        <h3>Connected tools</h3>
        <p className="quick-muted">
          Use services connected to your coding tools and read your workspaces. Quick Chat asks
          before changing, sending or running anything.
        </p>
        <QuickServers connection={connection} />
        {settings?.allowedTools?.length ? (
          <ul className="quick-connection-list" aria-label="Always allowed">
            {settings.allowedTools.map((name) => (
              <li key={name}>
                <span className="grow">Always allowed: {toolName(name)}</span>
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    run(
                      () => connection.call("quickChat.forgetTool", { name }, commandId()),
                      `${toolName(name)} will ask again.`,
                    )
                  }
                >
                  Ask again
                </Button>
              </li>
            ))}
          </ul>
        ) : null}
      </section>
      <section
        aria-label="Automatic fallback"
        className="quick-settings-section"
        hidden={view !== "fallback"}
      >
        <h3>Automatic fallback</h3>
        {settings?.fallback ? (
          <p>
            On. When a connection refuses before answering (for example a usage limit), Quick Chat
            sends the conversation to{" "}
            <strong>
              {connections.find((row) => row.id === settings.fallback?.connectionId)?.label ??
                "a removed connection"}{" "}
              · {settings.fallback.model}
            </strong>
            .{" "}
            <Button
              size="sm"
              disabled={busy}
              onClick={() =>
                run(
                  () =>
                    connection.call("quickConnection.setFallback", { enabled: false }, commandId()),
                  "Fallback is off.",
                )
              }
            >
              Turn off
            </Button>
          </p>
        ) : (
          <>
            <p className="quick-muted">
              Off. Choose a backup connection to use when your selected connection cannot answer.
            </p>
            <Field label="Fallback connection">
              <Select
                value={fallback.connectionId}
                onChange={(e) =>
                  setFallback({ connectionId: e.target.value, model: "", acknowledged: false })
                }
              >
                <option value="">Choose…</option>
                {connections
                  .filter((row) => row.models.length)
                  .map((row) => (
                    <option key={row.id} value={row.id}>
                      {row.label}
                    </option>
                  ))}
              </Select>
            </Field>
            {fallbackTarget ? (
              <>
                <Field label="Fallback model">
                  <Select
                    value={fallback.model}
                    onChange={(e) => setFallback({ ...fallback, model: e.target.value })}
                  >
                    <option value="">Choose…</option>
                    {fallbackTarget.models.map((model) => (
                      <option key={model.id} value={model.id}>
                        {model.label}
                      </option>
                    ))}
                  </Select>
                </Field>
                <label className="quick-check">
                  <input
                    type="checkbox"
                    checked={fallback.acknowledged}
                    onChange={(e) => setFallback({ ...fallback, acknowledged: e.target.checked })}
                  />
                  I understand the conversation context will be sent to {fallbackTarget.label} and
                  billed as:{" "}
                  {billingLabel({ ...fallbackTarget, hostName: fallbackTarget.host.name })}.
                </label>
                <Button
                  disabled={busy || !fallback.model || !fallback.acknowledged}
                  onClick={() =>
                    run(
                      () =>
                        connection.call(
                          "quickConnection.setFallback",
                          {
                            enabled: true,
                            connectionId: fallback.connectionId,
                            model: fallback.model,
                            acknowledged: true,
                          },
                          commandId(),
                        ),
                      "Fallback is on.",
                    )
                  }
                >
                  Turn on fallback
                </Button>
              </>
            ) : null}
          </>
        )}
      </section>
    </section>
  );
}
