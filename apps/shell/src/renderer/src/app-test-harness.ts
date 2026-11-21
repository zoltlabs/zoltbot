import { fireEvent, screen, within } from "@solidjs/testing-library";
import { vi } from "vitest";
import type {
  AgentEvent,
  AgentStatus,
  AttachmentImportEvent,
  BotSummary,
  UpdateStatus,
} from "../../shared/ipc";

export const READY_STATUS: AgentStatus = {
  phase: "ready",
  cliVersion: null,
  auth: { kind: "unknown" },
  providers: [
    { id: "codex", name: "Codex", state: "available", version: "0.144.1", message: null },
    { id: "claude", name: "Claude Code", state: "available", version: "2.1.231", message: null },
  ],
  capabilities: { chat: "ready", browser: "ready", computerUse: "ready" },
  message: null,
  fullAccess: true,
};

/** The daemon knows two agents and neither works yet. */
export const SETUP_STATUS: AgentStatus = {
  ...READY_STATUS,
  providers: [
    {
      id: "codex",
      name: "Codex",
      state: "not-installed",
      version: null,
      message: "Codex isn’t installed.",
      installUrl: "https://example.com/install-codex",
      installCommand: "npm install -g example-codex",
    },
    {
      id: "claude",
      name: "Claude Code",
      state: "sign-in-required",
      version: "2.1.231",
      message: "Sign in to Claude Code.",
      loginCommand: "claude auth login",
    },
  ],
  capabilities: { chat: "setup-required", browser: "ready", computerUse: "ready" },
};

export let emitAgentEvent: ((event: AgentEvent) => void) | undefined;
export let emitAttachmentImport: ((event: AttachmentImportEvent) => void) | undefined;
export let emitUpdateStatus: ((status: UpdateStatus) => void) | undefined;

export const BOTS: BotSummary[] = [
  {
    id: "chief",
    name: "Chief",
    role: "Chief of staff",
    description: "Coordinates work",
    notifications: true,
    model: "gpt-5.6-luna",
    reasoningEffort: "medium",
    avatarShape: "blob",
    avatarColor: "orange",
    threadId: "thread-chief",
    workspacePath: "/tmp/Zoltbot/Bots/chief",
    preview: "No messages yet",
    updatedAt: null,
    profileId: "profile",
    projectId: null,
    kind: "main",
    pinned: false,
    muted: false,
    onboarding: true,
    depth: 0,
    companyRole: "chat",
    roleLabel: "",
    parentId: null,
    projectName: "",
  },
  {
    id: "sales-outbound",
    name: "Sales Outbound",
    role: "Outbound specialist",
    description: "",
    notifications: true,
    model: "gpt-5.6-luna",
    reasoningEffort: "medium",
    avatarShape: "cloud",
    avatarColor: "violet",
    threadId: null,
    workspacePath: "/tmp/Zoltbot/Bots/sales-outbound",
    preview: "No messages yet",
    updatedAt: null,
    profileId: "profile",
    projectId: null,
    kind: "main",
    pinned: false,
    muted: false,
    onboarding: true,
    depth: 0,
    companyRole: "chat",
    roleLabel: "",
    parentId: null,
    projectName: "",
  },
];

export async function confirmOnboardingModel(): Promise<void> {
  const trigger = await screen.findByRole("button", { name: "Onboarding model: Luna" });
  await fireEvent.click(trigger);
  const picker = screen.getByRole("dialog", { name: "Choose agent model" });
  await fireEvent.click(within(picker).getByRole("option", { name: "Luna, default" }));
  await screen.findByRole("listbox", { name: "What do you want me helping with most?" });
}

/** Installs a mocked `window.openbot` bridge and resets the event emitters. */
export function setUpAppTest() {
  const agentListeners = new Set<(event: AgentEvent) => void>();
  emitAgentEvent = (event) => {
    for (const listener of [...agentListeners]) listener(event);
  };
  emitAttachmentImport = undefined;
  emitUpdateStatus = undefined;
  window.localStorage.clear();
  Object.defineProperty(window, "openbot", {
    configurable: true,
    value: {
      getAppInfo: vi
        .fn()
        .mockResolvedValue({ name: "Zoltbot", version: "0.1.0", platform: "darwin" }),
      getSetupState: vi.fn().mockResolvedValue({ completed: true, preferredProvider: "codex" }),
      saveSetup: vi.fn().mockImplementation(async ({ preferredProvider }) => ({
        completed: true,
        preferredProvider,
      })),
      getMacPermissions: vi.fn().mockResolvedValue({
        screenRecording: "granted",
        accessibility: "granted",
      }),
      requestMacPermission: vi.fn().mockResolvedValue({
        screenRecording: "granted",
        accessibility: "granted",
      }),
      openExternal: vi.fn().mockResolvedValue(undefined),
      openUrl: vi.fn().mockResolvedValue(undefined),
      account: {
        getStatus: vi.fn().mockResolvedValue({
          configured: true,
          signedIn: true,
          email: "sam@example.com",
          name: "Sam",
          managementUrl: "https://example.com/account",
        }),
        signIn: vi.fn(),
        signOut: vi.fn().mockResolvedValue({
          configured: true,
          signedIn: false,
          email: null,
          name: null,
          managementUrl: null,
        }),
        cancel: vi.fn().mockResolvedValue(undefined),
      },
      agent: {
        getStatus: vi.fn().mockResolvedValue(READY_STATUS),
        refreshAgents: vi.fn().mockResolvedValue(READY_STATUS),
        getUsage: vi.fn().mockResolvedValue({
          limits: [
            {
              id: "codex",
              primary: { usedPercent: 28, windowDurationMins: 300, resetsAt: 1_786_563_600 },
              secondary: {
                usedPercent: 41,
                windowDurationMins: 10_080,
                resetsAt: 1_787_040_000,
              },
            },
          ],
        }),
        listModels: vi.fn().mockResolvedValue([
          {
            id: "gpt-5.6-luna",
            provider: "codex",
            providerName: "Codex",
            name: "Luna",
            description: "Fast and efficient for everyday agent work.",
            defaultReasoningEffort: "medium",
            supportedReasoningEfforts: ["low", "medium", "high"],
          },
          {
            id: "gpt-5.6-terra",
            provider: "codex",
            providerName: "Codex",
            name: "Terra",
            description: "Balanced speed and capability for involved tasks.",
            defaultReasoningEffort: "medium",
            supportedReasoningEfforts: ["medium", "high"],
          },
          {
            id: "gpt-5.6-sol",
            provider: "codex",
            providerName: "Codex",
            name: "Sol",
            description: "Most capable for complex, long-running work.",
            defaultReasoningEffort: "high",
            supportedReasoningEfforts: ["medium", "high", "xhigh"],
          },
          {
            id: "claude-opus-5",
            provider: "claude",
            providerName: "Claude",
            name: "Claude Opus 5",
            description: "Most capable Claude model for complex work.",
            defaultReasoningEffort: "high",
            supportedReasoningEfforts: ["low", "medium", "high"],
          },
          {
            id: "claude-sonnet-5",
            provider: "claude",
            providerName: "Claude",
            name: "Claude Sonnet 5",
            description: "Balanced Claude model for general agent work.",
            defaultReasoningEffort: "high",
            supportedReasoningEfforts: ["low", "medium", "high"],
          },
        ]),
        listBots: vi.fn().mockResolvedValue(BOTS),
        createBot: vi
          .fn()
          .mockResolvedValue({ ...BOTS[0], id: "bot-new", name: "New agent", onboarding: false }),
        updateBot: vi.fn().mockImplementation(async (input) => ({
          ...BOTS.find((bot) => bot.id === input.botId),
          ...input,
        })),
        deleteBot: vi.fn().mockResolvedValue(undefined),
        readConversation: vi.fn().mockImplementation(async (botId) => ({
          botId,
          threadId: null,
          activeTurnId: null,
          revision: 0,
          messages: [],
        })),
        readContext: vi.fn().mockResolvedValue(null),
        compact: vi.fn().mockResolvedValue(undefined),
        branchPreview: vi.fn().mockResolvedValue({
          available: true,
          kind: "native",
          copiedMessages: 0,
          omittedMessages: 0,
          reason: "",
        }),
        branch: vi.fn().mockResolvedValue({ botId: "branch-1", ready: true, failed: false }),
        threadAction: vi.fn().mockResolvedValue(undefined),
        chooseAttachments: vi.fn().mockResolvedValue([]),
        onAttachmentImport: vi.fn((listener) => {
          emitAttachmentImport = listener;
          return () => undefined;
        }),
        discardDraftAttachment: vi.fn().mockResolvedValue(undefined),
        openAttachment: vi.fn().mockResolvedValue(undefined),
        sendMessage: vi.fn().mockResolvedValue({
          messageId: "message-1",
          deliveries: [
            { id: "delivery-1", recipientBotId: "chief", status: "queued", position: 1 },
          ],
        }),
        setMessageReaction: vi.fn().mockResolvedValue(undefined),
        listQueue: vi
          .fn()
          .mockImplementation(async (botId) => ({ botId, paused: false, deliveries: [] })),
        cancelQueuedMessage: vi.fn().mockResolvedValue(undefined),
        setQueuePaused: vi.fn().mockResolvedValue(undefined),
        interrupt: vi.fn().mockResolvedValue(undefined),
        respondToPrompt: vi.fn().mockResolvedValue(undefined),
        listTasks: vi.fn().mockResolvedValue([]),
        readStaff: vi.fn().mockResolvedValue({ approvals: [], people: [] }),
        staffAction: vi.fn().mockResolvedValue(undefined),
        reviewTask: vi.fn().mockResolvedValue(undefined),
        listChannels: vi.fn().mockResolvedValue([]),
        onEvent: vi.fn((listener) => {
          agentListeners.add(listener);
          return () => {
            agentListeners.delete(listener);
          };
        }),
      },
      memory: {
        list: vi.fn().mockResolvedValue({ entries: [], proposals: [] }),
        revisions: vi.fn().mockResolvedValue([]),
        save: vi.fn().mockResolvedValue(undefined),
        archive: vi.fn().mockResolvedValue(undefined),
        decide: vi.fn().mockResolvedValue(undefined),
      },
      pins: {
        set: vi.fn().mockResolvedValue(undefined),
      },
      hidden: {
        set: vi.fn().mockResolvedValue(undefined),
      },
      templates: {
        list: vi.fn().mockResolvedValue([]),
        create: vi.fn(),
      },
      aside: {
        ask: vi.fn().mockResolvedValue({ threadId: "aside-thread" }),
        continue: vi.fn().mockResolvedValue(undefined),
      },
      queue: {
        reorder: vi.fn().mockResolvedValue(undefined),
        sendNow: vi.fn().mockResolvedValue(undefined),
      },
      repository: {
        state: vi.fn().mockResolvedValue(null),
        add: vi.fn(),
        mode: vi.fn().mockResolvedValue(null),
        setMode: vi.fn().mockResolvedValue(undefined),
      },
      share: {
        status: vi.fn().mockResolvedValue({ kind: "unavailable" }),
        publish: vi.fn(),
        setVisibility: vi.fn(),
        replace: vi.fn(),
        unpublish: vi.fn().mockResolvedValue(undefined),
        copy: vi.fn().mockResolvedValue(undefined),
      },
      spend: {
        list: vi.fn().mockResolvedValue({ rows: [], budgets: [], projects: [] }),
        setBudget: vi.fn().mockResolvedValue(undefined),
      },
      browser: {
        open: vi.fn().mockResolvedValue(undefined),
        activate: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
        listTabs: vi.fn().mockResolvedValue([]),
        getControlState: vi.fn().mockResolvedValue({ sessions: [] }),
        setVisible: vi.fn().mockResolvedValue(undefined),
      },
      update: {
        getStatus: vi.fn().mockResolvedValue({
          phase: "idle",
          currentVersion: "0.1.0",
          availableVersion: null,
          progress: null,
          checkedAt: null,
          message: null,
        }),
        check: vi.fn().mockResolvedValue({
          phase: "up-to-date",
          currentVersion: "0.1.0",
          availableVersion: null,
          progress: null,
          checkedAt: "2026-08-12T22:00:00.000Z",
          message: null,
        }),
        download: vi.fn().mockResolvedValue({
          phase: "downloading",
          currentVersion: "0.1.0",
          availableVersion: "0.2.0",
          progress: 0,
          checkedAt: "2026-08-12T22:00:00.000Z",
          message: null,
        }),
        install: vi.fn().mockResolvedValue(undefined),
        onEvent: vi.fn((listener) => {
          emitUpdateStatus = listener;
          return () => undefined;
        }),
      },
      maintenance: {
        exportData: vi.fn().mockResolvedValue({ saved: true }),
        exportDiagnostics: vi.fn().mockResolvedValue({ saved: true }),
      },
    },
  });
}

export function attachment(id: string, name: string, kind: "image" | "pdf") {
  return {
    id,
    name,
    size: 2048,
    kind: kind === "image" ? ("image" as const) : ("file" as const),
    mimeType: kind === "image" ? "image/png" : "application/pdf",
    previewKind: kind,
    previewUrl: `openbot-attachment://file/${id}`,
  };
}
