import "./fork.css";
import { useEffect, useRef, useState } from "react";
import { Dialog } from "../components/primitives.js";
import { useShell } from "../state.js";
import { Markdown } from "./Markdown.js";
import { body, type ChatConnection, type Row, text } from "./types.js";

const reasons: Record<string, string> = {
  copied_history_unavailable:
    "There is no visible text history to copy, or the most recent message exceeds the copied-context limit.",
  fork_history_limit:
    "This conversation is too large to copy safely. Start a new chat with a shorter selection instead.",
  fork_destination_unavailable: "Choose an available coding-tool profile.",
  native_fork_unverified:
    "Native forks need the original coding-tool profile and a verified version. Choose Automatic or Copy visible context for another destination.",
  fork_requires_idle: "Finish or stop the current work and answer pending requests before forking.",
  fork_history_unavailable: "This conversation does not yet have saved native history.",
  fork_configuration_unavailable: "The original launch configuration is unavailable.",
  fork_execution_context_unavailable:
    "This conversation has an execution-owned browser or artifact context that cannot yet be copied safely.",
};
export function ForkControl({
  connection,
  threadId,
  title,
}: {
  connection: ChatConnection;
  threadId: string;
  title: string;
}) {
  const call = connection.call;
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [preview, setPreview] = useState<Row>();
  const [destinations, setDestinations] = useState<Row[]>([]);
  const [destination, setDestination] = useState("");
  const [method, setMethod] = useState("");
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const attempt = useRef<string | undefined>(undefined);
  const attemptKey = `native-fork-attempt:${threadId}`;
  const openThread = useShell((s) => s.openThread);
  useEffect(() => {
    if (!open) return;
    setError("");
    const saved = sessionStorage.getItem(attemptKey);
    if (saved) {
      const pending = JSON.parse(saved) as {
        id: string;
        title: string;
        destination?: string;
        kind?: string;
      };
      attempt.current = pending.id;
      setName(pending.title);
      setDestination(pending.destination ?? "");
      setMethod(pending.kind ?? "native");
    } else {
      attempt.current = undefined;
      setName(`${title} · fork`);
      setDestination("");
      setMethod("");
    }
  }, [open, title, attemptKey]);
  useEffect(() => {
    if (!open) return;
    let live = true;
    setPreview(undefined);
    call("thread.forkPreview", {
      id: threadId,
      ...(destination ? { destinationProfileId: destination } : {}),
      ...(method ? { kind: method } : {}),
    })
      .then((value) => {
        if (live) {
          setPreview(value as Row);
          setDestinations(((value as Row).destinations ?? []) as Row[]);
        }
      })
      .catch(() => {
        if (live) setError("Fork availability could not be checked.");
      });
    return () => {
      live = false;
    };
  }, [call, open, threadId, destination, method]);
  async function create() {
    setWorking(true);
    setError("");
    attempt.current ??= crypto.randomUUID();
    sessionStorage.setItem(
      attemptKey,
      JSON.stringify({
        id: attempt.current,
        title: name,
        destination,
        kind: method || text(preview?.kind),
      }),
    );
    try {
      const operation = (await connection.call(
        "thread.fork",
        {
          id: threadId,
          title: name,
          ...(destination ? { destinationProfileId: destination } : {}),
          kind: method || text(preview?.kind),
        },
        attempt.current,
      )) as Row;
      if (operation.state !== "ready") {
        setError(
          "Native creation could not be confirmed. The attempt is saved for reconciliation; retrying this attempt will not create another fork.",
        );
        return;
      }
      sessionStorage.removeItem(attemptKey);
      attempt.current = undefined;
      setOpen(false);
      openThread(text(operation.childThreadId));
    } catch {
      setError("Forking could not be confirmed. Retry uses the same saved attempt.");
    } finally {
      setWorking(false);
    }
  }
  return (
    <>
      <button
        className="btn sm"
        type="button"
        onClick={() => setOpen(true)}
        disabled={connection.status !== "online"}
      >
        Fork conversation
      </button>
      {open ? (
        <Dialog
          open
          title="Fork conversation"
          description="Create an independent conversation in the coding tool you choose. Both chats use the current files in this folder."
          onClose={() => {
            if (!working) setOpen(false);
          }}
          actions={
            <>
              <button
                className="btn"
                type="button"
                onClick={() => setOpen(false)}
                disabled={working}
              >
                Cancel
              </button>
              <button
                className="btn primary"
                type="button"
                onClick={() => void create()}
                disabled={
                  working ||
                  (!attempt.current && preview?.available !== true) ||
                  !name.trim() ||
                  connection.status !== "online"
                }
              >
                {working
                  ? "Forking…"
                  : attempt.current
                    ? "Check saved attempt"
                    : preview?.kind === "copied"
                      ? "Create copied-context fork"
                      : "Create native fork"}
              </button>
            </>
          }
        >
          <div className="fork-form">
            <label>
              Destination coding tool
              <select
                value={destination}
                disabled={working || !!attempt.current}
                onChange={(e) => setDestination(e.target.value)}
              >
                <option value="">Same coding tool and profile</option>
                {destinations.map((p) => (
                  <option key={text(p.id)} value={text(p.id)}>
                    {text(p.name)} · {text(p.tool)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Fork method
              <select
                value={method}
                disabled={working || !!attempt.current}
                onChange={(e) => setMethod(e.target.value)}
              >
                <option value="">Automatic (prefer native)</option>
                <option value="native">Native conversation state</option>
                <option value="copied">Copy visible context</option>
              </select>
            </label>
            {preview?.available === true ? (
              <output aria-live="polite">
                {preview.kind === "copied"
                  ? `Copied-context fork: ${Number(preview.copiedMessages)} visible message${Number(preview.copiedMessages) === 1 ? "" : "s"} will be sent as reference material with your first new message. ${Number(preview.omittedMessages)} older messages omitted. Internal reasoning, attachments and tool state are not copied.`
                  : "Native fork: preserves this coding tool’s conversation state without replaying messages."}
              </output>
            ) : null}
            <label>
              Conversation name
              <input
                value={name}
                disabled={working || !!attempt.current}
                onChange={(e) => setName(e.target.value)}
                maxLength={200}
              />
            </label>
            <p>{text(preview?.cwd)}</p>
            {preview?.available === false ? (
              <output aria-live="polite">
                {reasons[text(preview.reason)] ??
                  "Forking is currently unavailable for this conversation and destination."}
              </output>
            ) : !preview ? (
              <output aria-live="polite">Checking fork options…</output>
            ) : null}
            {error ? <p role="alert">{error}</p> : null}
          </div>
        </Dialog>
      ) : null}
    </>
  );
}
export function ForkHistory({
  connection,
  threadId,
  provenance,
}: {
  connection: ChatConnection;
  threadId: string;
  provenance: Row;
}) {
  const call = connection.call;
  const [items, setItems] = useState<Row[]>();
  const [error, setError] = useState(false);
  const [operation, setOperation] = useState<Row>();
  const operationId = text(provenance.operationId);
  const openThread = useShell((s) => s.openThread);
  useEffect(() => {
    let live = true;
    setItems(undefined);
    setError(false);
    Promise.all([
      call("thread.forkHistory", { id: threadId }),
      call("thread.forkGet", { id: operationId }),
    ])
      .then(([history, saved]) => {
        if (live) {
          setItems((history as { items: Row[] }).items);
          setOperation(saved as Row);
        }
      })
      .catch(() => {
        if (live) setError(true);
      });
    return () => {
      live = false;
    };
  }, [call, threadId, operationId]);
  return (
    <>
      {operation && operation.state !== "ready" ? (
        <p role="alert">
          This fork needs reconciliation before messages can be sent. Its native creation will not
          be repeated automatically.
        </p>
      ) : null}
      <details className="zb-card fork-history">
        <summary>
          {provenance.kind === "copied"
            ? "Copied conversation · read only"
            : "Inherited conversation · read only"}
        </summary>
        <button
          className="btn sm"
          type="button"
          onClick={() => openThread(text(provenance.sourceThreadId))}
        >
          Open original conversation
        </button>
        <p>
          {provenance.kind === "copied"
            ? `Copied-context fork. ${Number(provenance.copiedMessages)} visible message${Number(provenance.copiedMessages) === 1 ? " is" : "s are"} included as reference material with your first new message; ${Number(provenance.omittedMessages)} older messages are omitted. Attachments, internal reasoning and tool state are not copied. Files remain at their current state.`
            : "Native fork. Files remain at their current state. These messages are display history and are not sent to the coding tool again."}
        </p>
        {error ? (
          <p role="alert">Inherited history could not be loaded.</p>
        ) : items ? (
          items.map((item) => (
            <div className="fork-history-row" key={`${text(item.threadId)}:${text(item.id)}`}>
              <small>{text(item.kind)}</small>
              <Markdown value={text(body(item).text) || JSON.stringify(item.body)} />
            </div>
          ))
        ) : (
          <p>Loading inherited history…</p>
        )}
      </details>
    </>
  );
}
