// S6: the Usage page. Spend and tokens by day, by chat or agent, and a project's spending cap.
import { createMemo, createSignal, For, onMount, Show } from "solid-js";
import { t } from "../i18n";
import { Select } from "../kit";
import {
  chartMeasure,
  formatTokens,
  formatUsd,
  formatUsdShort,
  OTHER,
  SPEND_RANGES,
  type SpendMeasure,
  seriesColors,
  sortSpend,
  spendByBot,
  spendByDay,
  spendTotals,
} from "../spend";
import { createSpendStore, type SpendStore } from "../spend-store";
import { SidebarToggleIcon } from "./SidebarIcons";
import { UsageBudget } from "./UsageBudget";
import { dayLabel, UsageChart } from "./UsageChart";
import "../usage.css";

const RANGE_KEYS = {
  today: "usage.range.today",
  "7d": "usage.range.week",
  "30d": "usage.range.month",
} as const;

export function UsagePage(props: {
  /** Made by the page when not given; tests pass their own. */
  store?: SpendStore;
  sidebarCollapsed: boolean;
  onShowSidebar: () => void;
}) {
  const store = props.store ?? createSpendStore();
  const [projectId, setProjectId] = createSignal("");
  const [model, setModel] = createSignal("");
  const [sortBy, setSortBy] = createSignal<SpendMeasure>("cost");
  let heading: HTMLHeadingElement | undefined;
  onMount(() => heading?.focus());

  const all = () => store.view().rows;
  const rows = createMemo(() =>
    all().filter(
      (row) =>
        (!projectId() || row.projectId === projectId()) && (!model() || row.model === model()),
    ),
  );
  const measure = createMemo(() => chartMeasure(rows()));
  const chart = createMemo(() => spendByDay(rows(), store.days(), measure()));
  // Colors follow the unfiltered ranking, so picking a project doesn't repaint an agent.
  const colors = createMemo(() =>
    seriesColors(chart().series, spendByDay(all(), store.days(), measure()).series),
  );
  const totals = createMemo(() => spendTotals(rows()));
  const table = createMemo(() => sortSpend(spendByBot(rows()), sortBy()));
  const models = createMemo(() =>
    [
      ...new Set(
        all()
          .map((row) => row.model)
          .filter(Boolean),
      ),
    ].sort(),
  );
  const projects = () => store.view().projects;
  const project = () => projects().find((entry) => entry.id === projectId());
  const format = (value: number) => (measure() === "cost" ? formatUsd(value) : formatTokens(value));
  const seriesName = (series: { id: string; name: string }) =>
    series.id === OTHER ? t("usage.other") : series.name || t("usage.deletedChat");
  const formatTick = (value: number) =>
    measure() === "cost" ? formatUsdShort(value) : formatTokens(Math.round(value));
  /** A total with unpriced runs reads "$1.20+"; with no price at all, "Not reported". */
  const cost = (value: number, known: boolean) =>
    known
      ? formatUsd(value)
      : value > 0
        ? t("usage.costAtLeast", { amount: formatUsd(value) })
        : t("usage.costUnknown");
  // A filter whose value no longer appears stays visible, so it can be cleared.
  const projectOptions = () => [
    { value: "", label: t("usage.filter.anyProject") },
    ...projects().map((entry) => ({ value: entry.id, label: entry.name })),
  ];
  const modelOptions = () => {
    const names = models().includes(model()) || !model() ? models() : [...models(), model()];
    return [
      { value: "", label: t("usage.filter.anyModel") },
      ...names.map((name) => ({ value: name, label: name })),
    ];
  };
  // Read out the new totals when the range or a filter changes.
  const summary = () =>
    store.loaded() && !store.error()
      ? rows().length
        ? t("usage.summary", {
            cost: cost(totals().costUsd, totals().costKnown),
            tokens: formatTokens(totals().tokens),
          })
        : t("usage.empty")
      : "";

  const sortButton = (by: SpendMeasure, label: string) => (
    <button
      type="button"
      class="usage-sort"
      classList={{ "usage-sort-active": sortBy() === by }}
      onClick={() => setSortBy(by)}
    >
      {label}
    </button>
  );

  return (
    <main aria-label={t("usage.title")} class="map-panel usage-panel">
      <header class="window-drag map-header">
        <Show when={props.sidebarCollapsed}>
          <button
            type="button"
            class="sidebar-icon-button sidebar-restore-button no-drag"
            aria-label={t("memory.showSidebar")}
            aria-controls="bot-sidebar"
            aria-expanded="false"
            title={t("memory.showSidebar")}
            onClick={props.onShowSidebar}
          >
            <SidebarToggleIcon />
          </button>
        </Show>
        <h1 ref={heading} class="map-title tasks-title" tabIndex={-1}>
          {t("usage.title")}
        </h1>
      </header>
      <div class="tasks-body usage-body">
        <div class="memory-toolbar no-drag">
          <fieldset class="memory-views">
            <legend class="sr-only">{t("usage.range.label")}</legend>
            <For each={SPEND_RANGES}>
              {(range) => (
                <button
                  type="button"
                  class="memory-view"
                  aria-pressed={store.range() === range}
                  onClick={() => store.setRange(range)}
                >
                  {t(RANGE_KEYS[range])}
                </button>
              )}
            </For>
          </fieldset>
          <Show when={projects().length || projectId()}>
            <Select
              label={t("usage.filter.project")}
              class="tasks-filter"
              value={projectId()}
              options={projectOptions()}
              onChange={setProjectId}
            />
          </Show>
          <Show when={models().length > 1 || model()}>
            <Select
              label={t("usage.filter.model")}
              class="tasks-filter"
              value={model()}
              options={modelOptions()}
              onChange={setModel}
            />
          </Show>
        </div>
        <output class="sr-only">{summary()}</output>
        <Show when={store.error()}>
          {(message) => (
            <p class="tasks-error" role="alert">
              {message()}
            </p>
          )}
        </Show>
        {/* Keyed, so a half-typed budget doesn't carry over to another project. */}
        <Show when={project()?.id} keyed>
          {(id) => (
            <Show when={project()}>
              {(selected) => (
                <UsageBudget
                  project={selected()}
                  budget={store.view().budgets.find((entry) => entry.projectId === id)}
                  onSave={(usd) => store.setBudget(id, usd)}
                />
              )}
            </Show>
          )}
        </Show>
        <Show when={store.loaded()}>
          <Show when={rows().length} fallback={<p class="tasks-empty">{t("usage.empty")}</p>}>
            <dl class="usage-totals">
              <div>
                <dt>{t("usage.column.cost")}</dt>
                <dd>{cost(totals().costUsd, totals().costKnown)}</dd>
              </div>
              <div>
                <dt>{t("usage.column.tokens")}</dt>
                <dd>{formatTokens(totals().tokens)}</dd>
              </div>
            </dl>
            <Show when={store.days().length > 1}>
              <figure class="usage-figure">
                <figcaption class="usage-chart-title">
                  {measure() === "cost" ? t("usage.chart.cost") : t("usage.chart.tokens")}
                </figcaption>
                <UsageChart
                  series={chart().series}
                  days={chart().days}
                  measure={measure()}
                  colors={colors()}
                  formatTick={formatTick}
                  format={format}
                />
                <table class="sr-only">
                  <caption>{t("usage.chart.byDay")}</caption>
                  <thead>
                    <tr>
                      <th scope="col">{t("usage.column.day")}</th>
                      <For each={chart().series}>
                        {(series) => <th scope="col">{seriesName(series)}</th>}
                      </For>
                      <th scope="col">{t("usage.total")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    <For each={chart().days}>
                      {(day) => (
                        <tr>
                          <th scope="row">
                            {dayLabel(day.day, { weekday: "long", month: "long", day: "numeric" })}
                          </th>
                          <For each={chart().series}>
                            {(series) => <td>{format(day.values[series.id] ?? 0)}</td>}
                          </For>
                          <td>{format(day.total)}</td>
                        </tr>
                      )}
                    </For>
                  </tbody>
                </table>
              </figure>
            </Show>
            <table class="usage-table">
              <caption class="sr-only">{t("usage.table.caption")}</caption>
              <thead>
                <tr>
                  <th scope="col">{t("usage.column.agent")}</th>
                  <th
                    scope="col"
                    class="usage-number"
                    aria-sort={sortBy() === "cost" ? "descending" : "none"}
                  >
                    {sortButton("cost", t("usage.column.cost"))}
                  </th>
                  <th
                    scope="col"
                    class="usage-number"
                    aria-sort={sortBy() === "tokens" ? "descending" : "none"}
                  >
                    {sortButton("tokens", t("usage.column.tokens"))}
                  </th>
                </tr>
              </thead>
              <tbody>
                <For each={table()}>
                  {(row) => (
                    <tr>
                      <th scope="row">{row.botName || t("usage.deletedChat")}</th>
                      <td class="usage-number">{cost(row.costUsd, row.costKnown)}</td>
                      <td class="usage-number">{formatTokens(row.tokens)}</td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </Show>
        </Show>
      </div>
    </main>
  );
}
