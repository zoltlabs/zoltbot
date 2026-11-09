import type { QuickChat as Chat, DomainEvent } from "@zoltbot/protocol";
import { useEffect, useState } from "react";
import { IconButton, Input } from "../components/primitives.js";
import { Icon } from "../shell/icons.js";
import { useShell } from "../state.js";
import { applyQuickEvent, errorText, type QuickConnectionProp } from "./data.js";
import "./history.css";

/** History lives in the global sidebar, never beside the conversation as a second rail. */
export function QuickHistory({ connection }: { connection: QuickConnectionProp }) {
  const chatId = useShell((s) => s.quickChatId);
  const active = useShell((s) => s.route === "QuickChat");
  const openQuickChat = useShell((s) => s.openQuickChat);
  const [state, setState] = useState<{ chats: Chat[] }>({ chats: [] });
  const [renaming, setRenaming] = useState<{ id: string; title: string }>();
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
  return (
    <details
      className="sidebar-section quick-history"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>Recent chats</summary>
      {state.chats.length ? null : <p className="quick-muted">Your quick chats appear here.</p>}
      {notice ? (
        <p role="alert" className="sm">
          {notice}
        </p>
      ) : null}
      <ul>
        {(showAll ? state.chats : state.chats.slice(0, 8)).map((row) => (
          <li key={row.id} className={active && row.id === chatId ? "current" : undefined}>
            {renaming?.id === row.id ? (
              <form
                className="r"
                onSubmit={(event) => {
                  event.preventDefault();
                  void connection
                    .call(
                      "quickChat.rename",
                      { id: row.id, title: renaming.title },
                      `quick-rename-${crypto.randomUUID()}`,
                    )
                    .then(
                      () => setRenaming(undefined),
                      (error) => setNotice(errorText(error)),
                    );
                }}
              >
                <Input
                  aria-label="Chat name"
                  value={renaming.title}
                  autoFocus
                  onChange={(e) => setRenaming({ id: row.id, title: e.target.value })}
                />
                <IconButton icon="Check" label="Save name" type="submit" size="sm" />
              </form>
            ) : (
              <>
                <button
                  type="button"
                  className="quick-recent-open"
                  onClick={() => openQuickChat(row.id)}
                  aria-current={active && row.id === chatId ? "page" : undefined}
                >
                  {row.title}
                </button>
                <details className="quick-row-actions">
                  <summary aria-label={`Actions for ${row.title}`}>
                    <Icon name="More" size="sm" />
                  </summary>
                  <div>
                    <IconButton
                      icon="Edit"
                      size="sm"
                      label={`Rename ${row.title}`}
                      onClick={() => setRenaming({ id: row.id, title: row.title })}
                    />
                    <IconButton
                      icon="Delete"
                      size="sm"
                      label={`Delete ${row.title}`}
                      onClick={() => {
                        if (
                          !confirm(`Delete “${row.title}”? Its messages are removed from this Mac.`)
                        )
                          return;
                        void connection
                          .call(
                            "quickChat.delete",
                            { id: row.id, confirmed: true },
                            `quick-delete-${crypto.randomUUID()}`,
                          )
                          .then(
                            () => {
                              try {
                                localStorage.removeItem(`zoltbot.quickDraft.v1:${row.id}`);
                              } catch {}
                              if (row.id === chatId) openQuickChat(undefined);
                            },
                            (error) => setNotice(errorText(error)),
                          );
                      }}
                    />
                  </div>
                </details>
              </>
            )}
          </li>
        ))}
      </ul>
      {state.chats.length > 8 ? (
        <button
          type="button"
          className="btn sm ghost"
          onClick={() => setShowAll((value) => !value)}
        >
          {showAll ? "Show fewer" : `Show ${state.chats.length - 8} older chats`}
        </button>
      ) : null}
    </details>
  );
}
