import { parse, terms, type Wake, WakeSchema } from "@zoltbot/protocol";
import { type Row, text } from "../chat/types.js";
import { Button, EmptyState, ListRow } from "../components/primitives.js";
import { ago, scopeLabel } from "../workspaces/activity.js";
import "../chat/wakes.css";

/** Every chat, newest first, with where it lives; the Overview only shows the recent few. */
export function AllChats({
  threads,
  projects,
  wakes = [],
  directions,
  openThread,
  openQuickChat,
}: {
  threads: Row[];
  projects: Row[];
  wakes?: Row[];
  directions: Row[];
  openThread(id: string): void;
  openQuickChat(): void;
}) {
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
    .sort((a, b) => text(b.lastActivityAt).localeCompare(text(a.lastActivityAt)));
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
          {rows.map((thread) => (
            <ListRow
              key={text(thread.id)}
              icon="Sessions"
              label={text(thread.title) || terms.chat.One}
              trailing={
                <span className="dim">
                  {scopeLabel(thread, projects, directions) || `Not in a ${terms.workspace.one}`}
                  {thread.lastActivityAt ? ` · ${ago(thread.lastActivityAt)}` : ""}
                </span>
              }
              onClick={() => openThread(text(thread.id))}
            />
          ))}
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
