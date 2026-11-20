// C5: a hidden message, folded to one line. Show brings it back for everyone.
import { t } from "../../i18n";

export function HiddenMessage(props: { messageId: string; onShow: () => void }) {
  return (
    <div
      class="message-hidden"
      role="group"
      aria-label={t("chat.hide.row")}
      data-message-id={props.messageId}
    >
      <span class="message-hidden-label" aria-hidden="true">
        {t("chat.hide.row")}
      </span>
      <button
        type="button"
        class="message-hidden-show"
        aria-label={t("chat.hide.showLabel")}
        onClick={() => props.onShow()}
      >
        {t("chat.hide.show")}
      </button>
    </div>
  );
}
