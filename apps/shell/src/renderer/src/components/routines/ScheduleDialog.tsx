// R1 + R3: change when a routine runs. Once: a date and time. Repeats: every day or weekday at a
// time, or every so many minutes. Times are in the routine's own timezone.
import { createSignal, Match, Show, Switch } from "solid-js";
import type { RoutineItem } from "../../../../shared/routines";
import { t } from "../../i18n";
import { Dialog, Field, Select } from "../../kit";
import { draftOf, errorText, type ScheduleDraft, scheduleOf, wallClock } from "./routine-format";

type Every = "day" | "weekday" | "interval";

export function ScheduleDialog(props: {
  item: RoutineItem;
  onClose: () => void;
  onSaved: (item: RoutineItem) => void;
}) {
  const [draft, setDraft] = createSignal<ScheduleDraft>(draftOf(props.item.schedule));
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  /** A problem with what was typed, shown under the field it is about. */
  const [invalid, setInvalid] = createSignal<{ field: "when" | "minutes"; message: string } | null>(
    null,
  );
  const fieldError = (field: "when" | "minutes") =>
    invalid()?.field === field ? (invalid()?.message ?? null) : null;
  const timezone = () => props.item.schedule.timezone;

  const choose = (kind: "once" | "repeats") => {
    const current = draft();
    if (current.kind === kind) return;
    setError(null);
    setInvalid(null);
    const time = current.kind === "custom" ? "09:00" : current.time;
    setDraft(
      kind === "once"
        ? {
            kind,
            ...wallClock(new Date(Date.now() + 3_600_000).toISOString(), timezone()),
            timezone: timezone(),
          }
        : { kind, every: "day", time, minutes: 60, timezone: timezone() },
    );
  };
  const patch = (changes: Partial<Extract<ScheduleDraft, { kind: "once" | "repeats" }>>) => {
    setError(null);
    setInvalid(null);
    setDraft((current) => ({ ...current, ...changes }) as ScheduleDraft);
  };

  async function save() {
    const schedule = scheduleOf(draft());
    if (!schedule) {
      const current = draft();
      setInvalid(
        current.kind === "repeats" && current.every === "interval"
          ? { field: "minutes", message: t("routines.schedule.minutesInvalid") }
          : { field: "when", message: t("routines.schedule.incomplete") },
      );
      return;
    }
    if (schedule.cron === "@once" && schedule.at && schedule.at <= new Date().toISOString()) {
      setInvalid({ field: "when", message: t("routines.schedule.past") });
      return;
    }
    setBusy(true);
    setError(null);
    try {
      props.onSaved(await window.openbot.routines.setSchedule({ id: props.item.id, schedule }));
    } catch (failure) {
      setError(errorText(failure) || t("routines.schedule.failed"));
    } finally {
      setBusy(false);
    }
  }

  // A custom schedule shows neither choice, so either one switches away from it.
  const kind = () => (draft().kind === "custom" ? undefined : draft().kind);
  return (
    <Dialog
      title={t("routines.schedule.title", { name: props.item.name })}
      busy={busy()}
      onClose={props.onClose}
      width={420}
      actions={
        <>
          <Show when={error()}>
            {(message) => (
              <p class="zb-kit-error routines-form-error" role="alert">
                {message()}
              </p>
            )}
          </Show>
          <button type="button" class="zb-kit-button" disabled={busy()} onClick={props.onClose}>
            {t("routines.cancel")}
          </button>
          <button
            type="button"
            class="zb-kit-button primary"
            aria-busy={busy() || undefined}
            onClick={() => void save()}
          >
            {t("routines.schedule.save")}
          </button>
        </>
      }
    >
      <form
        class="routines-form"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <fieldset class="routines-choice">
          <legend class="sr-only">{t("routines.schedule.kind")}</legend>
          <label>
            <input
              type="radio"
              name="routine-schedule-kind"
              checked={kind() === "once"}
              onChange={() => choose("once")}
            />
            {t("routines.schedule.once")}
          </label>
          <label>
            <input
              type="radio"
              name="routine-schedule-kind"
              checked={kind() === "repeats"}
              onChange={() => choose("repeats")}
            />
            {t("routines.schedule.repeats")}
          </label>
        </fieldset>
        <Switch>
          <Match when={draft().kind === "custom" && (draft() as { cron: string })}>
            {(custom) => (
              <p class="routines-note">
                {t("routines.schedule.custom")} <code>{custom().cron}</code>
              </p>
            )}
          </Match>
          <Match
            when={draft().kind === "once" && (draft() as Extract<ScheduleDraft, { kind: "once" }>)}
          >
            {(once) => (
              <div class="routines-row">
                <Field
                  label={t("routines.schedule.date")}
                  error={fieldError("when")}
                  input={(id, describedBy) => (
                    <input
                      id={id}
                      aria-invalid={!!fieldError("when") || undefined}
                      aria-describedby={describedBy}
                      type="date"
                      class="zb-kit-input"
                      value={once().date}
                      onInput={(event) => patch({ date: event.currentTarget.value })}
                    />
                  )}
                />
                <Field
                  label={t("routines.schedule.time")}
                  input={(id) => (
                    <input
                      id={id}
                      type="time"
                      class="zb-kit-input"
                      value={once().time}
                      onInput={(event) => patch({ time: event.currentTarget.value })}
                    />
                  )}
                />
              </div>
            )}
          </Match>
          <Match
            when={
              draft().kind === "repeats" && (draft() as Extract<ScheduleDraft, { kind: "repeats" }>)
            }
          >
            {(repeats) => (
              <div class="routines-row">
                <Select<Every>
                  label={t("routines.schedule.every")}
                  value={repeats().every}
                  onChange={(every) => patch({ every })}
                  options={[
                    { value: "day", label: t("routines.schedule.everyDay") },
                    { value: "weekday", label: t("routines.schedule.weekdays") },
                    { value: "interval", label: t("routines.schedule.interval") },
                  ]}
                />
                <Show
                  when={repeats().every === "interval"}
                  fallback={
                    <Field
                      label={t("routines.schedule.time")}
                      error={fieldError("when")}
                      input={(id, describedBy) => (
                        <input
                          id={id}
                          aria-invalid={!!fieldError("when") || undefined}
                          aria-describedby={describedBy}
                          type="time"
                          class="zb-kit-input"
                          value={repeats().time}
                          onInput={(event) => patch({ time: event.currentTarget.value })}
                        />
                      )}
                    />
                  }
                >
                  <Field
                    label={t("routines.schedule.minutes")}
                    error={fieldError("minutes")}
                    input={(id, describedBy) => (
                      <input
                        id={id}
                        aria-invalid={!!fieldError("minutes") || undefined}
                        aria-describedby={describedBy}
                        type="number"
                        min="1"
                        class="zb-kit-input"
                        value={repeats().minutes}
                        onInput={(event) => patch({ minutes: Number(event.currentTarget.value) })}
                      />
                    )}
                  />
                </Show>
              </div>
            )}
          </Match>
        </Switch>
        <p class="routines-note">{t("routines.schedule.timezone", { timezone: timezone() })}</p>
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}
