import { parse, terms, type Wake, WakeSchema } from "@zoltbot/protocol";
import { type ChatConnection, type Row, text } from "../chat/types.js";
import { chiefThreadId } from "../chief/data.js";
import {
  ChatRowShell,
  createThreadActions,
  isManageableThread,
} from "../components/ChatRowActions.js";
import { Button, EmptyState, ListRow } from "../components/primitives.js";
import { ago, isThreadUnread, type RowStatus, scopeLabel } from "../workspaces/activity.js";
import "../chat/wakes.css";

/** Every chat, newest first, with where it lives; the Overview only shows the recent few. */
export function AllChats({
  threads,
  projects,
  wakes = [],
  directions,
  connection,
  turns,
  rowStatuses,
  openThread,
  openQuickChat,
}: {
  threads: Row[];
  projects: Row[];
  wakes?: Row[];
  directions: Row[];
  connection?: ChatConnection;
  turns?: Row[];
  rowStatuses?: Map<string, RowStatus>;
  openThread(id: string): void;
  openQuickChat(): void;
}) {
  const chiefId = connection ? chiefThreadId(connection.snapshot.entities) : undefined;
  const compareMembers = connection?.snapshot.entities.compareMember;
  const waits = wakes
    .map((w) => parse(WakeSchema, w))
    .filter(
      (w) =>
        ["waiting", "ready", "needs_attention"].includes(w.status) &&
        threads.some((t) => t.id === w.threadId && !t.archived),
    )
    .sort((a, b) => Date.parse(a.fallbackAt) - Date.parse(b.fallbackAt));
  const waitingIds = new Set(waits.map((w) => w.threadId));
  const rows = threads
    .filter(
      (thread) => !thread.archived && thread.kind !== "task" && !waitingIds.has(String(thread.id)),
    )
    .sort(
      (a, b) =>
        Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) ||
        text(b.lastActivityAt).localeCompare(text(a.lastActivityAt)),
    );
  return (
    <section className="zb-card recent-work">
      <h1>All {terms.chat.many}</h1>
      {waits.length ? (
        <details className="wake-waiting">
          <summary>Waiting ({waits.length})</summary>
          <ul>
            {waits.map((wake: Wake) => (
              <li key={wake.id}>
                <button className="btn" type="button" onClick={() => openThread(wake.threadId)}>
                  {text(threads.find((t) => t.id === wake.threadId)?.title) || "Chat"}
                </button>
                <p>{wake.label}</p>
                <p className="dim sm">
                  Fallback: {new Date(wake.fallbackAt).toLocaleString()}
                  {wake.status === "needs_attention" ? " · Needs attention" : ""}
                </p>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {rows.length ? (
        <div className="recent-list">
          {rows.map((thread) => {
            const id = text(thread.id);
            const label = text(thread.title) || terms.chat.One;
            const rowStatus = rowStatuses?.get(id);
            const unread = isThreadUnread(rowStatus);
            return (
              <ChatRowShell
                key={id}
                className="recent-row-shell"
                title={label}
                enabled={
                  Boolean(connection) && isManageableThread(thread, { compareMembers, chiefId })
                }
                actions={
                  connection
                    ? createThreadActions({
                        thread,
                        rowStatus,
                        turns,
                        call: connection.call,
                      })
                    : undefined
                }
              >
                <ListRow
                  icon="Sessions"
                  label={label}
                  trailing={
                    <>
                      {unread ? <span className="chat-unread-badge">Unread</span> : null}
                      <span className="dim">
                        {scopeLabel(thread, projects, directions) ||
                          `Not in a ${terms.workspace.one}`}
                        {thread.lastActivityAt ? ` · ${ago(thread.lastActivityAt)}` : ""}
                      </span>
                    </>
                  }
                  onClick={() => openThread(id)}
                />
              </ChatRowShell>
            );
          })}
        </div>
      ) : !waits.length ? (
        <EmptyState
          icon="Sessions"
          title={`No ${terms.chat.many} yet`}
          action={<Button onClick={openQuickChat}>Start a quick chat</Button>}
        >
          Ask something in Quick chat, or open a {terms.workspace.one} and start a {terms.chat.one}.
        </EmptyState>
      ) : null}
    </section>
  );
}
