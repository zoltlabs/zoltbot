import { mkdtempSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";
import { runAttachmentAction } from "../src/main/attachment-actions";
import { preferenceHandlers } from "../src/main/desktop/preferences-handlers";
import { IPC_CHANNELS } from "../src/shared/ipc";
import { normalizePreferences, parsePreferencesPatch } from "../src/shared/preferences";
import { agentHandlers, type Handler } from "../src/zolt/agent-handlers";
import { parseOpenAttachment } from "../src/zolt/parsers";
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
  // The headless page has no hosted service, so the account reads as not configured.
  const account = {
    configured: false,
    signedIn: false,
    email: null,
    name: null,
    managementUrl: null,
  };
  return {
    ...agentHandlers(service),
    ...preferenceHandlers(memoryPreferences(), () => undefined),
    [IPC_CHANNELS.accountGetStatus]: () => account,
    [IPC_CHANNELS.accountSignIn]: () => account,
    [IPC_CHANNELS.accountSignOut]: () => account,
    [IPC_CHANNELS.accountCancel]: () => undefined,
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
    // The open panel can't run headless; a spec names the files it "picks" with chooseFiles.
    [IPC_CHANNELS.agentChooseAttachments]: async () => {
      const paths = chosen.splice(0);
      return service.addDrafts(
        await Promise.all(paths.map(async (path) => ({ path, size: (await stat(path)).size }))),
      );
    },
    // Main's own attachment actions, with Finder, apps, the save panel and clipboard stubbed.
    [IPC_CHANNELS.agentOpenAttachment]: (input) => {
      const parsed = parseOpenAttachment(input);
      return runAttachmentAction(
        {
          window: () => null,
          showItemInFolder: () => undefined,
          openPath: async () => "",
          showSaveDialog: async () => ({ canceled: true }),
          writeImage: (bytes) => bytes.length > 0,
        },
        parsed,
        service.attachmentSource(parsed.attachmentId),
      );
    },
    // Pasted files, as the preload's paste handler sends them (bytes arrive as a plain array).
    [IPC_CHANNELS.agentImportAttachments]: (input) =>
      Promise.all(
        (input as { data: { name: string; bytes: number[] }[] }).data.map((item) =>
          service.addDraftBytes(item.name, Uint8Array.from(item.bytes)),
        ),
      ),
    [IPC_CHANNELS.agentCreateProject]: () =>
      service.createProject(mkdtempSync(join(tmpdir(), "launch-"))),
  };
}

const chosen: string[] = [];
/** The files the next "Attach a file" picks, as the open panel would return them. */
export function chooseFiles(paths: string[]): void {
  chosen.splice(0, chosen.length, ...paths);
}

/** Serves the built renderer at SHELL_ORIGIN. */
async function serveRenderer(page: Page): Promise<void> {
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
}

/** Opens the test-only kit gallery, which needs no daemon. */
export async function openKitGallery(page: Page): Promise<void> {
  await serveRenderer(page);
  await page.goto(`${SHELL_ORIGIN}/index.html?kit-gallery`);
}

/**
 * Loads the built renderer in a headless page and gives it the same `window.openbot` API the
 * preload script exposes, with each call routed to `handlers` and service events pushed back.
 */
export async function openShell(page: Page, service: ZoltService): Promise<void> {
  const handlers = shellHandlers(service);
  await serveRenderer(page);
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
    // The preload's paste handler: pasted files become draft attachments.
    const imports = new Set<(event: unknown) => void>();
    let pastes = 0;
    window.addEventListener("paste", (event) => {
      const files = [...(event.clipboardData?.files ?? [])];
      if (!files.length) return;
      event.preventDefault();
      const requestId = `e2e-${++pastes}`;
      for (const listener of imports) listener({ type: "started", requestId });
      void (async () => {
        const data = await Promise.all(
          files.map(async (file) => ({
            name: file.name,
            mimeType: file.type,
            bytes: Array.from(new Uint8Array(await file.arrayBuffer())),
          })),
        );
        const attachments = await call(channels.agentImportAttachments)({ paths: [], data });
        for (const listener of imports) listener({ type: "completed", requestId, attachments });
      })();
    });
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
      account: {
        getStatus: call(channels.accountGetStatus),
        signIn: call(channels.accountSignIn),
        signOut: call(channels.accountSignOut),
        cancel: call(channels.accountCancel),
      },
      agent: {
        getStatus: call(channels.agentGetStatus),
        refreshAgents: call(channels.agentRefreshAgents),
        getUsage: call(channels.agentGetUsage),
        listModels: call(channels.agentListModels),
        listBots: call(channels.agentListBots),
        createBot: call(channels.agentCreateBot),
        createProject: call(channels.agentCreateProject),
        updateBot: call(channels.agentUpdateBot),
        deleteBot: call(channels.agentDeleteBot),
        readConversation: call(channels.agentReadConversation),
        readContext: call(channels.agentReadContext),
        compact: call(channels.agentCompact),
        branchPreview: call(channels.agentBranchPreview),
        branch: call(channels.agentBranch),
        threadAction: call(channels.agentThreadAction),
        chooseAttachments: call(channels.agentChooseAttachments),
        onAttachmentImport: (listener: (event: unknown) => void) => {
          imports.add(listener);
          return () => imports.delete(listener);
        },
        discardDraftAttachment: call(channels.agentDiscardDraftAttachment),
        openAttachment: call(channels.agentOpenAttachment),
        sendMessage: call(channels.agentSendMessage),
        setMessageReaction: call(channels.agentSetMessageReaction),
        listQueue: call(channels.agentListQueue),
        cancelQueuedMessage: call(channels.agentCancelQueuedMessage),
        setQueuePaused: call(channels.agentSetQueuePaused),
        interrupt: call(channels.agentInterrupt),
        respondToPrompt: call(channels.agentRespondToPrompt),
        readCompany: call(channels.agentReadCompany),
        decidePlan: call(channels.agentDecidePlan),
        refreshBrief: call(channels.agentRefreshBrief),
        taskAction: call(channels.agentTaskAction),
        listTasks: call(channels.agentListTasks),
        reviewTask: call(channels.agentReviewTask),
        listChannels: call(channels.agentListChannels),
        readChannel: call(channels.agentReadChannel),
        readEarlierPosts: call(channels.agentReadEarlierPosts),
        postChannel: call(channels.agentPostChannel),
        channelRequest: call(channels.agentChannelRequest),
        readStaff: call(channels.agentReadStaff),
        staffAction: call(channels.agentStaffAction),
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
      // Preferences live in memory for the page's lifetime; a change reaches this page's listeners.
      preferences: (() => {
        const changed = new Set<(preferences: unknown) => void>();
        return {
          get: call("preferences:get"),
          set: async (patch: unknown) => {
            const saved = await call("preferences:set")(patch);
            for (const listener of changed) listener(saved);
            return saved;
          },
          onChange: (listener: (preferences: unknown) => void) => {
            changed.add(listener);
            return () => changed.delete(listener);
          },
        };
      })(),
      maintenance: {
        exportData: async () => ({ saved: false }),
        exportDiagnostics: async () => ({ saved: false }),
      },
      // Headless runs have no speech helper, so the composer hides the microphone.
      dictation: {
        status: async () => ({
          available: false,
          onDevice: false,
          locale: "en-US",
          microphone: "not_determined",
          speech: "not_determined",
        }),
        requestPermission: async () => ({
          available: false,
          onDevice: false,
          locale: "en-US",
          microphone: "not_determined",
          speech: "not_determined",
        }),
        start: async () => {
          throw new Error("Dictation isn't available.");
        },
        sendAudio: () => undefined,
        stop: async () => undefined,
        cancel: async () => undefined,
        onEvent: () => () => undefined,
      },
      artifacts: {
        prepare: call(channels.artifactPrepare),
      },
      models: {
        read: call(channels.modelsRead),
        addAccount: call(channels.modelsAddAccount),
        signIn: call(channels.modelsSignIn),
        check: call(channels.modelsCheck),
        remove: call(channels.modelsRemove),
        setOrder: call(channels.modelsSetOrder),
        runningLimit: call(channels.modelsRunningLimit),
        setRunningLimit: call(channels.modelsSetRunningLimit),
        starred: call(channels.modelsStarred),
        setStarred: call(channels.modelsSetStarred),
      },
      memory: {
        list: call(channels.memoryList),
        revisions: call(channels.memoryRevisions),
        save: call(channels.memorySave),
        archive: call(channels.memoryArchive),
        decide: call(channels.memoryDecide),
      },
      spend: {
        list: call(channels.spendList),
        setBudget: call(channels.spendSetBudget),
      },
      share: {
        status: call(channels.artifactShareStatus),
        publish: call(channels.artifactSharePublish),
        setVisibility: call(channels.artifactShareSetVisibility),
        replace: call(channels.artifactShareReplace),
        unpublish: call(channels.artifactShareUnpublish),
        copy: call(channels.artifactShareCopy),
      },
      repository: {
        state: call(channels.artifactRepositoryState),
        add: call(channels.artifactRepositoryAdd),
        mode: call(channels.artifactRepositoryMode),
        setMode: call(channels.artifactRepositorySetMode),
      },
      queue: {
        reorder: call(channels.queueReorder),
        sendNow: call(channels.queueSendNow),
      },
      aside: {
        ask: call(channels.asideAsk),
        continue: call(channels.asideContinue),
      },
      pins: {
        set: call(channels.pinsSet),
      },
      outbox: {
        sendNow: call(channels.outboxSendNow),
        delete: call(channels.outboxDelete),
      },
      links: {
        preview: call(channels.linksPreview),
        enabled: call(channels.linksEnabled),
        setEnabled: call(channels.linksSetEnabled),
      },
      hidden: {
        set: call(channels.hiddenSet),
      },
      voice: {
        status: call(channels.voiceStatus),
        setKey: call(channels.voiceSetKey),
        clearKey: call(channels.voiceClearKey),
        voices: call(channels.voiceVoices),
        speak: call(channels.voiceSpeak),
      },
      coAuthor: {
        get: call(channels.coAuthorGet),
        set: call(channels.coAuthorSet),
      },
      templates: {
        list: call(channels.agentTemplatesList),
        create: call(channels.agentTemplatesCreate),
      },
      // The headless page has no view scheme, so it reports no installed map.
      views: {
        getMap: async () => null,
        setGrants: async () => undefined,
        turnOn: async () => undefined,
        prepare: async () => {
          throw new Error("Views need the desktop app.");
        },
        connect: async () => {
          throw new Error("Views need the desktop app.");
        },
        post: () => undefined,
        update: () => undefined,
        close: () => undefined,
        shortcut: () => undefined,
        onEvent: () => () => undefined,
      },
    };
  }, IPC_CHANNELS);
  await page.goto(`${SHELL_ORIGIN}/index.html`);
}

interface ZoltWindow {
  __zoltInvoke(channel: string, input: unknown): Promise<unknown>;
  __zoltEmit(event: unknown): void;
}

/** Preferences kept in memory, validated the same way as the app's file. */
function memoryPreferences() {
  let values = normalizePreferences({});
  return {
    read: async () => values,
    update: async (patch: unknown) => {
      values = normalizePreferences({ ...values, ...parsePreferencesPatch(patch) });
      return values;
    },
  };
}
