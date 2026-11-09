import { useState } from "react";
import { Button } from "../components/primitives.js";
import { useShell } from "../state.js";
import { threadResults } from "./results-data.js";
import type { ChatConnection } from "./types.js";
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
  const data = threadResults(connection.snapshot.entities, threadId);
  const thread = connection.snapshot.entities.thread?.find((row) => row.id === threadId);
  if (!data.complete || thread?.archived || thread?.archiveWhenIdle) return null;
  const hasResults = !!(
    data.artifacts.length ||
    data.diffs.length ||
    data.links.length ||
    data.result
  );
  return (
    <section className="chat-completion" aria-label="Completed work">
      <strong>{data.task?.state === "review" ? "Ready to review" : "Turn complete"}</strong>
      <div className="r wrap">
        {hasResults && onResults ? (
          <Button size="sm" onClick={onResults}>
            View results
          </Button>
        ) : null}
        {data.task ? (
          <Button size="sm" onClick={() => useShell.getState().navigate("Tasks")}>
            Review task
          </Button>
        ) : (
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
        )}
      </div>
      {error ? <p role="alert">{error}</p> : null}
    </section>
  );
}
