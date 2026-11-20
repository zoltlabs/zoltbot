import { createSignal, For, Show } from "solid-js";
import { DOCUMENT_LIMITS } from "../../../shared/documents";
import type { BotProfile } from "../data";
import type { PlacedComment } from "./CommentsPanel";
import { Dialog } from "./Dialog";
import { errorText } from "./documents-store";

interface SendDialogProps {
  path: string;
  comments: PlacedComment[];
  bots: BotProfile[];
  defaultBotId: string | null;
  onSend: (botId: string, commentIds: string[], note: string) => Promise<void>;
  onClose: () => void;
}

/** Chooses which comments go to which chat, with an optional note. */
export function SendDialog(props: SendDialogProps) {
  const open = () => props.comments.filter((row) => row.comment.state !== "resolved");
  const [chosen, setChosen] = createSignal(
    new Set(
      open()
        .filter((row) => row.comment.state === "draft")
        .map((row) => row.comment.id),
    ),
  );
  const [botId, setBotId] = createSignal(
    props.defaultBotId && props.bots.some((bot) => bot.id === props.defaultBotId)
      ? props.defaultBotId
      : (props.bots[0]?.id ?? ""),
  );
  const [note, setNote] = createSignal("");
  const [sending, setSending] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  if (chosen().size === 0) setChosen(new Set(open().map((row) => row.comment.id)));

  const toggle = (id: string, on: boolean) => {
    const next = new Set(chosen());
    if (on) next.add(id);
    else next.delete(id);
    setChosen(next);
  };

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (!botId() || chosen().size === 0) return;
    setSending(true);
    setError(null);
    try {
      await props.onSend(
        botId(),
        open()
          .map((row) => row.comment.id)
          .filter((id) => chosen().has(id)),
        note(),
      );
      props.onClose();
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setSending(false);
    }
  }

  const label = (bot: BotProfile) => (bot.roleLabel ? `${bot.name} · ${bot.roleLabel}` : bot.name);

  return (
    <Dialog
      title="Send comments to an agent"
      description="The agent edits the file directly. You review each change before it's final."
      onClose={props.onClose}
      class="doc-send-dialog"
    >
      <form class="doc-dialog-form" onSubmit={(event) => void submit(event)}>
        <fieldset class="doc-fieldset">
          <legend>Comments on {props.path}</legend>
          <ul class="doc-send-list">
            <For each={open()}>
              {(row) => (
                <li>
                  <label class="doc-check">
                    <input
                      type="checkbox"
                      checked={chosen().has(row.comment.id)}
                      onChange={(event) => toggle(row.comment.id, event.currentTarget.checked)}
                    />
                    <span>
                      <span class="doc-send-quote">
                        “{row.comment.anchor.quote.replace(/\s+/g, " ").slice(0, 80)}”
                      </span>
                      <span class="doc-send-body">{row.comment.body}</span>
                      <Show when={row.comment.state !== "draft"}>
                        <span class="doc-send-state">
                          {row.comment.state === "sent" ? "Already sent" : "Addressed"}
                        </span>
                      </Show>
                    </span>
                  </label>
                </li>
              )}
            </For>
          </ul>
        </fieldset>
        <label class="doc-field">
          <span>Send to</span>
          <Show
            when={props.bots.length > 0}
            fallback={
              <span class="doc-error">
                This project has no chats yet. Start one from the sidebar first.
              </span>
            }
          >
            <select value={botId()} onChange={(event) => setBotId(event.currentTarget.value)}>
              <For each={props.bots}>{(bot) => <option value={bot.id}>{label(bot)}</option>}</For>
            </select>
          </Show>
        </label>
        <label class="doc-field">
          <span>Note for the agent (optional)</span>
          <textarea
            rows={3}
            maxLength={DOCUMENT_LIMITS.note}
            value={note()}
            onInput={(event) => setNote(event.currentTarget.value)}
          />
        </label>
        <Show when={error()}>
          {(message) => (
            <p class="doc-error" role="alert">
              {message()}
            </p>
          )}
        </Show>
        <div class="doc-dialog-actions">
          <button type="button" class="doc-button" onClick={props.onClose}>
            Cancel
          </button>
          <button
            type="submit"
            class="doc-button doc-button-primary"
            disabled={sending() || !botId() || chosen().size === 0}
          >
            {sending()
              ? "Sending…"
              : chosen().size === 1
                ? "Send 1 comment"
                : `Send ${chosen().size} comments`}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
