import type { ConversationNotice, ManagerCard, TaskActionInput } from "./manager-cards";
import type { PreferencesDesktopApi } from "./preferences";

export * from "./browser";
export * from "./company";
export * from "./dictation";
export type * from "./manager-cards";
export type * from "./staff";
export * from "./views";

import type { BrowserControlState, BrowserDesktopApi, BrowserTab } from "./browser";
import type {
  ChannelDetail,
  ChannelRequestInput,
  ChannelSummary,
  PostChannelInput,
  ReadEarlierPostsInput,
} from "./channels";
import type { CompanyOverview, DecidePlanInput } from "./company";
import type { DictationDesktopApi } from "./dictation";
import { MODEL_CHANNELS, type ModelSwitchDialog, type ModelsDesktopApi } from "./models";
import type { StaffActionInput, StaffOverview } from "./staff";
import type { ReviewTaskInput, TaskSummary } from "./tasks";
import type { ViewsDesktopApi } from "./views";

export const IPC_CHANNELS = {
  getAppInfo: "app:get-info",
  getSetupState: "app:get-setup-state",
  saveSetup: "app:save-setup",
  getMacPermissions: "app:get-mac-permissions",
  requestMacPermission: "app:request-mac-permission",
  openExternal: "app:open-external",
  openUrl: "app:open-url",
  setVisibleBot: "app:set-visible-bot",
  updateGetStatus: "update:get-status",
  updateCheck: "update:check",
  updateDownload: "update:download",
  updateInstall: "update:install",
  updateEvent: "update:event",
  maintenanceExportData: "maintenance:export-data",
  maintenanceExportDiagnostics: "maintenance:export-diagnostics",
  accountGetStatus: "account:get-status",
  accountSignIn: "account:sign-in",
  accountSignOut: "account:sign-out",
  accountCancel: "account:cancel",
  agentGetStatus: "agent:get-status",
  agentRefreshAgents: "agent:refresh-agents",
  agentGetUsage: "agent:get-usage",
  agentListModels: "agent:list-models",
  agentListBots: "agent:list-bots",
  agentCreateBot: "agent:create-bot",
  agentCreateProject: "agent:create-project",
  agentUpdateBot: "agent:update-bot",
  agentDeleteBot: "agent:delete-bot",
  agentReadConversation: "agent:read-conversation",
  agentSendMessage: "agent:send-message",
  agentSetMessageReaction: "agent:set-message-reaction",
  agentChooseAttachments: "agent:choose-attachments",
  agentImportAttachments: "agent:import-attachments",
  agentDiscardDraftAttachment: "agent:discard-draft-attachment",
  agentOpenAttachment: "agent:open-attachment",
  agentListQueue: "agent:list-queue",
  agentCancelQueuedMessage: "agent:cancel-queued-message",
  agentSetQueuePaused: "agent:set-queue-paused",
  agentInterrupt: "agent:interrupt",
  agentRespondToPrompt: "agent:respond-to-prompt",
  agentReadCompany: "agent:read-company",
  agentDecidePlan: "agent:decide-plan",
  agentRefreshBrief: "agent:refresh-brief",
  agentTaskAction: "agent:task-action",
  agentListTasks: "agent:list-tasks",
  agentReviewTask: "agent:review-task",
  agentListChannels: "agent:list-channels",
  agentReadChannel: "agent:read-channel",
  agentReadEarlierPosts: "agent:read-earlier-posts",
  agentPostChannel: "agent:post-channel",
  agentChannelRequest: "agent:channel-request",
  agentReadStaff: "agent:read-staff",
  agentStaffAction: "agent:staff-action",
  agentEvent: "agent:event",
  ...MODEL_CHANNELS,
  browserOpen: "browser:open",
  browserActivate: "browser:activate",
  browserClose: "browser:close",
  browserListTabs: "browser:list-tabs",
  browserGetControlState: "browser:get-control-state",
  browserSetVisible: "browser:set-visible",
  dictationStatus: "dictation:status",
  dictationRequestPermission: "dictation:request-permission",
  dictationStart: "dictation:start",
  dictationAudio: "dictation:audio",
  dictationStop: "dictation:stop",
  dictationCancel: "dictation:cancel",
  dictationEvent: "dictation:event",
  artifactPrepare: "artifact:prepare",
  viewGetMap: "view:get-map",
  viewSetGrants: "view:set-grants",
  viewTurnOn: "view:turn-on",
  viewPrepare: "view:prepare",
  viewConnect: "view:connect",
  viewPost: "view:post",
  viewUpdate: "view:update",
  viewClose: "view:close",
  viewShortcut: "view:shortcut",
  viewEvent: "view:event",
} as const;

export type DesktopPlatform = "darwin" | "win32" | "linux";

export interface AppInfo {
  name: string;
  version: string;
  platform: DesktopPlatform;
}

export type UpdatePhase =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "ready"
  | "installing"
  | "up-to-date"
  | "error"
  | "unsupported";

export interface UpdateStatus {
  phase: UpdatePhase;
  currentVersion: string;
  availableVersion: string | null;
  progress: number | null;
  checkedAt: string | null;
  message: string | null;
}

export interface ExportResult {
  saved: boolean;
}

export type AgentPhase = "idle" | "starting" | "ready" | "restarting" | "blocked" | "stopped";

export type CapabilityState = "ready" | "setup-required" | "unavailable";

/** A Zoltbot agent definition id, such as "claude" or "codex". */
export type AgentProviderId = string;
export type AgentProviderState =
  | "not-started"
  | "checking"
  | "available"
  | "sign-in-required"
  | "not-installed"
  | "outdated"
  | "error";

export interface AgentProviderStatus {
  id: AgentProviderId;
  /** The daemon's display name for the agent, such as "Claude Code". */
  name?: string;
  state: AgentProviderState;
  version: string | null;
  message: string | null;
  email?: string | null;
  /** Where to read how to install the agent. */
  installUrl?: string | null;
  /** The shell command that installs the agent, when the daemon knows one. */
  installCommand?: string | null;
  /** The shell command that signs the agent in, when the daemon knows one. */
  loginCommand?: string | null;
}

export interface CreateBotInput {
  projectId?: string | null;
}

export interface AppSetupState {
  completed: boolean;
  preferredProvider: AgentProviderId | null;
}

export interface SaveSetupInput {
  preferredProvider: AgentProviderId;
}

export type MacPermissionId = "screen-recording" | "accessibility";
export type MacPermissionState = "not-determined" | "granted" | "denied" | "restricted" | "unknown";

export interface MacPermissionsState {
  screenRecording: MacPermissionState;
  accessibility: MacPermissionState;
}

export type AgentAuthState =
  | { kind: "unknown" }
  | { kind: "signed-out" }
  | { kind: "unsupported"; accountType: string };

/** The Zoltbot cloud account. Never carries credentials. */
export interface CloudAccountStatus {
  /** False when this build has no hosted service to sign in to. */
  configured: boolean;
  signedIn: boolean;
  email: string | null;
  name: string | null;
  managementUrl: string | null;
}

export interface AccountUsageWindow {
  usedPercent: number;
  windowDurationMins: number | null;
  resetsAt: number | null;
}

export interface AccountUsageLimit {
  id: string;
  primary: AccountUsageWindow | null;
  secondary: AccountUsageWindow | null;
}

export interface AccountUsage {
  limits: AccountUsageLimit[];
}

export type ExternalDestination = "agent-setup" | "feedback" | "message";

export interface AgentStatus {
  phase: AgentPhase;
  cliVersion: string | null;
  auth: AgentAuthState;
  providers?: AgentProviderStatus[];
  capabilities: {
    chat: CapabilityState;
    browser: CapabilityState;
    computerUse: CapabilityState;
  };
  message: string | null;
  fullAccess: boolean;
}

export interface BotSummary {
  id: string;
  name: string;
  role: string;
  description: string;
  notifications: boolean;
  model: AgentModelId;
  reasoningEffort: AgentReasoningEffort;
  threadId: string | null;
  workspacePath: string;
  preview: string;
  updatedAt: string | null;
  avatarShape: BotAvatarShape;
  avatarColor: BotAvatarColor;
  /** The Zoltbot profile this chat runs on. */
  profileId: string;
  projectId: string | null;
  kind: string;
  pinned: boolean;
  /** Ask what the agent should focus on when its chat is empty. */
  onboarding: boolean;
  /** How far below the project's CEO this chat sits in the company. */
  depth: number;
  companyRole: "chief" | "ceo" | "manager" | "employee" | "chat";
  /** Short role shown next to the name, empty for plain chats. */
  roleLabel: string;
  parentId: string | null;
  projectName: string;
}

/** A model id reported by the provider, such as "claude-opus-5". */
export type AgentModelId = string;

export const AGENT_REASONING_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type AgentReasoningEffort = string;

export interface AgentModelOption {
  id: AgentModelId;
  provider: AgentProviderId;
  providerName: string;
  name: string;
  description: string;
  defaultReasoningEffort: AgentReasoningEffort;
  supportedReasoningEfforts: AgentReasoningEffort[];
}

export const BOT_AVATAR_SHAPES = [
  "blob",
  "pebble",
  "squircle",
  "tablet",
  "wedge",
  "hex",
  "cloud",
  "teardrop",
] as const;
export type BotAvatarShape = (typeof BOT_AVATAR_SHAPES)[number];

export const BOT_AVATAR_COLORS = [
  "black",
  "brown",
  "red",
  "orange",
  "yellow",
  "green",
  "cyan",
  "blue",
  "violet",
  "magenta",
  "gray",
] as const;
export type BotAvatarColor = (typeof BOT_AVATAR_COLORS)[number];

export function isAgentModel(value: unknown): value is AgentModelId {
  return typeof value === "string" && value.length > 0 && value.length <= 200;
}

export function isReasoningEffort(value: unknown): value is AgentReasoningEffort {
  return typeof value === "string" && value.length > 0 && value.length <= 40;
}

export function isAvatarShape(value: unknown): value is BotAvatarShape {
  return typeof value === "string" && BOT_AVATAR_SHAPES.includes(value as BotAvatarShape);
}

export function isAvatarColor(value: unknown): value is BotAvatarColor {
  return typeof value === "string" && BOT_AVATAR_COLORS.includes(value as BotAvatarColor);
}

export interface UpdateBotInput {
  botId: string;
  name?: string;
  role?: string;
  description?: string;
  notifications?: boolean;
  model?: AgentModelId;
  reasoningEffort?: AgentReasoningEffort;
  avatarShape?: BotAvatarShape;
  avatarColor?: BotAvatarColor;
}

export type ConversationMessageAuthor = "user" | "assistant" | "agent" | "system";

export type AttachmentKind = "image" | "file";
export type AttachmentPreviewKind = "image" | "pdf" | "text" | "none";

export interface AttachmentSummary {
  id: string;
  name: string;
  size: number;
  kind: AttachmentKind;
  mimeType: string;
  previewKind: AttachmentPreviewKind;
  previewUrl: string | null;
}

export type DraftAttachment = AttachmentSummary;

/** An artifact version an agent produced during a turn. */
export interface ArtifactSummary {
  id: string;
  versionId: string;
  title: string;
  kind: string;
  version: number;
  /** Null when the files aren't on this Mac, so the artifact can't open here. */
  manifestHash: string | null;
}

export interface AttachmentDataInput {
  name: string;
  mimeType: string;
  bytes: Uint8Array;
}

export interface ImportAttachmentsInput {
  paths: string[];
  data: AttachmentDataInput[];
}

export type AttachmentImportEvent =
  | { type: "started"; requestId: string }
  | { type: "completed"; requestId: string; attachments: DraftAttachment[] }
  | { type: "error"; requestId: string; message: string };

export interface OpenAttachmentInput {
  attachmentId: string;
  action: "open" | "reveal";
}

export type QueueDeliveryStatus =
  | "queued"
  | "starting"
  | "running"
  | "completed"
  | "failed"
  | "interrupted"
  | "cancelled";

export interface QueueDelivery {
  id: string;
  messageId: string;
  recipientBotId: string;
  sender: { kind: "user" } | { kind: "bot"; botId: string };
  text: string;
  attachments: AttachmentSummary[];
  replyToMessageId: string | null;
  status: QueueDeliveryStatus;
  position: number | null;
  turnId: string | null;
  error: string | null;
  createdAt: string;
}

export interface QueueSnapshot {
  botId: string;
  paused: boolean;
  deliveries: QueueDelivery[];
}

export interface ConversationMessage {
  id: string;
  turnId?: string;
  author: ConversationMessageAuthor;
  text: string;
  createdAt: string;
  status: "streaming" | "completed" | "failed" | "interrupted";
  itemType?: string;
  source?: "user" | "assistant" | "agent" | "system";
  senderBotId?: string;
  replyToMessageId?: string | null;
  attachments?: AttachmentSummary[];
  artifacts?: ArtifactSummary[];
  delivery?: Pick<QueueDelivery, "id" | "status" | "position">;
  exchange?: AgentExchangeSummary;
  reaction?: MessageReaction | null;
  notice?: ConversationNotice;
  card?: ManagerCard;
}

export const MESSAGE_REACTIONS = ["👍", "👎", "❤️", "😂", "🎉", "😮"] as const;
export const MORE_MESSAGE_REACTIONS = ["🔥", "👏", "🙏", "🤔", "👀", "✅", "🚀", "💯"] as const;
export const ALL_MESSAGE_REACTIONS = [...MESSAGE_REACTIONS, ...MORE_MESSAGE_REACTIONS] as const;
export type MessageReaction =
  | (typeof MESSAGE_REACTIONS)[number]
  | (typeof MORE_MESSAGE_REACTIONS)[number];

export function isMessageReaction(value: unknown): value is MessageReaction {
  return typeof value === "string" && ALL_MESSAGE_REACTIONS.includes(value as MessageReaction);
}

export interface AgentExchangeSummary {
  direction: "incoming" | "outgoing";
  messageId: string;
  senderBotId: string;
  recipientBotIds: string[];
  replyToMessageId: string | null;
  deliveries: Array<Pick<QueueDelivery, "id" | "recipientBotId" | "status" | "position" | "error">>;
}

export interface ConversationSnapshot {
  botId: string;
  threadId: string | null;
  activeTurnId: string | null;
  revision: number;
  messages: ConversationMessage[];
  /** The steps of the agent's newest plan in this chat; empty when it keeps none. */
  plan?: PlanStep[];
}

/** One step of an agent's plan. */
export interface PlanStep {
  step: string;
  status: "pending" | "in_progress" | "completed";
}

export interface SendMessageInput {
  botId: string;
  text: string;
  attachmentDraftIds?: string[];
  replyToMessageId?: string | null;
}

export interface SetMessageReactionInput {
  botId: string;
  messageId: string;
  emoji: MessageReaction | null;
}

export interface QueuedMessageReceipt {
  messageId: string;
  deliveries: Array<{
    id: string;
    recipientBotId: string;
    status: QueueDeliveryStatus;
    position: number | null;
  }>;
}

export interface CancelQueuedMessageInput {
  botId: string;
  deliveryId: string;
}

export interface SetQueuePausedInput {
  botId: string;
  paused: boolean;
}

export interface InterruptTurnInput {
  botId: string;
  turnId: string;
}

export interface AgentPromptQuestion {
  id: string;
  header: string;
  question: string;
  isSecret: boolean;
  options: Array<{ label: string; description: string }> | null;
}

export interface RespondToPromptInput {
  requestId: string | number;
  answers: Record<string, string[]>;
}

export type AgentEvent =
  | { type: "status"; status: AgentStatus }
  | { type: "usage-changed"; usage: AccountUsage }
  | { type: "bots-changed"; bots: BotSummary[] }
  | { type: "conversation"; snapshot: ConversationSnapshot }
  | {
      type: "conversation-delta";
      botId: string;
      threadId: string;
      turnId: string;
      messageId: string;
      delta: string;
      createdAt: string;
      revision: number;
    }
  | { type: "queue-changed"; snapshot: QueueSnapshot }
  | { type: "turn-started"; botId: string; threadId: string; turnId: string }
  | {
      type: "turn-completed";
      botId: string;
      threadId: string;
      turnId: string;
      status: string;
    }
  | {
      type: "prompt";
      requestId: string | number;
      botId: string;
      threadId: string;
      turnId: string;
      questions: AgentPromptQuestion[];
      /** Present when answering moves the chat's work to another provider. */
      switchDialog?: ModelSwitchDialog;
    }
  | { type: "prompt-cleared"; botId: string }
  /** Company rows changed. A null project means every project may have changed. */
  | { type: "company-changed"; projectId: string | null }
  | { type: "browser-changed"; tabs: BrowserTab[]; activeTabId: string | null }
  | { type: "browser-control-changed"; state: BrowserControlState }
  | { type: "error"; botId?: string; code: string; message: string };

export interface AgentDesktopApi {
  getStatus: () => Promise<AgentStatus>;
  /** Looks for installed agents again and returns the new status. */
  refreshAgents: () => Promise<AgentStatus>;
  getUsage: () => Promise<AccountUsage>;
  listModels: () => Promise<AgentModelOption[]>;
  listBots: () => Promise<BotSummary[]>;
  createBot: (input?: CreateBotInput) => Promise<BotSummary>;
  /** Asks for a folder, then creates a project for it with its CEO. Null when cancelled. */
  createProject: () => Promise<BotSummary | null>;
  updateBot: (input: UpdateBotInput) => Promise<BotSummary>;
  deleteBot: (botId: string) => Promise<void>;
  readConversation: (botId: string) => Promise<ConversationSnapshot>;
  chooseAttachments: () => Promise<DraftAttachment[]>;
  onAttachmentImport: (listener: (event: AttachmentImportEvent) => void) => () => void;
  discardDraftAttachment: (attachmentId: string) => Promise<void>;
  openAttachment: (input: OpenAttachmentInput) => Promise<void>;
  sendMessage: (input: SendMessageInput) => Promise<QueuedMessageReceipt>;
  setMessageReaction: (input: SetMessageReactionInput) => Promise<void>;
  listQueue: (botId: string) => Promise<QueueSnapshot>;
  cancelQueuedMessage: (input: CancelQueuedMessageInput) => Promise<void>;
  setQueuePaused: (input: SetQueuePausedInput) => Promise<void>;
  interrupt: (input: InterruptTurnInput) => Promise<void>;
  respondToPrompt: (input: RespondToPromptInput) => Promise<void>;
  readCompany: (projectId: string) => Promise<CompanyOverview>;
  /** Approves or declines a pending plan, then returns the project's company as it is now. */
  decidePlan: (input: DecidePlanInput) => Promise<CompanyOverview>;
  /** Writes a fresh project brief, then returns the project's company as it is now. */
  refreshBrief: (projectId: string) => Promise<CompanyOverview>;
  /** Stops, accepts or sends back a delegated task, or wakes a waiting chat. */
  taskAction: (input: TaskActionInput) => Promise<void>;
  /** Every task in every project, for the Tasks page and the sidebar. */
  listTasks: () => Promise<TaskSummary[]>;
  /** Accepts a task waiting for review, or sends it back with what to change. */
  reviewTask: (input: ReviewTaskInput) => Promise<void>;
  /** Team channels in every project, for the sidebar. */
  listChannels: () => Promise<ChannelSummary[]>;
  readChannel: (channelId: string) => Promise<ChannelDetail>;
  /** The page of posts before `before`, and whether still older ones exist. */
  readEarlierPosts: (input: ReadEarlierPostsInput) => Promise<ChannelDetail>;
  postChannel: (input: PostChannelInput) => Promise<void>;
  channelRequest: (input: ChannelRequestInput) => Promise<void>;
  /** Pending staff approvals (one project, or all with null) and the project's people. */
  readStaff: (projectId: string | null) => Promise<StaffOverview>;
  /** Answers a staff approval, or changes, archives or sets the allowance of a person. */
  staffAction: (input: StaffActionInput) => Promise<void>;
  onEvent: (listener: (event: AgentEvent) => void) => () => void;
}

export interface UpdateDesktopApi {
  getStatus: () => Promise<UpdateStatus>;
  check: () => Promise<UpdateStatus>;
  download: () => Promise<UpdateStatus>;
  install: () => Promise<void>;
  onEvent: (listener: (status: UpdateStatus) => void) => () => void;
}

export interface AccountDesktopApi {
  getStatus: () => Promise<CloudAccountStatus>;
  /** Opens the browser sign-in and resolves once it finishes, fails or is cancelled. */
  signIn: () => Promise<CloudAccountStatus>;
  signOut: () => Promise<CloudAccountStatus>;
  cancel: () => Promise<void>;
}

export interface MaintenanceDesktopApi {
  exportData: () => Promise<ExportResult>;
  exportDiagnostics: () => Promise<ExportResult>;
}

export interface ArtifactDesktopApi {
  /** Verifies the artifact's files and returns the URL that shows it in a frame. */
  prepare: (manifestHash: string) => Promise<{ url: string }>;
}

export interface OpenBotDesktopApi {
  getAppInfo: () => Promise<AppInfo>;
  getSetupState: () => Promise<AppSetupState>;
  saveSetup: (input: SaveSetupInput) => Promise<AppSetupState>;
  getMacPermissions: () => Promise<MacPermissionsState>;
  requestMacPermission: (permission: MacPermissionId) => Promise<MacPermissionsState>;
  openExternal: (destination: ExternalDestination) => Promise<void>;
  openUrl: (url: string) => Promise<void>;
  /** Tells main which chat is on screen, so its requests don't notify. */
  setVisibleBot: (botId: string | null) => void;
  agent: AgentDesktopApi;
  account: AccountDesktopApi;
  browser: BrowserDesktopApi;
  update: UpdateDesktopApi;
  maintenance: MaintenanceDesktopApi;
  /** Desktop-only preferences. Optional so test pages without it still load. */
  preferences?: PreferencesDesktopApi;
  views: ViewsDesktopApi;
  artifacts: ArtifactDesktopApi;
  dictation: DictationDesktopApi;
  models: ModelsDesktopApi;
}
