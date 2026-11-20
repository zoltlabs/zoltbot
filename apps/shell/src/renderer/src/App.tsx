import { createEffect, createMemo, createSignal, onCleanup, onMount, Show } from "solid-js";
import { createMutable } from "solid-js/store";
import type {
  AccountUsage,
  AgentEvent,
  AgentModelId,
  AgentModelOption,
  AgentProviderId,
  AgentReasoningEffort,
  AgentStatus,
  AppInfo,
  AppSetupState,
  BotSummary,
  BrowserControlState,
  BrowserTab,
  CloudAccountStatus,
  UpdateBotInput,
  UpdateStatus,
} from "../../shared/ipc";
import {
  FALLBACK_STATUS,
  FALLBACK_UPDATE_STATUS,
  formatTime,
  LEFT_PANEL_COLLAPSED_STORAGE_KEY,
  LEFT_PANEL_DEFAULT,
  LEFT_PANEL_MAX,
  LEFT_PANEL_MIN,
  LEFT_PANEL_STORAGE_KEY,
  ONBOARDING_PROFILES,
  type PromptEvent,
  toBotProfile,
  withoutBot,
} from "./app-model";
import { useShortcut } from "./app-shortcuts";
import { createConversationState } from "./app-state";
import { createChannelsStore } from "./channels-store";
import { ChannelPage } from "./components/ChannelPage";
import { CommandPalette } from "./components/CommandPalette";
import { Conversation } from "./components/Conversation";
import { InitialSetup } from "./components/InitialSetup";
import { MapView } from "./components/MapView";
import { ModelsSettings } from "./components/ModelsSettings";
import { PanelResizer, readPanelWidth, savePanelWidth } from "./components/PanelResizer";
import { Sidebar, type SidebarAgentState } from "./components/Sidebar";
import { SidebarChannels } from "./components/SidebarChannels";
import { createChatActions } from "./components/sidebar/chat-actions";
import { TasksPage } from "./components/TasksPage";
import type { BotProfile } from "./data";
import { CHAT_ROUTE, createPages, PAGES, pageFlag } from "./pages";
import { paletteItems } from "./palette-items";
import { createStaffStore } from "./staff-store";
import { createTasksStore } from "./tasks-store";

export function App() {
  const [botList, setBotList] = createSignal<BotProfile[]>([]);
  const [modelOptions, setModelOptions] = createSignal<AgentModelOption[]>([]);
  const [activeBotId, setActiveBotId] = createSignal("");
  const pages = createPages(CHAT_ROUTE);
  const [tasksProject, setTasksProject] = createSignal<string | null>(null);
  const [mapOpen, setMapOpen] = pageFlag(pages, "map");
  const [tasksOpen, setTasksOpen] = pageFlag(pages, "tasks", () => ({
    id: "tasks",
    projectId: tasksProject(),
  }));
  const [modelsOpen, setModelsOpen] = pageFlag(pages, "models");
  const tasks = createTasksStore();
  const staff = createStaffStore(() => null);
  const channels = createChannelsStore();
  const channelOpen = () => channels.openId() !== null;
  const conversationState = createConversationState(activeBotId);
  const {
    liveMessages,
    setLiveMessages,
    uiErrors,
    setUiErrors,
    conversationLoaded,
    setConversationLoaded,
    setConversationRevisions,
    activeTurns,
    setActiveTurns,
    unreadReplies,
    setUnreadReplies,
    recentReplies,
    setRecentReplies,
    queues,
    setQueues,
    scheduleConversation,
    applyConversationDelta,
    markReplyCompleted,
    clearRecentReply,
    clearReplyIndicators,
  } = conversationState;
  const [browserTabs, setBrowserTabs] = createSignal<BrowserTab[]>([]);
  const [activeBrowserTabId, setActiveBrowserTabId] = createSignal<string | null>(null);
  const [browserControlState, setBrowserControlState] = createSignal<BrowserControlState>({
    sessions: [],
  });
  const [agentPickerOpen, setAgentPickerOpen] = createSignal(false);
  const [creatingAgent, setCreatingAgent] = createSignal(false);
  const [settingsRequest, setSettingsRequest] = createSignal<{
    botId: string;
    nonce: number;
  } | null>(null);
  // Zoltbot agents start without OpenBot's specialty questions; the request stays unused.
  const onboardingRequest = (): { botId: string; nonce: number } | null => null;
  const [pendingPrompts, setPendingPrompts] = createSignal<Record<string, PromptEvent | undefined>>(
    {},
  );
  const [appInfo, setAppInfo] = createSignal<AppInfo | null>(null);
  const [agentStatus, setAgentStatus] = createSignal<AgentStatus>(FALLBACK_STATUS);
  const [accountUsage, setAccountUsage] = createSignal<AccountUsage | null>(null);
  const [updateStatus, setUpdateStatus] = createSignal<UpdateStatus>(FALLBACK_UPDATE_STATUS);
  const [leftPanelWidth, setLeftPanelWidth] = createSignal(
    readPanelWidth(LEFT_PANEL_STORAGE_KEY, LEFT_PANEL_DEFAULT, LEFT_PANEL_MIN, LEFT_PANEL_MAX),
  );
  const [leftPanelCollapsed, setLeftPanelCollapsed] = createSignal(
    window.localStorage.getItem(LEFT_PANEL_COLLAPSED_STORAGE_KEY) === "true",
  );
  const [setupState, setSetupState] = createSignal<AppSetupState | null>(null);
  const [setupLoaded, setSetupLoaded] = createSignal(false);
  const [permissionsOpen, setPermissionsOpen] = createSignal(false);
  const [cloudAccount, setCloudAccount] = createSignal<CloudAccountStatus | null>(null);
  const usableAgent = createMemo(() =>
    agentStatus().providers?.find((provider) => provider.state === "available"),
  );
  /** Setup is done once it was saved, or as soon as the daemon has an agent that works. */
  const setupDone = createMemo(() => setupState()?.completed === true || Boolean(usableAgent()));

  const activeBot = createMemo(
    () => botList().find((bot) => bot.id === activeBotId()) ?? botList()[0],
  );
  const activeMessages = createMemo(() => {
    const bot = activeBot();
    return bot ? [...(liveMessages()[bot.id] ?? []), ...(uiErrors()[bot.id] ?? [])] : [];
  });

  /** Shows the Tasks page for a project, or for the open chat's project. */
  function openTasks(projectId?: string | null) {
    setMapOpen(false);
    setModelsOpen(false);
    setAgentPickerOpen(false);
    setTasksProject(projectId === undefined ? (activeBot()?.projectId ?? null) : projectId);
    channels.open(null);
    setTasksOpen(true);
  }

  const [paletteOpen, setPaletteOpen] = createSignal(false);
  useShortcut({
    id: "app.palette",
    keys: "Mod+K",
    when: "global",
    label: "Search or run a command",
    run: () => {
      if (!setupDone()) return false;
      setPaletteOpen((open) => !open);
    },
  });

  function openChannel(channelId: string) {
    setMapOpen(false);
    setTasksOpen(false);
    setModelsOpen(false);
    setAgentPickerOpen(false);
    channels.open(channelId);
  }

  useShortcut({
    id: "app.tasks",
    keys: PAGES.tasks.shortcut ?? "Mod+T",
    when: "global",
    label: "Show or hide Tasks",
    run: () => {
      if (!setupDone()) return false;
      if (tasksOpen()) setTasksOpen(false);
      else openTasks();
    },
  });

  onMount(() => {
    const unsubscribe = window.openbot.agent.onEvent(handleAgentEvent);
    const unsubscribeUpdate = window.openbot.update.onEvent(setUpdateStatus);
    onCleanup(() => {
      unsubscribe();
      unsubscribeUpdate();
      conversationState.dispose();
    });
    void window.openbot.update
      .getStatus()
      .then(setUpdateStatus)
      .catch(() => undefined);
    void window.openbot
      .getSetupState()
      .then(setSetupState)
      .finally(() => setSetupLoaded(true));
    void window.openbot.account
      .getStatus()
      .then(setCloudAccount)
      .catch(() => undefined);

    void Promise.all([
      window.openbot
        .getAppInfo()
        .then(setAppInfo)
        .catch(() => setAppInfo({ name: "Zoltbot", version: "unavailable", platform: "darwin" })),
      window.openbot.agent
        .getStatus()
        .then(setAgentStatus)
        .catch(() => undefined),
      window.openbot.agent
        .listModels()
        .then(setModelOptions)
        .catch(() => undefined),
      window.openbot.agent
        .listBots()
        .then(applyStoredBots)
        .catch((error) => {
          setAgentStatus((current) => ({ ...current, message: String(error) }));
        }),
    ]);
    void window.openbot.browser
      .listTabs()
      .then((tabs) => {
        setBrowserTabs(tabs);
        setActiveBrowserTabId((current) => current ?? tabs[0]?.id ?? null);
      })
      .catch(() => undefined);
    void window.openbot.browser
      .getControlState()
      .then(setBrowserControlState)
      .catch(() => undefined);
  });

  createEffect(() => {
    const botId = activeBotId();
    agentStatus().phase;
    if (!botId) return;
    void Promise.all([
      window.openbot.agent.readConversation(botId),
      window.openbot.agent.listQueue(botId),
    ])
      .then(([snapshot, queue]) => {
        setQueues((current) => ({ ...current, [botId]: queue }));
        scheduleConversation(snapshot);
      })
      .catch((error) => appendUiError(botId, error, "Load failed"));
  });

  function handleAgentEvent(event: AgentEvent) {
    switch (event.type) {
      case "status":
        setAgentStatus(event.status);
        if (event.status.phase === "ready") {
          void window.openbot.agent
            .listModels()
            .then(setModelOptions)
            .catch(() => undefined);
        }
        return;
      case "usage-changed":
        setAccountUsage(event.usage);
        return;
      case "bots-changed":
        applyStoredBots(event.bots);
        return;
      case "conversation":
        scheduleConversation(event.snapshot);
        return;
      case "conversation-delta":
        applyConversationDelta(event);
        return;
      case "queue-changed":
        setQueues((current) => ({ ...current, [event.snapshot.botId]: event.snapshot }));
        return;
      case "browser-changed":
        setBrowserTabs(event.tabs);
        setActiveBrowserTabId(event.activeTabId);
        return;
      case "browser-control-changed":
        setBrowserControlState(event.state);
        return;
      case "turn-started":
        clearRecentReply(event.botId);
        setActiveTurns((current) => ({ ...current, [event.botId]: event.turnId }));
        return;
      case "turn-completed":
        setActiveTurns((current) => ({ ...current, [event.botId]: null }));
        if (event.status === "completed") markReplyCompleted(event.botId);
        return;
      case "prompt":
        setPendingPrompts((current) => ({ ...current, [event.botId]: event }));
        return;
      case "prompt-cleared":
        setPendingPrompts((current) => ({ ...current, [event.botId]: undefined }));
        return;
      case "error":
        if (event.botId) appendUiError(event.botId, event.message, "Error");
    }
  }

  function applyStoredBots(storedBots: BotSummary[]) {
    let profiles: BotProfile[] = [];
    setBotList((current) => {
      const currentById = new Map(current.map((bot) => [bot.id, bot]));
      profiles = storedBots.map((stored) => {
        const next = toBotProfile(stored);
        const existing = currentById.get(next.id);
        if (!existing) return createMutable(next);
        Object.assign(existing, next);
        return existing;
      });
      return profiles;
    });
    setActiveBotId((current) =>
      profiles.some((bot) => bot.id === current) ? current : (profiles[0]?.id ?? ""),
    );
    if (profiles.length === 0) setAgentPickerOpen(true);
  }

  createEffect(() => window.openbot.setVisibleBot?.(activeBotId() || null));

  async function createProject() {
    if (creatingAgent()) return;
    setCreatingAgent(true);
    try {
      const stored = await window.openbot.agent.createProject();
      if (stored) showCreatedAgent(stored);
    } catch (error) {
      if (activeBotId()) appendUiError(activeBotId(), error, "Create failed");
    } finally {
      setCreatingAgent(false);
    }
  }

  function showCreatedAgent(stored: BotSummary) {
    const newAgent = createMutable(toBotProfile(stored));
    setBotList((current) => {
      const rest = current.filter((item) => item.id !== newAgent.id);
      let after = -1;
      rest.forEach((item, index) => {
        if (stored.projectId && item.projectId === stored.projectId) after = index;
      });
      return after < 0
        ? [newAgent, ...rest]
        : [...rest.slice(0, after + 1), newAgent, ...rest.slice(after + 1)];
    });
    setLiveMessages((current) => ({ ...current, [newAgent.id]: [] }));
    setConversationLoaded((current) => ({ ...current, [newAgent.id]: true }));
    setActiveBotId(newAgent.id);
  }

  async function createAgent(projectId?: string) {
    if (creatingAgent()) return;
    setCreatingAgent(true);
    try {
      const stored = await window.openbot.agent.createBot(projectId ? { projectId } : undefined);
      showCreatedAgent(stored);
      setAgentPickerOpen(false);
    } catch (error) {
      setAgentPickerOpen(false);
      if (activeBotId()) appendUiError(activeBotId(), error, "Create failed");
    } finally {
      setCreatingAgent(false);
    }
  }

  /** Closes the channel and every page, so the conversation shows. */
  function closePages() {
    channels.open(null);
    setMapOpen(false);
    setTasksOpen(false);
    setModelsOpen(false);
  }

  function selectBot(botId: string) {
    channels.open(null);
    setMapOpen(false);
    setTasksOpen(false);
    setModelsOpen(false);
    setAgentPickerOpen(false);
    clearReplyIndicators(botId);
    setActiveBotId(botId);
  }

  function activateBrowserTab(tabId: string) {
    void window.openbot.browser.activate(tabId);
  }

  function closeBrowserTab(tabId: string) {
    void window.openbot.browser.close(tabId);
  }

  async function updateBot(botId: string, updates: Omit<UpdateBotInput, "botId">) {
    try {
      const stored = await window.openbot.agent.updateBot({ botId, ...updates });
      const existing = botList().find((bot) => bot.id === botId);
      if (existing) Object.assign(existing, toBotProfile(stored));
      else setBotList((current) => [...current, createMutable(toBotProfile(stored))]);
    } catch (error) {
      appendUiError(botId, error, "Settings failed");
      throw error;
    }
  }

  function editBot(botId: string) {
    selectBot(botId);
    setSettingsRequest({ botId, nonce: Date.now() });
  }

  async function deleteBot(botId: string) {
    try {
      await window.openbot.agent.deleteBot(botId);
      const remaining = botList().filter((bot) => bot.id !== botId);
      setBotList(remaining);
      setActiveBotId((current) => (current === botId ? (remaining[0]?.id ?? "") : current));
      setSettingsRequest((current) => (current?.botId === botId ? null : current));
      setLiveMessages((current) => withoutBot(current, botId));
      setUiErrors((current) => withoutBot(current, botId));
      setConversationLoaded((current) => withoutBot(current, botId));
      setConversationRevisions((current) => withoutBot(current, botId));
      setActiveTurns((current) => withoutBot(current, botId));
      setUnreadReplies((current) => withoutBot(current, botId));
      setRecentReplies((current) => withoutBot(current, botId));
      setQueues((current) => withoutBot(current, botId));
      setPendingPrompts((current) => withoutBot(current, botId));
      conversationState.forgetReplyTimer(botId);
    } catch (error) {
      appendUiError(botId, error, "Delete failed");
      throw error;
    }
  }

  async function sendMessage(
    body: string,
    attachmentDraftIds: string[],
    replyToMessageId: string | null,
  ): Promise<boolean> {
    const bot = activeBot();
    if (!bot || (!body.trim() && attachmentDraftIds.length === 0)) return false;
    return sendMessageToBot(bot.id, body, attachmentDraftIds, replyToMessageId);
  }

  async function sendMessageToBot(
    botId: string,
    body: string,
    attachmentDraftIds: string[],
    replyToMessageId: string | null = null,
  ): Promise<boolean> {
    try {
      await window.openbot.agent.sendMessage({
        botId,
        text: body.trim(),
        attachmentDraftIds,
        ...(replyToMessageId ? { replyToMessageId } : {}),
      });
      setUiErrors((current) => ({ ...current, [botId]: [] }));
      return true;
    } catch (error) {
      appendUiError(botId, error, "Send failed");
      return false;
    }
  }

  async function completeOnboarding(
    answer: string,
    model: AgentModelId,
    reasoningEffort: AgentReasoningEffort,
  ): Promise<boolean> {
    const bot = activeBot();
    const topic = answer.trim();
    if (!bot || !topic) return false;
    const predefined = ONBOARDING_PROFILES[topic];
    const profile = predefined ?? {
      role: topic.length <= 60 ? topic : "Custom focus",
      description: `Primary focus: ${topic.slice(0, 1_900)}.`,
      firstMessage: `My main focus for you is: ${topic}. Treat this as your ongoing specialty.`,
    };
    try {
      await updateBot(bot.id, {
        role: profile.role,
        description: profile.description,
        model,
        reasoningEffort,
      });
    } catch {
      return false;
    }
    return sendMessageToBot(bot.id, profile.firstMessage, []);
  }

  async function answerPrompt(answers: Record<string, string[]>): Promise<boolean> {
    const bot = activeBot();
    const prompt = bot ? pendingPrompts()[bot.id] : undefined;
    if (!bot || !prompt) return false;
    try {
      await window.openbot.agent.respondToPrompt({ requestId: prompt.requestId, answers });
      setPendingPrompts((current) => ({ ...current, [bot.id]: undefined }));
      return true;
    } catch (error) {
      appendUiError(bot.id, error, "Answer failed");
      return false;
    }
  }

  function cancelQueuedMessage(deliveryId: string) {
    const bot = activeBot();
    if (!bot) return;
    void window.openbot.agent
      .cancelQueuedMessage({ botId: bot.id, deliveryId })
      .catch((error) => appendUiError(bot.id, error, "Cancel failed"));
  }

  function resumeQueue() {
    const bot = activeBot();
    if (!bot) return;
    void window.openbot.agent
      .setQueuePaused({ botId: bot.id, paused: false })
      .catch((error) => appendUiError(bot.id, error, "Resume failed"));
  }

  function stopActiveTurn() {
    const bot = activeBot();
    const turnId = bot ? activeTurns()[bot.id] : null;
    if (!bot || !turnId) return;
    void window.openbot.agent
      .interrupt({ botId: bot.id, turnId })
      .catch((error) => appendUiError(bot.id, error, "Stop failed"));
  }

  async function refreshAccountUsage(): Promise<AccountUsage> {
    const usage = await window.openbot.agent.getUsage();
    setAccountUsage(usage);
    return usage;
  }

  function appendUiError(botId: string, error: unknown, status: string) {
    const body = error instanceof Error ? error.message : String(error);
    setUiErrors((current) => ({
      ...current,
      [botId]: [
        ...(current[botId] ?? []),
        {
          id: `ui-${Date.now()}-${Math.random()}`,
          author: "bot",
          body,
          time: formatTime(new Date().toISOString()),
          status,
        },
      ],
    }));
  }

  const activeQueue = createMemo(() => {
    const bot = activeBot();
    return bot ? queues()[bot.id] : undefined;
  });
  const sidebarAgentStates = createMemo<Record<string, SidebarAgentState>>(() => {
    const turns = activeTurns();
    const queueSnapshots = queues();
    const unread = unreadReplies();
    const recent = recentReplies();
    const states: Record<string, SidebarAgentState> = {};
    for (const bot of botList()) {
      const isWorking =
        Boolean(turns[bot.id]) ||
        Boolean(
          queueSnapshots[bot.id]?.deliveries.some(
            (delivery) => delivery.status === "starting" || delivery.status === "running",
          ),
        );
      if (isWorking) states[bot.id] = { kind: "working" };
      else if ((unread[bot.id] ?? 0) > 0) {
        states[bot.id] = { kind: "unread", count: unread[bot.id] ?? 1 };
      } else if (recent[bot.id]) states[bot.id] = { kind: "responded" };
    }
    return states;
  });

  const chatActions = createChatActions({
    bots: botList,
    // Covered by a page or channel, the open chat isn't being read.
    activeBotId: () =>
      mapOpen() || tasksOpen() || modelsOpen() || channelOpen() ? undefined : activeBot()?.id,
    clearLocalUnread: clearReplyIndicators,
  });

  function setSidebarCollapsed(collapsed: boolean) {
    setLeftPanelCollapsed(collapsed);
    window.localStorage.setItem(LEFT_PANEL_COLLAPSED_STORAGE_KEY, String(collapsed));
  }

  async function saveSetup(preferredProvider: AgentProviderId): Promise<void> {
    const state = await window.openbot.saveSetup({ preferredProvider });
    setSetupState(state);
    setPermissionsOpen(false);
  }

  // Remember setup once an agent works, so later launches skip the setup screen.
  let rememberingSetup = false;
  createEffect(() => {
    const state = setupState();
    const agent = usableAgent();
    if (!state || state.completed || !agent || rememberingSetup) return;
    rememberingSetup = true;
    void window.openbot
      .saveSetup({ preferredProvider: agent.id })
      .then(setSetupState)
      .catch(() => undefined)
      .finally(() => {
        rememberingSetup = false;
      });
  });

  async function checkAgents(): Promise<void> {
    setAgentStatus(await window.openbot.agent.refreshAgents());
  }

  async function signIn(): Promise<void> {
    setCloudAccount(await window.openbot.account.signIn());
  }

  async function signOut(): Promise<void> {
    setCloudAccount(await window.openbot.account.signOut());
  }

  async function runUpdateAction(): Promise<void> {
    const phase = updateStatus().phase;
    if (phase === "ready") {
      await window.openbot.update.install();
      return;
    }
    const status =
      phase === "available"
        ? await window.openbot.update.download()
        : await window.openbot.update.check();
    setUpdateStatus(status);
  }

  return (
    <Show
      when={setupLoaded() && appInfo() !== null}
      fallback={<div class="initial-setup-screen" role="status" aria-label="Loading Zoltbot" />}
    >
      <Show
        when={setupDone()}
        fallback={
          <InitialSetup
            state={setupState() ?? { completed: false, preferredProvider: null }}
            agentStatus={agentStatus()}
            platform={appInfo()?.platform ?? "darwin"}
            onSave={saveSetup}
            onCheckAgents={checkAgents}
            onOpenUrl={(url) => window.openbot.openUrl(url)}
          />
        }
      >
        <div
          class="app-frame"
          classList={{ "app-frame-sidebar-collapsed": leftPanelCollapsed() }}
          style={`--left-panel-width: ${leftPanelCollapsed() ? 0 : leftPanelWidth()}px`}
        >
          <Show when={!leftPanelCollapsed()}>
            <Sidebar
              bots={botList()}
              tasks={tasks.tasks()}
              staffApprovals={staff.approvals().length}
              activeBotId={
                mapOpen() || tasksOpen() || modelsOpen() || channelOpen()
                  ? ""
                  : (activeBot()?.id ?? "")
              }
              mapOpen={mapOpen()}
              tasksOpen={tasksOpen()}
              projectRows={(projectId, projectName) => (
                <SidebarChannels
                  projectName={projectName}
                  channels={channels.channels().filter((row) => row.projectId === projectId)}
                  activeChannelId={channels.openId()}
                  onOpenChannel={(channelId) => {
                    setMapOpen(false);
                    setTasksOpen(false);
                    setModelsOpen(false);
                    setAgentPickerOpen(false);
                    channels.open(channelId);
                  }}
                />
              )}
              onOpenMap={() => {
                channels.open(null);
                setTasksOpen(false);
                setModelsOpen(false);
                setMapOpen(true);
              }}
              onOpenTasks={() => openTasks()}
              modelsOpen={modelsOpen()}
              onOpenModels={() => {
                channels.open(null);
                setMapOpen(false);
                setTasksOpen(false);
                setModelsOpen(true);
              }}
              appInfo={appInfo()}
              agentStatus={agentStatus()}
              accountUsage={accountUsage()}
              cloudAccount={cloudAccount()}
              onSignIn={signIn}
              onSignOut={signOut}
              onCancelSignIn={() => void window.openbot.account.cancel()}
              updateStatus={updateStatus()}
              agentStates={sidebarAgentStates()}
              onSelectBot={selectBot}
              onChatAction={chatActions.run}
              onCreateBot={() => setAgentPickerOpen(true)}
              onCreateInProject={(projectId) => void createAgent(projectId)}
              onCreateProject={() => void createProject()}
              onEditBot={editBot}
              onDeleteBot={deleteBot}
              onRenameBot={(botId, name) => updateBot(botId, { name })}
              onRefreshUsage={refreshAccountUsage}
              onUpdateAction={runUpdateAction}
              onOpenExternal={(destination) => window.openbot.openExternal(destination)}
              onOpenPermissions={() => setPermissionsOpen(true)}
              onCollapse={() => setSidebarCollapsed(true)}
            >
              <PanelResizer
                class="left-panel-resizer"
                label="Resize left sidebar"
                controls="bot-sidebar"
                direction="left"
                value={leftPanelWidth()}
                defaultValue={LEFT_PANEL_DEFAULT}
                min={LEFT_PANEL_MIN}
                max={LEFT_PANEL_MAX}
                onResize={setLeftPanelWidth}
                onResizeEnd={(value) => savePanelWidth(LEFT_PANEL_STORAGE_KEY, value)}
              />
            </Sidebar>
          </Show>
          {/* The map covers the conversation; the conversation stays mounted so drafts survive. */}
          <div
            class="conversation-slot"
            inert={mapOpen() || tasksOpen() || modelsOpen() || channelOpen() || undefined}
          >
            <Conversation
              agentStatus={agentStatus()}
              bot={activeBot()}
              bots={botList()}
              modelOptions={modelOptions()}
              messages={activeMessages()}
              loaded={activeBot() ? conversationLoaded()[activeBot()?.id ?? ""] === true : false}
              queue={activeQueue()}
              browserTabs={browserTabs()}
              activeBrowserTabId={activeBrowserTabId()}
              browserControlState={browserControlState()}
              leftSidebarCollapsed={leftPanelCollapsed()}
              prompt={activeBot() ? pendingPrompts()[activeBot()?.id ?? ""] : undefined}
              activeTurnId={activeBot() ? activeTurns()[activeBot()?.id ?? ""] : null}
              agentPickerOpen={agentPickerOpen()}
              creatingAgent={creatingAgent()}
              settingsRequest={settingsRequest()}
              onboardingRequest={onboardingRequest()}
              onCloseAgentPicker={() => setAgentPickerOpen(false)}
              onCreateAgent={() => void createAgent()}
              onSelectAgent={selectBot}
              onUpdateBot={updateBot}
              onSendMessage={sendMessage}
              onCompleteOnboarding={completeOnboarding}
              onAnswerPrompt={answerPrompt}
              onCancelQueuedMessage={cancelQueuedMessage}
              onResumeQueue={resumeQueue}
              onActivateBrowserTab={activateBrowserTab}
              onCloseBrowserTab={closeBrowserTab}
              onToggleLeftSidebar={() => setSidebarCollapsed(false)}
              onOpenAgentSetup={async () => void setPermissionsOpen(true)}
              onStop={stopActiveTurn}
              onOpenTasks={openTasks}
            />
          </div>
          <Show when={tasksOpen()}>
            <TasksPage
              store={tasks}
              bots={botList()}
              projectId={tasksProject()}
              sidebarCollapsed={leftPanelCollapsed()}
              onShowSidebar={() => setSidebarCollapsed(false)}
              onOpenChat={selectBot}
            />
          </Show>
          <Show when={channelOpen()}>
            <ChannelPage
              store={channels}
              sidebarCollapsed={leftPanelCollapsed()}
              onShowSidebar={() => setSidebarCollapsed(false)}
              onOpenChat={(threadId) => {
                if (botList().some((bot) => bot.id === threadId)) selectBot(threadId);
              }}
            />
          </Show>
          <Show when={mapOpen()}>
            <MapView
              sidebarCollapsed={leftPanelCollapsed()}
              onShowSidebar={() => setSidebarCollapsed(false)}
              onToggleSidebar={() => setSidebarCollapsed(!leftPanelCollapsed())}
              onOpenChat={(chatId) => {
                if (chatId && botList().some((bot) => bot.id === chatId)) selectBot(chatId);
                else setMapOpen(false);
              }}
            />
          </Show>
          <Show when={modelsOpen()}>
            <ModelsSettings
              sidebarCollapsed={leftPanelCollapsed()}
              onShowSidebar={() => setSidebarCollapsed(false)}
            />
          </Show>
          <Show when={paletteOpen()}>
            <CommandPalette
              items={() =>
                paletteItems({
                  bots: botList(),
                  channels: channels.channels(),
                  tasks: tasks.tasks(),
                  openChat: selectBot,
                  openChannel,
                  openTasks,
                  openMap: () => {
                    closePages();
                    setMapOpen(true);
                  },
                  openModels: () => {
                    closePages();
                    setModelsOpen(true);
                  },
                  // The picker lives in the conversation, which a page or channel covers.
                  newChat: () => {
                    closePages();
                    setAgentPickerOpen(true);
                  },
                })
              }
              onClose={() => setPaletteOpen(false)}
            />
          </Show>
          <Show when={permissionsOpen()}>
            <InitialSetup
              reviewing
              state={setupState() ?? { completed: true, preferredProvider: null }}
              agentStatus={agentStatus()}
              platform={appInfo()?.platform ?? "darwin"}
              onSave={saveSetup}
              onCheckAgents={checkAgents}
              onOpenUrl={(url) => window.openbot.openUrl(url)}
              onClose={() => setPermissionsOpen(false)}
            />
          </Show>
        </div>
      </Show>
    </Show>
  );
}
