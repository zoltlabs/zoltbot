import { readFile, stat, writeFile } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
import {
  app,
  BrowserWindow,
  dialog,
  Menu,
  Notification,
  type OpenDialogOptions,
  protocol,
  session,
  shell,
} from "electron";
import {
  type AgentEvent,
  type AppInfo,
  type AppSetupState,
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
import { ZoltService } from "../zolt/zolt-service";
import { notificationForAgentEvent } from "./agent-notifications";
import { DaemonHost, daemonPaths } from "./daemon-host";
import { readMacPermissions, requestMacPermission } from "./mac-permissions";
import { readSetupState, writeSetupState } from "./setup-store";
import { handleTrusted } from "./trusted-ipc";
import { isTrustedRendererUrl } from "./trusted-renderer";

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
]);

const paths = daemonPaths(app.isPackaged, app.getAppPath());
const daemonHost = new DaemonHost(paths);
const client = new DaemonClient(daemonHost.connection);
const service = new ZoltService(client, join(paths.dataDir, "shell"));
let mainWindow: BrowserWindow | null = null;
let isQuitting = false;
let shutdownStarted = false;

const SETUP_FILE = "zoltbot-shell-setup-v1.json";

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
    "frame-src 'self' openbot-attachment:",
    "base-uri 'none'",
  ].join("; ");
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
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

  for (const [channel, handler] of Object.entries(agentHandlers(service)))
    handleTrusted(channel, handler);
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
    backgroundColor: "#0b0d0e",
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
  window.once("ready-to-show", () => window.show());
  window.on("close", (event) => {
    if (process.platform === "darwin" && !isQuitting) {
      event.preventDefault();
      window.hide();
    }
  });
  window.on("closed", () => {
    if (mainWindow === window) mainWindow = null;
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
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
      mainWindow = createWindow();
      service.on("event", forwardAgentEvent);
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
  void service
    .stop()
    .then(() => daemonHost.stop())
    .finally(() => app.quit());
});
