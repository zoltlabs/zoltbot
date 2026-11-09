import { useEffect, useRef, useState } from "react";
import { Dialog } from "../components/primitives.js";
import { type RewindPreview, rewindPreview } from "./parity-data.js";
import { DiffCounts } from "./tools/DiffView.js";
import type { ChatConnection } from "./types.js";
import "./parity.css";

/**
 * I13: restoring files discards work. The dry run shows what changes; Cancel is the default and a
 * real restore sends confirmed: true only from an explicit choice. Forking the conversation from
 * here waits for a daemon thread.fork handler (BL-011).
 */
export function RewindDialog({
  connection,
  sessionId,
  turnId,
  onClose,
}: {
  connection: ChatConnection;
  sessionId: string;
  turnId: string;
  onClose(): void;
}) {
  const [preview, setPreview] = useState<RewindPreview>(),
    [loading, setLoading] = useState(true),
    [working, setWorking] = useState(false),
    [error, setError] = useState("");
  const attempt = useRef<string | undefined>(undefined);
  useEffect(() => {
    let live = true;
    setLoading(true);
    connection
      .call(
        "session.rewind",
        { id: sessionId, turnId, dryRun: true, confirmed: false },
        crypto.randomUUID(),
      )
      .then((value) => {
        if (live) setPreview(rewindPreview(value));
      })
      .catch(() => {
        if (live) setPreview({ canRewind: false, files: [], error: "preview_failed" });
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [connection, sessionId, turnId]);
  const restore = async () => {
    attempt.current ??= crypto.randomUUID();
    setWorking(true);
    setError("");
    try {
      const result = rewindPreview(
        await connection.call(
          "session.rewind",
          { id: sessionId, turnId, dryRun: false, confirmed: true },
          attempt.current,
        ),
      );
      if (!result.canRewind || result.error) throw new Error(result.error ?? "rewind_failed");
      onClose();
    } catch {
      setError("Restoring could not be confirmed. Review your files before trying again.");
    } finally {
      setWorking(false);
    }
  };
  const restorable = !!preview?.canRewind && !preview.error;
  const busy = loading || working || connection.status !== "online";
  return (
    <Dialog
      open
      title="Rewind to before this message"
      description="Restore your files to how they were before this message. The conversation stays as it is."
      onClose={() => {
        if (!working) onClose();
      }}
      actions={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={working}>
            Cancel
          </button>
          <button
            type="button"
            className="btn chat-danger-fill"
            disabled={busy || !restorable}
            onClick={() => void restore()}
          >
            {working ? "Restoring…" : "Restore code"}
          </button>
        </>
      }
    >
      <div className="chat-rewind-preview" aria-live="polite" aria-busy={loading}>
        {loading ? (
          <p>Checking which files would change…</p>
        ) : !preview || preview.error || !preview.canRewind ? (
          <p>
            {preview?.error === "preview_failed"
              ? "The file preview could not be loaded. Nothing was changed."
              : "Files cannot be restored to this point."}
          </p>
        ) : preview.files.length ? (
          <>
            <p>
              {preview.files.length} file{preview.files.length === 1 ? "" : "s"} will be restored
              {preview.insertions !== undefined || preview.deletions !== undefined ? (
                <>
                  {" "}
                  <DiffCounts added={preview.insertions ?? 0} removed={preview.deletions ?? 0} />
                </>
              ) : null}
              . Changes made after this message are discarded.
            </p>
            <ul className="chat-rewind-files">
              {preview.files.map((file) => (
                <li key={file} className="mono truncate" title={file}>
                  {file}
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p>No tracked files changed after this message.</p>
        )}
        {error ? (
          <p className="chat-error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}
