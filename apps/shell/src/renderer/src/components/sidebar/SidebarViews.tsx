// The sidebar's page buttons: Map, Tasks, Models, Memory, Routines and Usage.
import { Show } from "solid-js";
import { t } from "../../i18n";
import { MapIcon, ModelsIcon, TasksIcon } from "../SidebarIcons";

function MemoryIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" class="size-4 fill-none stroke-current">
      <path
        d="M5.5 3.5h9a1 1 0 0 1 1 1v12l-5.5-3.2-5.5 3.2v-12a1 1 0 0 1 1-1Z"
        stroke-width="1.4"
        stroke-linejoin="round"
      />
    </svg>
  );
}

function UsageIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" class="size-4 fill-none stroke-current">
      <path
        d="M4 16.5h12M6 13.5v-3M10 13.5v-8M14 13.5v-5"
        stroke-width="1.6"
        stroke-linecap="round"
      />
    </svg>
  );
}

function RoutinesIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" class="size-4 fill-none stroke-current">
      <circle cx="10" cy="10" r="6.5" stroke-width="1.4" />
      <path d="M10 6.5V10l2.5 1.5" stroke-width="1.4" stroke-linecap="round" />
    </svg>
  );
}

export function SidebarViews(props: {
  mapOpen: boolean;
  tasksOpen: boolean;
  modelsOpen?: boolean;
  memoryOpen?: boolean;
  usageOpen?: boolean;
  routinesOpen?: boolean;
  /** Tasks and approvals waiting on the owner. */
  needsYou: number;
  /** What agents proposed to remember, waiting for review. */
  memoryReviews?: number;
  onOpenMap: () => void;
  onOpenTasks: () => void;
  onOpenModels?: (() => void) | undefined;
  onOpenMemory?: (() => void) | undefined;
  onOpenUsage?: (() => void) | undefined;
  onOpenRoutines?: (() => void) | undefined;
}) {
  return (
    <div class="sidebar-views">
      <button
        type="button"
        class="bot-row sidebar-map-button"
        classList={{ "bot-row-active": props.mapOpen }}
        aria-pressed={props.mapOpen}
        onClick={props.onOpenMap}
      >
        <span class="sidebar-map-icon">
          <MapIcon />
        </span>
        <span class="bot-row-copy">{t("sidebar.views.map")}</span>
      </button>
      <button
        type="button"
        class="bot-row sidebar-map-button"
        classList={{ "bot-row-active": props.tasksOpen }}
        aria-pressed={props.tasksOpen}
        aria-keyshortcuts="Meta+T"
        onClick={props.onOpenTasks}
      >
        <span class="sidebar-map-icon">
          <TasksIcon />
        </span>
        <span class="bot-row-copy">{t("sidebar.views.tasks")}</span>
        <Show when={props.needsYou > 0}>
          <span class="sidebar-tasks-count">
            {props.needsYou}
            <span class="sr-only"> {t("sidebar.views.needYou")}</span>
          </span>
        </Show>
      </button>
      <Show when={props.onOpenModels}>
        <button
          type="button"
          class="bot-row sidebar-map-button"
          classList={{ "bot-row-active": props.modelsOpen === true }}
          aria-pressed={props.modelsOpen === true}
          onClick={() => props.onOpenModels?.()}
        >
          <span class="sidebar-map-icon">
            <ModelsIcon />
          </span>
          <span class="bot-row-copy">{t("sidebar.views.models")}</span>
        </button>
      </Show>
      <Show when={props.onOpenMemory}>
        <button
          type="button"
          class="bot-row sidebar-map-button"
          classList={{ "bot-row-active": props.memoryOpen === true }}
          aria-pressed={props.memoryOpen === true}
          onClick={() => props.onOpenMemory?.()}
        >
          <span class="sidebar-map-icon">
            <MemoryIcon />
          </span>
          <span class="bot-row-copy">{t("memory.title")}</span>
          <Show when={(props.memoryReviews ?? 0) > 0}>
            <span class="sidebar-tasks-count">
              {props.memoryReviews}
              <span class="sr-only"> {t("sidebar.views.toReview")}</span>
            </span>
          </Show>
        </button>
      </Show>
      <Show when={props.onOpenRoutines}>
        <button
          type="button"
          class="bot-row sidebar-map-button"
          classList={{ "bot-row-active": props.routinesOpen === true }}
          aria-pressed={props.routinesOpen === true}
          onClick={() => props.onOpenRoutines?.()}
        >
          <span class="sidebar-map-icon">
            <RoutinesIcon />
          </span>
          <span class="bot-row-copy">{t("routines.title")}</span>
        </button>
      </Show>
      <Show when={props.onOpenUsage}>
        <button
          type="button"
          class="bot-row sidebar-map-button"
          classList={{ "bot-row-active": props.usageOpen === true }}
          aria-pressed={props.usageOpen === true}
          onClick={() => props.onOpenUsage?.()}
        >
          <span class="sidebar-map-icon">
            <UsageIcon />
          </span>
          <span class="bot-row-copy">{t("usage.title")}</span>
        </button>
      </Show>
    </div>
  );
}
