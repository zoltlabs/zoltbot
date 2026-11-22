import { createSignal, createUniqueId, For, Show } from "solid-js";
import { DOCUMENT_LIMITS } from "../../../shared/documents";
import { AgentAvatar } from "../components/AgentAvatar";
import type { BotProfile } from "../data";
import { t } from "../i18n";
import { Combobox, Dialog } from "../kit";
import type { PlacedComment } from "./CommentsPanel";
import { errorText } from "./documents-store";

interface SendDialogProps {
  path: string;
  comments: PlacedComment[];
  bots: BotProfile[];
  defaultBotId: string | null;
  onSend(botId: string, commentIds: string[], note: string): Promise<void>;
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

  const formId = createUniqueId();
  const options = () =>
    props.bots.map((bot) => ({
      value: bot.id,
      label: bot.name,
      icon: () => <AgentAvatar bot={bot} class="doc-agent-avatar" />,
    }));

  return (
    <Dialog
      title={t("documents.send.title")}
      onClose={props.onClose}
      busy={sending()}
      width={480}
      actions={
        <>
          <button type="button" class="zb-kit-button" onClick={props.onClose}>
            {t("documents.form.cancel")}
          </button>
          <button
            type="submit"
            form={formId}
            class="zb-kit-button primary"
            disabled={sending() || !botId() || chosen().size === 0}
          >
            {sending()
              ? t("documents.send.sending")
              : t("documents.send.button", { count: chosen().size })}
          </button>
        </>
      }
    >
      <form id={formId} class="doc-dialog-form" onSubmit={(event) => void submit(event)}>
        <div class="doc-field">
          <span aria-hidden="true">{t("documents.send.to")}</span>
          <Show
            when={props.bots.length > 0}
            fallback={<span class="doc-error">{t("documents.send.noChats")}</span>}
          >
            <Combobox
              label={t("documents.send.to")}
              searchLabel={t("documents.send.search")}
              emptyLabel={t("documents.send.noMatch")}
              value={botId()}
              options={options()}
              onChange={setBotId}
            />
          </Show>
        </div>
        <fieldset class="doc-fieldset">
          <legend>{t("documents.send.comments")}</legend>
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
                          {row.comment.state === "sent"
                            ? t("documents.send.alreadySent")
                            : t("documents.send.addressed")}
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
          <span>{t("documents.send.note")}</span>
          <textarea
            rows={3}
            maxLength={DOCUMENT_LIMITS.note}
            value={note()}
            onInput={(event) => setNote(event.currentTarget.value)}
          />
        </label>
        <p class="doc-dialog-consequence">{t("documents.send.consequence")}</p>
        <Show when={error()}>
          {(message) => (
            <p class="doc-error" role="alert">
              {message()}
            </p>
          )}
        </Show>
      </form>
    </Dialog>
  );
}
