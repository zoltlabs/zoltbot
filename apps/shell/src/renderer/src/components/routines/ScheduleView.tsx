// R3: the next 60 days of routine runs on a month calendar. Pick a day to list its runs; routines
// started by events have no times, so they are listed apart.
import { upcomingRuns } from "@zoltbot/protocol";
import { createMemo, createSignal, For, Show } from "solid-js";
import type { RoutineItem } from "../../../../shared/routines";
import { formatDate, t } from "../../i18n";
import { triggerText } from "./routine-format";

const DAYS_AHEAD = 60;
const DAY_MS = 86_400_000;

/** The viewer's local calendar day of an instant, as "2026-11-06". */
export function dayKey(at: string | Date): string {
  const date = new Date(at);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Each week of the month holding `month` (its first day), Sunday first; outside days are null. */
export function monthWeeks(month: Date): (Date | null)[][] {
  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  const days = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
  const cells: (Date | null)[] = Array.from({ length: first.getDay() }, () => null);
  for (let day = 1; day <= days; day++)
    cells.push(new Date(month.getFullYear(), month.getMonth(), day));
  while (cells.length % 7) cells.push(null);
  return Array.from({ length: cells.length / 7 }, (_, week) => cells.slice(week * 7, week * 7 + 7));
}

/** The day `days` after a "2026-11-06" key, as a key. */
export function addDays(key: string, days: number): string {
  const [year, month, day] = key.split("-").map(Number);
  return dayKey(new Date(year ?? 0, (month ?? 1) - 1, (day ?? 1) + days));
}

const ARROWS: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };

export function ScheduleView(props: { items: readonly RoutineItem[]; now: Date }) {
  const first = () => new Date(props.now.getFullYear(), props.now.getMonth(), 1);
  const [month, setMonth] = createSignal(first());
  const [selected, setSelected] = createSignal(dayKey(props.now));
  const until = () => new Date(props.now.getTime() + DAYS_AHEAD * DAY_MS);
  const today = () => dayKey(props.now);
  const lastDay = () => dayKey(until());
  const lastMonth = () => new Date(until().getFullYear(), until().getMonth(), 1);
  function inWindow(key: string) {
    return today() <= key && key <= lastDay();
  }
  const names = createMemo(() => new Map(props.items.map((item) => [item.id, item.name])));
  const byDay = createMemo(() => {
    const runs = upcomingRuns(
      props.items.map((item) => ({ ...item, event: item.trigger })),
      props.now.toISOString(),
      until().toISOString(),
    );
    const days = new Map<string, typeof runs>();
    for (const run of runs) {
      const key = dayKey(run.at);
      days.set(key, [...(days.get(key) ?? []), run]);
    }
    return days;
  });
  const triggered = () => props.items.filter((item) => item.trigger && !item.paused);
  const dayRuns = () => byDay().get(selected()) ?? [];
  function canGo(months: number) {
    return months < 0 ? first() < month() : month() < lastMonth();
  }
  const shift = (months: number) => {
    if (!canGo(months)) return;
    setMonth((current) => new Date(current.getFullYear(), current.getMonth() + months, 1));
  };
  let grid: HTMLTableElement | undefined;
  /** Arrow keys move the one focusable day; Home and End go to the week's ends. */
  function move(event: KeyboardEvent) {
    const key = selected();
    const weekday = new Date(`${key}T12:00:00`).getDay();
    const step =
      ARROWS[event.key] ??
      (event.key === "Home" ? -weekday : event.key === "End" ? 6 - weekday : undefined);
    if (step === undefined) return;
    event.preventDefault();
    const next = addDays(key, step);
    if (!inWindow(next)) return;
    setSelected(next);
    const date = new Date(`${next}T12:00:00`);
    setMonth(new Date(date.getFullYear(), date.getMonth(), 1));
    grid?.querySelector<HTMLButtonElement>(`[data-day="${next}"]`)?.focus();
  }
  /** The one day that takes Tab: the picked one, or the month's first day in the window. */
  const tabDay = createMemo(() => {
    const shown = dayKey(month()).slice(0, 7);
    if (selected().startsWith(shown)) return selected();
    const start = dayKey(month()) < today() ? today() : dayKey(month());
    return start.startsWith(shown) && inWindow(start) ? start : undefined;
  });
  const weekdays = Array.from({ length: 7 }, (_, day) => new Date(2026, 10, 1 + day));

  return (
    <div class="routines-schedule">
      <section class="routines-calendar" aria-labelledby="routines-month">
        <div class="routines-calendar-head">
          <h2 id="routines-month" aria-live="polite">
            {formatDate(month(), { month: "long", year: "numeric" })}
          </h2>
          <div class="routines-calendar-nav">
            <button
              type="button"
              class="zb-kit-button"
              aria-disabled={!canGo(-1) || undefined}
              onClick={() => shift(-1)}
            >
              {t("routines.calendar.previous")}
            </button>
            <button
              type="button"
              class="zb-kit-button"
              aria-disabled={!canGo(1) || undefined}
              onClick={() => shift(1)}
            >
              {t("routines.calendar.next")}
            </button>
          </div>
        </div>
        <table ref={grid} class="routines-month" aria-labelledby="routines-month">
          <thead>
            <tr>
              <For each={weekdays}>
                {(day) => (
                  <th scope="col" abbr={formatDate(day, { weekday: "long" })}>
                    {formatDate(day, { weekday: "narrow" })}
                  </th>
                )}
              </For>
            </tr>
          </thead>
          <tbody onKeyDown={move}>
            <For each={monthWeeks(month())}>
              {(week) => (
                <tr>
                  <For each={week}>
                    {(day) => (
                      <td>
                        <Show when={day}>
                          {(date) => {
                            const key = dayKey(date());
                            const count = () => byDay().get(key)?.length ?? 0;
                            const label = formatDate(date(), { month: "long", day: "numeric" });
                            return (
                              <button
                                type="button"
                                class="routines-day"
                                classList={{ "routines-day-busy": count() > 0 }}
                                data-day={key}
                                disabled={!inWindow(key)}
                                tabIndex={tabDay() === key ? 0 : -1}
                                aria-current={key === today() ? "date" : undefined}
                                aria-pressed={selected() === key}
                                aria-label={t("routines.calendar.day", {
                                  date: label,
                                  count: count(),
                                })}
                                onClick={() => setSelected(key)}
                              >
                                <span aria-hidden="true">{date().getDate()}</span>
                                <Show when={count()}>
                                  <span class="routines-day-count" aria-hidden="true">
                                    {count()}
                                  </span>
                                </Show>
                              </button>
                            );
                          }}
                        </Show>
                      </td>
                    )}
                  </For>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </section>
      <div class="routines-agenda">
        <section aria-labelledby="routines-day-heading">
          <h2 id="routines-day-heading">
            {formatDate(new Date(`${selected()}T12:00:00`), {
              weekday: "long",
              month: "long",
              day: "numeric",
            })}
          </h2>
          <Show
            when={dayRuns().length}
            fallback={<p class="routines-note">{t("routines.calendar.nothing")}</p>}
          >
            <ul class="routines-agenda-list">
              <For each={dayRuns()}>
                {(run) => (
                  <li>
                    <time datetime={run.at}>
                      {formatDate(new Date(run.at), { hour: "numeric", minute: "2-digit" })}
                    </time>
                    <span>{names().get(run.routineId)}</span>
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </section>
        <Show when={triggered().length}>
          <section aria-labelledby="routines-triggered-heading">
            <h2 id="routines-triggered-heading">{t("routines.calendar.triggered")}</h2>
            <ul class="routines-agenda-list">
              <For each={triggered()}>
                {(item) => (
                  <li>
                    <span>{item.name}</span>
                    <Show when={item.trigger}>
                      {(trigger) => <span class="routines-meta">{triggerText(trigger())}</span>}
                    </Show>
                  </li>
                )}
              </For>
            </ul>
          </section>
        </Show>
      </div>
    </div>
  );
}
