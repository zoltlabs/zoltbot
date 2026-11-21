// I3: the steps above the Telegram token field. BotFather makes the bot and gives its token.
import { t } from "../../i18n";

const BOTFATHER_URL = "https://t.me/BotFather";

export function TelegramSteps() {
  return (
    <ol class="bridge-steps">
      <li>
        <span>{t("bridges.telegram.create")}</span>
        <span class="bridge-step-actions">
          <button
            type="button"
            class="zb-kit-button"
            onClick={() => void window.openbot.openUrl(BOTFATHER_URL)}
          >
            {t("bridges.telegram.open")}
          </button>
        </span>
      </li>
      <li>{t("bridges.telegram.token")}</li>
      <li>{t("bridges.telegram.privacy")}</li>
    </ol>
  );
}
