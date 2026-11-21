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
import type { ThreadAction } from "../../../shared/thread-actions";
import { createAppearanceEntry } from "../appearance/AppearanceEntry";
import type { BotProfile } from "../data";
import { Menu, type MenuItem } from "../kit";
import { createDockEntry } from "../dock/DockEntry";
import { createStartFreshEntry } from "../fresh/StartFreshEntry";
import { createMoveEntry } from "../bundle/MoveEntry";
import { createSoundsEntry } from "../sounds/SoundsEntry";
import { needsYouCount, type SidebarEntry, sidebarEntries, stableEntries } from "../tasks";
import { AgentAvatar } from "./AgentAvatar";
import { createBridgesEntry } from "./bridges/BridgesEntry";
import { linkPreviewsEnabled, setLinkPreviewsEnabled } from "./conversation/link-cards";
import { SidebarEmployeeRow } from "./SidebarEmployee";
import {
  AccountIcon,
  CloseIcon,
  FeedbackIcon,
  MessageIcon,
  MoreIcon,
  PermissionsIcon,
  PlusIcon,
  SearchIcon,
  SidebarToggleIcon,
  UpdateIcon,
  UsageIcon,
} from "./SidebarIcons";
import { chooseSendKey, sendKey } from "./send-key";
import {
  SidebarAgentIndicator,
  type SidebarAgentState,
  sidebarAgentStateLabel,
} from "./sidebar/AgentIndicator";
import {
  AgentContextMenu,
  type BotContextMenu,
  chatMenuItems,
  DeleteAgentDialog,
} from "./sidebar/AgentMenus";
import { MutedMark } from "./sidebar/ChatIcons";
import { groupHeadingAt } from "./sidebar/organize";
import { SidebarViews } from "./sidebar/SidebarViews";
import { createSidebarOrder, SortMenu } from "./sidebar/SortMenu";

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
  /** Pin, read state and archive from a chat's row menu. */
  onChatAction?: (bot: BotProfile, action: ThreadAction) => void;
  onOpenMap: () => void;
  onOpenModels?: () => void;
  /** S5: the Memory page, and how many proposals wait for review. */
  memoryOpen?: boolean;
  memoryReviews?: number;
  onOpenMemory?: () => void;
  usageOpen?: boolean;
  onOpenUsage?: () => void;
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
  let accountButton: HTMLButtonElement | undefined;
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
  const isUnread = (bot: BotProfile) =>
    bot.unread === true || props.agentStates[bot.id]?.kind === "unread";
  const order = createSidebarOrder({
    bots: () => props.bots,
    isUnread,
    activeBotId: () => props.activeBotId ?? undefined,
  });
  const unreadCount = () => (query().trim() ? 0 : order.arranged().unread.length);
  const chatItems = (botId: string) => {
    const bot = props.bots.find((entry) => entry.id === botId);
    const working = props.agentStates[botId]?.kind === "working";
    return chatMenuItems(bot, { unread: !!bot && isUnread(bot), working }, props.onChatAction);
  };
  /** Bots in order; an employee running several tasks becomes one row, unless filtered. */
  const entries = createMemo(() =>
    stable(
      query().trim()
        ? filteredBots().map((bot): SidebarEntry => ({ kind: "bot", bot }))
        : [
            ...order.arranged().unread.map((bot): SidebarEntry => ({ kind: "bot", bot })),
            ...sidebarEntries(order.arranged().rest, props.tasks),
          ],
    ),
  );
  const firstBot = (entry: SidebarEntry | undefined) =>
    entry?.kind === "employee" ? entry.employee.bots[0] : entry?.bot;
  const needsYou = createMemo(() => needsYouCount(props.tasks) + (props.staffApprovals ?? 0));
  /** Unread first, then a group wherever the project changes, unless the list is searched. */
  const groupHeading = (index: number) =>
    query().trim()
      ? undefined
      : groupHeadingAt((at) => firstBot(entries()[at]), index, unreadCount());
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
    const resizeObserver = new ResizeObserver(updateScrollFade);
    if (botList) resizeObserver.observe(botList);
    requestAnimationFrame(updateScrollFade);
    onCleanup(() => {
      resizeObserver.disconnect();
    });
  });

  function openContextMenu(menu: BotContextMenu) {
    setDeleteError(null);
    setContextMenu(menu);
  }

  function toggleRowMenu(botId: string, button: HTMLElement) {
    if (contextMenu()?.botId === botId) setContextMenu(null);
    else openContextMenu({ botId, anchor: button, owner: button });
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

  const bridges = createBridgesEntry();
  const appearanceEntry = createAppearanceEntry();
  const soundsEntry = createSoundsEntry();
  const dockEntry = createDockEntry();
  const freshEntry = createStartFreshEntry();
  const moveEntry = createMoveEntry();
  function accountMenuGroups(): MenuItem[][] {
    const busy = accountBusy() !== null;
    const account: MenuItem[] = !props.cloudAccount?.configured
      ? []
      : signedIn()
        ? [
            {
              id: "sign-out",
              label: accountBusy() === "sign-out" ? "Signing out…" : "Sign out",
              icon: <AccountIcon />,
              disabled: busy,
              keepOpen: true,
              run: () => runAccountAction("sign-out"),
            },
          ]
        : [
            {
              id: "sign-in",
              label: accountBusy() === "sign-in" ? "Waiting for browser…" : "Sign in",
              icon: <AccountIcon />,
              disabled: busy,
              keepOpen: true,
              run: () => runAccountAction("sign-in"),
            },
            ...(accountBusy() === "sign-in"
              ? [
                  {
                    id: "cancel-sign-in",
                    label: "Cancel sign-in",
                    icon: <CloseIcon />,
                    keepOpen: true,
                    run: props.onCancelSignIn,
                  },
                ]
              : []),
          ];
    const update: MenuItem[] =
      props.updateStatus.phase === "unsupported"
        ? []
        : [
            {
              id: "update",
              label: updateLabel(),
              detail: updateDetail(),
              icon: <UpdateIcon active={updateBusy()} />,
              disabled: updateBusy(),
              keepOpen: true,
              run: runUpdateAction,
            },
          ];
    return [
      account,
      update,
      [
        {
          id: "usage",
          label: usageLoading() ? "Updating usage…" : "Weekly usage",
          detail: weeklyUsageRemaining() === null ? "—" : `${weeklyUsageRemaining()}%`,
          icon: <UsageIcon />,
          disabled: usageLoading() || props.agentStatus.phase !== "ready",
          keepOpen: true,
          run: () => void refreshUsage(),
        },
      ],
      // C14: which key sends a message.
      [
        {
          id: "send-enter",
          label: "Send with Enter",
          radio: true,
          checked: sendKey() === "enter",
          run: () => chooseSendKey("enter"),
        },
        {
          id: "send-mod-enter",
          label: "Send with ⌘ Enter",
          radio: true,
          checked: sendKey() === "mod-enter",
          run: () => chooseSendKey("mod-enter"),
        },
        // C15: cards under messages with links. The Mac fetches the pages.
        {
          id: "link-previews",
          label: "Show link previews",
          checked: linkPreviewsEnabled(),
          run: () => void setLinkPreviewsEnabled(!linkPreviewsEnabled()).catch(() => undefined),
        },
      ],
      [
        {
          id: "permissions",
          label: "Agents & permissions",
          icon: <PermissionsIcon />,
          run: props.onOpenPermissions,
        },
        bridges.item(),
        appearanceEntry.item(),
        soundsEntry.item(),
        dockEntry.item(),
        moveEntry.item(),
      ],
      [
        {
          id: "feedback",
          label: "Send feedback",
          icon: <FeedbackIcon />,
          keepOpen: true,
          run: () => openExternal("feedback"),
        },
        {
          id: "message",
          label: "Message",
          icon: <MessageIcon />,
          keepOpen: true,
          run: () => openExternal("message"),
        },
      ],
      [freshEntry.item()],
    ];
  }

  return (
    <aside id="bot-sidebar" aria-label="Bot navigation" class="sidebar panel-edge">
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

      <SidebarViews
        mapOpen={props.mapOpen}
        tasksOpen={props.tasksOpen}
        modelsOpen={props.modelsOpen}
        memoryOpen={props.memoryOpen}
        needsYou={needsYou()}
        memoryReviews={props.memoryReviews}
        onOpenMap={props.onOpenMap}
        onOpenTasks={props.onOpenTasks}
        onOpenModels={props.onOpenModels}
        onOpenMemory={props.onOpenMemory}
        usageOpen={props.usageOpen}
        onOpenUsage={props.onOpenUsage}
      />

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
        <SortMenu order={order} />
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
                        openContextMenu({
                          botId: bot.id,
                          anchor: { x: event.clientX, y: event.clientY },
                          owner: event.currentTarget,
                        });
                      }}
                      onKeyDown={(event) => {
                        if (
                          event.key !== "ContextMenu" &&
                          !(event.shiftKey && event.key === "F10")
                        ) {
                          return;
                        }
                        event.preventDefault();
                        openContextMenu({
                          botId: bot.id,
                          anchor: event.currentTarget,
                          owner: event.currentTarget,
                        });
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
                            <Show when={bot.muted}>
                              <MutedMark />
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
        <Show when={accountMenuOpen() && accountButton}>
          {(anchor) => (
            <Menu
              anchor={anchor()}
              label="Account menu"
              placement="top-start"
              header={
                signedIn() ? (
                  <div class="account-identity">
                    <Show when={props.cloudAccount?.name}>
                      {(name) => <strong>{name()}</strong>}
                    </Show>
                    <span>{accountEmail()}</span>
                  </div>
                ) : undefined
              }
              footer={
                popoverError() ? (
                  <p class="account-popover-error" role="alert">
                    {popoverError()}
                  </p>
                ) : undefined
              }
              groups={accountMenuGroups()}
              onClose={() => setAccountMenuOpen(false)}
            />
          )}
        </Show>

        <button
          ref={accountButton}
          type="button"
          class="sidebar-footer"
          aria-label="Open account menu"
          aria-haspopup="menu"
          aria-expanded={accountMenuOpen()}
          onClick={toggleAccountMenu}
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

      <bridges.Dialog />
      <appearanceEntry.Dialog />
      <soundsEntry.Dialog />
      <dockEntry.Dialog />
      <freshEntry.Dialog />
      <moveEntry.Dialog />
      <Show when={contextMenu()}>
        {(menu) => (
          <AgentContextMenu
            menu={menu()}
            chatItems={chatItems(menu().botId)}
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
