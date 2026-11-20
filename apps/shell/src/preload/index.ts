import { contextBridge, ipcRenderer, webUtils } from "electron";
import {
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
      message: error instanceof Error ? error.message : String(error),
    });
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
  agent: {
    getStatus: () => ipcRenderer.invoke(IPC_CHANNELS.agentGetStatus),
    refreshAgents: () => ipcRenderer.invoke(IPC_CHANNELS.agentRefreshAgents),
    getUsage: () => ipcRenderer.invoke(IPC_CHANNELS.agentGetUsage),
    listModels: () => ipcRenderer.invoke(IPC_CHANNELS.agentListModels),
    listBots: () => ipcRenderer.invoke(IPC_CHANNELS.agentListBots),
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
  },
  memory: {
    list: () => ipcRenderer.invoke(IPC_CHANNELS.memoryList),
    revisions: (id) => ipcRenderer.invoke(IPC_CHANNELS.memoryRevisions, id),
    save: (input) => ipcRenderer.invoke(IPC_CHANNELS.memorySave, input),
    archive: (input) => ipcRenderer.invoke(IPC_CHANNELS.memoryArchive, input),
    decide: (input) => ipcRenderer.invoke(IPC_CHANNELS.memoryDecide, input),
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
