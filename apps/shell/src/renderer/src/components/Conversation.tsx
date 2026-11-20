import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import type {
  AgentEvent,
  AgentModelId,
  AgentModelOption,
  AgentReasoningEffort,
  AgentStatus,
  BrowserControlState,
  BrowserTab,
  DraftAttachment,
  QueueSnapshot,
  UpdateBotInput,
} from "../../../shared/ipc";
import type { BotMessage, BotProfile } from "../data";
import { ARTIFACT_PANEL_MAX, ARTIFACT_PANEL_MIN, ArtifactPanel } from "./ArtifactPanel";
import { expandComposerMentions } from "./ComposerEditor";
import { PromptCard } from "./ConversationPrompts";
import { AgentSettings, createAgentSettingsForm } from "./conversation/AgentSettings";
import { createMediaPreview, MediaPreviewDialog } from "./conversation/Attachments";
import { BrowserPanel } from "./conversation/BrowserPanel";
import { createBrowserState } from "./conversation/browser-state";
import { Composer } from "./conversation/Composer";
import { ConversationHeader } from "./conversation/ConversationHeader";
import {
  ARTIFACT_PANEL_STORAGE_KEY,
  BROWSER_PANEL_STORAGE_KEY,
  CONVERSATION_PANEL_MIN,
  type ComposerDraft,
  EMPTY_DRAFT,
  SETTINGS_PANEL_STORAGE_KEY,
} from "./conversation/constants";
import { createMessageActionsState } from "./conversation/MessageActions";
import { OrganizationSidePanel } from "./conversation/RightPanel";
import { createRightPanelState } from "./conversation/right-panel-state";
import { AgentSetupCard, OnboardingStep, TranscriptEntry } from "./conversation/Transcript";
import { AgentActivityIndicator } from "./conversation/WorkingLine";
import { createDictation } from "./Dictation";
import { ManagerEntry } from "./ManagerEntry";
import { ModelNotice, SwitchDialog } from "./ModelSwitch";
import { savePanelWidth } from "./PanelResizer";

interface ConversationProps {
  agentStatus: AgentStatus;
  bot: BotProfile | undefined;
  bots: BotProfile[];
  modelOptions: AgentModelOption[];
  messages: BotMessage[];
  loaded: boolean;
  activeTurnId: string | null | undefined;
  agentPickerOpen: boolean;
  creatingAgent: boolean;
  settingsRequest: { botId: string; nonce: number } | null;
  onboardingRequest: { botId: string; nonce: number } | null;
  queue: QueueSnapshot | undefined;
  browserTabs: BrowserTab[];
  activeBrowserTabId: string | null;
  browserControlState: BrowserControlState;
  leftSidebarCollapsed: boolean;
  prompt: Extract<AgentEvent, { type: "prompt" }> | undefined;
  onCloseAgentPicker: () => void;
  onCreateAgent: () => void;
  onSelectAgent: (botId: string) => void;
  onUpdateBot: (botId: string, updates: Omit<UpdateBotInput, "botId">) => Promise<void>;
  onSendMessage: (
    body: string,
    attachmentDraftIds: string[],
    replyToMessageId: string | null,
  ) => Promise<boolean>;
  onCompleteOnboarding: (
    answer: string,
    model: AgentModelId,
    reasoningEffort: AgentReasoningEffort,
  ) => Promise<boolean>;
  onAnswerPrompt: (answers: Record<string, string[]>) => Promise<boolean>;
  onCancelQueuedMessage: (deliveryId: string) => void;
  onResumeQueue: () => void;
  onActivateBrowserTab: (tabId: string) => void;
  onCloseBrowserTab: (tabId: string) => void;
  onToggleLeftSidebar: () => void;
  onOpenAgentSetup: () => Promise<void>;
  onStop: () => void;
  /** Opens the Tasks page for a project, from its Organization panel. */
  onOpenTasks?: (projectId: string) => void;
}

export function Conversation(props: ConversationProps) {
  const agentReady = () => props.agentStatus.phase === "ready";
  const {
    rightPanels,
    setRightPanels,
    settingsPanelWidth,
    setSettingsPanelWidth,
    browserPanelWidth,
    setBrowserPanelWidth,
    artifactPanelWidth,
    setArtifactPanelWidth,
    screenOpen,
    settingsOpen,
    organizationOpen,
    openArtifact,
    artifactOpen,
    setActiveRightPanel,
    openFromOrganization,
    showArtifact,
  } = createRightPanelState(props);
  const [drafts, setDrafts] = createSignal<Record<string, ComposerDraft>>({});
  const [showAttachments, setShowAttachments] = createSignal(false);
  const [attachmentBusy, setAttachmentBusy] = createSignal(false);
  const [composerError, setComposerError] = createSignal<string | null>(null);
  const { mediaPreview, setMediaPreview, previewAttachment, attachmentAction } =
    createMediaPreview(setComposerError);
  const [settingsSaveError, setSettingsSaveError] = createSignal<string | null>(null);
  const [submitting, setSubmitting] = createSignal(false);
  const [dropActive, setDropActive] = createSignal(false);
  const settingsForm = createAgentSettingsForm();
  const [settingsModel, setSettingsModel] = createSignal<AgentModelId>("gpt-5.6-luna");
  const [settingsReasoning, setSettingsReasoning] = createSignal<AgentReasoningEffort>("medium");
  const [onboardingBots, setOnboardingBots] = createSignal<Record<string, true>>({});
  const [modelConfirmedBots, setModelConfirmedBots] = createSignal<Record<string, true>>({});
  const [completedOnboardingBots, setCompletedOnboardingBots] = createSignal<Record<string, true>>(
    {},
  );
  const selectedModel = createMemo(() =>
    props.modelOptions.find((option) => option.id === settingsModel()),
  );
  const reasoningOptions = createMemo(
    () => selectedModel()?.supportedReasoningEfforts ?? ["medium" as const],
  );
  const onboardingActive = createMemo(() => {
    const botId = props.bot?.id;
    return Boolean(botId && onboardingBots()[botId]);
  });
  const onboardingModelConfirmed = createMemo(() => {
    const botId = props.bot?.id;
    return Boolean(botId && onboardingActive() && modelConfirmedBots()[botId]);
  });
  const onboardingModelRequired = createMemo(
    () => agentReady() && onboardingActive() && !onboardingModelConfirmed(),
  );
  const currentDraft = createMemo(() => {
    const id = props.bot?.id;
    return id ? (drafts()[id] ?? EMPTY_DRAFT) : EMPTY_DRAFT;
  });
  const replyTarget = createMemo(() => {
    const id = currentDraft().replyToMessageId;
    return id ? props.messages.find((message) => message.id === id) : undefined;
  });
  const agentActivity = createMemo<"Queued" | "Working" | null>(() => {
    if (
      props.activeTurnId ||
      props.queue?.deliveries.some(
        (delivery) => delivery.status === "starting" || delivery.status === "running",
      )
    ) {
      return "Working";
    }
    if (
      !props.queue?.paused &&
      props.queue?.deliveries.some((delivery) => delivery.status === "queued")
    ) {
      return "Queued";
    }
    return null;
  });
  const queueBarVisible = createMemo(
    () =>
      Boolean(props.queue?.paused) ||
      Boolean(props.queue?.deliveries.some((item) => item.status === "queued")),
  );
  const seenMessageIds = new Set<string>();
  const [fadeAtTop, setFadeAtTop] = createSignal(false);
  const [fadeAtBottom, setFadeAtBottom] = createSignal(false);
  let scrollElement: HTMLDivElement | undefined;
  let conversationPanel: HTMLElement | undefined;
  let browserSurface: HTMLDivElement | undefined;
  let stickToLatest = true;
  let lastConversationBotId: string | undefined;
  let lastPanelBotId: string | undefined;
  let lastHandledSettingsRequestNonce: number | undefined;
  let lastHandledOnboardingRequestNonce: number | undefined;
  let lastSettingsSignature: string | undefined;
  const importTargetBots = new Map<string, string>();

  async function saveBotPatch(updates: Omit<UpdateBotInput, "botId">): Promise<boolean> {
    const botId = props.bot?.id;
    if (!botId) return false;
    setSettingsSaveError(null);
    try {
      await props.onUpdateBot(botId, updates);
      return true;
    } catch (error) {
      setSettingsSaveError(
        error instanceof Error ? error.message : "Could not save agent settings.",
      );
      return false;
    }
  }

  async function selectModel(
    model: AgentModelId,
    persist = true,
    reportComposerError = false,
  ): Promise<boolean> {
    const option = props.modelOptions.find((candidate) => candidate.id === model);
    if (!option) return false;
    const reasoningEffort = option.supportedReasoningEfforts.includes(settingsReasoning())
      ? settingsReasoning()
      : option.defaultReasoningEffort;
    const previousModel = settingsModel();
    const previousReasoning = settingsReasoning();
    setSettingsModel(model);
    setSettingsReasoning(reasoningEffort);
    if (!persist) return true;
    if (reportComposerError) setComposerError(null);
    const saved = await saveBotPatch({ model, reasoningEffort });
    if (saved) return true;
    setSettingsModel(previousModel);
    setSettingsReasoning(previousReasoning);
    if (reportComposerError) setComposerError("Could not change model. Try again.");
    return false;
  }

  async function selectAndConfirmModel(model: AgentModelId): Promise<void> {
    if (!(await selectModel(model, true, true))) return;
    const botId = props.bot?.id;
    if (botId) setModelConfirmedBots((current) => ({ ...current, [botId]: true }));
  }

  function finishOnboarding(botId: string): void {
    setCompletedOnboardingBots((current) => ({ ...current, [botId]: true }));
    setOnboardingBots((current) => {
      if (!current[botId]) return current;
      const next = { ...current };
      delete next[botId];
      return next;
    });
    setModelConfirmedBots((current) => {
      if (!current[botId]) return current;
      const next = { ...current };
      delete next[botId];
      return next;
    });
  }

  function updateScrollFade(element = scrollElement) {
    if (!element) return;
    const remaining = element.scrollHeight - element.scrollTop - element.clientHeight;
    setFadeAtTop(element.scrollTop > 2);
    setFadeAtBottom(remaining > 2);
  }

  const markMessageSeen = (messageId: string): boolean => {
    const key = `${props.bot?.id ?? "none"}:${messageId}`;
    if (seenMessageIds.has(key)) return false;
    seenMessageIds.add(key);
    return true;
  };

  const updateCurrentDraft = (patch: Partial<ComposerDraft>) => {
    const id = props.bot?.id;
    if (!id) return;
    setDrafts((current) => ({ ...current, [id]: { ...(current[id] ?? EMPTY_DRAFT), ...patch } }));
  };

  const dictation = createDictation({
    scope: () => props.bot?.id,
    draft: () => currentDraft().text,
    onDraft: (text) => updateCurrentDraft({ text }),
    onError: setComposerError,
  });

  const messageActions = createMessageActionsState({
    botId: () => props.bot?.id,
    onReply: (message) => updateCurrentDraft({ replyToMessageId: message.id }),
    onError: setComposerError,
  });

  onMount(() => {
    const unsubscribeImport = window.openbot.agent.onAttachmentImport((event) => {
      if (event.type === "started") {
        const botId = props.bot?.id;
        if (botId) importTargetBots.set(event.requestId, botId);
        setAttachmentBusy(true);
        setComposerError(null);
      } else if (event.type === "error") {
        importTargetBots.delete(event.requestId);
        setAttachmentBusy(false);
        setComposerError(event.message);
      } else {
        setAttachmentBusy(false);
        const botId = importTargetBots.get(event.requestId);
        importTargetBots.delete(event.requestId);
        if (botId && props.bots.some((bot) => bot.id === botId)) {
          addAttachments(event.attachments, botId);
        } else {
          for (const attachment of event.attachments) {
            void window.openbot.agent.discardDraftAttachment(attachment.id);
          }
        }
      }
    });
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      messageActions.closeAll();
      browser.hideBrowserPanel();
      setMediaPreview(null);
      settingsForm.setAvatarPickerOpen(false);
      props.onCloseAgentPicker();
    };
    const closeMessageMenus = (event: MouseEvent) => {
      if ((event.target as Element | null)?.closest(".message-actions")) return;
      messageActions.closeAll();
    };
    window.addEventListener("keydown", closeOnEscape);
    window.addEventListener("pointerdown", closeMessageMenus);
    const scrollResizeObserver = new ResizeObserver(() => updateScrollFade());
    if (scrollElement) scrollResizeObserver.observe(scrollElement);
    requestAnimationFrame(() => updateScrollFade());
    onCleanup(() => {
      scrollResizeObserver.disconnect();
      unsubscribeImport();
      window.removeEventListener("keydown", closeOnEscape);
      window.removeEventListener("pointerdown", closeMessageMenus);
    });
  });

  createEffect(() => {
    const request = props.onboardingRequest;
    if (
      !request ||
      props.bot?.id !== request.botId ||
      request.nonce === lastHandledOnboardingRequestNonce
    )
      return;
    lastHandledOnboardingRequestNonce = request.nonce;
    setOnboardingBots((current) => ({ ...current, [request.botId]: true }));
    setModelConfirmedBots((current) => ({ ...current, [request.botId]: true }));
    setActiveRightPanel("none");
  });

  createEffect(() => {
    const botId = props.bot?.id;
    const lastMessage = props.messages[props.messages.length - 1];
    props.activeTurnId;
    props.queue?.deliveries.map((delivery) => `${delivery.id}:${delivery.status}`).join("|");
    lastMessage?.body;
    lastMessage?.status;
    lastMessage?.exchange?.deliveries
      .map((delivery) => `${delivery.id}:${delivery.status}:${delivery.position}`)
      .join("|");
    props.loaded;
    props.agentPickerOpen;
    props.prompt;
    if (botId !== lastConversationBotId) {
      lastConversationBotId = botId;
      stickToLatest = true;
    }
    requestAnimationFrame(() => {
      if (!scrollElement) return;
      if (stickToLatest) scrollElement.scrollTop = scrollElement.scrollHeight;
      updateScrollFade(scrollElement);
    });
  });

  createEffect(() => {
    const bot = props.bot;
    if (!bot) return;
    const signature = [
      bot.id,
      bot.name,
      bot.role,
      bot.description,
      String(bot.notifications),
      bot.model,
      bot.reasoningEffort,
      bot.avatarShape,
      bot.avatarColor,
    ].join("\u0000");
    if (signature === lastSettingsSignature) return;
    lastSettingsSignature = signature;
    settingsForm.setName(bot.name);
    settingsForm.setTitle(bot.role);
    settingsForm.setDescription(bot.description);
    settingsForm.setNotifications(bot.notifications);
    setSettingsModel(bot.model);
    setSettingsReasoning(bot.reasoningEffort);
    settingsForm.setAvatarShape(bot.avatarShape);
    settingsForm.setAvatarColor(bot.avatarColor);
    settingsForm.setAvatarPickerOpen(false);
  });

  createEffect(() => {
    const botId = props.bot?.id;
    if (
      !botId ||
      !props.bot?.onboarding ||
      !props.loaded ||
      !agentReady() ||
      props.activeTurnId ||
      props.messages.length > 0 ||
      props.onboardingRequest?.botId === botId ||
      completedOnboardingBots()[botId] ||
      onboardingBots()[botId]
    )
      return;
    setOnboardingBots((current) => ({ ...current, [botId]: true }));
  });

  createEffect(() => {
    const botId = props.bot?.id;
    if (botId === lastPanelBotId) return;
    const previousBotId = lastPanelBotId;
    lastPanelBotId = botId;
    if (!previousBotId || !botId || rightPanels()[botId] !== "settings") return;
    setRightPanels((current) => ({ ...current, [botId]: "none" }));
  });

  createEffect(() => {
    const request = props.settingsRequest;
    if (
      !request ||
      props.bot?.id !== request.botId ||
      request.nonce === lastHandledSettingsRequestNonce
    )
      return;
    lastHandledSettingsRequestNonce = request.nonce;
    setActiveRightPanel("settings");
  });

  const browser = createBrowserState(props, {
    screenOpen,
    surface: () => browserSurface,
    setActiveRightPanel,
    setRightPanels,
  });

  function addAttachments(selected: DraftAttachment[], botId = props.bot?.id) {
    if (!botId) return;
    const draft = drafts()[botId] ?? EMPTY_DRAFT;
    const available = Math.max(0, 10 - draft.attachments.length);
    const accepted = selected.slice(0, available);
    for (const attachment of selected.slice(available)) {
      void window.openbot.agent.discardDraftAttachment(attachment.id);
    }
    setDrafts((current) => ({
      ...current,
      [botId]: {
        ...(current[botId] ?? EMPTY_DRAFT),
        attachments: [...draft.attachments, ...accepted],
      },
    }));
    if (selected.length > accepted.length) setComposerError("You can attach at most 10 files.");
    setShowAttachments(false);
  }

  async function chooseAttachments() {
    if (attachmentBusy()) return;
    setAttachmentBusy(true);
    setComposerError(null);
    try {
      addAttachments(await window.openbot.agent.chooseAttachments());
    } catch (error) {
      setComposerError(error instanceof Error ? error.message : String(error));
    } finally {
      setAttachmentBusy(false);
    }
  }

  async function submitMessage(override?: string) {
    const botId = props.bot?.id;
    const draft = currentDraft();
    const text = override ?? expandComposerMentions(draft.text);
    const attachments = override ? [] : draft.attachments;
    if (
      !botId ||
      submitting() ||
      onboardingModelRequired() ||
      (!text.trim() && attachments.length === 0)
    )
      return;
    stickToLatest = true;
    setSubmitting(true);
    setComposerError(null);
    const sent = await props.onSendMessage(
      text,
      attachments.map((item) => item.id),
      override ? null : draft.replyToMessageId,
    );
    setSubmitting(false);
    if (sent) {
      setDrafts((current) => ({ ...current, [botId]: EMPTY_DRAFT }));
      finishOnboarding(botId);
    }
  }

  function removeAttachment(id: string) {
    updateCurrentDraft({
      attachments: currentDraft().attachments.filter((attachment) => attachment.id !== id),
    });
    void window.openbot.agent.discardDraftAttachment(id);
  }

  async function openMessageLink(url: string) {
    try {
      await window.openbot.openUrl(url);
    } catch {
      setComposerError("Could not open the link.");
    }
  }

  const working = () => agentActivity() === "Working";
  const modelDisabled = () => !agentReady() || working();
  const containerWidth = () => conversationPanel?.clientWidth || window.innerWidth;

  return (
    <main
      ref={(element) => (conversationPanel = element)}
      aria-label="Conversation"
      class="conversation-panel"
      classList={{
        "conversation-drop-active": dropActive(),
        "browser-panel-active": screenOpen(),
        "artifact-panel-active": artifactOpen(),
      }}
      style={`--settings-panel-width: ${settingsPanelWidth()}px; --browser-panel-width: ${browserPanelWidth()}px; --artifact-panel-width: ${artifactPanelWidth()}px`}
      onDragEnter={(event) => {
        if (event.dataTransfer?.types.includes("Files")) setDropActive(true);
      }}
      onDragOver={(event) => {
        if (event.dataTransfer?.types.includes("Files")) event.preventDefault();
      }}
      onDragLeave={(event) => {
        if (event.currentTarget === event.target) setDropActive(false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        setDropActive(false);
      }}
    >
      <Show when={dropActive()}>
        <div class="attachment-drop-overlay">Drop files to attach</div>
      </Show>
      <ConversationHeader
        leftSidebarCollapsed={props.leftSidebarCollapsed}
        onToggleLeftSidebar={props.onToggleLeftSidebar}
        agentPickerOpen={props.agentPickerOpen}
        bot={props.bot}
        bots={props.bots}
        creatingAgent={props.creatingAgent}
        onCreateAgent={props.onCreateAgent}
        onSelectAgent={props.onSelectAgent}
        onCloseAgentPicker={props.onCloseAgentPicker}
        onOpenSettings={() => setActiveRightPanel("settings")}
        modelValue={settingsModel()}
        modelOptions={props.modelOptions}
        agentStatus={props.agentStatus}
        modelDisabled={modelDisabled()}
        working={working()}
        onModelChange={(model) => void selectAndConfirmModel(model)}
        organizationOpen={organizationOpen()}
        onToggleOrganization={() =>
          setActiveRightPanel(organizationOpen() ? "none" : "organization")
        }
        browserControlled={Boolean(browser.activeBrowserControl())}
        browserControllerName={browser.browserControlBot()?.name}
        screenOpen={screenOpen()}
        onToggleScreen={() => {
          if (screenOpen()) browser.hideBrowserPanel();
          else browser.showBrowserPanel();
        }}
      />

      <div
        class="conversation-scroll"
        classList={{
          "scroll-fade-top": fadeAtTop(),
          "scroll-fade-bottom": fadeAtBottom(),
        }}
        ref={(element) => (scrollElement = element)}
        onScroll={(event) => {
          const element = event.currentTarget;
          stickToLatest = element.scrollHeight - element.scrollTop - element.clientHeight <= 80;
          updateScrollFade(element);
        }}
      >
        <Show when={!props.agentPickerOpen && props.loaded}>
          <Show when={!agentReady()}>
            <AgentSetupCard
              agentStatus={props.agentStatus}
              onSetup={() =>
                void props
                  .onOpenAgentSetup()
                  .catch((error) =>
                    setComposerError(error instanceof Error ? error.message : String(error)),
                  )
              }
            />
          </Show>
          <Show when={props.messages.length > 0}>
            <div class="time-marker">
              <span>{props.messages[0]?.time ?? "now"}</span>
            </div>
          </Show>
          <Show when={agentReady() && onboardingActive() && !props.activeTurnId}>
            <OnboardingStep
              modelValue={settingsModel()}
              agentStatus={props.agentStatus}
              modelOptions={props.modelOptions}
              onModelChange={(model) => void selectAndConfirmModel(model)}
              modelConfirmed={onboardingModelConfirmed()}
              submitting={submitting()}
              onSubmit={async (answer) => {
                if (submitting()) return false;
                setSubmitting(true);
                setComposerError(null);
                const completed = await props.onCompleteOnboarding(
                  answer,
                  settingsModel(),
                  settingsReasoning(),
                );
                if (completed) {
                  const botId = props.bot?.id;
                  if (botId) finishOnboarding(botId);
                }
                setSubmitting(false);
                return completed;
              }}
            />
          </Show>
          <For each={props.messages}>
            {(message) => {
              if (message.card || message.notice)
                return (
                  <ManagerEntry
                    message={message}
                    bots={props.bots}
                    onSelectAgent={props.onSelectAgent}
                  />
                );
              if (message.kind === "notice") return <ModelNotice message={message} />;
              const animateEntrance = message.animate === true && markMessageSeen(message.id);
              return (
                <TranscriptEntry
                  message={message}
                  messages={props.messages}
                  bots={props.bots}
                  animate={animateEntrance}
                  actions={messageActions}
                  onSelectAgent={props.onSelectAgent}
                  onOpenLink={(url) => void openMessageLink(url)}
                  onPreview={(attachment) => void previewAttachment(attachment)}
                  onAttachmentAction={attachmentAction}
                  openArtifactVersionId={
                    artifactOpen() ? (openArtifact()?.versionId ?? null) : null
                  }
                  onOpenArtifact={showArtifact}
                />
              );
            }}
          </For>
          <AgentActivityIndicator bot={props.bot} state={agentActivity()} />
          <Show when={props.prompt}>
            {(prompt) => (
              <Show
                when={prompt().switchDialog}
                fallback={
                  <PromptCard questions={prompt().questions} onSubmit={props.onAnswerPrompt} />
                }
              >
                {(dialog) => (
                  <SwitchDialog
                    dialog={dialog()}
                    questions={prompt().questions}
                    onSubmit={props.onAnswerPrompt}
                  />
                )}
              </Show>
            )}
          </Show>
        </Show>
      </div>

      <Composer
        showAttachments={showAttachments()}
        attachmentBusy={attachmentBusy()}
        onToggleAttachments={() => setShowAttachments((value) => !value)}
        onChooseAttachments={() => void chooseAttachments()}
        attachments={currentDraft().attachments}
        onRemoveAttachment={removeAttachment}
        replyTarget={replyTarget()}
        onCancelReply={() => updateCurrentDraft({ replyToMessageId: null })}
        error={composerError()}
        queue={props.queue}
        queueBarVisible={queueBarVisible()}
        onResumeQueue={props.onResumeQueue}
        onCancelQueuedMessage={props.onCancelQueuedMessage}
        agentPickerOpen={props.agentPickerOpen}
        agentReady={agentReady()}
        onboardingModelRequired={onboardingModelRequired()}
        submitting={submitting()}
        bot={props.bot}
        bots={props.bots}
        text={currentDraft().text}
        onTextChange={(text) => updateCurrentDraft({ text })}
        onSubmit={() => void submitMessage()}
        dictation={dictation}
        activeTurnId={props.activeTurnId}
        onStop={props.onStop}
      />

      <Show when={mediaPreview()}>
        {(preview) => (
          <MediaPreviewDialog
            preview={preview()}
            onClose={() => setMediaPreview(null)}
            onAction={attachmentAction}
          />
        )}
      </Show>

      <Show when={screenOpen()}>
        <BrowserPanel
          browser={browser}
          activeBrowserTabId={props.activeBrowserTabId}
          width={browserPanelWidth()}
          containerWidth={containerWidth}
          onResize={setBrowserPanelWidth}
          onResizeEnd={(value) => savePanelWidth(BROWSER_PANEL_STORAGE_KEY, value)}
          onActivateBrowserTab={props.onActivateBrowserTab}
          onCloseBrowserTab={props.onCloseBrowserTab}
          surfaceRef={(element) => (browserSurface = element)}
        />
      </Show>

      <Show when={organizationOpen() && props.bot?.projectId} keyed>
        {(projectId) => (
          <OrganizationSidePanel
            projectId={projectId}
            bots={props.bots}
            width={settingsPanelWidth()}
            containerWidth={containerWidth}
            onResize={setSettingsPanelWidth}
            onResizeEnd={(value) => savePanelWidth(SETTINGS_PANEL_STORAGE_KEY, value)}
            onOpenChat={openFromOrganization}
            onOpenTasks={props.onOpenTasks}
            onClose={() => setActiveRightPanel("none")}
          />
        )}
      </Show>
      <Show when={artifactOpen() ? openArtifact() : undefined}>
        {(artifact) => (
          <ArtifactPanel
            artifact={artifact()}
            width={artifactPanelWidth()}
            maxWidth={() =>
              Math.min(
                ARTIFACT_PANEL_MAX,
                Math.max(ARTIFACT_PANEL_MIN, containerWidth() - CONVERSATION_PANEL_MIN),
              )
            }
            onResize={setArtifactPanelWidth}
            onResizeEnd={(value) => savePanelWidth(ARTIFACT_PANEL_STORAGE_KEY, value)}
            onClose={() => setActiveRightPanel("none")}
          />
        )}
      </Show>

      <Show when={settingsOpen() && props.bot}>
        <AgentSettings
          form={settingsForm}
          bot={props.bot}
          width={settingsPanelWidth()}
          containerWidth={containerWidth}
          onResize={setSettingsPanelWidth}
          onResizeEnd={(value) => savePanelWidth(SETTINGS_PANEL_STORAGE_KEY, value)}
          onClose={() => setActiveRightPanel("none")}
          save={saveBotPatch}
          modelValue={settingsModel()}
          agentStatus={props.agentStatus}
          modelOptions={props.modelOptions}
          modelDisabled={modelDisabled()}
          working={working()}
          onModelChange={(model) => void selectAndConfirmModel(model)}
          reasoning={settingsReasoning()}
          reasoningOptions={reasoningOptions()}
          onReasoningChange={(reasoningEffort) => {
            setSettingsReasoning(reasoningEffort);
            saveBotPatch({ reasoningEffort });
          }}
          saveError={settingsSaveError()}
        />
      </Show>
    </main>
  );
}
