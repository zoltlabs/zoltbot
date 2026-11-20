import {
  createEffect,
  createMemo,
  createSignal,
  For,
  type JSX,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import type {
  AccountUsage,
  AgentStatus,
  AppInfo,
  CloudAccountStatus,
  ExternalDestination,
  UpdateStatus,
} from "../../../shared/ipc";
import type { TaskSummary } from "../../../shared/tasks";
import type { BotProfile } from "../data";
import { needsYouCount, type SidebarEntry, sidebarEntries, stableEntries } from "../tasks";
import { AgentAvatar } from "./AgentAvatar";
import { SidebarEmployeeRow } from "./SidebarEmployee";
import {
  AccountIcon,
  CloseIcon,
  FeedbackIcon,
  MapIcon,
  MessageIcon,
  ModelsIcon,
  MoreIcon,
  PermissionsIcon,
  PlusIcon,
  SearchIcon,
  SidebarToggleIcon,
  TasksIcon,
  UpdateIcon,
  UsageIcon,
} from "./SidebarIcons";
import {
  SidebarAgentIndicator,
  type SidebarAgentState,
  sidebarAgentStateLabel,
} from "./sidebar/AgentIndicator";
import { AgentContextMenu, type BotContextMenu, DeleteAgentDialog } from "./sidebar/AgentMenus";

export type { SidebarAgentState };
export { SidebarToggleIcon };

interface SidebarProps {
  bots: BotProfile[];
  /** Every task, for the Needs you count and employees running several tasks. */
  tasks: TaskSummary[];
  /** Pending staff approvals, which also count toward Needs you. */
  staffApprovals?: number;
  activeBotId: string;
  mapOpen: boolean;
  tasksOpen: boolean;
  onOpenTasks: () => void;
  /** Whether Models settings cover the conversation. */
  modelsOpen?: boolean;
  appInfo: AppInfo | null;
  agentStatus: AgentStatus;
  accountUsage: AccountUsage | null;
  cloudAccount: CloudAccountStatus | null;
  updateStatus: UpdateStatus;
  agentStates: Record<string, SidebarAgentState>;
  onSelectBot: (botId: string) => void;
  onOpenMap: () => void;
  onOpenModels?: () => void;
  onCreateBot: () => void;
  onCreateInProject: (projectId: string) => void;
  onCreateProject: () => void;
  onEditBot: (botId: string) => void;
  onDeleteBot: (botId: string) => Promise<void>;
  onRenameBot: (botId: string, name: string) => Promise<void>;
  onRefreshUsage: () => Promise<AccountUsage>;
  onUpdateAction: () => Promise<void>;
  onOpenExternal: (destination: ExternalDestination) => Promise<void>;
  onOpenPermissions: () => void;
  onSignIn: () => Promise<void>;
  onSignOut: () => Promise<void>;
  onCancelSignIn: () => void;
  onCollapse: () => void;
  /** Rendered at the end of the sidebar landmark, e.g. its resize handle. */
  children?: JSX.Element;
  /** Rendered under a project's heading, e.g. its channels. */
  projectRows?: (projectId: string, projectName: string) => JSX.Element;
}

export function Sidebar(props: SidebarProps) {
  const [query, setQuery] = createSignal("");
  const [contextMenu, setContextMenu] = createSignal<BotContextMenu | null>(null);
  const [deleteTargetId, setDeleteTargetId] = createSignal<string | null>(null);
  const [deleting, setDeleting] = createSignal(false);
  const [deleteError, setDeleteError] = createSignal<string | null>(null);
  const [renamingId, setRenamingId] = createSignal<string | null>(null);
  const [fadeAtTop, setFadeAtTop] = createSignal(false);
  const [fadeAtBottom, setFadeAtBottom] = createSignal(false);
  const [accountMenuOpen, setAccountMenuOpen] = createSignal(false);
  const [usageLoading, setUsageLoading] = createSignal(false);
  const [accountError, setAccountError] = createSignal<string | null>(null);
  const [accountBusy, setAccountBusy] = createSignal<"sign-in" | "sign-out" | null>(null);
  let firstMenuItem: HTMLButtonElement | undefined;
  let sidebarElement: HTMLElement | undefined;
  let botList: HTMLElement | undefined;
  const filteredBots = createMemo(() => {
    const normalizedQuery = query().trim().toLowerCase();
    return normalizedQuery
      ? props.bots.filter((bot) =>
          `${bot.name} ${bot.role} ${bot.preview}`.toLowerCase().includes(normalizedQuery),
        )
      : props.bots;
  });
  const [expanded, setExpanded] = createSignal<Record<string, boolean>>({});
  const stable = stableEntries();
  /** Bots in order; an employee running several tasks becomes one row, unless filtered. */
  const entries = createMemo(() =>
    stable(
      query().trim()
        ? filteredBots().map((bot): SidebarEntry => ({ kind: "bot", bot }))
        : sidebarEntries(props.bots, props.tasks),
    ),
  );
  const firstBot = (entry: SidebarEntry | undefined) =>
    entry?.kind === "employee" ? entry.employee.bots[0] : entry?.bot;
  const needsYou = createMemo(() => needsYouCount(props.tasks) + (props.staffApprovals ?? 0));
  /** Rows start a new group where the project changes, unless the list is filtered. */
  const groupHeading = (index: number) => {
    if (query().trim()) return undefined;
    const bot = firstBot(entries()[index]);
    const previous = index > 0 ? firstBot(entries()[index - 1]) : undefined;
    if (!bot || (previous && (previous.projectId ?? null) === (bot.projectId ?? null)))
      return undefined;
    if (bot.projectId)
      return {
        projectId: bot.projectId,
        name: bot.projectName || "Project",
        title: bot.projectName,
      };
    return previous
      ? { projectId: null, name: "Chats", title: "Chats outside a project" }
      : undefined;
  };
  const signedIn = createMemo(() => props.cloudAccount?.signedIn === true);
  const accountEmail = createMemo(() => (signedIn() ? props.cloudAccount?.email : null) ?? null);
  const accountName = createMemo(
    () => accountEmail() ?? (props.cloudAccount?.configured ? "Sign in" : "Zoltbot"),
  );
  const accountInitials = createMemo(() => {
    const localPart =
      (signedIn() ? props.cloudAccount?.name : null) ?? accountEmail()?.split("@")[0] ?? "Zoltbot";
    const parts = localPart.split(/[._\-\s]+/).filter(Boolean);
    return (
      parts.length > 1 ? `${parts[0]?.[0]}${parts[1]?.[0]}` : localPart.slice(0, 2)
    ).toUpperCase();
  });
  const weeklyUsage = createMemo(() => {
    const limit =
      props.accountUsage?.limits.find((candidate) => candidate.id === "codex") ??
      props.accountUsage?.limits[0];
    if (!limit) return null;
    return (
      [limit.primary, limit.secondary].find((window) => window?.windowDurationMins === 10_080) ??
      limit.secondary ??
      limit.primary
    );
  });
  const weeklyUsageRemaining = createMemo(() => {
    const usage = weeklyUsage();
    return usage ? Math.max(0, Math.round(100 - usage.usedPercent)) : null;
  });
  const deleteTarget = createMemo(() => props.bots.find((bot) => bot.id === deleteTargetId()));
  const updateAvailable = createMemo(() =>
    ["available", "downloading", "ready", "installing"].includes(props.updateStatus.phase),
  );
  const updateBusy = createMemo(() =>
    ["checking", "downloading", "installing"].includes(props.updateStatus.phase),
  );
  const updateLabel = createMemo(() => {
    switch (props.updateStatus.phase) {
      case "checking":
        return "Checking for updates…";
      case "available":
        return "Download update";
      case "downloading":
        return "Downloading update…";
      case "ready":
        return "Restart to update";
      case "installing":
        return "Restarting…";
      case "up-to-date":
        return "Check for updates";
      case "error":
        return "Check for updates";
      default:
        return "Check for updates";
    }
  });
  const updateDetail = createMemo(() => {
    const status = props.updateStatus;
    if (status.phase === "downloading" && status.progress !== null) {
      return `${Math.round(status.progress)}%`;
    }
    if (status.availableVersion) return `v${status.availableVersion}`;
    if (status.phase === "up-to-date") return "Up to date";
    return status.currentVersion ? `v${status.currentVersion}` : "";
  });
  const popoverError = createMemo(
    () =>
      accountError() ?? (props.updateStatus.phase === "error" ? props.updateStatus.message : null),
  );

  function updateScrollFade() {
    if (!botList) return;
    const remaining = botList.scrollHeight - botList.scrollTop - botList.clientHeight;
    setFadeAtTop(botList.scrollTop > 2);
    setFadeAtBottom(remaining > 2);
  }

  createEffect(() => {
    filteredBots();
    requestAnimationFrame(updateScrollFade);
  });

  onMount(() => {
    const closeMenu = () => {
      setContextMenu(null);
      setAccountMenuOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (deleteTargetId()) setDeleteTargetId(null);
      else if (accountMenuOpen()) setAccountMenuOpen(false);
      else closeMenu();
    };
    window.addEventListener("pointerdown", closeMenu);
    window.addEventListener("blur", closeMenu);
    window.addEventListener("resize", closeMenu);
    window.addEventListener("keydown", closeOnEscape);
    const resizeObserver = new ResizeObserver(updateScrollFade);
    if (botList) resizeObserver.observe(botList);
    requestAnimationFrame(updateScrollFade);
    onCleanup(() => {
      resizeObserver.disconnect();
      window.removeEventListener("pointerdown", closeMenu);
      window.removeEventListener("blur", closeMenu);
      window.removeEventListener("resize", closeMenu);
      window.removeEventListener("keydown", closeOnEscape);
    });
  });

  function openContextMenu(botId: string, x: number, y: number) {
    setDeleteError(null);
    setContextMenu({
      botId,
      x: Math.max(8, Math.min(x, window.innerWidth - 190)),
      y: Math.max(8, Math.min(y, window.innerHeight - 156)),
    });
    requestAnimationFrame(() => firstMenuItem?.focus());
  }

  function toggleRowMenu(botId: string, button: HTMLElement) {
    if (contextMenu()?.botId === botId) {
      setContextMenu(null);
      return;
    }
    const bounds = button.getBoundingClientRect();
    openContextMenu(botId, bounds.right - 178, bounds.bottom + 4);
  }

  function startRename(botId: string) {
    setRenamingId(botId);
  }

  async function finishRename(bot: BotProfile, value: string) {
    if (renamingId() !== bot.id) return;
    setRenamingId(null);
    const name = value.trim();
    if (!name || name === bot.name) return;
    try {
      await props.onRenameBot(bot.id, name);
    } catch {
      // The conversation shows the error.
    }
  }

  async function confirmDelete() {
    const botId = deleteTargetId();
    if (!botId || deleting()) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await props.onDeleteBot(botId);
      setDeleteTargetId(null);
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : String(error));
    } finally {
      setDeleting(false);
    }
  }

  async function refreshUsage() {
    if (usageLoading() || props.agentStatus.phase !== "ready") return;
    setUsageLoading(true);
    setAccountError(null);
    try {
      await props.onRefreshUsage();
    } catch (error) {
      setAccountError(error instanceof Error ? error.message : "Usage is unavailable.");
    } finally {
      setUsageLoading(false);
    }
  }

  function toggleAccountMenu() {
    const opening = !accountMenuOpen();
    setAccountMenuOpen(opening);
    setAccountError(null);
    if (opening) void refreshUsage();
  }

  function openExternal(destination: ExternalDestination) {
    setAccountError(null);
    void props
      .onOpenExternal(destination)
      .then(() => setAccountMenuOpen(false))
      .catch((error) =>
        setAccountError(error instanceof Error ? error.message : "Could not open the link."),
      );
  }

  function runAccountAction(kind: "sign-in" | "sign-out") {
    if (accountBusy()) return;
    setAccountBusy(kind);
    setAccountError(null);
    void (kind === "sign-in" ? props.onSignIn() : props.onSignOut())
      .catch((error) =>
        setAccountError(
          error instanceof Error
            ? error.message
            : kind === "sign-in"
              ? "Couldn’t sign in."
              : "Couldn’t sign out.",
        ),
      )
      .finally(() => setAccountBusy(null));
  }

  function runUpdateAction() {
    setAccountError(null);
    void props
      .onUpdateAction()
      .catch((error) =>
        setAccountError(error instanceof Error ? error.message : "Could not update Zoltbot."),
      );
  }

  return (
    <aside
      ref={(element) => (sidebarElement = element)}
      id="bot-sidebar"
      aria-label="Bot navigation"
      class="sidebar panel-edge"
    >
      <div class="window-drag sidebar-topbar">
        <button
          type="button"
          class="sidebar-icon-button sidebar-toggle-button no-drag"
          onClick={props.onCollapse}
          aria-label="Hide sidebar"
          aria-controls="bot-sidebar"
          aria-expanded="true"
          title="Hide sidebar"
        >
          <SidebarToggleIcon />
        </button>
        <button
          type="button"
          class="sidebar-icon-button sidebar-new-button no-drag"
          onClick={props.onCreateBot}
          aria-label="New agent"
        >
          <PlusIcon />
        </button>
      </div>

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
          <span class="bot-row-copy">Map</span>
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
          <span class="bot-row-copy">Tasks</span>
          <Show when={needsYou() > 0}>
            <span class="sidebar-tasks-count">
              {needsYou()}
              <span class="sr-only"> need you</span>
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
            <span class="bot-row-copy">Models</span>
          </button>
        </Show>
      </div>

      <div class="sidebar-search-wrap">
        <label class="search-field">
          <span class="sr-only">Search chats</span>
          <SearchIcon />
          <input
            type="search"
            value={query()}
            onInput={(event) => setQuery(event.currentTarget.value)}
            placeholder="Search"
            aria-label="Search chats"
          />
        </label>
      </div>

      <nav
        ref={(element) => (botList = element)}
        aria-label="Bot list"
        class="bot-list"
        classList={{
          "scroll-fade-top": fadeAtTop(),
          "scroll-fade-bottom": fadeAtBottom(),
        }}
        onScroll={() => updateScrollFade()}
      >
        <Show
          when={filteredBots().length > 0}
          fallback={
            <p class="empty-search">{props.bots.length ? "No matches" : "No agents yet"}</p>
          }
        >
          <For each={entries()}>
            {(entry, index) => {
              const botRow = (bot: BotProfile) => (
                <div class="bot-row-item">
                  <Show
                    when={renamingId() !== bot.id}
                    fallback={
                      <form
                        class="bot-row bot-row-renaming"
                        classList={{ "bot-row-nested": (bot.depth ?? 0) > 0 }}
                        style={{ "--bot-depth": String(Math.min(bot.depth ?? 0, 4)) }}
                        onSubmit={(event) => {
                          event.preventDefault();
                          const input = event.currentTarget.elements.namedItem("name");
                          if (input instanceof HTMLInputElement)
                            void finishRename(bot, input.value);
                        }}
                      >
                        <span class="bot-row-avatar">
                          <AgentAvatar bot={bot} />
                        </span>
                        <input
                          ref={(element) =>
                            requestAnimationFrame(() => {
                              element.focus();
                              element.select();
                            })
                          }
                          name="name"
                          class="bot-row-rename-input"
                          aria-label={`Rename ${bot.name}`}
                          value={bot.name}
                          maxLength={80}
                          autocomplete="off"
                          spellcheck={false}
                          onKeyDown={(event) => {
                            if (event.key !== "Escape") return;
                            event.preventDefault();
                            event.stopPropagation();
                            setRenamingId(null);
                          }}
                          onBlur={(event) => void finishRename(bot, event.currentTarget.value)}
                        />
                      </form>
                    }
                  >
                    <button
                      type="button"
                      class="bot-row"
                      classList={{
                        "bot-row-active": props.activeBotId === bot.id,
                        "bot-row-menu-open": contextMenu()?.botId === bot.id,
                        "bot-row-nested": (bot.depth ?? 0) > 0,
                      }}
                      style={{ "--bot-depth": String(Math.min(bot.depth ?? 0, 4)) }}
                      aria-pressed={props.activeBotId === bot.id}
                      onClick={() => props.onSelectBot(bot.id)}
                      onContextMenu={(event) => {
                        event.preventDefault();
                        openContextMenu(bot.id, event.clientX, event.clientY);
                      }}
                      onKeyDown={(event) => {
                        if (
                          event.key !== "ContextMenu" &&
                          !(event.shiftKey && event.key === "F10")
                        ) {
                          return;
                        }
                        event.preventDefault();
                        const bounds = event.currentTarget.getBoundingClientRect();
                        openContextMenu(bot.id, bounds.left + 28, bounds.top + 32);
                      }}
                    >
                      <span class="bot-row-avatar">
                        <AgentAvatar bot={bot} />
                        <Show when={props.agentStates[bot.id]}>
                          {(state) => <SidebarAgentIndicator state={state()} />}
                        </Show>
                      </span>
                      <span class="bot-row-copy">
                        <span class="bot-row-heading">
                          <span class="bot-row-title">
                            <strong>{bot.name}</strong>
                            <Show when={bot.roleLabel}>
                              <em class="bot-row-role">{bot.roleLabel}</em>
                            </Show>
                          </span>
                          <span class="bot-row-time">{bot.time}</span>
                        </span>
                        <span class="bot-row-preview">{bot.preview}</span>
                      </span>
                      <Show when={props.agentStates[bot.id]}>
                        {(state) => <span class="sr-only">{sidebarAgentStateLabel(state())}</span>}
                      </Show>
                    </button>
                    <button
                      type="button"
                      class="bot-row-more"
                      aria-label={`Actions for ${bot.name}`}
                      aria-haspopup="menu"
                      aria-expanded={contextMenu()?.botId === bot.id}
                      title="More"
                      onPointerDown={(event) => event.stopPropagation()}
                      onClick={(event) => toggleRowMenu(bot.id, event.currentTarget)}
                    >
                      <MoreIcon />
                    </button>
                  </Show>
                </div>
              );
              return (
                <>
                  <Show when={groupHeading(index())}>
                    {(heading) => (
                      <div class="bot-group-header">
                        <span class="bot-group-name" title={heading().title}>
                          {heading().name}
                        </span>
                        <Show when={heading().projectId}>
                          {(projectId) => (
                            <button
                              type="button"
                              class="sidebar-icon-button bot-group-add"
                              aria-label={`New chat in ${heading().name}`}
                              title={`New chat in ${heading().name}`}
                              onClick={() => props.onCreateInProject(projectId())}
                            >
                              <PlusIcon />
                            </button>
                          )}
                        </Show>
                      </div>
                    )}
                  </Show>
                  <Show when={groupHeading(index())?.projectId}>
                    {(projectId) =>
                      props.projectRows?.(projectId(), groupHeading(index())?.name ?? "")
                    }
                  </Show>
                  {entry.kind === "employee" ? (
                    <SidebarEmployeeRow
                      employee={entry.employee}
                      expanded={expanded()[entry.employee.key] === true}
                      activeBotId={props.activeBotId}
                      working={entry.employee.bots.some(
                        (bot) => props.agentStates[bot.id]?.kind === "working",
                      )}
                      onToggle={() =>
                        setExpanded((current) => ({
                          ...current,
                          [entry.employee.key]: !current[entry.employee.key],
                        }))
                      }
                      onSelectBot={props.onSelectBot}
                    />
                  ) : (
                    botRow(entry.bot)
                  )}
                </>
              );
            }}
          </For>
        </Show>
        <Show when={!query().trim()}>
          <button type="button" class="bot-row bot-new-project" onClick={props.onCreateProject}>
            <span class="bot-new-project-icon" aria-hidden="true">
              <PlusIcon />
            </span>
            <span class="bot-row-copy">New project</span>
          </button>
        </Show>
      </nav>

      <div class="sidebar-account">
        <Show when={accountMenuOpen()}>
          <div
            class="account-popover"
            role="menu"
            aria-label="Account menu"
            onPointerDown={(event) => event.stopPropagation()}
          >
            <Show when={props.cloudAccount?.configured}>
              <Show
                when={signedIn()}
                fallback={
                  <>
                    <button
                      type="button"
                      role="menuitem"
                      class="account-menu-row"
                      onClick={() => runAccountAction("sign-in")}
                      disabled={accountBusy() !== null}
                    >
                      <AccountIcon />
                      <span>
                        {accountBusy() === "sign-in" ? "Waiting for browser…" : "Sign in"}
                      </span>
                    </button>
                    <Show when={accountBusy() === "sign-in"}>
                      <button
                        type="button"
                        role="menuitem"
                        class="account-menu-row"
                        onClick={props.onCancelSignIn}
                      >
                        <CloseIcon />
                        <span>Cancel sign-in</span>
                      </button>
                    </Show>
                  </>
                }
              >
                <div class="account-identity">
                  <Show when={props.cloudAccount?.name}>{(name) => <strong>{name()}</strong>}</Show>
                  <span>{accountEmail()}</span>
                </div>
                <button
                  type="button"
                  role="menuitem"
                  class="account-menu-row"
                  onClick={() => runAccountAction("sign-out")}
                  disabled={accountBusy() !== null}
                >
                  <AccountIcon />
                  <span>{accountBusy() === "sign-out" ? "Signing out…" : "Sign out"}</span>
                </button>
              </Show>
              <div class="account-menu-separator" />
            </Show>
            <Show when={props.updateStatus.phase !== "unsupported"}>
              <button
                type="button"
                role="menuitem"
                class="account-menu-row account-update-row"
                onClick={runUpdateAction}
                disabled={updateBusy()}
              >
                <UpdateIcon active={updateBusy()} />
                <span>{updateLabel()}</span>
                <small>{updateDetail()}</small>
              </button>
              <div class="account-menu-separator" />
            </Show>
            <button
              type="button"
              role="menuitem"
              class="account-menu-row"
              onClick={() => void refreshUsage()}
              disabled={usageLoading() || props.agentStatus.phase !== "ready"}
            >
              <UsageIcon />
              <span>{usageLoading() ? "Updating usage…" : "Weekly usage"}</span>
              <small>{weeklyUsageRemaining() === null ? "—" : `${weeklyUsageRemaining()}%`}</small>
            </button>
            <div class="account-menu-separator" />
            <button
              type="button"
              role="menuitem"
              class="account-menu-row"
              onClick={() => {
                setAccountMenuOpen(false);
                props.onOpenPermissions();
              }}
            >
              <PermissionsIcon />
              <span>Agents &amp; permissions</span>
            </button>
            <div class="account-menu-separator" />
            <button
              type="button"
              role="menuitem"
              class="account-menu-row"
              onClick={() => openExternal("feedback")}
            >
              <FeedbackIcon />
              <span>Send feedback</span>
            </button>
            <button
              type="button"
              role="menuitem"
              class="account-menu-row"
              onClick={() => openExternal("message")}
            >
              <MessageIcon />
              <span>Message</span>
            </button>
            <Show when={popoverError()}>
              {(message) => <p class="account-popover-error">{message()}</p>}
            </Show>
          </div>
        </Show>

        <button
          type="button"
          class="sidebar-footer"
          aria-label="Open account menu"
          aria-expanded={accountMenuOpen()}
          onClick={toggleAccountMenu}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <span class="profile-dot">{accountInitials()}</span>
          <span class="profile-copy">
            <strong>{accountName()}</strong>
            <Show when={props.appInfo}>
              {(info) => (
                <span class="sr-only" data-testid="app-version">
                  Version {info().version} · {info().platform}
                </span>
              )}
            </Show>
          </span>
          <Show when={updateAvailable()}>
            <span class="sidebar-update-pill">Update</span>
            <span class="sr-only">Zoltbot update available</span>
          </Show>
        </button>
      </div>

      <Show when={contextMenu()}>
        {(menu) => (
          <AgentContextMenu
            menu={menu()}
            mount={sidebarElement}
            firstItemRef={(element) => (firstMenuItem = element)}
            onClose={() => setContextMenu(null)}
            onRename={startRename}
            onEdit={props.onEditBot}
            onDelete={setDeleteTargetId}
          />
        )}
      </Show>

      <Show when={deleteTarget()}>
        {(bot) => (
          <DeleteAgentDialog
            bot={bot()}
            deleting={deleting()}
            error={deleteError()}
            onCancel={() => setDeleteTargetId(null)}
            onConfirm={() => void confirmDelete()}
          />
        )}
      </Show>
      {props.children}
    </aside>
  );
}
