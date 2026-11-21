// R6: puts the coming routine runs in the Calendar app, with or without their names.
import { upcomingRuns } from "@zoltbot/protocol";
import { createMemo, createSignal, Show } from "solid-js";
import type { RoutineItem } from "../../../../shared/routines";
import { t } from "../../i18n";
import { Dialog } from "../../kit";
import { errorText } from "./routine-format";

const DAY = 86_400_000;

export function AddToCalendar(props: { items: RoutineItem[]; onAdded: (runs: number) => void }) {
  const add = window.openbot?.routines.addToCalendar;
  const [open, setOpen] = createSignal(false);
  const [names, setNames] = createSignal(true);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  // Shown only when something runs in the next 30 days, the span the main process writes.
  const hasRuns = createMemo(() => {
    const now = Date.now();
    return (
      upcomingRuns(
        props.items.map((item) => ({ ...item, event: item.trigger })),
        new Date(now).toISOString(),
        new Date(now + 30 * DAY).toISOString(),
        1,
      ).length > 0
    );
  });
  const close = () => {
    setOpen(false);
    setError(null);
  };
  async function confirm() {
    if (!add || busy()) return;
    setBusy(true);
    setError(null);
    try {
      const { runs } = await add({ names: names() });
      if (!runs) {
        setError(t("routines.calendar.empty"));
        return;
      }
      close();
      props.onAdded(runs);
    } catch (failure) {
      setError(errorText(failure) || t("routines.calendar.failed"));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Show when={add && hasRuns()}>
      <button type="button" class="zb-kit-button" onClick={() => setOpen(true)}>
        {t("routines.calendar.add")}
      </button>
      <Show when={open()}>
        <Dialog
          title={t("routines.calendar.title")}
          busy={busy()}
          onClose={close}
          width={400}
          actions={
            <>
              <Show when={error()}>
                {(message) => (
                  <p class="zb-kit-error routines-form-error" role="alert">
                    {message()}
                  </p>
                )}
              </Show>
              <button type="button" class="zb-kit-button" disabled={busy()} onClick={close}>
                {t("routines.cancel")}
              </button>
              <button
                type="button"
                class="zb-kit-button primary"
                aria-busy={busy() || undefined}
                onClick={() => void confirm()}
              >
                {busy() ? t("routines.calendar.busy") : t("routines.calendar.confirm")}
              </button>
            </>
          }
        >
          <p class="routines-note">{t("routines.calendar.body")}</p>
          <label class="routines-check">
            <input
              type="checkbox"
              checked={names()}
              disabled={busy()}
              onChange={(event) => setNames(event.currentTarget.checked)}
            />
            <span>{t("routines.calendar.names")}</span>
          </label>
        </Dialog>
      </Show>
    </Show>
  );
}
