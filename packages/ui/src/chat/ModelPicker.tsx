import { useEffect, useRef, useState } from "react";
import { Dialog } from "../components/primitives.js";
import { useShell } from "../state.js";
import { type Recovery, sessionRecovery } from "./session-recovery.js";
import { body, type ChatConnection, type Row, text } from "./types.js";

/** Only offer choices reported by this session's provider. */
export function modelChoices(session: Row | undefined) {
  const caps = body({ body: session?.capabilities });
  const models = body({ body: caps.models });
  return {
    selectable: models.selectable === true,
    models: (Array.isArray(models.list) ? models.list : []).filter(
      (row): row is { id: string; name: string } =>
        !!row && typeof row.id === "string" && typeof row.name === "string",
    ),
    efforts: (Array.isArray(caps.effort) ? caps.effort : []).filter(
      (value): value is string => typeof value === "string",
    ),
  };
}

export function ModelPicker({
  connection,
  threadId,
  session,
  tool,
  onPendingChange,
}: {
  connection: ChatConnection;
  threadId: string;
  session: Row | undefined;
  tool: string;
  onPendingChange?(pending: boolean): void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [recovery, setRecovery] = useState<Recovery>();
  const [change, setChange] = useState<{ model: string; effort?: string }>();
  const attempt = useRef<{ key: string; id: string } | undefined>(undefined);
  useEffect(() => {
    onPendingChange?.(pending);
  }, [pending, onPendingChange]);
  useEffect(() => () => onPendingChange?.(false), [onPendingChange]);
  const choices = modelChoices(session);
  const started = connection.snapshot.entities.turn?.some((turn) => turn.sessionId === session?.id);
  const online = connection.status === "online";
  const ready = session?.state === "ready";
  const working = connection.snapshot.entities.turn?.some(
    (turn) => turn.sessionId === session?.id && turn.status === "running",
  );
  async function apply(value: { model: string; effort?: string }, accepted = false) {
    if (pending || !online || !ready || working) return;
    if (started && !accepted) {
      setChange(value);
      return;
    }
    const key = JSON.stringify([session?.id, value]);
    if (attempt.current?.key !== key) attempt.current = { key, id: crypto.randomUUID() };
    setPending(true);
    setError("");
    setRecovery(undefined);
    try {
      await connection.call(
        "session.setModel",
        {
          id: session?.id,
          ...value,
          cacheWarningAccepted: accepted,
        },
        attempt.current.id,
      );
      attempt.current = undefined;
      setChange(undefined);
    } catch {
      setError("Could not change the model. Try again or review model settings.");
      setRecovery({
        title: "Model change failed",
        description: "",
        route: "ModelsSettings",
        label: "Model settings",
      });
    } finally {
      setPending(false);
    }
  }
  return (
    <div className="chat-model-controls">
      <span className="chat-agent-name">{tool}</span>
      {!session ? (
        <button
          type="button"
          className="btn sm"
          disabled={pending || !online}
          onClick={async () => {
            setPending(true);
            setError("");
            setRecovery(undefined);
            try {
              await connection.call("session.connect", { threadId }, crypto.randomUUID());
            } catch (cause) {
              const next = sessionRecovery(cause instanceof Error ? cause.message : "");
              setRecovery({
                ...next,
                route: next.route ?? "Doctor",
                label: next.label ?? "Review coding agent",
              });
              setError(`${next.title}. ${next.description}`);
            } finally {
              setPending(false);
            }
          }}
        >
          {pending ? "Connecting…" : "Choose model"}
        </button>
      ) : session.state === "starting" ? (
        <output>Loading models…</output>
      ) : choices.selectable && choices.models.length ? (
        <>
          <label className="chat-model-field">
            <span className="sr-only">Model</span>
            <select
              aria-label="Model"
              value={text(session.model)}
              disabled={pending || !online || !ready || working}
              onChange={(event) => void apply({ model: event.target.value })}
            >
              {!choices.models.some((model) => model.id === session.model) ? (
                <option value={text(session.model)}>{text(session.model) || "Tool default"}</option>
              ) : null}
              {choices.models.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.name}
                </option>
              ))}
            </select>
          </label>
          {choices.efforts.length ? (
            <label className="chat-model-field">
              <span className="sr-only">Reasoning effort</span>
              <select
                aria-label="Reasoning effort"
                value={text(session.effort)}
                disabled={pending || !online || !ready || working || !text(session.model)}
                onChange={(event) =>
                  void apply({ model: text(session.model), effort: event.target.value })
                }
              >
                {!choices.efforts.includes(text(session.effort)) ? (
                  <option value={text(session.effort)}>
                    {text(session.effort) || "Default effort"}
                  </option>
                ) : null}
                {choices.efforts.map((effort) => (
                  <option key={effort} value={effort}>
                    {effort}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
        </>
      ) : (
        <span className="chat-model-managed">
          {text(session.model) ||
            (choices.selectable ? "Model list unavailable" : `Model managed by ${tool}`)}
        </span>
      )}
      {pending && ready ? <output>Updating…</output> : null}
      {error ? (
        <span className="chat-mode-error" role="alert">
          {error}
        </span>
      ) : null}
      {recovery?.route ? (
        <button
          type="button"
          className="btn sm"
          onClick={() => {
            if (recovery.route) useShell.getState().navigate(recovery.route);
          }}
        >
          {recovery.label}
        </button>
      ) : null}
      <Dialog
        open={!!change}
        title="Change model settings?"
        description="The next message uses these settings. Switching may rebuild the prompt cache and increase cost."
        onClose={() => {
          if (!pending) setChange(undefined);
        }}
        actions={
          <>
            <button
              type="button"
              className="btn"
              disabled={pending}
              onClick={() => setChange(undefined)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn pri"
              disabled={pending || !online || working}
              onClick={() => {
                if (change) void apply(change, true);
              }}
            >
              {pending ? "Updating…" : "Change settings"}
            </button>
          </>
        }
      >
        {error ? <p role="alert">{error}</p> : null}
      </Dialog>
    </div>
  );
}
