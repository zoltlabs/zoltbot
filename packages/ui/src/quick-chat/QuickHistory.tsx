import type { QuickChat as Chat, DomainEvent } from "@zoltbot/protocol";
import { useEffect, useState } from "react";
import { ChatRowShell } from "../components/ChatRowActions.js";
import { useShell } from "../state.js";
import { applyQuickEvent, type QuickConnectionProp } from "./data.js";
import "./history.css";

/** History lives in the global sidebar, never beside the conversation as a second rail. */
export function QuickHistory({ connection }: { connection: QuickConnectionProp }) {
  const chatId = useShell((s) => s.quickChatId);
  const active = useShell((s) => s.route === "QuickChat");
  const openQuickChat = useShell((s) => s.openQuickChat);
  const [state, setState] = useState<{ chats: Chat[] }>({ chats: [] });
  const [notice, setNotice] = useState("");
  const [open, setOpen] = useState(active);
  const [showAll, setShowAll] = useState(false);
  useEffect(() => {
    if (active) setOpen(true);
  }, [active]);
  useEffect(() => {
    if (connection.status !== "online") return;
    let live = true;
    const buffered: DomainEvent[] = [];
    let loaded = false;
    const stop = connection.onEvent?.((event) => {
      if (event.type !== "quickChat.changed" && event.type !== "quickChat.removed") return;
      if (!loaded) buffered.push(event);
      else
        setState((current) => ({
          chats: applyQuickEvent({ ...current, messages: [] }, event).chats,
        }));
    });
    void connection
      .call("quickChat.list", {})
      .then((result) => {
        if (!live) return;
        let next = { chats: (result as { items: Chat[] }).items, messages: [] };
        for (const event of buffered) next = { ...next, chats: applyQuickEvent(next, event).chats };
        loaded = true;
        setState({ chats: next.chats });
        setNotice("");
      })
      .catch(() => {
        loaded = true;
        if (live) setNotice("Chats could not be loaded. Reconnect to try again.");
      });
    return () => {
      live = false;
      stop?.();
    };
  }, [connection.status, connection.call, connection.onEvent]);
  const unarchived = state.chats
    .filter((row) => !row.archived)
    .sort(
      (a, b) =>
        Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) ||
        b.updatedAt.localeCompare(a.updatedAt),
    );
  const shown = unarchived.filter((row, index) => showAll || index < 8 || Boolean(row.pinned));
  const hiddenCount = unarchived.length - shown.length;
  return (
    <details
      className="sidebar-section quick-history"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>Recent chats</summary>
      {unarchived.length ? null : <p className="quick-muted">Your quick chats appear here.</p>}
      {notice ? (
        <p role="alert" className="sm">
          {notice}
        </p>
      ) : null}
      <ul>
        {shown.map((row) => (
          <li key={row.id} className={active && row.id === chatId ? "current" : undefined}>
            <ChatRowShell
              title={row.title}
              onError={(message) => setNotice(message)}
              actions={{
                pinned: Boolean(row.pinned),
                archived: Boolean(row.archived),
                unread: Boolean(row.unread),
                async onTogglePin() {
                  await connection.call(
                    "quickChat.update",
                    { id: row.id, pinned: !row.pinned },
                    `quick-pin-${crypto.randomUUID()}`,
                  );
                },
                async onToggleUnread() {
                  await connection.call(
                    "quickChat.update",
                    { id: row.id, unread: !row.unread },
                    `quick-unread-${crypto.randomUUID()}`,
                  );
                },
                async onRename(nextTitle) {
                  await connection.call(
                    "quickChat.rename",
                    { id: row.id, title: nextTitle },
                    `quick-rename-${crypto.randomUUID()}`,
                  );
                },
                async onToggleArchive() {
                  await connection.call(
                    "quickChat.update",
                    { id: row.id, archived: !row.archived },
                    `quick-archive-${crypto.randomUUID()}`,
                  );
                  if (!row.archived && row.id === chatId) openQuickChat(undefined);
                },
                async onDelete() {
                  await connection.call(
                    "quickChat.delete",
                    { id: row.id, confirmed: true },
                    `quick-delete-${crypto.randomUUID()}`,
                  );
                  try {
                    localStorage.removeItem(`zoltbot.quickDraft.v1:${row.id}`);
                  } catch {}
                  if (row.id === chatId) openQuickChat(undefined);
                },
              }}
            >
              <button
                type="button"
                className="quick-recent-open"
                onClick={() => {
                  if (row.unread) {
                    void connection
                      .call(
                        "quickChat.update",
                        { id: row.id, unread: false },
                        `quick-read-${crypto.randomUUID()}`,
                      )
                      .catch(() => undefined);
                  }
                  openQuickChat(row.id);
                }}
                aria-current={active && row.id === chatId ? "page" : undefined}
              >
                <span className="truncate grow">{row.title}</span>
                {row.unread ? <span className="chat-unread-badge">Unread</span> : null}
              </button>
            </ChatRowShell>
          </li>
        ))}
      </ul>
      {hiddenCount > 0 || (showAll && unarchived.length > 8) ? (
        <button
          type="button"
          className="btn sm ghost"
          onClick={() => setShowAll((value) => !value)}
        >
          {showAll
            ? "Show fewer"
            : `Show ${hiddenCount} older ${hiddenCount === 1 ? "chat" : "chats"}`}
        </button>
      ) : null}
    </details>
  );
}
