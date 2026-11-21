// I5: the steps above the WhatsApp fields. The owner needs a Meta app with WhatsApp added and a
// permanent access token; receiving also needs the Zoltbot cloud, which relays Meta's webhook.
import { t } from "../../i18n";

const META_URL = "https://developers.facebook.com/apps";

export function WhatsappSteps() {
  return (
    <ol class="bridge-steps">
      <li>
        <span>{t("bridges.whatsapp.create")}</span>
        <span class="bridge-step-actions">
          <button
            type="button"
            class="zb-kit-button"
            onClick={() => void window.openbot.openUrl(META_URL)}
          >
            {t("bridges.whatsapp.open")}
          </button>
        </span>
      </li>
      <li>{t("bridges.whatsapp.token")}</li>
    </ol>
  );
}
