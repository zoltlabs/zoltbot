import { useRef, useState } from "react";
import { body, type ChatConnection, type Row, text } from "./types.js";

function preview(item: Row) {
  const input = body(item).input;
  if (!Array.isArray(input)) return "Message";
  return (
    (input as Row[])
      .map((part) =>
        part.type === "text"
          ? text(part.text)
          : `${part.type === "image" ? "Image" : "File"}: ${text(part.path).split(/[\\/]/).at(-1) || "Attachment"}`,
      )
      .join(" ") || "Message"
  );
}
export function QueueStrip({
  connection,
  threadId,
  items,
}: {
  connection: ChatConnection;
  threadId: string;
  items: Row[];
}) {
  const [pending, setPending] = useState(new Set<string>()),
    [error, setError] = useState("");
  const attempts = useRef(new Map<string, string>());
  return (
    <section className="chat-queue" aria-label="Queued messages">
      <div className="r">
        <strong>
          {items.length} message{items.length === 1 ? "" : "s"} waiting
        </strong>
      </div>
      {error ? <p role="alert">{error}</p> : null}
      <ul>
        {items.map((item) => {
          const id = text(item.id),
            value = body(item),
            label = preview(item);
          return (
            <li key={id}>
              <span className="truncate" title={label}>
                {label}
              </span>
              <span>
                {value.queueState === "uncertain"
                  ? "Delivery needs review"
                  : value.queueState === "sending"
                    ? "Sending"
                    : "Queued"}
              </span>
              <button
                type="button"
                className="btn sm"
                aria-label={`Remove queued message ${item.seq}`}
                title={
                  value.queueState === "queued"
                    ? "Cancel before delivery starts"
                    : "Delivery may have started. Review its state before continuing."
                }
                disabled={
                  value.queueState !== "queued" || pending.has(id) || connection.status !== "online"
                }
                onClick={async () => {
                  const commandId = attempts.current.get(id) ?? crypto.randomUUID();
                  attempts.current.set(id, commandId);
                  setPending((previous) => new Set([...previous, id]));
                  setError("");
                  try {
                    await connection.call("turn.cancelQueued", { threadId, id }, commandId);
                  } catch {
                    setError(
                      "Cancellation could not be confirmed. Review the message's current delivery state.",
                    );
                  } finally {
                    setPending((previous) => {
                      const next = new Set(previous);
                      next.delete(id);
                      return next;
                    });
                  }
                }}
              >
                {pending.has(id) ? "Removing…" : "Remove"}
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
