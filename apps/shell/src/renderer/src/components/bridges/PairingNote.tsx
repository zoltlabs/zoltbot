// I3: shown on a Telegram bridge until the owner pairs their own account with `/start <code>`.
import type { BridgeView } from "@zoltbot/protocol";
import { BRIDGE_DIRECT } from "@zoltbot/protocol";
import { createSignal, onCleanup, Show } from "solid-js";
import { t } from "../../i18n";

export function PairingNote(props: { view: BridgeView; busy: boolean; renew: () => void }) {
  const unpaired = () =>
    props.view.bridge.kind === "telegram" &&
    props.view.bridge.routes.some(
      (route) => route.from.id === BRIDGE_DIRECT && route.allow.length === 0,
    );
  const pairing = () =>
    props.view.bridge.options?.pairing as { code?: string; expiresAt?: string } | undefined;
  // Re-checks the clock, so an open dialog turns to "expired" on time.
  const [now, setNow] = createSignal(Date.now());
  const tick = setInterval(() => setNow(Date.now()), 15_000);
  onCleanup(() => clearInterval(tick));
  const live = () => {
    const value = pairing();
    return value?.code && value.expiresAt && Date.parse(value.expiresAt) > now()
      ? value.code
      : undefined;
  };
  return (
    <Show when={unpaired()}>
      <section aria-live="polite" class="bridge-pairing" aria-labelledby="bridge-pairing">
        <h3 id="bridge-pairing">{t("bridges.telegram.pairTitle")}</h3>
        <Show
          when={live()}
          fallback={
            <p class="bridge-step-actions">
              <span>{t("bridges.telegram.expired")}</span>
              <button
                type="button"
                class="zb-kit-button"
                disabled={props.busy}
                onClick={() => props.renew()}
              >
                {t("bridges.telegram.renew")}
              </button>
            </p>
          }
        >
          {(code) => (
            <>
              <p>
                {t("bridges.telegram.pairBody", {
                  bot: props.view.status.account ?? t("bridges.telegram.yourBot"),
                })}
              </p>
              <code class="bridge-code" aria-hidden="true">
                {`/start ${code()}`}
              </code>
              <span class="sr-only">{`/start ${code().split("").join(" ")}`}</span>
            </>
          )}
        </Show>
      </section>
    </Show>
  );
}
