// C5: hiding a message. The first time, a dialog says the agent still remembers it; after that a
// hide happens at once, with Undo in a toast. A hidden message folds to one line with Show.
import { createSignal, Show } from "solid-js";
import { t } from "../../i18n";
import { ConfirmDialog, showToast } from "../../kit";
import { jumpToMessage } from "./PinStrip";

type OnError = (message: string) => void;

/** After the transcript redraws, puts focus on the message's row: Show when hidden, else the
 * message itself. The element that had focus (More, Show or Undo) is gone by then. */
function refocus(messageId: string, hidden: boolean) {
  let tries = 0;
  const attempt = () => {
    const row = document.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(messageId)}"]`);
    const ready = row && row.classList.contains("message-hidden") === hidden;
    if (!ready) {
      if (++tries < 30) requestAnimationFrame(attempt);
      return;
    }
    if (hidden) row.querySelector<HTMLElement>(".message-hidden-show")?.focus();
    else jumpToMessage(messageId);
  };
  requestAnimationFrame(attempt);
}
interface Pending {
  botId: string;
  messageId: string;
  onError: OnError;
}

const [pending, setPending] = createSignal<Pending | null>(null);
const failed = (error: unknown) => (error instanceof Error ? error.message : String(error));

export async function setHidden(
  botId: string,
  messageId: string,
  hidden: boolean,
  onError: OnError,
) {
  try {
    await window.openbot.hidden.set({ botId, messageId, hidden });
  } catch (error) {
    onError(failed(error));
    return;
  }
  refocus(messageId, hidden);
  if (hidden)
    showToast({
      message: t("chat.hide.done"),
      action: {
        label: t("chat.hide.undo"),
        run: () => void setHidden(botId, messageId, false, onError),
      },
    });
}

export async function requestHide(botId: string, messageId: string, onError: OnError) {
  const preferences = await window.openbot.preferences?.get().catch(() => undefined);
  if (preferences?.hideConfirmed) return setHidden(botId, messageId, true, onError);
  setPending({ botId, messageId, onError });
}

/** The first-time dialog. Mounted once in the conversation. */
export function HideConfirm() {
  return (
    <Show when={pending()}>
      {(request) => (
        <ConfirmDialog
          title={t("chat.hide.title")}
          body={t("chat.hide.body")}
          confirmLabel={t("chat.hide.confirm")}
          onConfirm={() => {
            const { botId, messageId, onError } = request();
            setPending(null);
            void window.openbot.preferences?.set({ hideConfirmed: true }).catch(() => undefined);
            void setHidden(botId, messageId, true, onError);
          }}
          onCancel={() => setPending(null)}
        />
      )}
    </Show>
  );
}
