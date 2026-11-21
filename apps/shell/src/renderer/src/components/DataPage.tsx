// M8: the Data page. Each project's shared database, as agents left it: tables, a read-only
// grid and a CSV export. Nothing here writes.
import { createEffect, createSignal, For, on, onMount, Show } from "solid-js";
import type { DataCell, DataProject, DataRows, DataTables } from "../../../shared/data";
import { formatNumber, t } from "../i18n";
import { Select } from "../kit";
import { memoryError } from "../memory-store";
import { SidebarToggleIcon } from "./SidebarIcons";
import "../data.css";

const PAGE = 100;
/** The size cap note appears once a database passes this share of its limit. */
const NEAR_FULL = 0.8;

export function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024)
    return t("data.kilobytes", { size: formatNumber(Math.ceil(bytes / 1024)) });
  const size = formatNumber(bytes / (1024 * 1024), { maximumFractionDigits: 1 });
  return t("data.megabytes", { size });
}

function cellText(cell: DataCell): string {
  if (cell === null) return "";
  if (typeof cell === "object") return t("data.blob", { size: formatBytes(cell.bytes) });
  return typeof cell === "number" ? String(cell) : cell;
}

/** Saves text as a file through the browser's download, which the app turns into a save dialog. */
function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function DataPage(props: {
  /** The open chat's project, shown first. */
  projectId: string | null;
  sidebarCollapsed: boolean;
  onShowSidebar: () => void;
}) {
  const [projects, setProjects] = createSignal<DataProject[]>([]);
  const [projectId, setProjectId] = createSignal("");
  const [tables, setTables] = createSignal<DataTables | null>(null);
  const [table, setTable] = createSignal("");
  const [rows, setRows] = createSignal<DataRows | null>(null);
  const [offset, setOffset] = createSignal(0);
  const [error, setError] = createSignal<string | null>(null);
  const [notice, setNotice] = createSignal<string | null>(null);
  const [exporting, setExporting] = createSignal(false);
  let heading: HTMLHeadingElement | undefined;
  let generation = 0;

  onMount(() => {
    heading?.focus();
    void window.openbot.data
      .projects()
      .then((list) => {
        setProjects(list);
        const first = list.find((row) => row.id === props.projectId) ?? list[0];
        setProjectId(first?.id ?? "");
        if (!first) setTables({ tables: [], bytes: 0, limitBytes: 0 });
      })
      .catch((failure) => setError(memoryError(failure)));
  });

  async function loadTables() {
    const id = projectId();
    if (!id) return;
    const current = ++generation;
    try {
      const next = await window.openbot.data.tables(id);
      if (current !== generation) return;
      setTables(next);
      setError(null);
      const keep = next.tables.some((row) => row.name === table());
      if (!keep) {
        setTable(next.tables[0]?.name ?? "");
        setOffset(0);
      }
      await loadRows();
    } catch (failure) {
      if (current === generation) setError(memoryError(failure));
    }
  }

  async function loadRows() {
    const id = projectId();
    const name = table();
    if (!id || !name) return setRows(null);
    const current = generation;
    try {
      const next = await window.openbot.data.rows({
        projectId: id,
        table: name,
        offset: offset(),
        limit: PAGE,
      });
      if (current !== generation) return;
      setRows(next);
      setError(null);
    } catch (failure) {
      if (current === generation) setError(memoryError(failure));
    }
  }

  createEffect(
    on(projectId, () => {
      setTable("");
      setNotice(null);
      void loadTables();
    }),
  );

  function pick(name: string) {
    setTable(name);
    setRows(null);
    setOffset(0);
    setNotice(null);
    generation++;
    void loadRows();
  }

  function page(next: number) {
    setOffset(next);
    generation++;
    void loadRows();
  }

  async function exportCsv() {
    setExporting(true);
    setNotice(null);
    try {
      const result = await window.openbot.data.csv({ projectId: projectId(), table: table() });
      download(result.name, result.csv);
      if (result.truncated) setNotice(t("data.exportCut"));
    } catch (failure) {
      setError(memoryError(failure));
    } finally {
      setExporting(false);
    }
  }

  const list = () => tables()?.tables ?? [];
  const nearFull = () => {
    const current = tables();
    return !!current?.limitBytes && current.bytes >= current.limitBytes * NEAR_FULL;
  };
  const range = () => {
    const current = rows();
    if (!current || !current.total) return "";
    return t("data.range", {
      from: formatNumber(offset() + 1),
      to: formatNumber(offset() + current.rows.length),
      total: formatNumber(current.total),
    });
  };

  return (
    <main aria-label={t("data.title")} class="map-panel data-panel">
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
          {t("data.title")}
        </h1>
      </header>
      <div class="tasks-body data-body">
        <div class="memory-toolbar no-drag">
          <Show when={projects().length > 1}>
            <Select
              label={t("data.project")}
              class="tasks-filter"
              value={projectId()}
              options={projects().map((row) => ({ value: row.id, label: row.name }))}
              onChange={setProjectId}
            />
          </Show>
          <button
            type="button"
            class="zb-kit-button"
            disabled={!projectId()}
            onClick={() => void loadTables()}
          >
            {t("data.refresh")}
          </button>
          <Show when={table()}>
            <button
              type="button"
              class="zb-kit-button"
              disabled={exporting()}
              onClick={() => void exportCsv()}
            >
              {t("data.export")}
            </button>
          </Show>
        </div>
        <Show when={error()}>
          {(message) => (
            <p class="tasks-error" role="alert">
              {message()}
            </p>
          )}
        </Show>
        <Show when={notice()}>{(message) => <p role="status">{message()}</p>}</Show>
        <Show when={nearFull()}>
          <p class="data-note">
            {t("data.nearFull", {
              used: formatBytes(tables()?.bytes ?? 0),
              limit: formatBytes(tables()?.limitBytes ?? 0),
            })}
          </p>
        </Show>
        <Show when={tables()}>
          <Show when={list().length} fallback={<p class="tasks-empty">{t("data.empty")}</p>}>
            <div class="data-layout">
              <nav class="data-tables" aria-label={t("data.tables")}>
                <ul>
                  <For each={list()}>
                    {(row) => (
                      <li>
                        <button
                          type="button"
                          class="data-table-button"
                          aria-current={row.name === table() ? "true" : undefined}
                          onClick={() => pick(row.name)}
                        >
                          <span class="data-table-name">{row.name}</span>
                          <span class="data-table-count">
                            {t("data.rowCount", { count: row.rows })}
                          </span>
                        </button>
                      </li>
                    )}
                  </For>
                </ul>
              </nav>
              <Show when={rows()}>
                {(current) => (
                  <div class="data-grid-wrap">
                    <div
                      class="data-grid-scroll"
                      role="region"
                      aria-label={table()}
                      // biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard users scroll wide or long tables here.
                      tabIndex={0}
                    >
                      <table class="data-grid">
                        <caption class="sr-only">{table()}</caption>
                        <thead>
                          <tr>
                            <For each={current().columns}>
                              {(name) => <th scope="col">{name}</th>}
                            </For>
                          </tr>
                        </thead>
                        <tbody>
                          <For each={current().rows}>
                            {(row) => (
                              <tr>
                                <For each={row}>
                                  {(cell) => (
                                    <td classList={{ "data-number": typeof cell === "number" }}>
                                      {cellText(cell)}
                                    </td>
                                  )}
                                </For>
                              </tr>
                            )}
                          </For>
                        </tbody>
                      </table>
                    </div>
                    <div class="data-pager">
                      <span>{range()}</span>
                      <Show when={current().total > PAGE}>
                        <button
                          type="button"
                          class="zb-kit-button"
                          disabled={offset() === 0}
                          onClick={() => page(Math.max(0, offset() - PAGE))}
                        >
                          {t("data.previous")}
                        </button>
                        <button
                          type="button"
                          class="zb-kit-button"
                          disabled={offset() + PAGE >= current().total}
                          onClick={() => page(offset() + PAGE)}
                        >
                          {t("data.next")}
                        </button>
                      </Show>
                    </div>
                  </div>
                )}
              </Show>
            </div>
          </Show>
        </Show>
      </div>
    </main>
  );
}
