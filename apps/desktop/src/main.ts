import { mkdirSync, readFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Logger, Redactor } from "@zoltbot/daemon/logging";
import { Supervisor } from "@zoltbot/daemon/supervisor";
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  net,
  protocol,
  session,
  shell,
  systemPreferences,
  Tray,
} from "electron";
import WebSocket from "ws";
import { artifactKitAsset } from "../../../packages/artifact-kit/src/index.js";
import { keychainProcess } from "../../../packages/daemon/src/keychain-process.js";
import { KeychainSecrets } from "../../../packages/daemon/src/secrets.js";
import { artifactProtocol } from "./artifact-protocol.js";
import { cloudAccount } from "./cloud-account.js";
import { createDictationController, type DictationStartOptions } from "./dictation.js";
import { folderPicker } from "./folder-picker.js";
import { frameRequestAllowed } from "./frame-isolation.js";
import { hostedOrigins } from "./hosted-origins.js";
import { answerNotification } from "./notification-answer.js";
import { desktopNotifications } from "./notifications.js";
import { desktopViewProtocol } from "./view-protocol.js";

const startupAt = performance.now();
// A packaged app carries its files flat in the app folder (scripts/package-desktop.mjs);
// development and tests read them from this checkout.
const packaged = app.isPackaged && !process.env.ZOLTBOT_REPO_ROOT;
const root = process.env.ZOLTBOT_REPO_ROOT ?? (packaged ? app.getAppPath() : process.cwd());
const file = (development: string, bundled: string) =>
  path.join(root, packaged ? bundled : development);
const hosted = hostedOrigins(
  process.env,
  packaged ? readFileSync(path.join(root, "package.json"), "utf8") : undefined,
);
const appIcon = nativeImage.createFromPath(file("apps/desktop/assets/zoltbot.png", "zoltbot.png"));
const dataDir =
  process.env.ZOLTBOT_DATA_DIR ??
  (packaged
    ? path.join(homedir(), "Library/Application Support/Zoltbot")
    : path.join(root, ".cache/desktop-data"));
const desktopData = path.join(dataDir, "desktop");
mkdirSync(desktopData, { recursive: true, mode: 0o700 });
app.setPath("userData", desktopData);
app.setPath("sessionData", desktopData);
app.setPath("logs", path.join(desktopData, "logs"));
app.setPath("crashDumps", path.join(desktopData, "crash-dumps"));
app.setName("Zoltbot");
const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) app.quit();
let window: BrowserWindow | undefined;
let tray: Tray | undefined;
let quitting = false;
let badgeSocket: WebSocket | undefined;
let notifications: ReturnType<typeof desktopNotifications> | undefined;
let visibleThreadId: string | undefined;
let currentPid: number | undefined;
let attachedPid: number | undefined;
const redactor = new Redactor();
const logger = new Logger(path.join(dataDir, "desktop.log"), redactor);
const startupStage = (stage: string) =>
  logger.write("info", "Desktop startup", {
    stage,
    elapsedMs: performance.now() - startupAt,
    atMs: Date.now(),
  });
startupStage("main_loaded");
// The packaged UI is served from the app folder on zoltbot://desktop, the origin the daemon
// accepts by default. Node reports no origin for custom schemes, so it is spelled out.
const uiUrl =
  process.env.ZOLTBOT_UI_URL ?? (packaged ? "zoltbot://desktop/" : "http://127.0.0.1:5173");
const uiOrigin = uiUrl.startsWith("zoltbot://desktop/")
  ? "zoltbot://desktop"
  : new URL(uiUrl).origin;
if (
  uiOrigin !== "zoltbot://desktop" &&
  !["127.0.0.1", "localhost"].includes(new URL(uiUrl).hostname)
)
  throw new Error("UI must be served from loopback");
protocol.registerSchemesAsPrivileged(
  ["zoltbot", "zoltbot-artifact", "zoltbot-view"].map((scheme) => ({
    scheme,
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
  })),
);
app.commandLine.appendSwitch("site-per-process");
const entry =
  process.env.ZOLTBOT_E2E === "1" && process.env.ZOLTBOT_TEST_DAEMON_ENTRY
    ? process.env.ZOLTBOT_TEST_DAEMON_ENTRY
    : file(".cache/desktop/daemon.mjs", "daemon.mjs");
const daemon = new Supervisor(
  {
    command: process.env.ZOLTBOT_NODE_BINARY ?? (packaged ? file("", "bin/node") : "node"),
    args: [entry],
    surviveParentExit: true,
    cwd: packaged ? dataDir : root,
    env: {
      ZOLTBOT_DATA_DIR: dataDir,
      ZOLTBOT_UI_ORIGIN: uiOrigin,
      ...(!packaged && process.env.ZOLTBOT_GOOGLE_TEST_MODE === "1"
        ? { ZOLTBOT_GOOGLE_TEST_MODE: "1" }
        : {}),
      ...(packaged ? { ZOLTBOT_KEYCHAIN_HELPER: file("", "bin/zoltbot-keychain") } : {}),
      ...(hosted.broker ? { ZOLTBOT_BROKER_ORIGIN: hosted.broker } : {}),
      ...(hosted.relay ? { ZOLTBOT_RELAY_URL: hosted.relay } : {}),
      TSX_DISABLE_CACHE: "1",
      TMPDIR: desktopData,
    },
    frameFile: path.join(dataDir, "supervisor-frames.jsonl"),
  },
  logger,
);
const connection = () =>
  JSON.parse(readFileSync(path.join(dataDir, "daemon.json"), "utf8")) as {
    url: string;
    token: string;
    pid: number;
  };

const artifactServer = artifactProtocol({
  origin: uiOrigin,
  kitAsset: (name) => artifactKitAsset(root, name),
  async asset(kind, hash, mime) {
    const info = connection();
    const url = new URL(info.url.replace(/^ws:/, "http:"));
    if (url.hostname !== "127.0.0.1") throw Error("invalid_daemon_address");
    url.pathname = `/artifact-${kind}/${hash}`;
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${info.token}`,
        ...(mime ? { "X-Zoltbot-Artifact-Mime": mime } : {}),
      },
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok || Number(response.headers.get("content-length")) > 25 * 1024 * 1024)
      throw Error("artifact_unavailable");
    return new Uint8Array(await response.arrayBuffer());
  },
});
const viewServer = desktopViewProtocol(uiOrigin, root, connection);
function showWindow(hash = "") {
  if (!window || window.isDestroyed()) {
    window = new BrowserWindow({
      width: 1320,
      height: 900,
      minWidth: 900,
      minHeight: 600,
      title: "Zoltbot",
      icon: appIcon,
      backgroundColor: "#F5F6FD",
      // macOS: the app header doubles as the title bar, with the traffic lights inset into it.
      ...(process.platform === "darwin"
        ? { titleBarStyle: "hiddenInset" as const, trafficLightPosition: { x: 16, y: 24 } }
        : {}),
      show: false,
      webPreferences: {
        preload: file(".cache/desktop/preload.cjs", "preload.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", (event, url) => {
      if (!url.startsWith(`${uiOrigin}/`)) event.preventDefault();
    });
    window.webContents.on("will-frame-navigate", (event) => {
      if (
        !frameRequestAllowed(
          event.initiator?.url,
          event.url,
          event.isMainFrame ? "mainFrame" : "subFrame",
        )
      )
        event.preventDefault();
    });
    window.webContents.on("render-process-gone", () => {
      dictation.cancel();
      if (quitting) return;
      const crashed = window;
      window = undefined;
      crashed?.destroy();
      showWindow();
    });
    window.on("focus", () => notifications?.tick());
    window.on("blur", () => notifications?.tick());
    window.webContents.once("dom-ready", () => startupStage("dom_ready"));
    window.once("ready-to-show", () => {
      startupStage("window_ready");
      window?.show();
    });
    void window.loadURL(`${uiUrl}${hash}`);
  } else {
    if (hash) void window.loadURL(`${uiUrl}${hash}`);
    window.show();
    window.focus();
  }
}
function setBadge(count: number) {
  app.dock?.setBadge(count ? String(count) : "");
  tray?.setTitle(count ? `Z ${count}` : "Z");
  tray?.setToolTip(count ? `Zoltbot: ${count} need you` : "Zoltbot");
  tray?.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Open Zoltbot", click: () => showWindow() },
      { label: `Needs you (${count})`, click: () => showWindow("#inbox") },
      { type: "separator" },
      { label: "Quit Zoltbot", click: () => app.quit() },
    ]),
  );
}
function connectBadge(info: { url: string; token: string }) {
  badgeSocket?.close();
  notifications?.close();
  notifications = desktopNotifications({
    focusedThread: () => (window?.isFocused() ? visibleThreadId : undefined),
    open: () => showWindow("#inbox"),
    failed: () => logger.write("warn", "Desktop notification unavailable"),
    answer: (id, version, choice) => answerNotification(info, { id, version }, choice),
  });
  const socket = new WebSocket(info.url);
  badgeSocket = socket;
  redactor.register(info.token);
  const pending = new Set<string>();
  let appliedSeq = 0;
  socket.on("open", () =>
    socket.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "hello",
        params: { protocolVersion: 1, token: info.token },
      }),
    ),
  );
  socket.on("error", () => {});
  socket.on("message", (data) => {
    if (socket !== badgeSocket) return;
    try {
      const message = JSON.parse(data.toString());
      if (message.id === 1) {
        socket.send(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "snapshot.get", params: {} }));
      }
      if (message.id === 2) {
        appliedSeq = message.result.seq;
        notifications?.snapshot(message.result?.entities ?? {});
        pending.clear();
        for (const i of message.result?.entities?.interaction ?? [])
          if (i.state === "pending") pending.add(i.id);
        setBadge(pending.size);
        socket.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 3,
            method: "events.subscribe",
            params: { fromSeq: message.result.seq },
          }),
        );
      }
      const applyBadgeEvent = (event: {
        seq: number;
        aggregateType: string;
        payload: Record<string, unknown>;
      }) => {
        if (!Number.isSafeInteger(event.seq) || event.seq <= appliedSeq) return;
        appliedSeq = event.seq;
        notifications?.event(event.aggregateType, event.payload);
        if (event.aggregateType !== "interaction") return;
        const i = event.payload;
        if (i.state === "pending") pending.add(String(i.id));
        else pending.delete(String(i.id));
        setBadge(pending.size);
      };
      if (message.id === 3) {
        if (message.result?.resync)
          socket.send(
            JSON.stringify({ jsonrpc: "2.0", id: 2, method: "snapshot.get", params: {} }),
          );
        else for (const event of message.result?.events ?? []) applyBadgeEvent(event);
      }
      if (message.method === "event") applyBadgeEvent(message.params);
    } catch {
      logger.write("warn", "Invalid badge event");
    }
  });
}
const speechHelperPath =
  process.env.ZOLTBOT_SPEECH_HELPER ?? file(".cache/native/zoltbot-speech", "bin/zoltbot-speech");
const speechIsScript = /\.[cm]?js$/.test(speechHelperPath);
const dictation = createDictationController({
  command: speechIsScript
    ? (process.env.ZOLTBOT_NODE_BINARY ?? process.execPath)
    : speechHelperPath,
  ...(speechIsScript ? { args: [speechHelperPath] } : {}),
  cwd: packaged ? dataDir : root,
  microphoneStatus: () => {
    if (process.env.ZOLTBOT_SPEECH_HELPER) return "not_determined";
    try {
      const raw = systemPreferences.getMediaAccessStatus?.("microphone") ?? "not-determined";
      if (raw === "granted") return "authorized";
      if (raw === "denied") return "denied";
      if (raw === "restricted") return "restricted";
      return "not_determined";
    } catch {
      return "not_determined";
    }
  },
  requestMicrophoneAccess: async () => {
    if (process.env.ZOLTBOT_SPEECH_HELPER) return true;
    try {
      return (await systemPreferences.askForMediaAccess?.("microphone")) ?? false;
    } catch {
      return false;
    }
  },
  onEvent: (payload) => {
    if (window && !window.isDestroyed()) window.webContents.send("zolt:dictation-event", payload);
  },
});
function verifyMainFrame(event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent) {
  if (
    !window ||
    event.sender !== window.webContents ||
    event.senderFrame !== window.webContents.mainFrame
  )
    throw new Error("unauthorized_renderer");
}
const account = cloudAccount({
  ...(hosted.cloud ? { origin: hosted.cloud } : {}),
  referenceFile: path.join(desktopData, "account-keychain-reference"),
  secrets: new KeychainSecrets(
    keychainProcess({
      command:
        process.env.ZOLTBOT_KEYCHAIN_HELPER ??
        file(".cache/native/zoltbot-keychain", "bin/zoltbot-keychain"),
      cwd: root,
    }),
  ),
  openBrowser: (url) => shell.openExternal(url),
  deviceName: hostname(),
  writeClipboard: (text) => clipboard.writeText(text),
  readArtifact: async (kind, hash) => {
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error("invalid_artifact_hash");
    const info = connection();
    const url = new URL(info.url.replace(/^ws:/, "http:"));
    url.pathname = `/artifact-${kind}/${hash}`;
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${info.token}` },
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok || Number(response.headers.get("content-length")) > 26214400)
      throw new Error("artifact_unavailable");
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > 26214400) throw new Error("artifact_too_large");
    return bytes;
  },
});
for (const action of ["status", "signIn", "signOut", "cancel", "revokeAll", "export"] as const) {
  ipcMain.handle(`zolt:account-${action}`, (event) => {
    verifyMainFrame(event);
    return account[action]();
  });
}
ipcMain.handle("zolt:account-revoke", (event, id: unknown) => {
  verifyMainFrame(event);
  if (typeof id !== "string") throw new Error("invalid_session_id");
  return account.revoke(id);
});
ipcMain.handle("zolt:account-upload-artifact", (event, input: unknown) => {
  verifyMainFrame(event);
  if (!input || typeof input !== "object") throw new Error("invalid_upload");
  const value = input as Record<string, unknown>;
  if (
    typeof value.hash !== "string" ||
    typeof value.title !== "string" ||
    typeof value.orgId !== "string" ||
    value.confirm !== true
  )
    throw new Error("invalid_upload");
  return account.uploadArtifact(value.hash, value.title, value.orgId, true);
});
ipcMain.handle("zolt:account-find-artifact", (event, hash: unknown, title: unknown) => {
  verifyMainFrame(event);
  if (typeof hash !== "string" || typeof title !== "string") throw new Error("invalid_artifact");
  return account.findArtifact(hash, title);
});
ipcMain.handle("zolt:account-copy-artifact-link", (event, id: unknown) => {
  verifyMainFrame(event);
  if (typeof id !== "string") throw new Error("invalid_artifact_id");
  return account.copyArtifactLink(id);
});
ipcMain.handle("zolt:account-artifact-visibility", (event, input: unknown) => {
  verifyMainFrame(event);
  const value = input as Record<string, unknown> | null;
  if (
    !value ||
    typeof value.id !== "string" ||
    typeof value.hash !== "string" ||
    typeof value.title !== "string" ||
    value.confirm !== true ||
    (value.visibility !== "private" && value.visibility !== "public")
  )
    throw new Error("invalid_artifact_visibility");
  return account.setArtifactVisibility({
    id: value.id,
    hash: value.hash,
    title: value.title,
    visibility: value.visibility,
    confirm: true,
  });
});
ipcMain.handle("zolt:dictation-status", async (event, params: unknown) => {
  verifyMainFrame(event);
  const locale =
    params && typeof params === "object" ? (params as { locale?: unknown }).locale : undefined;
  return dictation.status({ locale });
});
ipcMain.handle("zolt:dictation-request-permission", async (event, params: unknown) => {
  verifyMainFrame(event);
  const locale =
    params && typeof params === "object" ? (params as { locale?: unknown }).locale : undefined;
  return dictation.requestPermission({ locale });
});
ipcMain.handle("zolt:dictation-start", async (event, options: unknown) => {
  verifyMainFrame(event);
  return dictation.start(
    options && typeof options === "object" ? (options as DictationStartOptions) : undefined,
  );
});
ipcMain.on("zolt:dictation-audio", (event, sessionId: unknown, pcm16le: unknown) => {
  try {
    verifyMainFrame(event);
    if (typeof sessionId !== "string" || !(pcm16le instanceof Uint8Array)) return;
    dictation.writeAudio(sessionId, pcm16le);
  } catch {}
});
ipcMain.handle("zolt:dictation-stop", async (event, sessionId: unknown) => {
  verifyMainFrame(event);
  if (typeof sessionId !== "string") return;
  await dictation.stop(sessionId);
});
ipcMain.handle("zolt:dictation-cancel", async (event, sessionId: unknown) => {
  verifyMainFrame(event);
  dictation.cancel(typeof sessionId === "string" ? sessionId : undefined);
});
const pickFolders = folderPicker(async () => {
  if (!window || window.isDestroyed()) throw new Error("window_unavailable");
  return dialog.showOpenDialog(window, {
    title: "Choose code folders",
    buttonLabel: "Choose folders",
    properties: ["openDirectory", "multiSelections"],
  });
});
ipcMain.handle("zolt:pick-folders", async (event) => {
  if (
    !window ||
    event.sender !== window.webContents ||
    event.senderFrame !== window.webContents.mainFrame
  )
    throw new Error("unauthorized_renderer");
  return pickFolders();
});
ipcMain.on("zolt:visible-thread", (event, id: unknown) => {
  try {
    verifyMainFrame(event);
  } catch {
    return;
  }
  if (id !== undefined && (typeof id !== "string" || id.length > 200)) return;
  visibleThreadId = id as string | undefined;
  notifications?.tick();
});
ipcMain.handle("zolt:open-external", async (event, value: unknown) => {
  verifyMainFrame(event);
  if (typeof value !== "string" || value.length > 4000) throw new Error("invalid_link");
  const url = new URL(value);
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password)
    throw new Error("invalid_link");
  await shell.openExternal(url.toString());
});
ipcMain.handle("zolt:browser-evidence", async (event, id: unknown) => {
  if (
    !window ||
    event.sender !== window.webContents ||
    event.senderFrame !== window.webContents.mainFrame
  )
    throw new Error("unauthorized_renderer");
  if (typeof id !== "string" || !/^[a-f0-9]{64}$/.test(id)) throw new Error("invalid_evidence_id");
  const info = connection();
  const url = new URL(info.url.replace(/^ws:/, "http:"));
  url.pathname = `/browser-evidence/${id}`;
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${info.token}` },
    signal: AbortSignal.timeout(10000),
  });
  if (
    !response.ok ||
    response.headers.get("content-type") !== "image/png" ||
    Number(response.headers.get("content-length")) > 8 * 1024 * 1024
  )
    throw new Error("evidence_unavailable");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > 8 * 1024 * 1024) throw new Error("evidence_too_large");
  return bytes;
});
ipcMain.handle("zolt:view-prepare", (event, hash: unknown) => {
  verifyMainFrame(event);
  if (typeof hash !== "string") throw Error("invalid_view_hash");
  return viewServer.prepare(hash);
});
ipcMain.handle("zolt:artifact-prepare", async (event, hash: unknown) => {
  verifyMainFrame(event);
  if (typeof hash !== "string") throw Error("invalid_artifact_hash");
  return artifactServer.prepare(hash);
});
ipcMain.handle("zolt:connection", (event) => {
  verifyMainFrame(event);
  const info = connection();
  return { url: info.url, token: info.token };
});

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
async function findExistingDaemon(): Promise<number | undefined> {
  try {
    const info = connection();
    if (!alive(info.pid) || new URL(info.url).hostname !== "127.0.0.1") return undefined;
    return await new Promise<number | undefined>((resolve) => {
      const socket = new WebSocket(info.url);
      const timer = setTimeout(() => {
        socket.terminate();
        resolve(undefined);
      }, 1000);
      socket.on("open", () =>
        socket.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "hello",
            params: { protocolVersion: 1, token: info.token },
          }),
        ),
      );
      socket.once("message", (data) => {
        clearTimeout(timer);
        socket.close();
        try {
          resolve(JSON.parse(data.toString()).result ? info.pid : undefined);
        } catch {
          resolve(undefined);
        }
      });
      socket.once("error", () => {
        clearTimeout(timer);
        resolve(undefined);
      });
    });
  } catch {
    return undefined;
  }
}
async function stopDaemon() {
  logger.write("info", "Daemon shutdown started", { attached: Boolean(attachedPid) });
  if (attachedPid) {
    const pid = attachedPid;
    attachedPid = undefined;
    try {
      process.kill(-pid, "SIGTERM");
    } catch {}
    for (let i = 0; i < 30 && alive(pid); i++)
      await new Promise((resolve) => setTimeout(resolve, 100));
    if (alive(pid))
      try {
        process.kill(-pid, "SIGKILL");
      } catch {}
  }
  await daemon.close();
  logger.write("info", "Daemon shutdown completed");
}
/** Serve the built UI on zoltbot://desktop, refusing paths outside its folder. */
function serveUi(directory: string) {
  protocol.handle("zoltbot", (request) => {
    const url = new URL(request.url);
    const target = path.join(
      directory,
      decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname),
    );
    if (url.host !== "desktop" || !target.startsWith(`${directory}${path.sep}`))
      return new Response(null, { status: 404 });
    return net.fetch(pathToFileURL(target).href);
  });
}
async function main() {
  if (!singleInstance) return;
  await app.whenReady();
  session.defaultSession.protocol.handle("zoltbot-artifact", (request) =>
    artifactServer.handle(request),
  );
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
  if (uiOrigin === "zoltbot://desktop") serveUi(file("dist/ui", "ui"));
  app.dock?.setIcon(appIcon);
  startupStage("app_ready");
  tray = new Tray(nativeImage.createEmpty());
  tray.on("click", () => showWindow());
  setBadge(0);
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { label: "Zoltbot", submenu: [{ role: "about" }, { type: "separator" }, { role: "quit" }] },
      { role: "editMenu" },
      { role: "viewMenu" },
      { role: "windowMenu" },
    ]),
  );
  if (app.isPackaged) app.setAsDefaultProtocolClient("zoltbot");
  app.on("open-url", (event, url) => {
    event.preventDefault();
    try {
      const target = new URL(url);
      if (target.protocol === "zoltbot:") showWindow(`#${target.hostname}`);
    } catch {}
  });
  app.on("activate", () => showWindow());
  app.on("second-instance", () => showWindow());
  app.on("window-all-closed", () => {});
  attachedPid = await findExistingDaemon();
  if (!attachedPid) daemon.start();
  startupStage("daemon_started_or_attached");
  showWindow();
  const poll = setInterval(() => {
    try {
      if (attachedPid && !alive(attachedPid)) {
        attachedPid = undefined;
        currentPid = undefined;
        daemon.start();
      }
      const info = connection();
      if (info.pid !== (daemon.pid ?? attachedPid) || info.pid === currentPid) return;
      currentPid = info.pid;
      startupStage("connection_available");
      connectBadge(info);
      window?.webContents.send("zolt:connection-changed");
    } catch {}
  }, 100);
  daemon.on("exit", () => {
    currentPid = undefined;
    window?.webContents.send("zolt:connection-changed");
  });
  app.on("will-quit", () => logger.write("info", "Desktop will quit"));
  app.on("quit", () => logger.write("info", "Desktop quit"));
  app.on("before-quit", (event) => {
    if (quitting) return;
    event.preventDefault();
    quitting = true;
    logger.write("info", "Desktop shutdown started");
    clearInterval(poll);
    account.close();
    dictation.cancel();
    // No close handshake can complete once the daemon is stopped. Terminate the
    // read-only badge subscription so ws's close timer cannot delay desktop exit.
    badgeSocket?.terminate();
    badgeSocket = undefined;
    notifications?.close();
    void stopDaemon().finally(() => {
      logger.write("info", "Desktop quit requested");
      app.quit();
    });
  });
}
void main().catch(() => app.quit());
