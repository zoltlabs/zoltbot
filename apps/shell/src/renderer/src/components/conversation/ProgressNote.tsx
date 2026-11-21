// C10: a progress note: a small bubble in the agent's colour, with no avatar.
import type { BotMessage, BotProfile } from "../../data";
import { t } from "../../i18n";
import "./progress-note.css";

export function ProgressNote(props: { message: BotMessage; agent: BotProfile | undefined }) {
  return (
    <p class={`progress-note progress-note-${props.agent?.accent ?? "neutral"}`}>
      <span class="progress-note-dot" aria-hidden="true" />
      <span class="sr-only">{t("chat.progress.label")}</span>
      <span class="progress-note-text">{props.message.body}</span>
    </p>
  );
}
