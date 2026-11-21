// R4: whether the Mac stays awake while agents work, or also shortly before a routine is due.
import { createSignal, onCleanup, onMount, Show } from "solid-js";
import type { KeepAwakePreference } from "../../../../shared/preferences";
import { t } from "../../i18n";
import { Select, showToast } from "../../kit";

export function KeepAwakeSelect() {
  const preferences = window.openbot?.preferences;
  const [mode, setMode] = createSignal<KeepAwakePreference | null>(null);
  onMount(() => {
    if (!preferences) return;
    void preferences
      .get()
      .then((value) => setMode((current) => current ?? value.keepAwake))
      .catch(() => undefined);
    onCleanup(preferences.onChange((value) => setMode(value.keepAwake)));
  });
  const choose = (next: KeepAwakePreference) => {
    const previous = mode();
    setMode(next);
    void preferences?.set({ keepAwake: next }).catch(() => {
      setMode(previous);
      showToast({
        message: t("routines.keepAwake.failed"),
        action: { label: t("routines.keepAwake.retry"), run: () => choose(next) },
      });
    });
  };
  return (
    <Show when={mode()}>
      {(current) => (
        <div class="routines-keep-awake">
          {/* Shown for sighted readers; the select's own name says the same. */}
          <span aria-hidden="true">{t("routines.keepAwake.label")}</span>
          <Select<KeepAwakePreference>
            label={t("routines.keepAwake.label")}
            class="tasks-filter"
            value={current()}
            onChange={choose}
            options={[
              { value: "never", label: t("routines.keepAwake.never") },
              { value: "working", label: t("routines.keepAwake.working") },
              { value: "working-or-due", label: t("routines.keepAwake.workingOrDue") },
            ]}
          />
        </div>
      )}
    </Show>
  );
}
