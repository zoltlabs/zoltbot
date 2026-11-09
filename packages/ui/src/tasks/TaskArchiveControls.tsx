import { useRef, useState } from "react";
import { type ChatConnection, type Row, text } from "../chat/types.js";
import { Button } from "../components/primitives.js";
export function TaskArchiveControls({
  task,
  connection,
}: {
  task: Row;
  connection: ChatConnection;
}) {
  const [confirming, setConfirming] = useState(false),
    [pending, setPending] = useState(false),
    [message, setMessage] = useState("");
  const trigger = useRef<HTMLButtonElement>(null);
  if (task.state !== "completed") return null;
  const archive = connection.snapshot.entities.settings?.find(
    (row) => row.key === `worktree.archive.${text(task.id)}`,
  )?.value as Row | undefined;
  const archived = archive?.state === "archived";
  return (
    <div>
      <Button
        ref={trigger}
        aria-disabled={pending || connection.status !== "online"}
        onClick={() => {
          if (pending || connection.status !== "online") return;
          setConfirming(true);
        }}
      >
        {archived ? "Restore worktree…" : "Archive worktree…"}
      </Button>
      {confirming ? (
        <section aria-label={archived ? "Restore worktree" : "Archive worktree"}>
          <p>
            {archived
              ? "Restore the verified snapshot to its original managed location."
              : "Save a verified Git bundle before removing this managed checkout. Create a review commit first to preserve changed and untracked files. Ignored files and active sessions block removal. You can keep the worktree by cancelling."}
          </p>
          <div className="r wrap">
            <Button
              aria-disabled={pending}
              onClick={async () => {
                if (pending) return;
                setPending(true);
                setMessage("");
                try {
                  await connection.call(
                    archived ? "task.restoreWorkspace" : "task.archiveWorkspace",
                    { id: task.id, confirmed: true },
                    crypto.randomUUID(),
                  );
                  setMessage(
                    archived
                      ? "Worktree restored."
                      : "Verified snapshot saved. Managed checkout archived.",
                  );
                  setConfirming(false);
                  trigger.current?.focus();
                } catch (error) {
                  const code = (error instanceof Error ? error.message : "").split(":")[0];
                  setMessage(
                    code === "close_session_before_archive"
                      ? "Close the native session before archiving. Your checkout is unchanged."
                      : "Archiving or restoring is blocked. Preserve dirty and ignored files, inspect the worktree, then try again. Existing work is kept.",
                  );
                } finally {
                  setPending(false);
                }
              }}
            >
              Confirm {archived ? "restore" : "archive"}
            </Button>
            <Button
              onClick={() => {
                setConfirming(false);
                trigger.current?.focus();
              }}
            >
              Keep worktree
            </Button>
          </div>
        </section>
      ) : null}
      <p aria-live="polite">{pending ? "Verifying snapshot…" : message}</p>
    </div>
  );
}
