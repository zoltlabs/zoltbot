// S9: the sidebar's sort and project filter, and the order they give.
import { createMemo, createSignal, Show } from "solid-js";
import type { BotProfile } from "../../data";
import { t } from "../../i18n";
import { Menu } from "../../kit";
import { SortIcon } from "./ChatIcons";
import {
  ALL_PROJECTS,
  arrangeBots,
  type ProjectFilter,
  projectsOf,
  type SidebarSort,
} from "./organize";
import "./organize.css";

const SORT_KEY = "zoltbot.sidebar.sort";

function savedSort(): SidebarSort {
  try {
    return localStorage.getItem(SORT_KEY) === "name" ? "name" : "recent";
  } catch {
    return "recent";
  }
}

/** The sort and filter the owner picked, and the sidebar's chats in that order. */
export function createSidebarOrder(deps: {
  bots: () => readonly BotProfile[];
  isUnread: (bot: BotProfile) => boolean;
  activeBotId: () => string | undefined;
}) {
  // The open chat stays in the group it was in when opened, so reading it doesn't move it away.
  let held: { id: string; unread: boolean } | undefined;
  const grouped = (bot: BotProfile) => {
    const active = deps.activeBotId();
    if (bot.id !== active) return deps.isUnread(bot);
    if (held?.id !== active) held = { id: active, unread: deps.isUnread(bot) };
    return held.unread;
  };
  const [sort, setSortSignal] = createSignal<SidebarSort>(savedSort());
  const [picked, setProject] = createSignal<ProjectFilter>(ALL_PROJECTS);
  const projects = createMemo(() => projectsOf(deps.bots()));
  // A project that's gone, or the only one left, shows everything.
  const project = createMemo((): ProjectFilter => {
    const current = picked();
    return current.kind === "project" &&
      projects().length > 1 &&
      projects().some((entry) => entry.id === current.projectId)
      ? current
      : ALL_PROJECTS;
  });
  const arranged = createMemo(() =>
    arrangeBots(deps.bots(), { sort: sort(), project: project(), isUnread: grouped }),
  );
  function setSort(next: SidebarSort) {
    setSortSignal(next);
    try {
      localStorage.setItem(SORT_KEY, next);
    } catch {
      // Without storage the sort lasts until the app closes.
    }
  }
  return { sort, setSort, project, setProject, projects, arranged };
}

export function SortMenu(props: { order: ReturnType<typeof createSidebarOrder> }) {
  const [open, setOpen] = createSignal(false);
  let button: HTMLButtonElement | undefined;
  const order = props.order;
  const filterName = () => {
    const current = order.project();
    if (current.kind !== "project") return "";
    return order.projects().find((project) => project.id === current.projectId)?.name ?? "";
  };
  const selected = (projectId: string | null) => {
    const current = order.project();
    return current.kind === "project" && current.projectId === projectId;
  };
  return (
    <>
      <button
        ref={button}
        type="button"
        class="sidebar-icon-button sidebar-sort-button"
        classList={{ "sidebar-sort-filtered": order.project().kind === "project" }}
        aria-label={
          filterName()
            ? t("sidebar.sort.filtered", { project: filterName() })
            : t("sidebar.sort.label")
        }
        title={
          filterName()
            ? t("sidebar.sort.filtered", { project: filterName() })
            : t("sidebar.sort.label")
        }
        aria-haspopup="menu"
        aria-expanded={open()}
        onClick={() => setOpen((value) => !value)}
      >
        <SortIcon />
        <Show when={filterName()}>
          <span class="sidebar-sort-dot" aria-hidden="true" />
        </Show>
      </button>
      <Show when={open() && button}>
        {(anchor) => (
          <Menu
            anchor={anchor()}
            label={t("sidebar.sort.label")}
            placement="bottom-end"
            onClose={() => setOpen(false)}
            groups={[
              (["recent", "name"] as const).map((sort) => ({
                id: `sort-${sort}`,
                label: t(sort === "recent" ? "sidebar.sort.recent" : "sidebar.sort.name"),
                checked: order.sort() === sort,
                radio: true,
                run: () => order.setSort(sort),
              })),
              order.projects().length > 1
                ? [
                    {
                      id: "project-all",
                      label: t("sidebar.sort.allProjects"),
                      checked: order.project().kind === "all",
                      radio: true,
                      run: () => order.setProject(ALL_PROJECTS),
                    },
                    ...order.projects().map((project) => ({
                      id: `project-${project.id ?? "none"}`,
                      label: project.name,
                      checked: selected(project.id),
                      radio: true,
                      run: () => order.setProject({ kind: "project", projectId: project.id }),
                    })),
                  ]
                : [],
            ]}
          />
        )}
      </Show>
    </>
  );
}
