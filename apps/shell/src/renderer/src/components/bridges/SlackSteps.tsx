// I2: the steps above the Slack token fields. The owner creates the app from our manifest, so it
// asks for exactly the scopes the bridge uses, then pastes the two tokens Slack gives them.
import { SLACK_APP_MANIFEST } from "@zoltbot/protocol";
import { createSignal, onCleanup } from "solid-js";
import { t } from "../../i18n";

const CREATE_URL = "https://api.slack.com/apps?new_app=1";

export function SlackSteps() {
  const [copy, setCopy] = createSignal<"idle" | "copied" | "failed">("idle");
  let timer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(timer));
  const copyManifest = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(SLACK_APP_MANIFEST, null, 2));
      setCopy("copied");
    } catch {
      setCopy("failed");
    }
    clearTimeout(timer);
    timer = setTimeout(() => setCopy("idle"), 2000);
  };
  return (
    <ol class="bridge-steps">
      <li>
        <span>{t("bridges.slack.create")}</span>
        <span class="bridge-step-actions">
          <button type="button" class="zb-kit-button" onClick={() => void copyManifest()}>
            {t("bridges.slack.copy")}
          </button>
          <button
            type="button"
            class="zb-kit-button"
            onClick={() => void window.openbot.openUrl(CREATE_URL)}
          >
            {t("bridges.slack.open")}
          </button>
          <span class="bridge-muted" aria-live="polite">
            {copy() === "copied"
              ? t("bridges.slack.copied")
              : copy() === "failed"
                ? t("bridges.slack.copyFailed")
                : ""}
          </span>
        </span>
      </li>
      <li>{t("bridges.slack.tokens")}</li>
    </ol>
  );
}
