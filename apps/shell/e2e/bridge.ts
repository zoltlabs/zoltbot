import { mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";
import { IPC_CHANNELS } from "../src/shared/ipc";
import { agentHandlers, type Handler } from "../src/zolt/agent-handlers";
import type { ZoltService } from "../src/zolt/zolt-service";

export const SHELL_ORIGIN = "http://shell.test";
const RENDERER = fileURLToPath(new URL("../out/renderer", import.meta.url));
const TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
};

/** Main-process handlers the headless page calls, built from the same table Electron main uses. */
export function shellHandlers(service: ZoltService): Record<string, Handler> {
  const update = {
    phase: "unsupported",
    currentVersion: "0.0.0",
    availableVersion: null,
    progress: null,
    checkedAt: null,
    message: null,
  };
  return {
    ...agentHandlers(service),
    [IPC_CHANNELS.getAppInfo]: () => ({ name: "Zoltbot", version: "0.0.0", platform: "darwin" }),
    [IPC_CHANNELS.getSetupState]: () => ({ completed: true, preferredProvider: "fake" }),
    [IPC_CHANNELS.saveSetup]: (input) => ({ completed: true, ...(input as object) }),
    [IPC_CHANNELS.getMacPermissions]: () => ({
      screenRecording: "granted",
      accessibility: "granted",
    }),
    [IPC_CHANNELS.updateGetStatus]: () => update,
    [IPC_CHANNELS.updateCheck]: () => update,
    [IPC_CHANNELS.browserListTabs]: () => [],
    [IPC_CHANNELS.browserGetControlState]: () => ({ sessions: [] }),
    [IPC_CHANNELS.browserSetVisible]: () => undefined,
    [IPC_CHANNELS.agentChooseAttachments]: () => [],
    [IPC_CHANNELS.agentCreateProject]: () =>
      service.createProject(mkdtempSync(join(tmpdir(), "launch-"))),
  };
}

/**
 * Loads the built renderer in a headless page and gives it the same `window.openbot` API the
 * preload script exposes, with each call routed to `handlers` and service events pushed back.
 */
export async function openShell(page: Page, service: ZoltService): Promise<void> {
  const handlers = shellHandlers(service);
  await page.route(`${SHELL_ORIGIN}/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    const file = normalize(join(RENDERER, path === "/" ? "index.html" : path));
    if (!file.startsWith(RENDERER)) return route.fulfill({ status: 404 });
    try {
      const body = await readFile(file);
      await route.fulfill({
        body,
        contentType: TYPES[extname(file)] ?? "application/octet-stream",
      });
    } catch {
      await route.fulfill({ status: 404 });
    }
  });
  await page.exposeFunction("__zoltInvoke", async (channel: string, input: unknown) => {
    const handler = handlers[channel];
    if (!handler) throw new Error(`No handler for ${channel}`);
    return JSON.parse(JSON.stringify((await handler(input)) ?? null));
  });
  service.on("event", (event) => {
    void page
      .evaluate((payload) => (window as unknown as ZoltWindow).__zoltEmit(payload), event)
      .catch(() => undefined);
  });
  await page.addInitScript((channels) => {
    const listeners = new Set<(event: unknown) => void>();
    const call =
      (channel: string) =>
      (input?: unknown): Promise<unknown> =>
        (window as unknown as ZoltWindow).__zoltInvoke(channel, input);
    const target = window as unknown as ZoltWindow & { openbot: unknown };
    target.__zoltEmit = (event) => {
      for (const listener of listeners) listener(event);
    };
    target.openbot = {
      getAppInfo: call(channels.getAppInfo),
      getSetupState: call(channels.getSetupState),
      saveSetup: call(channels.saveSetup),
      getMacPermissions: call(channels.getMacPermissions),
      requestMacPermission: call(channels.requestMacPermission),
      openExternal: async () => undefined,
      openUrl: async () => undefined,
      setVisibleBot: () => undefined,
      agent: {
        getStatus: call(channels.agentGetStatus),
        getUsage: call(channels.agentGetUsage),
        listModels: call(channels.agentListModels),
        listBots: call(channels.agentListBots),
        createBot: call(channels.agentCreateBot),
        createProject: call(channels.agentCreateProject),
        updateBot: call(channels.agentUpdateBot),
        deleteBot: call(channels.agentDeleteBot),
        readConversation: call(channels.agentReadConversation),
        chooseAttachments: call(channels.agentChooseAttachments),
        onAttachmentImport: () => () => undefined,
        discardDraftAttachment: call(channels.agentDiscardDraftAttachment),
        openAttachment: call(channels.agentOpenAttachment),
        sendMessage: call(channels.agentSendMessage),
        setMessageReaction: call(channels.agentSetMessageReaction),
        listQueue: call(channels.agentListQueue),
        cancelQueuedMessage: call(channels.agentCancelQueuedMessage),
        setQueuePaused: call(channels.agentSetQueuePaused),
        interrupt: call(channels.agentInterrupt),
        respondToPrompt: call(channels.agentRespondToPrompt),
        onEvent: (listener: (event: unknown) => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
      browser: {
        open: call(channels.browserOpen),
        activate: call(channels.browserActivate),
        close: call(channels.browserClose),
        listTabs: call(channels.browserListTabs),
        getControlState: call(channels.browserGetControlState),
        setVisible: call(channels.browserSetVisible),
      },
      update: {
        getStatus: call(channels.updateGetStatus),
        check: call(channels.updateCheck),
        download: call(channels.updateCheck),
        install: async () => undefined,
        onEvent: () => () => undefined,
      },
      maintenance: {
        exportData: async () => ({ saved: false }),
        exportDiagnostics: async () => ({ saved: false }),
      },
      artifacts: {
        prepare: call(channels.artifactPrepare),
      },
    };
  }, IPC_CHANNELS);
  await page.goto(`${SHELL_ORIGIN}/index.html`);
}

interface ZoltWindow {
  __zoltInvoke(channel: string, input: unknown): Promise<unknown>;
  __zoltEmit(event: unknown): void;
}
