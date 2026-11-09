import { useId, useRef, useState } from "react";
import { type ChatConnection, type Row, text } from "../chat/types.js";
import { Button } from "../components/primitives.js";
import "./changes.css";
import { ChangesWorkspace } from "./ChangesWorkspace.js";
import { TaskArchiveControls } from "./TaskArchiveControls.js";

const reasons: Record<string, string> = {
  partial_staging_requires_resolution:
    "A file has both staged and unstaged edits. Resolve its staging in the task worktree before creating a review commit; both variants are preserved.",
  destination_dirty: "The destination has local changes. Commit them there, then check again.",
  integration_preview_stale: "The destination moved. Check the updated proposal and confirm again.",
  update_task_from_destination_required:
    "Update this task from the destination in its worktree, resolve conflicts there, then request a new review. The destination is unchanged.",
  review_preview_stale:
    "Files or Git configuration changed. Inspect a new preview before continuing.",
  git_identity_required:
    "Configure your Git author and committer identity before creating a review commit.",
  review_execution_approval_required:
    "Approve the pending Git execution request in the inbox, then continue here.",
  review_files_excluded:
    "Some files are excluded. Remove or ignore them in the task worktree before creating a review commit.",
  review_commit_required: "Create a review commit for this task revision before integrating.",
  source_changed_since_review:
    "The source changed since review. Create and review its latest commit.",
  hook_execution_approval_required:
    "A Git hook requires host execution approval. Your work is preserved.",
};
export function TaskChangesSection({
  task,
  connection,
}: {
  task: Row;
  connection: ChatConnection;
}) {
  const unavailableId = useId();
  const proposalTrigger = useRef<HTMLButtonElement>(null);
  const [changes, setChanges] = useState<Row>();
  const [proposal, setProposal] = useState<{ kind: "reviewCommit" | "integrate"; value: Row }>();
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [pending, setPending] = useState(false);
  if (task.workspaceMode !== "worktree") return null;
  const unavailable = pending || connection.status !== "online";
  async function call(method: string, params: Row = {}) {
    if (unavailable) return;
    setPending(true);
    setError("");
    setNotice("");
    try {
      return (await connection.call(
        method,
        { id: task.id, ...params },
        crypto.randomUUID(),
      )) as Row;
    } catch (problem) {
      const message = problem instanceof Error ? problem.message : "";
      const code = message.split(":")[0] ?? "";
      setError(
        code === "destination_dirty" && message.includes(".zoltbot/")
          ? `${reasons[code]} ${message.slice(message.indexOf(":") + 1, 1600).trim()}`
          : (reasons[code] ??
              "The operation could not finish. Your work is preserved. Inspect the worktree and try again."),
      );
    } finally {
      setPending(false);
    }
  }
  return (
    <section className="task-changes" aria-label="Changes">
      <h4>Changes</h4>
      <p className="dim sm">Validation result: Not reported.</p>
      <p className="dim">Separate worktree · Accepting the result keeps these changes here.</p>
      <div className="r wrap">
        <Button
          aria-disabled={unavailable}
          aria-describedby={unavailable ? unavailableId : undefined}
          onClick={async () => {
            const result = await call("task.changes");
            if (result) setChanges({ ...result, taskId: task.id });
          }}
        >
          Inspect changes
        </Button>
        {["review", "completed"].includes(text(task.state)) ? (
          <Button
            aria-disabled={unavailable}
            aria-describedby={unavailable ? unavailableId : undefined}
            onClick={async (event) => {
              proposalTrigger.current = event.currentTarget;
              const result = await call("task.reviewCommitPreview");
              if (result) setProposal({ kind: "reviewCommit", value: result });
            }}
          >
            Create review commit…
          </Button>
        ) : null}
        {task.state === "completed" ? (
          <Button
            aria-disabled={unavailable}
            aria-describedby={unavailable ? unavailableId : undefined}
            onClick={async (event) => {
              proposalTrigger.current = event.currentTarget;
              const result = await call("task.integrationPreview");
              if (result) setProposal({ kind: "integrate", value: result });
            }}
          >
            Integrate changes…
          </Button>
        ) : null}
      </div>
      <TaskArchiveControls task={task} connection={connection} />
      {unavailable ? (
        <p id={unavailableId} className="dim sm">
          {pending
            ? "Git checks are in progress."
            : "Reconnect to the local daemon to use Git actions."}
        </p>
      ) : null}
      <div aria-live="polite">{pending ? "Checking Git state…" : error || notice}</div>
      {changes && changes.taskId === task.id ? (
        <ChangesWorkspace key={text(task.id)} changes={changes} />
      ) : null}
      {proposal ? (
        <section
          className="zb-card"
          aria-label={
            proposal.kind === "reviewCommit" ? "Review commit preview" : "Integration preview"
          }
        >
          <h4>
            {proposal.kind === "reviewCommit"
              ? "Create review commit"
              : "Integrate into destination"}
          </h4>
          {proposal.kind === "reviewCommit" ? (
            <>
              <p>
                Only these exact files will be staged. Git uses your configured identity. Hooks,
                clean filters and signing programs require execution approval in the inbox.
              </p>
              <p>
                Current source <code>{text(proposal.value.head)}</code>. Existing commits are
                included in the cumulative review from the original base.
              </p>
              <ul>
                {((proposal.value.committedPaths as string[] | undefined) ?? []).map((file) => (
                  <li key={file}>
                    <code>{file}</code> · Already committed
                  </li>
                ))}
              </ul>
              <ul>
                {(proposal.value.files as Row[]).map((file) => (
                  <li key={text(file.path)}>
                    <code>{text(file.path)}</code>
                    {file.excluded ? ` · Excluded: ${text(file.excluded)}` : ""}
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <>
              <p>
                Source <code>{text(proposal.value.sourceCommit)}</code>
              </p>
              <p>
                Destination <code>{text(proposal.value.destination)}</code> ·{" "}
                <code>{text(proposal.value.branch)}</code>
              </p>
              <p>
                Current head <code>{text(proposal.value.destinationHead)}</code>. A recovery ref
                will retain this commit.
              </p>
              <ul>
                {(proposal.value.paths as string[]).map((file) => (
                  <li key={file}>
                    <code>{file}</code>
                  </li>
                ))}
              </ul>
            </>
          )}
          <div className="r wrap">
            <Button
              aria-disabled={unavailable}
              aria-describedby={unavailable ? unavailableId : undefined}
              onClick={async () => {
                const result = await call(`task.${proposal.kind}`, {
                  fingerprint: proposal.value.fingerprint,
                  confirmed: true,
                });
                if (!result) return;
                if (result.pendingApproval) {
                  setNotice(
                    "Git execution approval is waiting in the inbox. Approve it, then press Confirm again.",
                  );
                  return;
                }
                setNotice(
                  result.backupRef
                    ? `Integrated. Recovery ref: ${text(result.backupRef)}`
                    : `Review commit created: ${text(result.head)}`,
                );
                setProposal(undefined);
              }}
            >
              Confirm {proposal.kind === "reviewCommit" ? "review commit" : "integration"}
            </Button>
            <Button
              onClick={() => {
                setProposal(undefined);
                proposalTrigger.current?.focus();
              }}
            >
              Cancel
            </Button>
          </div>
        </section>
      ) : null}
    </section>
  );
}
