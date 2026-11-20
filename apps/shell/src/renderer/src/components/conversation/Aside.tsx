// C2: a side question and its answer, shown inside the chat it was asked in. The answer can be
// continued as a normal chat.
import { createSignal, Show } from "solid-js";
import type { BotMessage } from "../../data";
import { t } from "../../i18n";
import "../../aside.css";

export function AsideEntry(props: { message: BotMessage; onOpenChat: (botId: string) => void }) {
  const [error, setError] = createSignal<string | null>(null);
  const question = () => props.message.author === "you";
  async function keep() {
    const threadId = props.message.aside?.threadId;
    if (!threadId) return;
    setError(null);
    try {
      await window.openbot.aside.continue({ threadId });
      props.onOpenChat(threadId);
      // The button leaves with the aside; continue typing in the chat it became.
      setTimeout(() => {
        const field = document.querySelector(".composer-wrap [contenteditable='true']");
        if (field instanceof HTMLElement) field.focus();
      }, 0);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  }
  return (
    <article
      class="aside-entry"
      classList={{ "aside-question": question(), "aside-answer": !question() }}
      aria-label={question() ? t("aside.question") : t("aside.answer")}
    >
      <Show when={question()}>
        <span class="aside-label">{t("aside.label")}</span>
      </Show>
      <Show
        when={props.message.body}
        fallback={
          <p class="aside-copy aside-pending">
            {props.message.status === "Failed" ? t("aside.failed") : t("aside.answering")}
          </p>
        }
      >
        <p class="aside-copy">{props.message.body}</p>
      </Show>
      <Show when={!question() && !props.message.streaming && props.message.body}>
        <button type="button" class="aside-continue" onClick={() => void keep()}>
          {t("aside.continue")}
        </button>
      </Show>
      <Show when={!question()}>
        <span class="sr-only" aria-live="polite">
          {!props.message.streaming && props.message.body ? t("aside.ready") : ""}
        </span>
      </Show>
      <Show when={error()}>
        <p class="aside-error" role="alert">
          {error()}
        </p>
      </Show>
    </article>
  );
}
