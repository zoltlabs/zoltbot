// I4: the steps above the Discord token field. The bot needs the Message Content intent to read
// what people write, and an invite to the owner's server.
import { t } from "../../i18n";

const PORTAL_URL = "https://discord.com/developers/applications";

export function DiscordSteps() {
  return (
    <ol class="bridge-steps">
      <li>
        <span>{t("bridges.discord.create")}</span>
        <span class="bridge-step-actions">
          <button
            type="button"
            class="zb-kit-button"
            onClick={() => void window.openbot.openUrl(PORTAL_URL)}
          >
            {t("bridges.discord.open")}
          </button>
        </span>
      </li>
      <li>{t("bridges.discord.invite")}</li>
      <li>{t("bridges.discord.token")}</li>
    </ol>
  );
}
