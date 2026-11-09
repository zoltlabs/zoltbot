import "../context/TaskConnectionsContextSection.js";
import { terms } from "@zoltbot/protocol";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Chat from "../chat/Chat.js";
import { ChiefPage } from "../chief/ChiefPage.js";
import { chiefName, chiefThreadId } from "../chief/data.js";
import { CompareSidebar } from "../compare/CompareSidebar.js";
import { assignHues, ProfileHues } from "../components/identity.js";
import { Chip, EmptyState, IconButton, Kbd, ListRow, StatusDot } from "../components/primitives.js";
import { inboxFromSnapshot } from "../inbox/data.js";
import { markRead, mergeSeen, useSeenMigration } from "../inbox/read-state.js";
import { QuickHistory } from "../quick-chat/QuickHistory.js";
import { completeOnboarding, needsOnboarding } from "../setup/onboarding-state.js";
import { UpdateNotice } from "../setup/UpdateNotice.js";
import { navRoutes, routeLabels, routes, useShell } from "../state.js";
import { useConnection } from "../use-connection.js";
import { chatStatuses, mostRecentProject, rowStatuses } from "../workspaces/activity.js";
import { markSeen, useSeen } from "../workspaces/seen.js";
import { emptyRows } from "../workspaces/view.js";
import { WorkspaceTree } from "../workspaces/WorkspaceTree.js";
import { AllChats } from "./AllChats.js";
import { CommandPalette } from "./CommandPalette.js";
import { Icon } from "./icons.js";
import { Overview } from "./Overview.js";
import { SettingsPage } from "./SettingsPage.js";
import { Sidebar, useSidebarDrawer } from "./Sidebar.js";

const CompareView = lazy(() => import("../compare/CompareView.js"));
const ArtifactPage = lazy(() => import("../artifacts/ArtifactPage.js"));
const Gallery = lazy(() => import("../components/Gallery.js"));
const Inbox = lazy(() => import("../interactions/Inbox.js"));
const QuickChat = lazy(() => import("../quick-chat/QuickChat.js"));
const Setup = lazy(() => import("../setup/Setup.js"));
const Workspaces = lazy(() => import("../workspaces/Workspaces.js"));
const Routines = lazy(() => import("../tasks/Routines.js"));
const Tasks = lazy(() => import("../tasks/Tasks.js"));
function useStoredFlag(key: string, initial: boolean) {
  const [value, setValue] = useState(() => {
    try {
      const saved = localStorage.getItem(key);
      return saved === null ? initial : saved === "1";
    } catch {
      return initial;
    }
  });
  const set = useCallback(
    (next: boolean) => {
      setValue(next);
      try {
        localStorage.setItem(key, next ? "1" : "0");
      } catch {}
    },
    [key],
  );
  return [value, set] as const;
}
export function App() {
  const connection = useConnection();
  const threadId = useShell((s) => s.threadId),
    openThread = useShell((s) => s.openThread),
    openRequest = useShell((s) => s.openRequest),
    scope = useShell((s) => s.scope),
    openScope = useShell((s) => s.openScope),
    openQuickChat = useShell((s) => s.openQuickChat);
  const artifactId = useShell((s) => s.artifactId);
  const compareId = useShell((s) => s.compareId);
  const route = useShell((s) => s.route),
    navigate = useShell((s) => s.navigate),
    theme = useShell((s) => s.theme),
    fontScale = useShell((s) => s.fontScale),
    setFontScale = useShell((s) => s.setFontScale),
    setTheme = useShell((s) => s.setTheme),
    setPalette = useShell((s) => s.setPalette);
  const sidebar = useShell((s) => s.sidebar),
    toggleSidebar = useShell((s) => s.toggleSidebar),
    width = useShell((s) => s.width),
    setWidth = useShell((s) => s.setWidth);
  const drawer = useSidebarDrawer();
  const expandedSidebar = drawer.narrow || sidebar;
  const [systemDark, setSystemDark] = useState(
    () => matchMedia("(prefers-color-scheme: dark)").matches,
  );
  const dark = theme === "dark" || (theme === "system" && systemDark);
  const entities = connection.snapshot.entities,
    reviews = (entities.task ?? emptyRows).filter((task) =>
      ["review", "failed"].includes(String(task.state)),
    ).length;
  // Read by the hash listener, which should not re-subscribe on every snapshot.
  const latestEntities = useRef(entities);
  latestEntities.current = entities;
  useEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const change = () => setSystemDark(media.matches);
    media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, []);
  useEffect(() => {
    document.documentElement.style.setProperty("--zb-font-scale", String(fontScale / 100));
  }, [fontScale]);
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? "dark" : "light";
  }, [dark]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey) {
        if (event.key === "k") {
          event.preventDefault();
          setPalette(true);
        }
        if (event.key === "b") {
          event.preventDefault();
          toggleSidebar();
        }
        if (event.key === "i") {
          event.preventDefault();
          navigate("Inbox");
        }
        if (event.key === "j") {
          event.preventDefault();
          openQuickChat();
        }
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [navigate, setPalette, toggleSidebar, openQuickChat]);
  useEffect(() => {
    const hash = () => {
      const raw = location.hash.slice(1);
      if (raw.startsWith("tasks/") && raw.endsWith("/shipping")) {
        try {
          const id = decodeURIComponent(raw.slice(6, -9));
          if (id) useShell.getState().openShipping(id);
        } catch {}
        return;
      }
      if (raw.startsWith("artifact/")) {
        try {
          const id = decodeURIComponent(raw.slice(9));
          if (id && id.length <= 200) useShell.getState().openArtifact(id);
        } catch {}
        return;
      }
      if (raw === "quick" || raw.startsWith("quick/")) {
        try {
          const id = raw.startsWith("quick/") ? decodeURIComponent(raw.slice(6)) : undefined;
          if (route !== "QuickChat" || useShell.getState().quickChatId !== id) openQuickChat(id);
        } catch {}
        return;
      }
      if (raw.startsWith("compare/")) {
        try {
          const id = decodeURIComponent(raw.slice(8));
          if (
            id &&
            (useShell.getState().route !== "Compare" || useShell.getState().compareId !== id)
          )
            useShell.getState().openCompare(id);
        } catch {}
        return;
      }
      if (raw.startsWith("chat/")) {
        try {
          const id = decodeURIComponent(raw.slice(5));
          // The main agent's chat always opens on its own page, beside the overview.
          if (id && id === chiefThreadId(latestEntities.current)) navigate("Chief");
          else if (id) openThread(id);
        } catch {}
        return;
      }
      if (raw.startsWith("projects/")) {
        const [, type, encoded] = raw.split("/");
        if ((type === "project" || type === "subproject") && encoded) {
          try {
            const id = decodeURIComponent(encoded);
            if (scope?.type !== type || scope.id !== id) openScope({ type, id });
          } catch {}
        }
        return;
      }
      const current = raw.toLowerCase();
      const found = [
        ...routes,
        "Settings",
        "Rules",
        "Doctor",
        "Connections",
        "Setup",
        "Chief",
        ...(import.meta.env.DEV ? ["Components"] : []),
      ].find((r) => r.toLowerCase() === current);
      if (found) navigate(found as typeof route);
    };
    hash();
    window.addEventListener("hashchange", hash);
    return () => window.removeEventListener("hashchange", hash);
  }, [navigate, openThread, openScope, scope, route, openQuickChat]);
  // Opening the app with no page in the URL lands on the most recent workspace, ready to start a
  // chat. Without a workspace it stays on Overview.
  const launched = useRef(Boolean(location.hash.slice(1)));
  useEffect(() => {
    if (launched.current || connection.status !== "online") return;
    launched.current = true;
    if (location.hash.slice(1)) return;
    if (needsOnboarding()) {
      navigate("Setup");
      return;
    }
    const project = mostRecentProject(
      entities.project ?? emptyRows,
      entities.thread ?? emptyRows,
      entities.subproject ?? emptyRows,
    );
    if (project) openScope({ type: "project", id: String(project.id) });
  }, [connection.status, entities, openScope, navigate]);
  // A chat on screen counts as read, including turns that finish while you watch it.
  const seen = useSeen();
  // useConnection returns a new object each render, and markSeen re-renders App, so depending on
  // the connection itself would loop; read it through a ref and re-run when its status changes.
  const latestConnection = useRef(connection);
  latestConnection.current = connection;
  const connectionStatus = connection.status;
  useEffect(() => {
    if (route !== "Chat" || !threadId || !entities.turn) return;
    markSeen(threadId);
    // The thread records the read too, so Ready to review clears on every device.
    const ended = entities.turn
      .filter((turn) => turn.threadId === threadId && typeof turn.endedAt === "string")
      .map((turn) => String(turn.endedAt))
      .sort()
      .at(-1);
    if (ended && connectionStatus === "online")
      markRead(
        latestConnection.current,
        entities.thread?.find((row) => row.id === threadId),
        ended,
      );
  }, [route, threadId, entities.turn, entities.thread, connectionStatus]);
  useSeenMigration(connection, seen);
  const inboxCounts = useMemo(() => inboxFromSnapshot(entities).counts, [entities]);
  // Sections remember what you set; landing on a page inside one only opens it, never closes it.
  const [moreOpen, setMoreOpen] = useStoredFlag("zoltbot.sidebar.more.v1", false);
  const [workspaceTreeOpen, setWorkspaceTreeOpen] = useStoredFlag(
    "zoltbot.sidebar.workspaces.v1",
    true,
  );
  useEffect(() => {
    if (route === "Tasks" || route === "Routines") setMoreOpen(true);
    if (route === "Chat" || route === "Projects") setWorkspaceTreeOpen(true);
  }, [route, setMoreOpen, setWorkspaceTreeOpen]);
  const online = connection.status === "online";
  const statuses = useMemo(() => chatStatuses(entities), [entities]);
  const chiefLabel = chiefName(entities);
  const rows = useMemo(
    () =>
      rowStatuses(
        { thread: entities.thread, turn: entities.turn, interaction: entities.interaction },
        mergeSeen(seen, entities.thread),
      ),
    [entities.thread, entities.turn, entities.interaction, seen],
  );
  const sidebarThreads = useMemo(
    () =>
      (entities.thread ?? emptyRows).filter(
        (row) => !entities.compareMember?.some((member) => member.threadId === row.id),
      ),
    [entities.thread, entities.compareMember],
  );
  const inboxTotal = (inboxCounts.needs_you ?? 0) + (inboxCounts.review ?? 0) + reviews;
  const running = [...statuses.values()].filter((status) => status === "working").length;
  const hues = useMemo(
    () =>
      assignHues(
        (entities.agent ?? emptyRows).map((profile) => ({
          id: String(profile.id),
          createdAt: typeof profile.createdAt === "string" ? profile.createdAt : undefined,
        })),
      ),
    [entities.agent],
  );
  const navigationRow = (name: (typeof navRoutes)[number] | "Projects") => (
    <ListRow
      key={name}
      icon={name}
      label={<span className="sidebar-label">{routeLabels[name] ?? name}</span>}
      aria-label={routeLabels[name] ?? name}
      title={routeLabels[name] ?? name}
      current={route === name}
      trailing={
        // Conversations that need you or finished unread, plus tasks waiting for review.
        name === "Inbox" && inboxTotal > 0 ? (
          <span className="sidebar-label">
            <Chip tone="attention">{inboxTotal}</Chip>
          </span>
        ) : name === "Tasks" && reviews > 0 ? (
          <span className="sidebar-label">
            <Chip tone="attention">{reviews}</Chip>
          </span>
        ) : undefined
      }
      onClick={() => {
        navigate(name);
        drawer.close();
      }}
    />
  );
  return (
    <ProfileHues.Provider value={hues}>
      <div
        className={`zb workspace-shell${drawer.narrow ? " sidebar-overlay" : sidebar ? "" : " sidebar-collapsed"}`}
        style={{ "--sidebar-width": `${width}px` } as React.CSSProperties}
      >
        <a className="skip-link zb-button secondary" href="#main-content">
          Skip to content
        </a>
        <Sidebar narrow={drawer.narrow} open={drawer.open} onClose={drawer.close}>
          <button
            type="button"
            className="brand"
            onClick={() => {
              openQuickChat();
              drawer.close();
            }}
            aria-label="Zoltbot: open quick chat"
            title="Open quick chat"
          >
            <span className="logo" aria-hidden="true">
              <img src="./zoltbot.svg" alt="" width="20" height="20" />
            </span>
            <strong className="sidebar-label">Zoltbot</strong>
          </button>
          <button
            type="button"
            className={`sidebar-quick-chat sidebar-chief${route === "Chief" ? " on" : ""}`}
            onClick={() => {
              navigate("Chief");
              drawer.close();
            }}
            aria-label={chiefLabel}
            title={`${chiefLabel}: your main agent across every ${terms.workspace.one}`}
          >
            <Icon name="Chief" />
            <span className="sidebar-label grow">{chiefLabel}</span>
          </button>
          <button
            type="button"
            className={`sidebar-quick-chat${route === "QuickChat" ? " on" : ""}`}
            onClick={() => {
              openQuickChat();
              drawer.close();
            }}
            aria-label="Quick chat"
            title="Quick chat: ask anything without choosing a workspace"
          >
            <Icon name="Sessions" />
            <span className="sidebar-label grow">Quick chat</span>
            <span className="sidebar-label">
              <Kbd>⌘J</Kbd>
            </span>
          </button>
          <button
            type="button"
            className="sidebar-search"
            onClick={() => setPalette(true)}
            aria-label="Search and commands"
            title="Search and commands"
          >
            <Icon name="Search" />
            <span className="sidebar-label grow">Search</span>
            <span className="sidebar-label">
              <Kbd>⌘K</Kbd>
            </span>
          </button>
          <nav aria-label="Workspace">
            {navRoutes.filter((name) => name === "Overview" || name === "Inbox").map(navigationRow)}
            {expandedSidebar ? null : (
              <>
                {navRoutes
                  .filter((name) => name !== "Overview" && name !== "Inbox")
                  .map(navigationRow)}
                {navigationRow("Projects")}
              </>
            )}
            <details
              className="sidebar-section"
              open={moreOpen}
              onToggle={(event) => setMoreOpen(event.currentTarget.open)}
            >
              <summary>More</summary>
              {navRoutes
                .filter((name) => name !== "Overview" && name !== "Inbox")
                .map(navigationRow)}
            </details>
          </nav>
          {expandedSidebar ? <QuickHistory connection={connection} /> : null}
          <div className="project-tree-wrap grow sidebar-label">
            {/* Sits beside the summary rather than inside it, so it never toggles the section. */}
            <span className="tree-add">
              <IconButton
                icon="Plus"
                size="sm"
                label={`Manage ${terms.workspace.many}`}
                onClick={() => navigate("Projects")}
              />
            </span>
            <details
              className="project-tree sidebar-section"
              aria-label={`${terms.workspace.One} tree`}
              open={workspaceTreeOpen}
              onToggle={(event) => setWorkspaceTreeOpen(event.currentTarget.open)}
            >
              <summary>{terms.workspace.Many}</summary>
              <WorkspaceTree
                projects={entities.project ?? emptyRows}
                directions={entities.subproject ?? emptyRows}
                threads={sidebarThreads}
                statuses={statuses}
                rows={rows}
                selected={route === "Projects" ? scope : undefined}
                currentChat={route === "Chat" ? threadId : undefined}
                onScope={openScope}
                onChat={openThread}
              />
              <CompareSidebar connection={connection} />
            </details>
          </div>
          <div className="sidebar-bottom">
            <IconButton
              icon="Settings"
              size="sm"
              label="Settings"
              className={
                ["Settings", "Doctor", "Connections", "Rules"].includes(route) ? "on" : undefined
              }
              onClick={() => {
                navigate("Settings");
                drawer.close();
              }}
            />
          </div>
          {sidebar && !drawer.narrow ? (
            <hr
              className="sidebar-resizer"
              tabIndex={0}
              aria-label="Sidebar width"
              aria-orientation="vertical"
              aria-valuemin={220}
              aria-valuemax={360}
              aria-valuenow={width}
              onPointerDown={(e) => e.currentTarget.setPointerCapture(e.pointerId)}
              onPointerMove={(e) => {
                if (e.currentTarget.hasPointerCapture(e.pointerId)) setWidth(e.clientX);
              }}
              onPointerUp={(e) => e.currentTarget.releasePointerCapture(e.pointerId)}
              onKeyDown={(e) => {
                if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
                  e.preventDefault();
                  setWidth(width + (e.key === "ArrowRight" ? 8 : -8));
                }
              }}
            />
          ) : null}
        </Sidebar>
        <div
          className={`workspace-body${route === "Chat" || route === "QuickChat" || route === "Chief" || route === "Compare" ? " chat-route" : ""}`}
        >
          <header className="workspace-header">
            <IconButton
              icon="Menu"
              size="sm"
              onClick={drawer.narrow ? drawer.show : toggleSidebar}
              aria-expanded={drawer.narrow ? drawer.open : sidebar}
              aria-controls="workspace-sidebar"
              label={drawer.narrow || !sidebar ? "Show sidebar" : "Hide sidebar"}
            />
            <nav className="breadcrumb" aria-label="Breadcrumb">
              <span>Zoltbot</span>
              <Icon name="ChevronRight" size="sm" />
              <span className="page-title" aria-current="page">
                {routeLabels[route] ?? route}
              </span>
            </nav>
            <span className="sp" />
            <IconButton
              icon={dark ? "Sun" : "Moon"}
              size="sm"
              onClick={() => setTheme(dark ? "light" : "dark")}
              label={dark ? "Use light theme" : "Use dark theme"}
            />
          </header>
          {!online ? (
            <section className="offline-banner" aria-live="polite" aria-label="Daemon connection">
              <StatusDot status="blocked" label={false} />
              <div>
                <strong>Reconnecting to the Zoltbot daemon</strong>
                <p>The workspace will reconnect automatically.</p>
              </div>
            </section>
          ) : null}
          <main
            id="main-content"
            tabIndex={-1}
            className={`main-content${route === "Chat" || route === "QuickChat" || route === "Chief" || route === "Compare" ? " chat-page" : route === "Inbox" ? " inbox-page" : ""}`}
          >
            {import.meta.env.DEV && route === "Components" ? (
              <Suspense fallback={<p>Loading components</p>}>
                <Gallery />
              </Suspense>
            ) : route === "Overview" ? (
              <Overview
                connection={connection}
                statuses={statuses}
                navigate={navigate}
                openThread={openThread}
                openRequest={openRequest}
              />
            ) : route === "Artifact" ? (
              <Suspense fallback={<p>Loading artifact…</p>}>
                <ArtifactPage key={artifactId} connection={connection} id={artifactId ?? ""} />
              </Suspense>
            ) : route === "Chief" ? (
              <ChiefPage
                connection={connection}
                statuses={statuses}
                openThread={openThread}
                openRequest={openRequest}
              />
            ) : route === "QuickChat" ? (
              <Suspense fallback={<p>Loading quick chat</p>}>
                <QuickChat connection={connection} />
              </Suspense>
            ) : route === "Compare" && compareId ? (
              <Suspense fallback={<p>Loading compare…</p>}>
                <CompareView key={compareId} connection={connection} id={compareId} />
              </Suspense>
            ) : route === "Chat" && threadId ? (
              <Suspense fallback={<p>Loading conversation</p>}>
                <Chat key={threadId} connection={connection} threadId={threadId} />
              </Suspense>
            ) : route === "Sessions" ? (
              <AllChats
                wakes={entities.wake ?? emptyRows}
                threads={entities.thread ?? emptyRows}
                projects={entities.project ?? emptyRows}
                directions={entities.subproject ?? emptyRows}
                openThread={openThread}
                openQuickChat={() => openQuickChat()}
              />
            ) : route === "Inbox" ? (
              <Suspense fallback={<p>Loading Inbox</p>}>
                <Inbox connection={connection} />
              </Suspense>
            ) : route === "Routines" ? (
              <Suspense fallback={<p>Loading routines</p>}>
                <Routines connection={connection} />
              </Suspense>
            ) : route === "Tasks" ? (
              <Suspense fallback={<p>Loading tasks</p>}>
                <Tasks connection={connection} />
              </Suspense>
            ) : route === "Projects" ? (
              <Suspense fallback={<p>Loading workspaces</p>}>
                <Workspaces connection={connection} />
              </Suspense>
            ) : route === "Setup" ? (
              <Suspense fallback={<p>Loading setup</p>}>
                <Setup
                  connection={connection}
                  onOpen={openThread}
                  onSkip={() => {
                    completeOnboarding();
                    navigate("Overview");
                  }}
                  onDoctor={() => navigate("Doctor")}
                />
              </Suspense>
            ) : ["Settings", "Doctor", "Connections", "Rules"].includes(route) ? (
              <SettingsPage
                tab={
                  route === "Doctor"
                    ? "agents"
                    : route === "Connections"
                      ? "connections"
                      : route === "Rules"
                        ? "rules"
                        : "general"
                }
                connection={connection}
                settings={entities.settings ?? emptyRows}
                devices={entities.device ?? emptyRows}
                fontScale={fontScale}
                setFontScale={setFontScale}
                theme={theme}
                setTheme={setTheme}
                navigate={navigate}
              />
            ) : (
              <section className="zb-card empty-page">
                <EmptyState level={1} icon={route} title={routeLabels[route] ?? route} />
              </section>
            )}
          </main>
          <footer className="workspace-status" aria-live="polite">
            <span className="r" data-connection-status={connection.status}>
              <StatusDot status={online ? "idle" : "blocked"} label={false} />
              {online ? "Connected to local daemon" : "Reconnecting"}
            </span>
            <span className="sp" />
            <span>{running} running</span>
            <span className="status-separator" />
            <span>Local computer</span>
          </footer>
        </div>
        <UpdateNotice connection={connection} settings={entities.settings ?? emptyRows} />
        <CommandPalette entities={entities} />
      </div>
    </ProfileHues.Provider>
  );
}
