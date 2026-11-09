import { useState } from "react";
import { type ChatConnection, text } from "../chat/types.js";
import { Dialog } from "../components/primitives.js";
import { useCompareActions } from "./compare-actions.js";
export function CompareCeiling({
  connection,
  threadId,
}: {
  connection: ChatConnection;
  threadId: string;
}) {
  const [confirm, setConfirm] = useState(false),
    actions = useCompareActions(connection);
  const e = connection.snapshot.entities,
    member = e.compareMember?.find((r) => r.threadId === threadId),
    group = e.compare?.find((r) => r.id === member?.compareId);
  const thread = e.thread?.find((r) => r.id === threadId),
    profile = e.agent?.find((r) => r.id === thread?.agentId);
  const permission =
    profile?.permissionProfile === "full_access"
      ? "full access to files and commands"
      : profile?.permissionProfile === "workspace_write"
        ? "file edits in this workspace"
        : "read-only access";
  const summary = e.compare?.some((r) => r.summaryThreadId === threadId);
  if (!summary && (!member || member.ceiling !== "read_only")) return null;
  return (
    <div className="compare-ceiling">
      <span>Compare · Read only: no file edits</span>
      {member && group && group.state !== "open" ? (
        <button
          className="btn sm"
          type="button"
          disabled={actions.busy || connection.status !== "online"}
          onClick={() => setConfirm(true)}
        >
          Allow profile permissions…
        </button>
      ) : null}
      {actions.error ? <p role="alert">{actions.error}</p> : null}
      <Dialog
        open={confirm}
        title="Allow this profile’s permissions?"
        description={`${text(profile?.name) || "This profile"} will have ${permission} on the next connection. Your confirmation is recorded in the audit log. The current native session stays read-only.`}
        onClose={() => setConfirm(false)}
        actions={
          <>
            <button type="button" className="btn" onClick={() => setConfirm(false)}>
              Cancel
            </button>
            <button
              type="button"
              className="btn pri"
              disabled={actions.busy}
              onClick={() => {
                void actions
                  .run("compare.widen", { id: text(member?.compareId), threadId, confirmed: true })
                  .then((ok) => {
                    if (ok) setConfirm(false);
                  });
              }}
            >
              Confirm profile permissions
            </button>
          </>
        }
      />
    </div>
  );
}
