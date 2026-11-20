// S6: spend or tokens per day, stacked by chat or agent. The table below the chart carries the
// same numbers for screen readers, so the drawing itself is hidden from them.
import { createMemo, createSignal, For, Index, onCleanup, Show } from "solid-js";
import { formatDate, t } from "../i18n";
import { chartTicks, type DaySpend, labeledDay, niceMax, OTHER, type SpendMeasure } from "../spend";

const HEIGHT = 168;
const GAP = 2;
const RADIUS = 4;

/** A bar segment whose top corners are rounded when it ends the bar. */
function segment(x: number, y: number, width: number, height: number, top: boolean): string {
  const r = top ? Math.min(RADIUS, width / 2, height) : 0;
  return [
    `M${x},${y + height}`,
    `V${y + r}`,
    r ? `Q${x},${y} ${x + r},${y}` : "",
    `H${x + width - r}`,
    r ? `Q${x + width},${y} ${x + width},${y + r}` : "",
    `V${y + height}`,
    "Z",
  ].join("");
}

export const dayLabel = (day: string, options: Intl.DateTimeFormatOptions) => {
  const [year, month, date] = day.split("-").map(Number);
  return formatDate(new Date(year ?? 0, (month ?? 1) - 1, date ?? 1), options);
};

export function UsageChart(props: {
  series: { id: string; name: string }[];
  days: DaySpend[];
  measure: SpendMeasure;
  colors: Map<string, number>;
  /** Short labels for the axis. */
  formatTick: (value: number) => string;
  format: (value: number) => string;
}) {
  const [hovered, setHovered] = createSignal<number | null>(null);
  const [width, setWidth] = createSignal(600);
  const top = createMemo(() => niceMax(Math.max(0, ...props.days.map((day) => day.total))));
  const slot = () => width() / Math.max(1, props.days.length);
  const barWidth = () => Math.max(4, Math.min(28, slot() * 0.6));
  const scale = (value: number) => (value / top()) * HEIGHT;
  const color = (id: string) =>
    id === OTHER ? "var(--chart-other)" : `var(--chart-${(props.colors.get(id) ?? 0) + 1})`;
  const name = (series: { id: string; name: string }) =>
    series.id === OTHER ? t("usage.other") : series.name || t("usage.deletedChat");
  const labeled = (index: number) => labeledDay(index, props.days.length);
  const ticks = () => chartTicks(props.measure, top());

  const observe = (element: HTMLDivElement) => {
    const resize = new ResizeObserver(([entry]) => {
      if (entry) setWidth(Math.max(120, entry.contentRect.width));
    });
    resize.observe(element);
    onCleanup(() => resize.disconnect());
  };

  const tip = () => {
    const index = hovered();
    return index === null ? undefined : props.days[index];
  };

  return (
    <div class="usage-chart">
      <Show when={props.series.length > 1}>
        <ul class="usage-legend" aria-hidden="true">
          <For each={props.series}>
            {(series) => (
              <li>
                <span class="usage-swatch" style={{ background: color(series.id) }} />
                {name(series)}
              </li>
            )}
          </For>
        </ul>
      </Show>
      <div class="usage-plot" aria-hidden="true">
        <div class="usage-axis">
          <For each={ticks()}>
            {(step) => (
              <span class="usage-tick" style={{ bottom: `${step * HEIGHT}px` }}>
                {props.formatTick(top() * step)}
              </span>
            )}
          </For>
        </div>
        <div class="usage-canvas" ref={observe}>
          <svg
            aria-hidden="true"
            class="usage-bars"
            width={width()}
            height={HEIGHT + 20}
            viewBox={`0 0 ${width()} ${HEIGHT + 20}`}
            onPointerLeave={() => setHovered(null)}
          >
            <For each={[1, 0.5]}>
              {(step) => (
                <line
                  class="usage-grid"
                  x1="0"
                  x2={width()}
                  y1={HEIGHT - step * HEIGHT + 0.5}
                  y2={HEIGHT - step * HEIGHT + 0.5}
                />
              )}
            </For>
            <line class="usage-baseline" x1="0" x2={width()} y1={HEIGHT + 0.5} y2={HEIGHT + 0.5} />
            <Index each={props.days}>
              {(entry, index) => {
                const x = () => index * slot() + (slot() - barWidth()) / 2;
                const parts = () => {
                  const shown = props.series.filter(
                    (series) => (entry().values[series.id] ?? 0) > 0,
                  );
                  let y = HEIGHT;
                  return shown.map((series, at) => {
                    const height = Math.max(
                      1,
                      scale(entry().values[series.id] ?? 0) - (at ? GAP : 0),
                    );
                    y -= height + (at ? GAP : 0);
                    return { id: series.id, y, height, top: at === shown.length - 1 };
                  });
                };
                return (
                  <g>
                    <For each={parts()}>
                      {(part) => (
                        <path
                          d={segment(x(), part.y, barWidth(), part.height, part.top)}
                          fill={color(part.id)}
                          opacity={hovered() === null || hovered() === index ? 1 : 0.45}
                        />
                      )}
                    </For>
                    <Show when={labeled(index)}>
                      <text
                        class="usage-day"
                        x={index * slot() + slot() / 2}
                        y={HEIGHT + 15}
                        text-anchor="middle"
                      >
                        {dayLabel(
                          entry().day,
                          props.days.length > 7
                            ? { month: "short", day: "numeric" }
                            : { weekday: "short" },
                        )}
                      </text>
                    </Show>
                    {/* Taller and wider than the bar, so a thin day is still easy to point at. */}
                    <rect
                      class="usage-hit"
                      x={index * slot()}
                      y="0"
                      width={slot()}
                      height={HEIGHT}
                      onPointerEnter={() => setHovered(index)}
                    />
                  </g>
                );
              }}
            </Index>
          </svg>
          <Show when={tip()}>
            {(day) => {
              const index = () => hovered() ?? 0;
              // Beside the bar, on whichever side has room.
              const place = () =>
                (index() + 0.5) * slot() > width() / 2
                  ? { right: `${width() - index() * slot() + 4}px` }
                  : { left: `${(index() + 1) * slot() + 4}px` };
              return (
                <div class="usage-tooltip" style={place()}>
                  <p class="usage-tooltip-day">
                    {dayLabel(day().day, { weekday: "short", month: "short", day: "numeric" })}
                  </p>
                  <For each={props.series.filter((series) => (day().values[series.id] ?? 0) > 0)}>
                    {(series) => (
                      <p class="usage-tooltip-row">
                        <span class="usage-swatch" style={{ background: color(series.id) }} />
                        <span class="usage-tooltip-name">{name(series)}</span>
                        <span class="usage-tooltip-value">
                          {props.format(day().values[series.id] ?? 0)}
                        </span>
                      </p>
                    )}
                  </For>
                  <p class="usage-tooltip-row usage-tooltip-total">
                    <span class="usage-tooltip-name">{t("usage.total")}</span>
                    <span class="usage-tooltip-value">{props.format(day().total)}</span>
                  </p>
                </div>
              );
            }}
          </Show>
        </div>
      </div>
    </div>
  );
}
