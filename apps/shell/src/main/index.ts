import { readFileSync } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  Notification,
  nativeTheme,
  type OpenDialogOptions,
  protocol,
  session,
  shell,
  systemPreferences,
  type WebContents,
} from "electron";
import {
  type AgentEvent,
  type AppInfo,
  type AppSetupState,
  type DictationAccessStatus,
  type ExportResult,
  IPC_CHANNELS,
} from "../shared/ipc";
import { agentHandlers } from "../zolt/agent-handlers";
import { DaemonClient } from "../zolt/daemon-client";
import {
  isObject,
  parseImportAttachments,
  parseMacPermission,
  parseOpenAttachment,
  requireString,
} from "../zolt/parsers";
import { viewHandlers, viewMessages } from "../zolt/view-handlers";
import { ViewHost } from "../zolt/view-host";
import { ZoltService } from "../zolt/zolt-service";
import { notificationForAgentEvent } from "./agent-notifications";
import { DaemonHost, daemonPaths } from "./daemon-host";
import { accountHandlers } from "./desktop/account-handlers";
import { artifactProtocol, artifactScheme } from "./desktop/artifact-protocol";
import { cloudAccount } from "./desktop/cloud-account";
import { createDictationController, type DictationStartOptions } from "./desktop/dictation";
import { folderPicker } from "./desktop/folder-picker";
import { frameRequestAllowed } from "./desktop/frame-isolation";
import { hostedOrigins } from "./desktop/hosted-origins";
import { desktopKitAsset } from "./desktop/kit-assets";
import { desktopAccountClient } from "./desktop/native-account-client";
import { desktopViewProtocol, viewScheme } from "./desktop/view-protocol";
import { readMacPermissions, requestMacPermission } from "./mac-permissions";
import { readSetupState, writeSetupState } from "./setup-store";
import { handleTrusted } from "./trusted-ipc";
import { isTrustedRendererUrl } from "./trusted-renderer";
import { followWindowTheme, windowBackground } from "./window-theme";
import { connectNotifications } from "./zolt-notifications";

if (!app.isPackaged) app.setPath("userData", join(app.getPath("appData"), "Zoltbot Shell Dev"));
app.setName("Zoltbot");
app.enableSandbox();
const hasSingleInstanceLock = app.requestSingleInstanceLock();
protocol.registerSchemesAsPrivileged([
  { scheme: "openbot-app", privileges: { standard: true, secure: true, supportFetchAPI: true } },
  {
    scheme: "openbot-attachment",
    privileges: { standard: true, secure: true, supportFetchAPI: true },
  },
  {
    scheme: "zoltbot-artifact",
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
  },
  {
    scheme: "zoltbot-view",
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
  },
]);

const paths = daemonPaths(app.isPackaged, app.getAppPath());
// Hosted services are off unless the environment or the packaged manifest names them.
const hosted = hostedOrigins(
  process.env,
  app.isPackaged ? readFileSync(join(paths.root, "package.json"), "utf8") : undefined,
);
const daemonHost = new DaemonHost(paths, {
  ...(hosted.broker ? { ZOLTBOT_BROKER_ORIGIN: hosted.broker } : {}),
  ...(hosted.cloud ? { ZOLTBOT_CLOUD_ORIGIN: hosted.cloud } : {}),
  ...(hosted.relay ? { ZOLTBOT_RELAY_URL: hosted.relay } : {}),
});
const client = new DaemonClient(daemonHost.connection);
const service = new ZoltService(client, join(paths.dataDir, "shell"));
const rendererOrigin = process.env.ELECTRON_RENDERER_URL
  ? new URL(process.env.ELECTRON_RENDERER_URL).origin
  : "openbot-app://app";
const artifacts = artifactProtocol({
  origin: rendererOrigin,
  kitAsset: desktopKitAsset(app.isPackaged, app.getAppPath()),
  async asset(kind, hash, mime) {
    const info = await daemonHost.connection();
    const url = new URL(info.url.replace(/^ws:/, "http:"));
    if (url.hostname !== "127.0.0.1") throw new Error("invalid_daemon_address");
    url.pathname = `/artifact-${kind}/${hash}`;
    url.search = "";
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${info.token}`,
        ...(mime ? { "X-Zoltbot-Artifact-Mime": mime } : {}),
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok || Number(response.headers.get("content-length")) > 25 * 1024 * 1024)
      throw new Error("artifact_unavailable");
    return new Uint8Array(await response.arrayBuffer());
  },
});
const viewServer = desktopViewProtocol(rendererOrigin, paths.root, daemonHost.connection);
let answerConfirmationOpen = false;
const viewHost = new ViewHost({
  client,
  prepare: (hash) => viewServer.prepare(hash),
  send: (event) => {
    if (mainWindow && !mainWindow.isDestroyed())
      mainWindow.webContents.send(IPC_CHANNELS.viewEvent, event);
  },
  // A view never sees this dialog. It runs in main, outside the window the view shares.
  async confirm(request, choice) {
    if (answerConfirmationOpen || !mainWindow || mainWindow.isDestroyed()) return false;
    answerConfirmationOpen = true;
    try {
      const result = await dialog.showMessageBox(mainWindow, {
        type: "question",
        message: request.title,
        detail: [request.context?.command, choice.label].filter(Boolean).join("\n\n"),
        buttons: ["Confirm", "Cancel"],
        defaultId: 1,
        cancelId: 1,
      });
      return result.response === 0;
    } finally {
      answerConfirmationOpen = false;
    }
  },
});
// The daemon owns the account credentials; main only starts sign-in and reads who is signed in.
const account = cloudAccount({
  ...(hosted.cloud
    ? {
        origin: hosted.cloud,
        nativeSession: desktopAccountClient({
          origin: hosted.cloud,
          socketPath: resolve(paths.dataDir, "account-ipc", "broker.sock"),
        }),
      }
    : {}),
  referenceFile: join(paths.dataDir, "shell", "account-keychain-reference"),
  openBrowser: (url) => shell.openExternal(url),
  deviceName: hostname(),
});
let mainWindow: BrowserWindow | null = null;
let visibleBotId: string | undefined;
let isQuitting = false;
let shutdownStarted = false;

const SETUP_FILE = "zoltbot-shell-setup-v1.json";

// The desktop build compiles the speech helper; ZOLTBOT_SPEECH_HELPER points tests at a fake.
const speechHelperPath =
  process.env.ZOLTBOT_SPEECH_HELPER ??
  (app.isPackaged
    ? join(app.getAppPath(), "bin/zoltbot-speech")
    : join(paths.root, ".cache/native/zoltbot-speech"));
const speechIsScript = /\.[cm]?js$/.test(speechHelperPath);
const dictation = createDictationController({
  command: speechIsScript
    ? (process.env.ZOLTBOT_NODE_BINARY ?? process.execPath)
    : speechHelperPath,
  ...(speechIsScript ? { args: [speechHelperPath] } : {}),
  cwd: app.isPackaged ? paths.dataDir : paths.root,
  microphoneStatus: (): DictationAccessStatus => {
    if (process.env.ZOLTBOT_SPEECH_HELPER || process.platform !== "darwin") return "not_determined";
    try {
      const raw = systemPreferences.getMediaAccessStatus("microphone");
      if (raw === "granted") return "authorized";
      if (raw === "denied") return "denied";
      if (raw === "restricted") return "restricted";
      return "not_determined";
    } catch {
      return "not_determined";
    }
  },
  requestMicrophoneAccess: async () => {
    if (process.env.ZOLTBOT_SPEECH_HELPER || process.platform !== "darwin") return true;
    try {
      return await systemPreferences.askForMediaAccess("microphone");
    } catch {
      return false;
    }
  },
  onEvent: (payload) => {
    if (mainWindow && !mainWindow.isDestroyed())
      mainWindow.webContents.send(IPC_CHANNELS.dictationEvent, payload);
  },
});

function localeParam(params: unknown): unknown {
  return isObject(params) ? params.locale : undefined;
}

function isMainFrame(sender: WebContents, frame: Electron.WebFrameMain | null): boolean {
  return (
    !!mainWindow &&
    !mainWindow.isDestroyed() &&
    sender === mainWindow.webContents &&
    frame === mainWindow.webContents.mainFrame &&
    isTrustedRendererUrl(frame?.url)
  );
}

function configureContentSecurityPolicy(): void {
  const developmentSources = app.isPackaged ? "" : " http://localhost:* ws://localhost:*";
  const policy = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: openbot-attachment: https:",
    "font-src 'self' data:",
    `connect-src 'self'${developmentSources}`,
    "object-src 'none'",
    `frame-src 'self' openbot-attachment: ${artifactScheme} zoltbot-view:`,
    "base-uri 'none'",
  ].join("; ");
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    // Artifact responses carry their own sandboxed policy.
    if (details.url.startsWith(artifactScheme)) {
      callback({});
      return;
    }
    // A view's own response carries its stricter policy; the shell's must not replace it.
    if (details.url.startsWith(viewScheme)) {
      callback({ responseHeaders: details.responseHeaders });
      return;
    }
    callback({
      responseHeaders: { ...details.responseHeaders, "Content-Security-Policy": [policy] },
    });
  });
}

function registerIpcHandlers(setupFile: string): void {
  handleTrusted(IPC_CHANNELS.getAppInfo, (): AppInfo => {
    const platform = process.platform;
    if (platform !== "darwin" && platform !== "win32" && platform !== "linux")
      throw new Error(`Unsupported desktop platform: ${platform}`);
    return { name: "Zoltbot", version: app.getVersion(), platform };
  });
  handleTrusted(IPC_CHANNELS.getSetupState, () => readSetupState(setupFile));
  handleTrusted(IPC_CHANNELS.saveSetup, async (input: unknown): Promise<AppSetupState> => {
    if (!isObject(input)) throw new Error("Setup input is required.");
    return writeSetupState(setupFile, requireString(input.preferredProvider, "preferredProvider"));
  });
  handleTrusted(IPC_CHANNELS.getMacPermissions, readMacPermissions);
  handleTrusted(IPC_CHANNELS.requestMacPermission, (permission: unknown) =>
    requestMacPermission(parseMacPermission(permission)),
  );
  handleTrusted(IPC_CHANNELS.openExternal, () => shell.openExternal("https://zoltbot.ai"));
  ipcMain.on(IPC_CHANNELS.setVisibleBot, (event, botId: unknown) => {
    if (!isTrustedRendererUrl(event.senderFrame?.url)) return;
    visibleBotId = typeof botId === "string" && botId ? botId : undefined;
  });
  handleTrusted(IPC_CHANNELS.openUrl, (value: unknown) => {
    const url = new URL(requireString(value, "URL"));
    if (url.protocol !== "http:" && url.protocol !== "https:")
      throw new Error("Only HTTP(S) links can open in the external browser.");
    return shell.openExternal(url.toString());
  });

  const updateStatus = {
    phase: "unsupported" as const,
    currentVersion: app.getVersion(),
    availableVersion: null,
    progress: null,
    checkedAt: null,
    message: null,
  };
  handleTrusted(IPC_CHANNELS.updateGetStatus, () => updateStatus);
  handleTrusted(IPC_CHANNELS.updateCheck, () => updateStatus);
  handleTrusted(IPC_CHANNELS.updateDownload, () => updateStatus);
  handleTrusted(IPC_CHANNELS.updateInstall, () => undefined);
  handleTrusted(IPC_CHANNELS.maintenanceExportData, () => exportDiagnostics());
  handleTrusted(IPC_CHANNELS.maintenanceExportDiagnostics, () => exportDiagnostics());
  handleTrusted(IPC_CHANNELS.artifactPrepare, (hash: unknown) =>
    artifacts.prepare(requireString(hash, "manifestHash")),
  );

  for (const [channel, handler] of Object.entries(agentHandlers(service)))
    handleTrusted(channel, handler);
  for (const [channel, handler] of Object.entries(viewHandlers(viewHost)))
    handleTrusted(channel, handler);
  for (const [channel, handler] of Object.entries(viewMessages(viewHost)))
    ipcMain.on(channel, (event, ...values: unknown[]) => {
      if (!isTrustedRendererUrl(event.senderFrame?.url)) return;
      try {
        handler(...values);
      } catch {
        // A malformed one-way message is dropped; nothing waits for a reply.
      }
    });
  for (const [channel, handler] of Object.entries(accountHandlers(account)))
    handleTrusted(channel, handler);
  const pickProjectFolder = folderPicker(() => {
    const options: OpenDialogOptions = {
      title: "Choose the project folder",
      buttonLabel: "Create project",
      properties: ["openDirectory", "createDirectory"],
    };
    return mainWindow ? dialog.showOpenDialog(mainWindow, options) : dialog.showOpenDialog(options);
  });
  handleTrusted(IPC_CHANNELS.agentCreateProject, async () => {
    const [folder] = await pickProjectFolder();
    return folder ? service.createProject(folder) : null;
  });
  handleTrusted(IPC_CHANNELS.agentChooseAttachments, async () => {
    const options: OpenDialogOptions = { properties: ["openFile", "multiSelections"] };
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options);
    if (result.canceled) return [];
    return Promise.all(
      result.filePaths.map(async (path) => service.addDraft(path, (await stat(path)).size)),
    );
  });
  handleTrusted(IPC_CHANNELS.agentImportAttachments, async (input: unknown) => {
    const parsed = parseImportAttachments(input);
    return [
      ...(await Promise.all(
        parsed.paths.map(async (path) => service.addDraft(path, (await stat(path)).size)),
      )),
      ...(await Promise.all(
        parsed.data.map((item) => service.addDraftBytes(item.name, item.bytes)),
      )),
    ];
  });
  handleTrusted(IPC_CHANNELS.agentOpenAttachment, async (input: unknown) => {
    const parsed = parseOpenAttachment(input);
    const path = service.draftPath(parsed.attachmentId);
    if (!path) throw new Error("Attachment was not found.");
    if (parsed.action === "reveal") {
      shell.showItemInFolder(path);
      return;
    }
    const error = await shell.openPath(path);
    if (error) throw new Error(error);
  });

  handleTrusted(IPC_CHANNELS.dictationStatus, (params: unknown) =>
    dictation.status({ locale: localeParam(params) }),
  );
  handleTrusted(IPC_CHANNELS.dictationRequestPermission, (params: unknown) =>
    dictation.requestPermission({ locale: localeParam(params) }),
  );
  handleTrusted(IPC_CHANNELS.dictationStart, (options: unknown) =>
    dictation.start(isObject(options) ? (options as DictationStartOptions) : undefined),
  );
  ipcMain.on(IPC_CHANNELS.dictationAudio, (event, sessionId: unknown, pcm16le: unknown) => {
    try {
      if (!isMainFrame(event.sender, event.senderFrame)) return;
      if (typeof sessionId !== "string" || !(pcm16le instanceof Uint8Array)) return;
      dictation.writeAudio(sessionId, pcm16le);
    } catch {}
  });
  handleTrusted(IPC_CHANNELS.dictationStop, async (sessionId: unknown) => {
    if (typeof sessionId === "string") await dictation.stop(sessionId);
  });
  handleTrusted(IPC_CHANNELS.dictationCancel, (sessionId: unknown) => {
    dictation.cancel(typeof sessionId === "string" ? sessionId : undefined);
  });

  // Zoltbot agents use their own browser tools; the shell has no embedded browser yet.
  handleTrusted(IPC_CHANNELS.browserOpen, () => {
    throw new Error("The built-in browser isn't available yet.");
  });
  handleTrusted(IPC_CHANNELS.browserActivate, () => undefined);
  handleTrusted(IPC_CHANNELS.browserClose, () => undefined);
  handleTrusted(IPC_CHANNELS.browserListTabs, () => []);
  handleTrusted(IPC_CHANNELS.browserGetControlState, () => ({ sessions: [] }));
  handleTrusted(IPC_CHANNELS.browserSetVisible, () => undefined);
}

async function exportDiagnostics(): Promise<ExportResult> {
  const report = await client.call("diagnostics.export", {});
  const options = {
    defaultPath: `zoltbot-diagnostics-${new Date().toISOString().slice(0, 10)}.json`,
  };
  const result = mainWindow
    ? await dialog.showSaveDialog(mainWindow, options)
    : await dialog.showSaveDialog(options);
  if (result.canceled || !result.filePath) return { saved: false };
  await writeFile(result.filePath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  return { saved: true };
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1200,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    show: false,
    backgroundColor: windowBackground(nativeTheme),
    title: "Zoltbot",
    ...(process.platform === "darwin"
      ? { titleBarStyle: "hidden" as const, trafficLightPosition: { x: 13, y: 14 } }
      : {}),
    webPreferences: {
      preload: join(__dirname, "../preload/index.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });
  const stopFollowingTheme = followWindowTheme(window, nativeTheme);
  window.once("ready-to-show", () => window.show());
  window.on("close", (event) => {
    if (process.platform === "darwin" && !isQuitting) {
      event.preventDefault();
      window.hide();
    }
  });
  window.on("closed", () => {
    stopFollowingTheme();
    if (mainWindow === window) mainWindow = null;
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("render-process-gone", () => dictation.cancel());
  window.webContents.on("will-navigate", (event, targetUrl) => {
    if (!isTrustedRendererUrl(targetUrl)) event.preventDefault();
  });
  return window;
}

function loadRenderer(window: BrowserWindow): Promise<void> {
  const developmentUrl = process.env.ELECTRON_RENDERER_URL;
  return developmentUrl
    ? window.loadURL(developmentUrl)
    : window.loadURL("openbot-app://app/index.html");
}

function configureApplicationMenu(): void {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        role: "appMenu",
        submenu: [
          {
            label: "Stop all agents",
            accelerator: "CommandOrControl+.",
            click: () => void service.interruptAll(),
          },
          { type: "separator" },
          { role: "hide" },
          { role: "hideOthers" },
          { role: "unhide" },
          { type: "separator" },
          { role: "quit" },
        ],
      },
      { role: "editMenu" },
      { role: "viewMenu" },
      { role: "windowMenu" },
    ]),
  );
}

function forwardAgentEvent(event: AgentEvent): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send(IPC_CHANNELS.agentEvent, event);
  if (mainWindow.isFocused() || !Notification.isSupported()) return;
  const content = notificationForAgentEvent(event, service.listBots());
  if (!content) return;
  const notification = new Notification(content);
  notification.on("click", () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
  notification.show();
}

function configureAttachmentProtocol(): void {
  session.defaultSession.protocol.handle("openbot-attachment", async (request) => {
    try {
      const id = new URL(request.url).pathname.split("/").filter(Boolean).at(-1);
      const path = id ? service.draftPath(id) : undefined;
      if (!path) return new Response("Not found", { status: 404 });
      return new Response(await readFile(path), {
        headers: {
          "Content-Type": contentType(path),
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
          "Content-Disposition": "inline",
        },
      });
    } catch {
      return new Response("Not found", { status: 404 });
    }
  });
}

function configureViewProtocol(): void {
  session.defaultSession.protocol.handle("zoltbot-view", (request) => viewServer.handle(request));
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    callback({
      cancel: !frameRequestAllowed(
        details.frame?.url ?? details.referrer,
        details.url,
        details.resourceType,
      ),
    });
  });
}

function configureApplicationProtocol(): void {
  const rendererRoot = resolve(__dirname, "../renderer");
  session.defaultSession.protocol.handle("openbot-app", async (request) => {
    try {
      const url = new URL(request.url);
      if (url.host !== "app") return new Response("Not found", { status: 404 });
      const pathname = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
      const filePath = resolve(rendererRoot, `.${pathname}`);
      const candidate = relative(rendererRoot, filePath);
      if (candidate.startsWith("..") || isAbsolute(candidate))
        return new Response("Not found", { status: 404 });
      return new Response(await readFile(filePath), {
        headers: {
          "Content-Type": contentType(filePath),
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        },
      });
    } catch {
      return new Response("Not found", { status: 404 });
    }
  });
}

function contentType(path: string): string {
  const types: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".pdf": "application/pdf",
    ".woff2": "font/woff2",
  };
  return types[extname(path).toLowerCase()] ?? "application/octet-stream";
}

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  void app
    .whenReady()
    .then(async () => {
      configureContentSecurityPolicy();
      configureApplicationProtocol();
      configureAttachmentProtocol();
      session.defaultSession.protocol.handle("zoltbot-artifact", (request) =>
        artifacts.handle(request),
      );
      configureViewProtocol();
      viewHost.start();
      mainWindow = createWindow();
      service.on("event", forwardAgentEvent);
      const requests = connectNotifications(client, {
        focusedBot: () => (mainWindow?.isFocused() ? visibleBotId : undefined),
        open: () => {
          if (!mainWindow || mainWindow.isDestroyed()) return;
          mainWindow.show();
          mainWindow.focus();
        },
        failed: () => console.warn("A Zoltbot notification couldn't be shown."),
        setBadge: (count) => app.dock?.setBadge(count ? String(count) : ""),
      });
      mainWindow.on("focus", requests.tick);
      mainWindow.on("blur", requests.tick);
      app.on("before-quit", requests.close);
      registerIpcHandlers(join(app.getPath("userData"), SETUP_FILE));
      configureApplicationMenu();
      await loadRenderer(mainWindow);
      await daemonHost.start();
      await service.initialize();
      app.on("activate", () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.show();
          return;
        }
        mainWindow = createWindow();
        void loadRenderer(mainWindow);
      });
    })
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error("Zoltbot failed to start:", error);
      dialog.showErrorBox("Zoltbot couldn’t start", message);
      app.quit();
    });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", (event) => {
  isQuitting = true;
  if (shutdownStarted) return;
  event.preventDefault();
  shutdownStarted = true;
  dictation.cancel();
  viewHost.stop();
  account.close();
  void service
    .stop()
    .then(() => daemonHost.stop())
    .finally(() => app.quit());
});
