import { terms } from "@zoltbot/protocol";
import { type Row, text } from "../chat/types.js";
import { Button, EmptyState, ListRow } from "../components/primitives.js";
import { ago, scopeLabel } from "../workspaces/activity.js";

/** Every chat, newest first, with where it lives; the Overview only shows the recent few. */
export function AllChats({
  threads,
  projects,
  directions,
  openThread,
  openQuickChat,
}: {
  threads: Row[];
  projects: Row[];
  directions: Row[];
  openThread(id: string): void;
  openQuickChat(): void;
}) {
  const rows = threads
    .filter((thread) => !thread.archived && thread.kind !== "task")
    .sort((a, b) => text(b.lastActivityAt).localeCompare(text(a.lastActivityAt)));
  return (
    <section className="zb-card recent-work">
      <h1>All {terms.chat.many}</h1>
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
      ) : (
        <EmptyState
          icon="Sessions"
          title={`No ${terms.chat.many} yet`}
          action={<Button onClick={openQuickChat}>Start a quick chat</Button>}
        >
          Ask something in Quick chat, or open a {terms.workspace.one} and start a {terms.chat.one}.
        </EmptyState>
      )}
    </section>
  );
}
