import { useState } from "react";
import { Button } from "../components/primitives.js";
import { useShell } from "../state.js";
import { completionReceipt } from "./completion-data.js";
import { DiffDialog } from "./tools/DiffDialog.js";
import type { ChatConnection } from "./types.js";
import { waitingState } from "./waiting-state.js";
import "./results.css";

/** One end-of-turn action surface shared by chat and the Inbox's letter view. */
export function CompletionCard({
  connection,
  threadId,
  onResults,
}: {
  connection: ChatConnection;
  threadId: string;
  onResults?: (() => void) | undefined;
}) {
  const [pending, setPending] = useState(false),
    [error, setError] = useState("");
  const [changes, setChanges] = useState(false);
  const data = completionReceipt(connection.snapshot.entities, threadId);
  const thread = connection.snapshot.entities.thread?.find((row) => row.id === threadId);
  if (
    !data.visible ||
    thread?.archived ||
    thread?.archiveWhenIdle ||
    waitingState(connection.snapshot.entities, threadId, connection.status)
  )
    return null;
  return (
    <section className="chat-completion" aria-label="Completed work">
      <strong>{data.summary}</strong>
      <div className="r wrap">
        {data.action === "changes" || onResults ? (
          <Button
            size="sm"
            onClick={data.action === "changes" ? () => setChanges(true) : onResults}
          >
            {data.actionLabel}
          </Button>
        ) : null}
        {data.task ? (
          <Button size="sm" onClick={() => useShell.getState().navigate("Tasks")}>
            Review task
          </Button>
        ) : (
          <details className="completion-actions">
            <summary>More actions</summary>
            <Button
              size="sm"
              disabled={pending || connection.status !== "online"}
              onClick={async () => {
                setPending(true);
                setError("");
                try {
                  await connection.call("thread.settle", { id: threadId }, crypto.randomUUID());
                } catch {
                  setError("Could not archive. Try again.");
                } finally {
                  setPending(false);
                }
              }}
            >
              {pending ? "Archiving…" : "Archive"}
            </Button>
          </details>
        )}
      </div>
      {error ? <p role="alert">{error}</p> : null}
      {changes ? (
        <DiffDialog
          title="Latest turn changes"
          diffs={data.diffs}
          onClose={() => setChanges(false)}
        />
      ) : null}
    </section>
  );
}
