import { useEffect, useId, useRef, useState } from "react";
import { Dialog } from "../components/primitives.js";
import { useShell } from "../state.js";
import { type RewindPreview, rewindPreview } from "./parity-data.js";
import { DiffCounts } from "./tools/DiffView.js";
import { body, type ChatConnection, type Row, text } from "./types.js";
import "./parity.css";

/** The text you typed for a message, joined the way the composer sent it. */
export function messageText(item: Row) {
  const input = body(item).input;
  return Array.isArray(input)
    ? (input as Row[])
        .filter((part) => part.type === "text")
        .map((part) => text(part.text))
        .join("\n")
    : "";
}

const reasons: Record<string, string> = {
  fork_requires_idle: "Finish or stop the current work and answer pending requests first.",
  fork_history_limit: "This conversation is too large to copy up to here.",
  copied_history_unavailable: "There is no visible history before this message to copy.",
  fork_boundary_unavailable: "This message can no longer be used as a starting point.",
};

/**
 * T3's "edit from here": a new chat starts with the conversation up to this message and sends the
 * edited text. This chat stays as it is. Restoring files is a separate, explicit choice (I13),
 * because both chats share the same folder.
 */
export function EditDialog({
  connection,
  threadId,
  title,
  item,
  sessionId,
  onClose,
}: {
  connection: ChatConnection;
  threadId: string;
  title: string;
  item: Row;
  /** Present when the session can restore files to before this message. */
  sessionId?: string | undefined;
  onClose(): void;
}) {
  const openThread = useShell((state) => state.openThread);
  const turnId = text(item.turnId);
  const ids = useId();
  const [draft, setDraft] = useState(() => messageText(item)),
    [restore, setRestore] = useState(true),
    [files, setFiles] = useState<RewindPreview>(),
    [blocked, setBlocked] = useState(""),
    [working, setWorking] = useState(false),
    [error, setError] = useState("");
  const attempt = useRef<string | undefined>(undefined);
  useEffect(() => {
    const boundary = { kind: "before_user", turnId };
    let live = true;
    connection
      .call("thread.forkPreview", { id: threadId, kind: "copied", boundary })
      .then((value) => {
        const row = value as Row;
        if (live && row.available === false)
          setBlocked(reasons[text(row.reason)] ?? "A new chat cannot start from this message.");
      })
      .catch(() => {
        if (live) setBlocked("A new chat cannot start from this message right now.");
      });
    if (sessionId)
      connection
        .call(
          "session.rewind",
          { id: sessionId, turnId, dryRun: true, confirmed: false },
          crypto.randomUUID(),
        )
        .then((value) => {
          if (live) setFiles(rewindPreview(value));
        })
        .catch(() => {
          if (live) setFiles({ canRewind: false, files: [], error: "preview_failed" });
        });
    return () => {
      live = false;
    };
  }, [connection, threadId, turnId, sessionId]);
  const restorable = !!files?.canRewind && !files.error && files.files.length > 0;
  const send = async () => {
    attempt.current ??= crypto.randomUUID();
    setWorking(true);
    setError("");
    try {
      if (restorable && restore && sessionId) {
        const result = rewindPreview(
          await connection.call(
            "session.rewind",
            { id: sessionId, turnId, dryRun: false, confirmed: true },
            `${attempt.current}:rewind`,
          ),
        );
        if (!result.canRewind || result.error) throw new Error("rewind_failed");
      }
      const operation = (await connection.call(
        "thread.fork",
        {
          id: threadId,
          title: `${title} · edited`,
          kind: "copied",
          boundary: { kind: "before_user", turnId },
        },
        `${attempt.current}:fork`,
      )) as Row;
      const child = text(operation.childThreadId);
      if (operation.state !== "ready" || !child) throw new Error("fork_not_ready");
      await connection.call(
        "turn.send",
        { threadId: child, input: [{ type: "text", text: draft.trim() }], mode: "queue" },
        `${attempt.current}:send`,
      );
      onClose();
      openThread(child);
    } catch {
      setError(
        "The new chat could not be confirmed. Trying again reuses the same attempt, so it will not start a second chat.",
      );
    } finally {
      setWorking(false);
    }
  };
  return (
    <Dialog
      open
      title="Edit and send again"
      description="A new chat starts with the conversation up to this message, then sends your edit. This chat stays as it is."
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
            className="btn pri"
            disabled={working || !!blocked || !draft.trim() || connection.status !== "online"}
            onClick={() => void send()}
          >
            {working ? "Starting…" : "Send in a new chat"}
          </button>
        </>
      }
    >
      <div className="chat-edit">
        <label htmlFor={`${ids}-text`}>Message</label>
        <textarea
          id={`${ids}-text`}
          value={draft}
          rows={5}
          autoFocus
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              if (!working && !blocked && draft.trim()) void send();
            }
          }}
        />
        {restorable ? (
          <label className="chat-edit-restore">
            <input
              type="checkbox"
              checked={restore}
              onChange={(event) => setRestore(event.target.checked)}
            />
            <span>
              Restore files to before this message
              <span className="dim">
                {" "}
                · {files.files.length} file{files.files.length === 1 ? "" : "s"}
                {files.insertions !== undefined || files.deletions !== undefined ? (
                  <>
                    {" "}
                    <DiffCounts added={files.insertions ?? 0} removed={files.deletions ?? 0} />
                  </>
                ) : null}
              </span>
              <span className="dim chat-edit-note">
                Both chats share this folder, so this chat sees the restored files too.
              </span>
            </span>
          </label>
        ) : null}
        {blocked ? <p className="chat-error">{blocked}</p> : null}
        {error ? (
          <p className="chat-error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}
