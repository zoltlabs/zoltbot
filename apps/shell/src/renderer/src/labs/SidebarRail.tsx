// Experimental: the sidebar's page buttons as an icon rail at the window's left edge. It stays
// when the sidebar hides, so the pages and their counts are one click away.
import { For, type JSX, Show } from "solid-js";
import { MapIcon, ModelsIcon, TasksIcon } from "../components/SidebarIcons";
import {
  DataIcon,
  MemoryIcon,
  RoutinesIcon,
  type SidebarViewsProps,
  UsageIcon,
  VaultIcon,
} from "../components/sidebar/SidebarViews";
import { t } from "../i18n";
import { Tooltip } from "../kit";
import "./rail.css";

interface RailItem {
  id: string;
  label: () => string;
  icon: () => JSX.Element;
  open: () => boolean;
  run: () => (() => void) | undefined;
  count?: () => number;
  countLabel?: () => string;
  keys?: string;
}

export function SidebarRail(props: SidebarViewsProps) {
  // Built once; each item reads its props when drawn, so buttons keep focus as counts change.
  const items: RailItem[] = [
    {
      id: "tasks",
      label: () => t("sidebar.views.tasks"),
      icon: TasksIcon,
      open: () => props.tasksOpen,
      run: () => props.onOpenTasks,
      count: () => props.needsYou,
      countLabel: () => t("sidebar.views.needYou"),
      keys: "Meta+T",
    },
    {
      id: "map",
      label: () => t("sidebar.views.map"),
      icon: MapIcon,
      open: () => props.mapOpen,
      run: () => props.onOpenMap,
    },
    {
      id: "memory",
      label: () => t("memory.title"),
      icon: MemoryIcon,
      open: () => props.memoryOpen === true,
      run: () => props.onOpenMemory,
      count: () => props.memoryReviews ?? 0,
      countLabel: () => t("sidebar.views.toReview"),
    },
    {
      id: "routines",
      label: () => t("routines.title"),
      icon: RoutinesIcon,
      open: () => props.routinesOpen === true,
      run: () => props.onOpenRoutines,
    },
    {
      id: "models",
      label: () => t("sidebar.views.models"),
      icon: ModelsIcon,
      open: () => props.modelsOpen === true,
      run: () => props.onOpenModels,
    },
    {
      id: "usage",
      label: () => t("usage.title"),
      icon: UsageIcon,
      open: () => props.usageOpen === true,
      run: () => props.onOpenUsage,
    },
    {
      id: "vault",
      label: () => t("vault.title"),
      icon: VaultIcon,
      open: () => props.vaultOpen === true,
      run: () => props.onOpenVault,
    },
    {
      id: "data",
      label: () => t("data.title"),
      icon: DataIcon,
      open: () => props.dataOpen === true,
      run: () => props.onOpenData,
    },
  ];

  return (
    <nav class="sidebar-rail" aria-label={t("labs.railLabel")}>
      <For each={items}>
        {(item) => (
          <Show when={item.run()}>
            <Tooltip label={item.label()}>
              <button
                type="button"
                class="sidebar-rail-button"
                classList={{ "sidebar-rail-button-active": item.open() }}
                aria-label={item.label()}
                aria-pressed={item.open()}
                aria-keyshortcuts={item.keys}
                data-rail={item.id}
                onClick={() => item.run()?.()}
              >
                {item.icon()}
                <Show when={(item.count?.() ?? 0) > 0}>
                  <span class="sidebar-rail-count">
                    {item.count?.()}
                    <span class="sr-only"> {item.countLabel?.()}</span>
                  </span>
                </Show>
              </button>
            </Tooltip>
          </Show>
        )}
      </For>
    </nav>
  );
}
