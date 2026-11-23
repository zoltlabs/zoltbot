import { contextBridge, ipcRenderer, webUtils } from "electron";
import { BUNDLE_CHANNELS } from "../shared/bundle";
import { CLI_CHANNELS } from "../shared/cli";
import { DOCK_CHANNELS, type DockState } from "../shared/dock";
import {
  type AgentBrowserFrame,
  type AgentEvent,
  type AttachmentImportEvent,
  type DictationEvent,
  type ImportAttachmentsInput,
  IPC_CHANNELS,
  type OpenBotDesktopApi,
  type UpdateStatus,
  type ViewHostEvent,
} from "../shared/ipc";
import { PREFERENCE_CHANNELS, type Preferences } from "../shared/preferences";
import { START_FRESH_CHANNELS } from "../shared/start-fresh";

/** ATTACHMENT_MAX_BYTES, kept here so the preload stays free of the protocol package. */
const PASTE_MAX_BYTES = 100 * 1024 * 1024;

const attachmentImportListeners = new Set<(event: AttachmentImportEvent) => void>();

function emitAttachmentImport(event: AttachmentImportEvent): void {
  for (const listener of attachmentImportListeners) listener(event);
}

async function importFiles(files: File[]): Promise<void> {
  if (files.length === 0) return;
  const requestId = crypto.randomUUID();
  emitAttachmentImport({ type: "started", requestId });
  try {
    const input: ImportAttachmentsInput = { paths: [], data: [] };
    for (const file of files) {
      const path = webUtils.getPathForFile(file);
      if (path) input.paths.push(path);
      else {
        // Checked here too, so a huge pasted file is never read into memory (C18).
        if (file.size > PASTE_MAX_BYTES)
          throw new Error(
            `${file.name || "The pasted file"} is over 100 MB, so it wasn't attached.`,
          );
        input.data.push({
          name: file.name || `pasted-${Date.now()}.png`,
          mimeType: file.type,
          bytes: new Uint8Array(await file.arrayBuffer()),
        });
      }
    }
    const attachments = await ipcRenderer.invoke(IPC_CHANNELS.agentImportAttachments, input);
    emitAttachmentImport({ type: "completed", requestId, attachments });
  } catch (error) {
    emitAttachmentImport({
      type: "error",
      requestId,
      message: (error instanceof Error ? error.message : String(error)).replace(
        /^Error invoking remote method '[^']+': (Error: )?/,
        "",
      ),
    });
  }
}

/** Invokes main and rethrows its message without Electron's "Error invoking remote method" prefix. */
async function invokeShown(channel: string, ...args: unknown[]) {
  try {
    return await ipcRenderer.invoke(channel, ...args);
  } catch (error) {
    throw new Error(
      (error instanceof Error ? error.message : String(error)).replace(
        /^Error invoking remote method '[^']+': (Error: )?/,
        "",
      ),
    );
  }
}

window.addEventListener("dragover", (event) => {
  if ([...(event.dataTransfer?.items ?? [])].some((item) => item.kind === "file")) {
    event.preventDefault();
  }
});
window.addEventListener("drop", (event) => {
  const files = [...(event.dataTransfer?.files ?? [])];
  if (!files.length) return;
  event.preventDefault();
  void importFiles(files);
});
window.addEventListener("paste", (event) => {
  const files = [...(event.clipboardData?.files ?? [])];
  if (files.length) {
    event.preventDefault();
    void importFiles(files);
  }
});

const openbotApi: OpenBotDesktopApi = {
  getAppInfo: () => ipcRenderer.invoke(IPC_CHANNELS.getAppInfo),
  getSetupState: () => ipcRenderer.invoke(IPC_CHANNELS.getSetupState),
  saveSetup: (input) => ipcRenderer.invoke(IPC_CHANNELS.saveSetup, input),
  getMacPermissions: () => ipcRenderer.invoke(IPC_CHANNELS.getMacPermissions),
  requestMacPermission: (permission) =>
    ipcRenderer.invoke(IPC_CHANNELS.requestMacPermission, permission),
  openExternal: (destination) => ipcRenderer.invoke(IPC_CHANNELS.openExternal, destination),
  openUrl: (url) => ipcRenderer.invoke(IPC_CHANNELS.openUrl, url),
  setVisibleBot: (botId) => ipcRenderer.send(IPC_CHANNELS.setVisibleBot, botId),
  account: {
    getStatus: () => ipcRenderer.invoke(IPC_CHANNELS.accountGetStatus),
    signIn: () => ipcRenderer.invoke(IPC_CHANNELS.accountSignIn),
    signOut: () => ipcRenderer.invoke(IPC_CHANNELS.accountSignOut),
    cancel: () => ipcRenderer.invoke(IPC_CHANNELS.accountCancel),
  },
  cloud: {
    settings: () => ipcRenderer.invoke(IPC_CHANNELS.cloudSettings),
    update: (setting) => ipcRenderer.invoke(IPC_CHANNELS.cloudUpdate, setting),
    saveSecret: (input) => ipcRenderer.invoke(IPC_CHANNELS.cloudSaveSecret, input),
    workspace: () => ipcRenderer.invoke(IPC_CHANNELS.cloudWorkspace),
    answer: (input) => ipcRenderer.invoke(IPC_CHANNELS.cloudAnswer, input),
    onWorkspace(listener) {
      const receive = (_event: unknown, state: Parameters<typeof listener>[0]) => listener(state);
      ipcRenderer.on(IPC_CHANNELS.cloudWorkspaceEvent, receive);
      return () => {
        ipcRenderer.removeListener(IPC_CHANNELS.cloudWorkspaceEvent, receive);
      };
    },
    call: (owner, method, params, commandId) =>
      ipcRenderer.invoke(IPC_CHANNELS.cloudCall, { owner, method, params, commandId }),
  },
  agent: {
    getStatus: () => ipcRenderer.invoke(IPC_CHANNELS.agentGetStatus),
    refreshAgents: () => ipcRenderer.invoke(IPC_CHANNELS.agentRefreshAgents),
    getUsage: () => ipcRenderer.invoke(IPC_CHANNELS.agentGetUsage),
    listModels: () => ipcRenderer.invoke(IPC_CHANNELS.agentListModels),
    refreshModels: (providers) => ipcRenderer.invoke(IPC_CHANNELS.agentRefreshModels, providers),
    listBots: () => ipcRenderer.invoke(IPC_CHANNELS.agentListBots),
    listAgents: () => ipcRenderer.invoke(IPC_CHANNELS.agentListAgents),
    createBot: (input) => ipcRenderer.invoke(IPC_CHANNELS.agentCreateBot, input),
    createProject: () => ipcRenderer.invoke(IPC_CHANNELS.agentCreateProject),
    updateBot: (input) => ipcRenderer.invoke(IPC_CHANNELS.agentUpdateBot, input),
    deleteBot: (botId) => ipcRenderer.invoke(IPC_CHANNELS.agentDeleteBot, botId),
    readConversation: (botId) => ipcRenderer.invoke(IPC_CHANNELS.agentReadConversation, botId),
    readContext: (botId) => ipcRenderer.invoke(IPC_CHANNELS.agentReadContext, botId),
    compact: (botId) => ipcRenderer.invoke(IPC_CHANNELS.agentCompact, botId),
    branchPreview: (input) => ipcRenderer.invoke(IPC_CHANNELS.agentBranchPreview, input),
    branch: (request) => ipcRenderer.invoke(IPC_CHANNELS.agentBranch, request),
    threadAction: (input) => ipcRenderer.invoke(IPC_CHANNELS.agentThreadAction, input),
    chooseAttachments: () => ipcRenderer.invoke(IPC_CHANNELS.agentChooseAttachments),
    onAttachmentImport: (listener) => {
      attachmentImportListeners.add(listener);
      return () => attachmentImportListeners.delete(listener);
    },
    discardDraftAttachment: (attachmentId) =>
      ipcRenderer.invoke(IPC_CHANNELS.agentDiscardDraftAttachment, attachmentId),
    openAttachment: (input) => ipcRenderer.invoke(IPC_CHANNELS.agentOpenAttachment, input),
    sendMessage: (input) => ipcRenderer.invoke(IPC_CHANNELS.agentSendMessage, input),
    setMessageReaction: (input) => ipcRenderer.invoke(IPC_CHANNELS.agentSetMessageReaction, input),
    listQueue: (botId) => ipcRenderer.invoke(IPC_CHANNELS.agentListQueue, botId),
    cancelQueuedMessage: (input) =>
      ipcRenderer.invoke(IPC_CHANNELS.agentCancelQueuedMessage, input),
    setQueuePaused: (input) => ipcRenderer.invoke(IPC_CHANNELS.agentSetQueuePaused, input),
    interrupt: (input) => ipcRenderer.invoke(IPC_CHANNELS.agentInterrupt, input),
    respondToPrompt: (input) => ipcRenderer.invoke(IPC_CHANNELS.agentRespondToPrompt, input),
    readCompany: (projectId) => ipcRenderer.invoke(IPC_CHANNELS.agentReadCompany, projectId),
    decidePlan: (input) => ipcRenderer.invoke(IPC_CHANNELS.agentDecidePlan, input),
    refreshBrief: (projectId) => ipcRenderer.invoke(IPC_CHANNELS.agentRefreshBrief, projectId),
    taskAction: (input) => ipcRenderer.invoke(IPC_CHANNELS.agentTaskAction, input),
    listTasks: () => ipcRenderer.invoke(IPC_CHANNELS.agentListTasks),
    reviewTask: (input) => ipcRenderer.invoke(IPC_CHANNELS.agentReviewTask, input),
    listChannels: () => ipcRenderer.invoke(IPC_CHANNELS.agentListChannels),
    readChannel: (channelId) => ipcRenderer.invoke(IPC_CHANNELS.agentReadChannel, channelId),
    readEarlierPosts: (input) => ipcRenderer.invoke(IPC_CHANNELS.agentReadEarlierPosts, input),
    postChannel: (input) => ipcRenderer.invoke(IPC_CHANNELS.agentPostChannel, input),
    channelRequest: (input) => ipcRenderer.invoke(IPC_CHANNELS.agentChannelRequest, input),
    readStaff: (projectId) => ipcRenderer.invoke(IPC_CHANNELS.agentReadStaff, projectId),
    staffAction: (input) => ipcRenderer.invoke(IPC_CHANNELS.agentStaffAction, input),
    onEvent: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: AgentEvent) => listener(payload);
      ipcRenderer.on(IPC_CHANNELS.agentEvent, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.agentEvent, handler);
    },
  },
  browser: {
    open: (input) => ipcRenderer.invoke(IPC_CHANNELS.browserOpen, input),
    activate: (tabId) => ipcRenderer.invoke(IPC_CHANNELS.browserActivate, tabId),
    close: (tabId) => ipcRenderer.invoke(IPC_CHANNELS.browserClose, tabId),
    listTabs: () => ipcRenderer.invoke(IPC_CHANNELS.browserListTabs),
    getControlState: () => ipcRenderer.invoke(IPC_CHANNELS.browserGetControlState),
    setVisible: (input) => ipcRenderer.invoke(IPC_CHANNELS.browserSetVisible, input),
  },
  update: {
    getStatus: () => ipcRenderer.invoke(IPC_CHANNELS.updateGetStatus),
    check: () => ipcRenderer.invoke(IPC_CHANNELS.updateCheck),
    download: () => ipcRenderer.invoke(IPC_CHANNELS.updateDownload),
    install: () => ipcRenderer.invoke(IPC_CHANNELS.updateInstall),
    onEvent: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, status: UpdateStatus) => listener(status);
      ipcRenderer.on(IPC_CHANNELS.updateEvent, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.updateEvent, handler);
    },
  },
  preferences: {
    get: () => ipcRenderer.invoke(PREFERENCE_CHANNELS.preferencesGet),
    set: (patch) => ipcRenderer.invoke(PREFERENCE_CHANNELS.preferencesSet, patch),
    onChange: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, preferences: Preferences) =>
        listener(preferences);
      ipcRenderer.on(PREFERENCE_CHANNELS.preferencesEvent, handler);
      return () => ipcRenderer.removeListener(PREFERENCE_CHANNELS.preferencesEvent, handler);
    },
  },
  cli: {
    status: () => ipcRenderer.invoke(CLI_CHANNELS.cliStatus),
    install: () => ipcRenderer.invoke(CLI_CHANNELS.cliInstall),
  },
  maintenance: {
    exportData: () => ipcRenderer.invoke(IPC_CHANNELS.maintenanceExportData),
    exportDiagnostics: () => ipcRenderer.invoke(IPC_CHANNELS.maintenanceExportDiagnostics),
  },
  dictation: {
    status: (params) => ipcRenderer.invoke(IPC_CHANNELS.dictationStatus, params),
    requestPermission: (params) =>
      ipcRenderer.invoke(IPC_CHANNELS.dictationRequestPermission, params),
    start: (options) => ipcRenderer.invoke(IPC_CHANNELS.dictationStart, options),
    sendAudio: (sessionId, pcm16le) =>
      ipcRenderer.send(IPC_CHANNELS.dictationAudio, sessionId, pcm16le),
    stop: (sessionId) => ipcRenderer.invoke(IPC_CHANNELS.dictationStop, sessionId),
    cancel: (sessionId) => ipcRenderer.invoke(IPC_CHANNELS.dictationCancel, sessionId),
    onEvent: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: DictationEvent) =>
        listener(payload);
      ipcRenderer.on(IPC_CHANNELS.dictationEvent, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.dictationEvent, handler);
    },
  },
  artifacts: {
    prepare: (manifestHash) => ipcRenderer.invoke(IPC_CHANNELS.artifactPrepare, manifestHash),
  },
  models: {
    read: () => ipcRenderer.invoke(IPC_CHANNELS.modelsRead),
    addAccount: (input) => ipcRenderer.invoke(IPC_CHANNELS.modelsAddAccount, input),
    signIn: (accountId) => ipcRenderer.invoke(IPC_CHANNELS.modelsSignIn, accountId),
    check: (accountId) => ipcRenderer.invoke(IPC_CHANNELS.modelsCheck, accountId),
    remove: (accountId) => ipcRenderer.invoke(IPC_CHANNELS.modelsRemove, accountId),
    setOrder: (input) => ipcRenderer.invoke(IPC_CHANNELS.modelsSetOrder, input),
    runningLimit: () => ipcRenderer.invoke(IPC_CHANNELS.modelsRunningLimit),
    setRunningLimit: (limit) => ipcRenderer.invoke(IPC_CHANNELS.modelsSetRunningLimit, limit),
    starred: () => ipcRenderer.invoke(IPC_CHANNELS.modelsStarred),
    setStarred: (ids) => ipcRenderer.invoke(IPC_CHANNELS.modelsSetStarred, ids),
  },
  memory: {
    list: () => ipcRenderer.invoke(IPC_CHANNELS.memoryList),
    revisions: (id) => ipcRenderer.invoke(IPC_CHANNELS.memoryRevisions, id),
    save: (input) => ipcRenderer.invoke(IPC_CHANNELS.memorySave, input),
    archive: (input) => ipcRenderer.invoke(IPC_CHANNELS.memoryArchive, input),
    decide: (input) => ipcRenderer.invoke(IPC_CHANNELS.memoryDecide, input),
    decideSkill: (input) => ipcRenderer.invoke(IPC_CHANNELS.memoryDecideSkill, input),
    forget: (input) => ipcRenderer.invoke(IPC_CHANNELS.memoryForget, input),
    setTidy: (on) => ipcRenderer.invoke(IPC_CHANNELS.memorySetTidy, on),
    importChoose: (source) => ipcRenderer.invoke(IPC_CHANNELS.memoryImportChoose, source),
    importStart: (choice) => ipcRenderer.invoke(IPC_CHANNELS.memoryImportStart, choice),
    importStatus: (id) => ipcRenderer.invoke(IPC_CHANNELS.memoryImportStatus, id),
  },
  agentBrowser: {
    profile: (input) => ipcRenderer.invoke(IPC_CHANNELS.agentBrowserProfile, input),
    clearProfile: (input) => ipcRenderer.invoke(IPC_CHANNELS.agentBrowserClearProfile, input),
    view: (input) => ipcRenderer.invoke(IPC_CHANNELS.agentBrowserView, input),
    takeover: (input) => ipcRenderer.invoke(IPC_CHANNELS.agentBrowserTakeover, input),
    input: (input) => ipcRenderer.invoke(IPC_CHANNELS.agentBrowserInput, input),
    cookies: (input) => ipcRenderer.invoke(IPC_CHANNELS.agentBrowserCookies, input),
    teach: (input) => ipcRenderer.invoke(IPC_CHANNELS.agentBrowserTeach, input),
    onFrame: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, frame: AgentBrowserFrame) =>
        listener(frame);
      ipcRenderer.on(IPC_CHANNELS.agentBrowserFrame, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.agentBrowserFrame, handler);
    },
  },
  spend: {
    list: (input) => ipcRenderer.invoke(IPC_CHANNELS.spendList, input),
    setBudget: (input) => ipcRenderer.invoke(IPC_CHANNELS.spendSetBudget, input),
  },
  data: {
    projects: () => ipcRenderer.invoke(IPC_CHANNELS.dataProjects),
    tables: (projectId) => ipcRenderer.invoke(IPC_CHANNELS.dataTables, projectId),
    rows: (input) => ipcRenderer.invoke(IPC_CHANNELS.dataRows, input),
    csv: (input) => ipcRenderer.invoke(IPC_CHANNELS.dataCsv, input),
  },
  share: {
    status: (input) => ipcRenderer.invoke(IPC_CHANNELS.artifactShareStatus, input),
    publish: (input) => ipcRenderer.invoke(IPC_CHANNELS.artifactSharePublish, input),
    setVisibility: (input) => ipcRenderer.invoke(IPC_CHANNELS.artifactShareSetVisibility, input),
    replace: (input) => ipcRenderer.invoke(IPC_CHANNELS.artifactShareReplace, input),
    unpublish: (input) => ipcRenderer.invoke(IPC_CHANNELS.artifactShareUnpublish, input),
    copy: (input) => ipcRenderer.invoke(IPC_CHANNELS.artifactShareCopy, input),
  },
  repository: {
    state: (artifactId) => ipcRenderer.invoke(IPC_CHANNELS.artifactRepositoryState, artifactId),
    add: (input) => ipcRenderer.invoke(IPC_CHANNELS.artifactRepositoryAdd, input),
    mode: (botId) => ipcRenderer.invoke(IPC_CHANNELS.artifactRepositoryMode, botId),
    setMode: (input) => ipcRenderer.invoke(IPC_CHANNELS.artifactRepositorySetMode, input),
  },
  queue: {
    reorder: (input) => ipcRenderer.invoke(IPC_CHANNELS.queueReorder, input),
    sendNow: (input) => ipcRenderer.invoke(IPC_CHANNELS.queueSendNow, input),
  },
  aside: {
    ask: (input) => ipcRenderer.invoke(IPC_CHANNELS.asideAsk, input),
    continue: (input) => ipcRenderer.invoke(IPC_CHANNELS.asideContinue, input),
  },
  pins: {
    set: (input) => ipcRenderer.invoke(IPC_CHANNELS.pinsSet, input),
  },
  outbox: {
    sendNow: (input) => ipcRenderer.invoke(IPC_CHANNELS.outboxSendNow, input),
    delete: (input) => ipcRenderer.invoke(IPC_CHANNELS.outboxDelete, input),
  },
  links: {
    preview: (input) => ipcRenderer.invoke(IPC_CHANNELS.linksPreview, input),
    enabled: () => ipcRenderer.invoke(IPC_CHANNELS.linksEnabled),
    setEnabled: (enabled) => ipcRenderer.invoke(IPC_CHANNELS.linksSetEnabled, enabled),
  },
  voice: {
    status: () => ipcRenderer.invoke(IPC_CHANNELS.voiceStatus),
    setKey: (key) => invokeShown(IPC_CHANNELS.voiceSetKey, key),
    clearKey: () => invokeShown(IPC_CHANNELS.voiceClearKey),
    voices: () => invokeShown(IPC_CHANNELS.voiceVoices),
    speak: (input) => invokeShown(IPC_CHANNELS.voiceSpeak, input),
    logCall: (input) => ipcRenderer.invoke(IPC_CHANNELS.voiceCallLog, input),
  },
  hidden: {
    set: (input) => ipcRenderer.invoke(IPC_CHANNELS.hiddenSet, input),
  },
  vault: {
    list: () => ipcRenderer.invoke(IPC_CHANNELS.vaultList),
    save: (input) => ipcRenderer.invoke(IPC_CHANNELS.vaultSave, input),
    update: (input) => ipcRenderer.invoke(IPC_CHANNELS.vaultUpdate, input),
    remove: (id) => ipcRenderer.invoke(IPC_CHANNELS.vaultRemove, id),
    reveal: (id) => ipcRenderer.invoke(IPC_CHANNELS.vaultReveal, id),
    agents: () => ipcRenderer.invoke(IPC_CHANNELS.vaultAgents),
    providers: () => ipcRenderer.invoke(IPC_CHANNELS.vaultProviders),
    providerItems: (input) => ipcRenderer.invoke(IPC_CHANNELS.vaultProviderItems, input),
    providerUnlock: (input) => ipcRenderer.invoke(IPC_CHANNELS.vaultProviderUnlock, input),
    providerForget: (provider) => ipcRenderer.invoke(IPC_CHANNELS.vaultProviderForget, provider),
    saveSecret: (input) => ipcRenderer.invoke(IPC_CHANNELS.vaultSaveSecret, input),
  },
  coAuthor: {
    get: (botId) => ipcRenderer.invoke(IPC_CHANNELS.coAuthorGet, botId),
    set: (input) => ipcRenderer.invoke(IPC_CHANNELS.coAuthorSet, input),
  },
  bridges: {
    list: () => ipcRenderer.invoke(IPC_CHANNELS.bridgesList),
    save: (input) => ipcRenderer.invoke(IPC_CHANNELS.bridgesSave, input),
    remove: (id) => ipcRenderer.invoke(IPC_CHANNELS.bridgesRemove, id),
    targets: () => ipcRenderer.invoke(IPC_CHANNELS.bridgesTargets),
  },
  routines: {
    list: () => ipcRenderer.invoke(IPC_CHANNELS.routinesList),
    history: (id) => ipcRenderer.invoke(IPC_CHANNELS.routinesHistory, id),
    setPaused: (input) => ipcRenderer.invoke(IPC_CHANNELS.routinesSetPaused, input),
    setSchedule: (input) => ipcRenderer.invoke(IPC_CHANNELS.routinesSetSchedule, input),
    runNow: (id) => ipcRenderer.invoke(IPC_CHANNELS.routinesRunNow, id),
    addToCalendar: (input) => ipcRenderer.invoke(IPC_CHANNELS.routinesAddToCalendar, input),
    webAddress: (input) => ipcRenderer.invoke(IPC_CHANNELS.routinesWebAddress, input),
    starters: () => ipcRenderer.invoke(IPC_CHANNELS.routinesStarters),
    addStarter: (input) => ipcRenderer.invoke(IPC_CHANNELS.routinesAddStarter, input),
  },
  workflows: {
    list: () => ipcRenderer.invoke(IPC_CHANNELS.workflowsList),
    run: (id) => ipcRenderer.invoke(IPC_CHANNELS.workflowsRun, id),
    setPaused: (input) => ipcRenderer.invoke(IPC_CHANNELS.workflowsSetPaused, input),
    decide: (input) => ipcRenderer.invoke(IPC_CHANNELS.workflowsDecide, input),
    agents: () => ipcRenderer.invoke(IPC_CHANNELS.workflowsAgents),
    edit: (input) => ipcRenderer.invoke(IPC_CHANNELS.workflowsEdit, input),
  },
  templates: {
    list: () => ipcRenderer.invoke(IPC_CHANNELS.agentTemplatesList),
    create: (input) => ipcRenderer.invoke(IPC_CHANNELS.agentTemplatesCreate, input),
  },
  bundle: {
    export: () => ipcRenderer.invoke(BUNDLE_CHANNELS.export),
    preview: () => ipcRenderer.invoke(BUNDLE_CHANNELS.preview),
    apply: (input) => ipcRenderer.invoke(BUNDLE_CHANNELS.apply, input),
  },
  fresh: {
    run: (confirm) => ipcRenderer.invoke(START_FRESH_CHANNELS.run, confirm),
    restart: () => ipcRenderer.invoke(START_FRESH_CHANNELS.restart),
  },
  dock: {
    getState: () => ipcRenderer.invoke(DOCK_CHANNELS.getState),
    onState: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, state: DockState) => listener(state);
      ipcRenderer.on(DOCK_CHANNELS.state, handler);
      return () => ipcRenderer.removeListener(DOCK_CHANNELS.state, handler);
    },
    expand: (botId) => ipcRenderer.invoke(DOCK_CHANNELS.expand, botId),
    openChat: (botId) => ipcRenderer.invoke(DOCK_CHANNELS.openChat, botId),
    onShowChat: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, botId: string) => listener(botId);
      ipcRenderer.on(DOCK_CHANNELS.showChat, handler);
      return () => ipcRenderer.removeListener(DOCK_CHANNELS.showChat, handler);
    },
  },
  documents: {
    list: (projectId) => ipcRenderer.invoke(IPC_CHANNELS.documentsList, projectId),
    open: (input) => ipcRenderer.invoke(IPC_CHANNELS.documentsOpen, input),
    stat: (input) => ipcRenderer.invoke(IPC_CHANNELS.documentsStat, input),
    save: (input) => ipcRenderer.invoke(IPC_CHANNELS.documentsSave, input),
    create: (input) => ipcRenderer.invoke(IPC_CHANNELS.documentsCreate, input),
    addComment: (input) => ipcRenderer.invoke(IPC_CHANNELS.documentsAddComment, input),
    updateComment: (input) => ipcRenderer.invoke(IPC_CHANNELS.documentsUpdateComment, input),
    deleteComment: (input) => ipcRenderer.invoke(IPC_CHANNELS.documentsDeleteComment, input),
    sendComments: (input) => ipcRenderer.invoke(IPC_CHANNELS.documentsSendComments, input),
    startReview: (input) => ipcRenderer.invoke(IPC_CHANNELS.documentsStartReview, input),
    setBaseline: (input) => ipcRenderer.invoke(IPC_CHANNELS.documentsSetBaseline, input),
    endReview: (input) => ipcRenderer.invoke(IPC_CHANNELS.documentsEndReview, input),
    history: (input) => ipcRenderer.invoke(IPC_CHANNELS.documentsHistory, input),
    versionText: (input) => ipcRenderer.invoke(IPC_CHANNELS.documentsVersionText, input),
    restore: (input) => ipcRenderer.invoke(IPC_CHANNELS.documentsRestore, input),
    commit: (input) => ipcRenderer.invoke(IPC_CHANNELS.documentsCommit, input),
    push: (projectId) => ipcRenderer.invoke(IPC_CHANNELS.documentsPush, projectId),
    artifactVersions: (artifactId) => ipcRenderer.invoke(IPC_CHANNELS.artifactVersions, artifactId),
    artifactText: (input) => ipcRenderer.invoke(IPC_CHANNELS.artifactText, input),
    saveArtifact: (input) => ipcRenderer.invoke(IPC_CHANNELS.artifactSave, input),
  },
  views: {
    getMap: () => ipcRenderer.invoke(IPC_CHANNELS.viewGetMap),
    setGrants: (viewId, permissions) =>
      ipcRenderer.invoke(IPC_CHANNELS.viewSetGrants, { viewId, permissions }),
    turnOn: (viewId) => ipcRenderer.invoke(IPC_CHANNELS.viewTurnOn, viewId),
    prepare: (viewId) => ipcRenderer.invoke(IPC_CHANNELS.viewPrepare, viewId),
    connect: (input) => ipcRenderer.invoke(IPC_CHANNELS.viewConnect, input),
    post: (sessionId, message) => ipcRenderer.send(IPC_CHANNELS.viewPost, sessionId, message),
    update: (input) => ipcRenderer.send(IPC_CHANNELS.viewUpdate, input),
    close: (sessionId) => ipcRenderer.send(IPC_CHANNELS.viewClose, sessionId),
    shortcut: (sessionId, shortcutId) =>
      ipcRenderer.send(IPC_CHANNELS.viewShortcut, sessionId, shortcutId),
    onEvent: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: ViewHostEvent) =>
        listener(payload);
      ipcRenderer.on(IPC_CHANNELS.viewEvent, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.viewEvent, handler);
    },
  },
};

contextBridge.exposeInMainWorld("openbot", openbotApi);
