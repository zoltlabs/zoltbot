// B1: the agent's kept browser profile, with Clear.
import { createResource, createSignal, Show } from "solid-js";
import { t } from "../../i18n";
import { ConfirmDialog } from "../../kit";

export function AgentBrowserProfile(props: { agentId: string; agentName: string }) {
  const [profile, { mutate }] = createResource(
    () => props.agentId,
    (agentId) => window.openbot.agentBrowser.profile({ agentId }),
  );
  const [confirming, setConfirming] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  let clearButton: HTMLButtonElement | undefined;

  async function clear() {
    setBusy(true);
    setError(null);
    try {
      await window.openbot.agentBrowser.clearProfile({ agentId: props.agentId });
      setConfirming(false);
      mutate(null);
    } catch (failure) {
      setError(
        String(failure).includes("browser_profile_in_use")
          ? t("browser.profile.inUse")
          : t("browser.profile.clearFailed"),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Show when={!profile.error && profile()}>
      <div class="agent-settings-model-row agent-settings-context-row">
        <span id="agent-browser-profile-label">{t("browser.profile.title")}</span>
        <div class="agent-browser-profile">
          <span class="agent-browser-profile-value">{t("browser.profile.value")}</span>
          <button
            ref={clearButton}
            type="button"
            id="agent-browser-profile-clear"
            class="zb-kit-button"
            aria-label={t("browser.profile.clearLabel")}
            onClick={() => setConfirming(true)}
          >
            {t("browser.profile.clear")}
          </button>
        </div>
      </div>
      <Show when={confirming()}>
        <ConfirmDialog
          title={t("browser.profile.clearTitle")}
          body={t("browser.profile.clearBody", { agent: props.agentName })}
          confirmLabel={t("browser.profile.clear")}
          busyLabel={t("browser.profile.clearing")}
          danger
          busy={busy()}
          error={error()}
          onCancel={() => {
            setConfirming(false);
            setError(null);
            clearButton?.focus();
          }}
          onConfirm={() => void clear()}
        />
      </Show>
    </Show>
  );
}
