import {
  type Accessor,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  type Setter,
} from "solid-js";
import type { BrowserControlState, BrowserTab } from "../../../../shared/ipc";
import type { BotProfile } from "../../data";
import type { RightPanelMode } from "./constants";

interface BrowserStateProps {
  bot: BotProfile | undefined;
  bots: BotProfile[];
  browserTabs: BrowserTab[];
  activeBrowserTabId: string | null;
  browserControlState: BrowserControlState;
  onActivateBrowserTab: (tabId: string) => void;
}

/** The in-chat browser's tabs, control state and native view placement. */
export function createBrowserState(
  props: BrowserStateProps,
  deps: {
    screenOpen: Accessor<boolean>;
    surface: Accessor<HTMLDivElement | undefined>;
    setActiveRightPanel: (mode: RightPanelMode) => void;
    setRightPanels: Setter<Record<string, RightPanelMode>>;
  },
) {
  const [browserAddress, setBrowserAddress] = createSignal("https://www.google.com");
  let browserResizeObserver: ResizeObserver | undefined;
  let browserWindowResizeHandler: (() => void) | undefined;
  let browserVisibilityFrame: number | undefined;
  let browserBoundsFrame: number | undefined;
  let browserVisibilityGeneration = 0;

  const browserTabs = createMemo(() => {
    const bot = props.bot;
    if (!bot) return [];
    return props.browserTabs.filter((tab) =>
      tab.ownerBotId
        ? tab.ownerBotId === bot.id
        : Boolean(bot.threadId && tab.ownerThreadId === bot.threadId),
    );
  });
  const activeBrowserTab = createMemo(
    () => browserTabs().find((tab) => tab.id === props.activeBrowserTabId) ?? browserTabs()[0],
  );
  const activeBrowserControl = createMemo(() => {
    const sessions = props.browserControlState.sessions;
    const activeTab = activeBrowserTab();
    const forActiveTab = activeTab?.ownerThreadId
      ? sessions.filter((session) => session.threadId === activeTab.ownerThreadId)
      : [];
    const forActiveBot = props.bot?.threadId
      ? sessions.filter((session) => session.threadId === props.bot?.threadId)
      : [];
    const candidates = forActiveTab.length > 0 ? forActiveTab : forActiveBot;
    return (
      [...candidates]
        .sort((left, right) => right.startedAt.localeCompare(left.startedAt))
        .find((session) => session.phase === "acting") ?? candidates.at(-1)
    );
  });
  const browserControlBot = createMemo(() => {
    const control = activeBrowserControl();
    return control ? props.bots.find((bot) => bot.threadId === control.threadId) : undefined;
  });
  const browserControlForTab = (tab: BrowserTab) => {
    const sessions = props.browserControlState.sessions;
    return (
      sessions.find((session) => session.tabId === tab.id) ??
      sessions.find(
        (session) =>
          session.tabId === null &&
          tab.id === activeBrowserTab()?.id &&
          session.threadId === tab.ownerThreadId,
      )
    );
  };
  const browserControllerForTab = (tab: BrowserTab) => {
    const control = browserControlForTab(tab);
    return control ? props.bots.find((bot) => bot.threadId === control.threadId) : undefined;
  };

  createEffect(() => {
    props.bot?.id;
    const activeTab = activeBrowserTab();
    setBrowserAddress(activeTab?.url ?? "https://www.google.com");
    if (deps.screenOpen() && activeTab && activeTab.id !== props.activeBrowserTabId) {
      props.onActivateBrowserTab(activeTab.id);
    }
  });

  createEffect(() => {
    const controlledBotIds = new Set(
      props.browserControlState.sessions
        .map((session) => props.bots.find((bot) => bot.threadId === session.threadId)?.id)
        .filter((botId): botId is string => Boolean(botId)),
    );
    if (controlledBotIds.size === 0) return;
    deps.setRightPanels((current) => {
      const next = { ...current };
      let changed = false;
      for (const botId of controlledBotIds) {
        if (next[botId] === "browser") continue;
        next[botId] = "browser";
        changed = true;
      }
      return changed ? next : current;
    });
  });

  createEffect(() => {
    const botId = props.bot?.id;
    const visible = deps.screenOpen();
    const generation = ++browserVisibilityGeneration;
    if (browserVisibilityFrame !== undefined) cancelAnimationFrame(browserVisibilityFrame);
    browserResizeObserver?.disconnect();
    browserResizeObserver = undefined;
    if (browserWindowResizeHandler)
      window.removeEventListener("resize", browserWindowResizeHandler);
    browserWindowResizeHandler = undefined;
    if (browserBoundsFrame !== undefined) cancelAnimationFrame(browserBoundsFrame);
    browserBoundsFrame = undefined;
    if (!visible) {
      void window.openbot.browser.setVisible({ visible: false });
      return;
    }
    browserVisibilityFrame = requestAnimationFrame(() => {
      browserVisibilityFrame = undefined;
      const surface = deps.surface();
      if (
        generation !== browserVisibilityGeneration ||
        props.bot?.id !== botId ||
        !deps.screenOpen() ||
        !surface
      ) {
        return;
      }
      const syncBounds = () => {
        const current = deps.surface();
        if (
          generation !== browserVisibilityGeneration ||
          props.bot?.id !== botId ||
          !deps.screenOpen() ||
          !current
        ) {
          return;
        }
        const bounds = current.getBoundingClientRect();
        void window.openbot.browser.setVisible({
          visible: true,
          bounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
        });
      };
      syncBounds();
      const scheduleBoundsSync = () => {
        if (browserBoundsFrame !== undefined) cancelAnimationFrame(browserBoundsFrame);
        browserBoundsFrame = requestAnimationFrame(() => {
          browserBoundsFrame = undefined;
          syncBounds();
        });
      };
      browserResizeObserver = new ResizeObserver(scheduleBoundsSync);
      browserResizeObserver.observe(surface);
      browserWindowResizeHandler = scheduleBoundsSync;
      window.addEventListener("resize", browserWindowResizeHandler);
    });
  });

  onCleanup(() => {
    browserVisibilityGeneration += 1;
    if (browserVisibilityFrame !== undefined) cancelAnimationFrame(browserVisibilityFrame);
    if (browserBoundsFrame !== undefined) cancelAnimationFrame(browserBoundsFrame);
    browserResizeObserver?.disconnect();
    if (browserWindowResizeHandler)
      window.removeEventListener("resize", browserWindowResizeHandler);
    void window.openbot.browser.setVisible({ visible: false });
  });

  async function openBrowserAddress() {
    const value = browserAddress().trim();
    if (!value) return;
    const url = /^https?:\/\//i.test(value) ? value : `https://${value}`;
    try {
      const tab = await window.openbot.browser.open({
        url,
        ownerThreadId: props.bot?.threadId ?? null,
        ownerBotId: props.bot?.id ?? null,
      });
      setBrowserAddress(tab.url);
      deps.setActiveRightPanel("browser");
    } catch {
      setBrowserAddress(url);
    }
  }

  function showBrowserPanel() {
    deps.setActiveRightPanel("browser");
    if (browserTabs().length === 0) void openBrowserAddress();
  }

  function hideBrowserPanel() {
    deps.setActiveRightPanel("none");
    void window.openbot.browser.setVisible({ visible: false });
  }

  return {
    browserAddress,
    setBrowserAddress,
    browserTabs,
    activeBrowserTab,
    activeBrowserControl,
    browserControlBot,
    browserControlForTab,
    browserControllerForTab,
    openBrowserAddress,
    showBrowserPanel,
    hideBrowserPanel,
  };
}

export type BrowserState = ReturnType<typeof createBrowserState>;
