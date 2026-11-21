// R3: every routine in one place. The List tab runs, pauses and reschedules them and shows their
// recent runs; the Schedule tab shows the next 60 days on a calendar. R7: the Workflows tab shows
// each workflow as a graph.
import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { createStore, reconcile, unwrap } from "solid-js/store";
import type { RoutineItem, RoutineRun } from "../../../../shared/routines";
import { t } from "../../i18n";
import { type Anchor, Menu, type MenuItem, showToast } from "../../kit";
import { SidebarToggleIcon } from "../SidebarIcons";
import { AddToCalendar } from "./AddToCalendar";
import { KeepAwakeSelect } from "./KeepAwakeSelect";
import {
  dateTimeText,
  errorText,
  runStatusText,
  scheduleText,
  statusText,
  triggerText,
} from "./routine-format";
import { ScheduleDialog } from "./ScheduleDialog";
import { ScheduleView } from "./ScheduleView";
import { RotateDialog, webAddress, webAddressMenu } from "./WebAddress";
import { WorkflowsView } from "./WorkflowsView";
import "./routines.css";

type View = "list" | "schedule" | "workflows";
/** What the status line reads out once an action finishes. */
type Status = Promise<string>;

const failure = (error: unknown) => errorText(error) || t("routines.failed");

export function RoutinesPage(props: { sidebarCollapsed: boolean; onShowSidebar: () => void }) {
  // A store reconciled by id keeps each row's nodes, so focus stays on its button after a change.
  const [items, setItems] = createStore<RoutineItem[]>([]);
  const [loaded, setLoaded] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [view, setView] = createSignal<View>("list");
  const [now, setNow] = createSignal(new Date());
  const [menu, setMenu] = createSignal<{ item: RoutineItem; anchor: Anchor } | null>(null);
  const [editing, setEditing] = createSignal<RoutineItem | null>(null);
  const [rotating, setRotating] = createSignal<RoutineItem | null>(null);
  const [runs, setRuns] = createSignal<{ id: string; items: RoutineRun[] } | null>(null);
  const [status, setStatus] = createSignal("");
  let heading: HTMLHeadingElement | undefined;

  async function load() {
    try {
      setItems(reconcile(await window.openbot.routines.list(), { key: "id" }));
      setNow(new Date());
      setError(null);
    } catch (problem) {
      setError(failure(problem));
    } finally {
      setLoaded(true);
    }
  }
  onMount(() => {
    heading?.focus();
    void load();
    const timer = setInterval(() => void load(), 30_000);
    onCleanup(() => clearInterval(timer));
  });

  const replace = (next: RoutineItem) =>
    setItems(
      reconcile(
        unwrap(items).map((item) => (item.id === next.id ? next : item)),
        { key: "id" },
      ),
    );

  async function act(work: () => Status) {
    setError(null);
    // Cleared first, so the same message is read out again.
    setStatus("");
    try {
      setStatus(await work());
    } catch (problem) {
      setError(failure(problem));
    }
  }
  async function showRuns(item: RoutineItem) {
    if (runs()?.id === item.id) return setRuns(null);
    await act(async () => {
      const list = await window.openbot.routines.history(item.id);
      setRuns({ id: item.id, items: list });
      return t("routines.runs.shown", { name: item.name, count: list.length });
    });
  }
  const runNow = (item: RoutineItem) =>
    act(async () => {
      await window.openbot.routines.runNow(item.id);
      if (runs()?.id === item.id)
        setRuns({ id: item.id, items: await window.openbot.routines.history(item.id) });
      return t("routines.started", { name: item.name });
    });
  const setPaused = (item: RoutineItem, paused: boolean) =>
    act(async () => {
      replace(await window.openbot.routines.setPaused({ id: item.id, paused }));
      return t(paused ? "routines.pausedStatus" : "routines.resumedStatus", { name: item.name });
    });

  const menuGroups = (item: RoutineItem): MenuItem[][] => [
    [
      ...(item.trigger
        ? []
        : [{ id: "run", label: t("routines.action.runNow"), run: () => void runNow(item) }]),
      {
        id: "pause",
        label: t(item.paused ? "routines.action.resume" : "routines.action.pause"),
        run: () => void setPaused(item, !item.paused),
      },
      ...(item.trigger || item.workflow
        ? []
        : [
            {
              id: "schedule",
              label: t("routines.action.schedule"),
              run: () => setEditing(item),
            },
          ]),
    ],
    ...webAddressMenu(
      item,
      // A toast, so sighted people see it too; it is announced, so the status line stays quiet.
      (action) =>
        void act(async () => {
          showToast({ message: await webAddress(item, action) });
          return "";
        }),
      () => setRotating(item),
    ),
    [
      {
        id: "runs",
        label: t(runs()?.id === item.id ? "routines.action.hideRuns" : "routines.action.showRuns"),
        run: () => void showRuns(item),
      },
    ],
  ];

  return (
    <main aria-label={t("routines.title")} class="map-panel routines-panel">
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
          {t("routines.title")}
        </h1>
      </header>
      <div class="tasks-body routines-body">
        <div class="memory-toolbar no-drag">
          <fieldset class="memory-views">
            <legend class="sr-only">{t("routines.view.label")}</legend>
            <button
              type="button"
              class="memory-view"
              aria-pressed={view() === "list"}
              onClick={() => setView("list")}
            >
              {t("routines.view.list")}
            </button>
            <button
              type="button"
              class="memory-view"
              aria-pressed={view() === "schedule"}
              onClick={() => setView("schedule")}
            >
              {t("routines.view.schedule")}
            </button>
            <button
              type="button"
              class="memory-view"
              aria-pressed={view() === "workflows"}
              onClick={() => setView("workflows")}
            >
              {t("routines.view.workflows")}
            </button>
          </fieldset>
          <div class="routines-tools">
            <KeepAwakeSelect />
            <AddToCalendar
              items={items}
              onAdded={(runs) => setStatus(t("routines.calendar.added", { count: runs }))}
            />
          </div>
        </div>
        <output class="sr-only">{status()}</output>
        <Show when={error()}>
          {(message) => (
            <p class="tasks-error" role="alert">
              {message()}
            </p>
          )}
        </Show>
        <Show when={view() === "workflows"}>
          <WorkflowsView onStatus={setStatus} />
        </Show>
        <Show when={loaded() && view() !== "workflows"}>
          <Show when={items.length} fallback={<p class="tasks-empty">{t("routines.empty")}</p>}>
            <Show when={view() === "list"} fallback={<ScheduleView items={items} now={now()} />}>
              <ul class="routines-list">
                <For each={items}>
                  {(item) => (
                    <li class="routines-item" classList={{ "routines-item-paused": item.paused }}>
                      <div class="routines-item-main">
                        <div class="routines-item-text">
                          <span class="routines-name">{item.name}</span>
                          <span class="routines-meta">
                            {t("routines.meta", {
                              when: item.trigger
                                ? triggerText(item.trigger)
                                : item.schedule.cron === "@once"
                                  ? t("routines.when.once")
                                  : scheduleText(item.schedule),
                              agent: item.agent,
                            })}
                          </span>
                        </div>
                        <span class="routines-status">{statusText(item)}</span>
                        <button
                          type="button"
                          class="sidebar-icon-button routines-more"
                          aria-label={t("routines.actions", { name: item.name })}
                          aria-haspopup="menu"
                          aria-expanded={menu()?.item.id === item.id}
                          onClick={(event) => setMenu({ item, anchor: event.currentTarget })}
                        >
                          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
                            <circle cx="3.5" cy="8" r="1.25" fill="currentColor" />
                            <circle cx="8" cy="8" r="1.25" fill="currentColor" />
                            <circle cx="12.5" cy="8" r="1.25" fill="currentColor" />
                          </svg>
                        </button>
                      </div>
                      <Show when={runs()?.id === item.id && runs()}>
                        {(shown) => (
                          <section
                            class="routines-runs"
                            aria-label={t("routines.runs.label", { name: item.name })}
                          >
                            <Show
                              when={shown().items.length}
                              fallback={<p class="routines-note">{t("routines.runs.none")}</p>}
                            >
                              <ol>
                                <For each={shown().items}>
                                  {(run) => (
                                    <li>
                                      <time datetime={run.scheduledAt}>
                                        {dateTimeText(run.scheduledAt, item.schedule.timezone)}
                                      </time>
                                      <span>
                                        {runStatusText(run.status)}
                                        <Show when={run.manual}>
                                          {" · "}
                                          {t("routines.runs.manual")}
                                        </Show>
                                      </span>
                                      <Show when={run.reason}>
                                        <span class="routines-meta">{run.reason}</span>
                                      </Show>
                                    </li>
                                  )}
                                </For>
                              </ol>
                            </Show>
                          </section>
                        )}
                      </Show>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
          </Show>
        </Show>
      </div>
      <Show when={menu()}>
        {(open) => (
          <Menu
            anchor={open().anchor}
            label={t("routines.actions", { name: open().item.name })}
            groups={menuGroups(open().item)}
            onClose={() => setMenu(null)}
          />
        )}
      </Show>
      <Show when={rotating()}>
        {(item) => (
          <RotateDialog
            item={item()}
            onClose={() => setRotating(null)}
            onRotated={(message) => {
              setRotating(null);
              showToast({ message });
              void load();
            }}
          />
        )}
      </Show>
      <Show when={editing()}>
        {(item) => (
          <ScheduleDialog
            item={item()}
            onClose={() => setEditing(null)}
            onSaved={(next) => {
              replace(next);
              setEditing(null);
              setStatus(t("routines.schedule.saved", { name: next.name }));
            }}
          />
        )}
      </Show>
    </main>
  );
}
