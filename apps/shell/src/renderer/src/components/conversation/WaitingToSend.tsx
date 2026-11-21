// C12: a message written while Zoltbot was unreachable. It sends on its own once Zoltbot is back.
import { createSignal, Show } from "solid-js";
import { t } from "../../i18n";
import "./waiting.css";

function ClockIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" class="size-[13px] fill-none stroke-current">
      <circle cx="10" cy="10" r="6.5" stroke-width="1.4" />
      <path d="M10 6.5V10l2.5 1.5" stroke-width="1.4" stroke-linecap="round" />
    </svg>
  );
}

export function WaitingToSend(props: { botId: string; messageId: string }) {
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  async function run(action: "sendNow" | "delete") {
    setBusy(true);
    setError("");
    try {
      await window.openbot.outbox[action]({ botId: props.botId, messageId: props.messageId });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div class="message-status message-waiting">
      <span class="message-waiting-label">
        <ClockIcon />
        {t("chat.waiting.label")}
      </span>
      <span class="message-waiting-actions">
        <button type="button" disabled={busy()} onClick={() => void run("sendNow")}>
          {t("chat.waiting.sendNow")}
        </button>
        <button type="button" disabled={busy()} onClick={() => void run("delete")}>
          {t("chat.waiting.delete")}
        </button>
      </span>
      <Show when={error()}>
        <span class="message-waiting-error" role="alert">
          {error()}
        </span>
      </Show>
    </div>
  );
}
