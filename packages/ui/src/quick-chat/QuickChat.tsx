import type {
  QuickChat as Chat,
  QuickConnection,
  QuickContextSource,
  QuickMessage,
  QuickSettings,
} from "@zoltbot/protocol";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { composingKey } from "../chat/composer-editing.js";
import { Markdown } from "../chat/Markdown.js";
import { MessageDetails } from "../chat/MessageDetails.js";
import { Button, Chip, Dialog, Field, IconButton, Select } from "../components/primitives.js";
import { Icon } from "../shell/icons.js";
import { useShell } from "../state.js";
import { ContextPicker } from "./ContextPicker.js";
import {
  applyQuickEvent,
  billingLabel,
  errorText,
  initialSelection,
  outcomeText,
  type QuickConnectionProp,
  replyLabel,
  sourceLabel,
  usable,
} from "./data.js";
import { Handoff } from "./Handoff.js";
import { QuickConnections } from "./QuickConnections.js";
import { QuickRequests } from "./QuickRequests.js";
import "./quick-chat.css";

// The chip shows the label; the draft gets a starter the user finishes typing.
const suggestions = [
  { label: "Explain something simply", draft: "Explain this simply: " },
  { label: "Draft a short reply", draft: "Draft a short reply to: " },
  { label: "Summarize text", draft: "Summarize: " },
  { label: "Brainstorm ideas", draft: "Brainstorm ideas for " },
];
const draftKey = (chatId?: string) => `zoltbot.quickDraft.v1:${chatId ?? "new"}`;
function storedDraft(chatId?: string) {
  try {
    return localStorage.getItem(draftKey(chatId)) ?? "";
  } catch {
    return "";
  }
}
function storeDraft(chatId: string | undefined, text: string) {
  try {
    if (text) localStorage.setItem(draftKey(chatId), text);
    else localStorage.removeItem(draftKey(chatId));
  } catch {}
}
/** A general conversation outside any workspace. Opening it creates nothing until first send. */
export default function QuickChat({ connection }: { connection: QuickConnectionProp }) {
  const sidebar = useShell((s) => s.sidebar),
    toggleSidebar = useShell((s) => s.toggleSidebar);
  const chatId = useShell((s) => s.quickChatId),
    openQuickChat = useShell((s) => s.openQuickChat);
  const [state, setState] = useState<{
    chats: Chat[];
    messages: QuickMessage[];
    chatId?: string | undefined;
  }>({ chats: [], messages: [] });
  const [connections, setConnections] = useState<QuickConnection[]>();
  const [settings, setSettings] = useState<QuickSettings>();
  const [selection, setSelection] = useState<{ connectionId: string; model: string }>();
  const [sources, setSources] = useState<QuickContextSource[]>([]);
  const [draft, setDraftState] = useState(() => storedDraft(chatId));
  const [notice, setNotice] = useState("");
  const [sending, setSending] = useState(false);
  const [showConnections, setShowConnections] = useState(false);
  const [handoff, setHandoff] = useState(false);
  const editor = useRef<HTMLTextAreaElement>(null);
  const composing = useRef(false);
  const lastSent = useRef<{ replyId: string; text: string }>(undefined);
  const online = connection.status === "online";
  const setDraft = (text: string) => {
    setDraftState(text);
    storeDraft(chatId, text);
  };
  const loadConnections = useCallback(async () => {
    const result = (await connection.call("quickConnection.list", {})) as {
      items: QuickConnection[];
      settings: QuickSettings;
    };
    setConnections(result.items);
    setSettings(result.settings);
    return result;
  }, [connection.call]);
  // Reload whenever the daemon connection comes back: events missed while offline are not replayed.
  useEffect(() => {
    if (!online) return;
    let live = true;
    void (async () => {
      const [list, current] = await Promise.all([
        connection.call("quickChat.list", {}) as Promise<{ items: Chat[] }>,
        chatId
          ? (
              connection.call("quickChat.get", { id: chatId }) as Promise<{
                chat: Chat;
                messages: QuickMessage[];
              }>
            ).catch(() => undefined)
          : Promise.resolve(undefined),
      ]);
      const loaded = await loadConnections();
      if (!live) return;
      setState({ chats: list.items, messages: current?.messages ?? [], chatId });
      setSources(current?.chat.contextSources ?? []);
      setSelection((previous) =>
        initialSelection(loaded.items, loaded.settings, {
          connectionId: current?.chat.lastConnectionId ?? previous?.connectionId,
          model: current?.chat.lastModel ?? previous?.model,
        }),
      );
      if (chatId && !current) openQuickChat(undefined);
    })().catch((error) => live && setNotice(errorText(error)));
    return () => {
      live = false;
    };
  }, [online, chatId, connection.call, loadConnections, openQuickChat]);
  useEffect(() => {
    setDraftState(storedDraft(chatId));
    editor.current?.focus();
  }, [chatId]);
  useEffect(
    () =>
      connection.onEvent?.((event) => {
        if (event.type === "quickConnection.changed") void loadConnections();
        setState((current) => applyQuickEvent(current, event));
      }),
    [connection.onEvent, loadConnections],
  );
  // Keep the selection valid as connections are added, refreshed or removed. Signed-in coding
  // tools are picked up on their own, so settings never open unasked.
  useEffect(() => {
    if (!connections) return;
    setSelection((previous) => initialSelection(connections, settings, previous));
  }, [connections, settings]);
  const replies = state.messages.filter((row) => row.role === "assistant");
  const streaming = replies.find((row) => row.status === "streaming");
  // A refused reply gives the question back to the composer so nothing typed is lost.
  useEffect(() => {
    const sent = lastSent.current;
    const reply = sent && state.messages.find((row) => row.id === sent.replyId);
    if (!sent || !reply || reply.status === "streaming") return;
    lastSent.current = undefined;
    if (reply.status === "failed") {
      setNotice(
        `${reply.error?.message ?? "Not answered."} Your message is back in the composer; choose another connection or try again.`,
      );
      setDraftState((current) => current || sent.text);
    }
  }, [state.messages]);
  const selected = connections?.find((row) => row.id === selection?.connectionId);
  const ready = connections?.filter(usable) ?? [];
  const checking = !connections || connections.some((row) => !row.modelsCheckedAt);
  /** Switching is remembered, so the next new chat starts on the same tool and model. */
  const choose = (connectionId: string, model?: string) => {
    const next = connections?.find((row) => row.id === connectionId);
    if (!next) return;
    const picked = initialSelection([next], settings, {
      connectionId,
      model:
        model ??
        (settings?.defaultConnectionId === connectionId ? settings.defaultModel : undefined),
    });
    if (!picked) return;
    setSelection(picked);
    void connection
      .call(
        "quickConnection.setDefaults",
        { defaultConnectionId: picked.connectionId, defaultModel: picked.model },
        `quick-defaults-${crypto.randomUUID()}`,
      )
      .then(() => loadConnections())
      .catch(() => {});
  };
  const send = async () => {
    const text = draft.trim();
    if (!text || !selected || !selection?.model || sending) return;
    setSending(true);
    setNotice("");
    try {
      const result = (await connection.call(
        "quickChat.send",
        {
          ...(chatId ? { chatId } : {}),
          text,
          connectionId: selected.id,
          model: selection.model,
          contextSources: sources,
        },
        `quick-send-${crypto.randomUUID()}`,
      )) as { chatId: string; replyId: string };
      lastSent.current = { replyId: result.replyId, text };
      setDraft("");
      if (!chatId) {
        storeDraft(undefined, "");
        openQuickChat(result.chatId);
      }
    } catch (error) {
      // The draft stays: nothing was created when the host refused the send.
      setNotice(errorText(error));
    } finally {
      setSending(false);
    }
  };
  const removeSource = async (id: string) => {
    const next = sources.filter((row) => row.id !== id);
    setSources(next);
    if (chatId) await connection.call("quickChat.setContext", { id: chatId, contextSources: next });
    setNotice(
      "Removed. Future messages will not read it; text already sent stays in this conversation.",
    );
  };
  const chat = state.chats.find((row) => row.id === chatId);
  const hostName = selected?.host.name ?? connections?.[0]?.host.name ?? "this Mac";
  const models = useMemo(() => selected?.models ?? [], [selected]);
  return (
    <div className="quick-chat">
      <section
        className={`quick-main${state.messages.length ? "" : " empty"}`}
        aria-label="Quick chat"
      >
        <header className="quick-head">
          <IconButton
            icon="Menu"
            size="sm"
            label={sidebar ? "Hide sidebar" : "Show sidebar"}
            onClick={toggleSidebar}
          />
          {/* Same breadcrumb shape as every other page: "Quick chat › Chat title". */}
          <nav className="breadcrumb" aria-label="Breadcrumb">
            {chat ? (
              <>
                <span>Quick chat</span>
                <Icon name="ChevronRight" size="sm" />
              </>
            ) : null}
            <h1 className="page-title">{chat?.title ?? "Quick chat"}</h1>
          </nav>
          <span className="sp" />
          <Button size="sm" icon="Plus" onClick={() => openQuickChat(undefined)}>
            New chat
          </Button>
          {chat?.handoffs.length ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                const last = chat.handoffs.at(-1);
                if (last) useShell.getState().openThread(last.threadId);
              }}
            >
              Open workspace chat
            </Button>
          ) : null}
          {chatId ? (
            <Button size="sm" icon="Move" onClick={() => setHandoff(true)}>
              Continue in workspace
            </Button>
          ) : null}
          <IconButton
            icon="Settings"
            size="sm"
            label="Quick Chat settings"
            onClick={() => setShowConnections(true)}
          />
        </header>
        <Dialog
          open={showConnections}
          title="Quick Chat settings"
          onClose={() => setShowConnections(false)}
          actions={
            <Button variant="primary" onClick={() => setShowConnections(false)}>
              Done
            </Button>
          }
        >
          {selected ? (
            <div className="quick-model-row">
              <Field label="Model">
                <Select
                  value={selection?.model ?? ""}
                  onChange={(event) => choose(selected.id, event.target.value)}
                >
                  {models.map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.label}
                    </option>
                  ))}
                </Select>
              </Field>
              <p className="quick-muted">
                Used by {selected.label} for new messages.{" "}
                {billingLabel({ ...selected, hostName: selected.host.name })}.
              </p>
            </div>
          ) : null}
          {showConnections ? (
            <QuickConnections
              connection={connection}
              connections={connections ?? []}
              settings={settings}
              hostName={hostName}
              onChanged={() => void loadConnections()}
            />
          ) : null}
        </Dialog>
        <ol className="quick-messages" aria-live="polite" hidden={!state.messages.length}>
          {state.messages.map((message) => (
            <li key={message.id} className={`quick-message ${message.role}`}>
              {message.role === "user" ? (
                <>
                  <p className="quick-user-text">{message.text}</p>
                  {message.context.length || message.contextNotes?.length ? (
                    <MessageDetails>
                      {message.context.length ? (
                        <p>
                          Context used:{" "}
                          {message.context
                            .map(
                              (ref) => `${ref.path ?? ref.label}${ref.reused ? " (reused)" : ""}`,
                            )
                            .join(", ")}
                        </p>
                      ) : null}
                      {message.contextNotes?.map((note) => (
                        <p key={note}>{note}</p>
                      ))}
                    </MessageDetails>
                  ) : null}
                </>
              ) : (
                <>
                  {message.text ? <Markdown value={message.text} /> : null}
                  <QuickRequests message={message} connection={connection} />
                  <MessageDetails>
                    <p className="quick-reply-meta">
                      {replyLabel(message)}
                      {message.fallbackFrom ? " · automatic fallback" : ""}
                      {message.usage?.outputTokens !== undefined
                        ? ` · ${message.usage.inputTokens ?? 0} in / ${message.usage.outputTokens} out tokens`
                        : ""}
                    </p>
                  </MessageDetails>
                  {outcomeText[message.status] ? (
                    <p
                      className={`quick-outcome ${message.status}`}
                      role={message.status === "failed" ? "alert" : undefined}
                    >
                      {outcomeText[message.status]} {message.error?.message ?? ""}
                    </p>
                  ) : null}
                </>
              )}
            </li>
          ))}
        </ol>
        {!state.messages.length ? (
          <div className="quick-empty">
            <h2>What can I help with?</h2>
            <ul className="quick-suggestions" aria-label="Suggestions">
              {suggestions.map((suggestion) => (
                <li key={suggestion.label}>
                  <button
                    type="button"
                    onClick={() => {
                      setDraft(suggestion.draft);
                      editor.current?.focus();
                    }}
                  >
                    {suggestion.label}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        <form
          className="chat-composer quick-composer"
          aria-label="Quick chat composer"
          onSubmit={(event) => {
            event.preventDefault();
            void send();
          }}
        >
          {sources.length ? (
            <ul className="quick-chips" aria-label="Context sources">
              {sources.map((source) => (
                <li key={source.id}>
                  <Chip tone="accent">
                    {sourceLabel(source)}
                    <button
                      type="button"
                      className="quick-chip-remove"
                      aria-label={`Remove ${sourceLabel(source)}`}
                      onClick={() => void removeSource(source.id)}
                    >
                      ×
                    </button>
                  </Chip>
                </li>
              ))}
            </ul>
          ) : null}
          <textarea
            ref={editor}
            aria-label="Message"
            placeholder="Ask anything…"
            // biome-ignore lint/a11y/noAutofocus: Quick Chat exists to start typing immediately.
            autoFocus
            value={draft}
            onCompositionStart={() => {
              composing.current = true;
            }}
            onCompositionEnd={() => {
              composing.current = false;
            }}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (composingKey(event.nativeEvent, composing.current)) return;
              if (event.key === "Enter" && event.repeat) {
                event.preventDefault();
                return;
              }
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void send();
              }
            }}
          />
          <div className="r quick-controls">
            {ready.length > 1 ? (
              <Select
                aria-label="Coding tool"
                size="md"
                className="quick-switcher"
                title={selected ? billingLabel({ ...selected, hostName: selected.host.name }) : ""}
                value={selection?.connectionId ?? ""}
                onChange={(event) => choose(event.target.value)}
              >
                {ready.map((row) => (
                  <option key={row.id} value={row.id}>
                    {row.label}
                  </option>
                ))}
              </Select>
            ) : selected ? (
              <span
                className="quick-muted"
                title={billingLabel({ ...selected, hostName: selected.host.name })}
              >
                {selected.label}
              </span>
            ) : null}
            <ContextPicker
              connection={connection}
              draft={draft}
              setDraft={setDraft}
              selected={sources}
              destination={
                selected ? billingLabel({ ...selected, hostName: selected.host.name }) : undefined
              }
              onAdd={(source) => {
                const next = [...sources.filter((row) => row.id !== source.id), source].slice(
                  0,
                  20,
                );
                setSources(next);
                if (chatId)
                  void connection.call("quickChat.setContext", {
                    id: chatId,
                    contextSources: next,
                  });
              }}
            />
            <span className="sp" />
            {streaming ? (
              <Button
                size="sm"
                icon="Stop"
                type="button"
                onClick={() =>
                  void connection.call(
                    "quickChat.cancel",
                    { chatId: streaming.chatId, replyId: streaming.id },
                    `quick-cancel-${crypto.randomUUID()}`,
                  )
                }
              >
                Stop
              </Button>
            ) : null}
            <Button
              variant="primary"
              type="submit"
              disabled={!draft.trim() || !selected || !selection?.model || sending || !online}
            >
              Send
            </Button>
          </div>
          {selected ? null : checking ? (
            <p className="quick-billing">Finding the coding tools signed in on {hostName}…</p>
          ) : (
            <p className="quick-billing">
              Sign in to Codex, Claude Code or Antigravity on {hostName} and it is used
              automatically. Your draft is kept.{" "}
              <Button
                size="sm"
                variant="ghost"
                type="button"
                onClick={() => setShowConnections(true)}
              >
                Use an API key instead
              </Button>
            </p>
          )}
          {notice ? <output className="quick-notice">{notice}</output> : null}
        </form>
      </section>
      {handoff && chatId ? (
        <Handoff connection={connection} chatId={chatId} onClose={() => setHandoff(false)} />
      ) : null}
    </div>
  );
}
