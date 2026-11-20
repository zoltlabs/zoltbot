import type {
  AgentEvent,
  AgentStatus,
  BotSummary,
  ConversationMessage,
  UpdateStatus,
} from "../../shared/ipc";
import { accentForAvatarColor, accentForBot, type BotMessage, type BotProfile } from "./data";

export const FALLBACK_STATUS: AgentStatus = {
  phase: "starting",
  cliVersion: null,
  auth: { kind: "unknown" },
  providers: [],
  capabilities: { chat: "unavailable", browser: "unavailable", computerUse: "unavailable" },
  message: "Connecting to Zoltbot…",
  fullAccess: false,
};

export const FALLBACK_UPDATE_STATUS: UpdateStatus = {
  phase: "unsupported",
  currentVersion: "",
  availableVersion: null,
  progress: null,
  checkedAt: null,
  message: null,
};

export type PromptEvent = Extract<AgentEvent, { type: "prompt" }>;

export const LEFT_PANEL_STORAGE_KEY = "openbot:left-panel-width";
export const LEFT_PANEL_COLLAPSED_STORAGE_KEY = "openbot:left-panel-collapsed";
export const LEFT_PANEL_DEFAULT = 275;
export const LEFT_PANEL_MIN = 220;
export const LEFT_PANEL_MAX = 360;

export const ONBOARDING_PROFILES: Record<
  string,
  { role: string; description: string; firstMessage: string }
> = {
  "Work & projects": {
    role: "Work & projects",
    description:
      "Helps plan, organize, and execute ongoing work and projects while keeping priorities, next steps, and deliverables clear.",
    firstMessage:
      "Focus on my work and projects. Help me plan, organize, and execute them proactively.",
  },
  "Research & writing": {
    role: "Research & writing",
    description:
      "Researches topics, synthesizes reliable sources, and helps draft, edit, and refine clear writing.",
    firstMessage:
      "Focus on research and writing. Help me investigate topics and turn the findings into clear, useful writing.",
  },
  "Sales & outreach": {
    role: "Sales & outreach",
    description:
      "Supports prospect research, sales preparation, personalized outreach, and organized follow-up work.",
    firstMessage:
      "Focus on sales and outreach. Help me research prospects, prepare personalized outreach, and manage follow-ups.",
  },
};

export function toBotProfile(stored: BotSummary): BotProfile {
  return {
    id: stored.id,
    name: stored.name,
    role: stored.role,
    description: stored.description,
    notifications: stored.notifications,
    model: stored.model,
    reasoningEffort: stored.reasoningEffort,
    threadId: stored.threadId,
    accent:
      stored.name.toLowerCase() === "new agent"
        ? "neutral"
        : stored.avatarColor
          ? accentForAvatarColor(stored.avatarColor)
          : accentForBot(stored.id),
    avatarShape: stored.avatarShape ?? "blob",
    avatarColor: stored.avatarColor ?? "orange",
    time: stored.updatedAt ? formatTime(stored.updatedAt) : "now",
    preview: cleanPreview(stored.preview),
    profileId: stored.profileId,
    projectId: stored.projectId,
    kind: stored.kind,
    pinned: stored.pinned,
    onboarding: stored.onboarding,
    depth: stored.depth,
    companyRole: stored.companyRole,
    roleLabel: stored.roleLabel,
    parentId: stored.parentId,
    projectName: stored.projectName,
    contextFull: stored.contextFull,
    ...(stored.branchedFrom ? { branchedFrom: stored.branchedFrom } : {}),
    unread: stored.unread === true,
    updatedAt: stored.updatedAt,
  };
}

export function toBotMessage(message: ConversationMessage): BotMessage {
  const exchangeSenderId = message.senderBotId ?? message.exchange?.senderBotId;
  return {
    id: message.id,
    turnId: message.turnId,
    author: message.author === "user" ? "you" : "bot",
    body: message.text,
    time: formatTime(message.createdAt),
    streaming: message.status === "streaming",
    itemType: message.itemType,
    kind: message.exchange ? "exchange" : message.source === "system" ? "notice" : "text",
    senderBotId: exchangeSenderId,
    replyToMessageId: message.replyToMessageId,
    attachments: message.attachments,
    artifacts: message.artifacts,
    exchange: message.exchange,
    reaction: message.reaction,
    ...(message.notice ? { notice: message.notice } : {}),
    ...(message.card ? { card: message.card } : {}),
    ...(message.aside ? { aside: { threadId: message.aside.threadId } } : {}),
    hidden: message.hidden === true,
    status: message.exchange
      ? undefined
      : message.delivery?.status === "queued"
        ? `Queued #${message.delivery.position}`
        : message.delivery?.status === "cancelled"
          ? "Cancelled"
          : message.status === "failed"
            ? "Failed"
            : message.status === "interrupted"
              ? "Stopped"
              : undefined,
  };
}

export function toBotMessages(messages: ConversationMessage[]): BotMessage[] {
  const result: BotMessage[] = [];
  const thinkingByTurn = new Map<string, BotMessage>();
  for (const message of messages) {
    if (message.author !== "assistant" || message.itemType !== "commentary") {
      result.push(toBotMessage(message));
      continue;
    }

    const key = message.turnId ?? message.id;
    const existing = thinkingByTurn.get(key);
    if (existing) {
      if (message.text.trim()) existing.items = [...(existing.items ?? []), message.text];
      existing.streaming = existing.streaming || message.status === "streaming";
      continue;
    }

    const thinking: BotMessage = {
      id: `thinking:${key}`,
      turnId: message.turnId,
      author: "bot",
      body: "",
      time: formatTime(message.createdAt),
      streaming: message.status === "streaming",
      itemType: "commentary",
      kind: "thinking",
      items: message.text.trim() ? [message.text] : [],
    };
    thinkingByTurn.set(key, thinking);
    result.push(thinking);
  }
  return result;
}

export function cleanPreview(preview: string): string {
  const cleaned = preview
    .replace(/\binbox\s+at\s+zero\b[:,]?\s*/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  return cleaned || "No messages yet";
}

export function botMessagesEqual(left: BotMessage, right: BotMessage): boolean {
  return (
    left.id === right.id &&
    left.turnId === right.turnId &&
    left.author === right.author &&
    left.body === right.body &&
    left.time === right.time &&
    left.kind === right.kind &&
    left.streaming === right.streaming &&
    left.itemType === right.itemType &&
    left.status === right.status &&
    left.senderBotId === right.senderBotId &&
    left.replyToMessageId === right.replyToMessageId &&
    left.reaction === right.reaction &&
    JSON.stringify(left.attachments) === JSON.stringify(right.attachments) &&
    JSON.stringify(left.exchange) === JSON.stringify(right.exchange) &&
    JSON.stringify(left.items) === JSON.stringify(right.items) &&
    JSON.stringify([left.notice, left.card, left.aside, left.hidden]) ===
      JSON.stringify([right.notice, right.card, right.aside, right.hidden])
  );
}

export function retainThinkingMessages(previous: BotMessage[], next: BotMessage[]): BotMessage[] {
  const result = [...next];
  const nextIds = new Set(result.map((message) => message.id));
  for (const thinking of previous) {
    if (thinking.kind !== "thinking" || nextIds.has(thinking.id) || !thinking.turnId) continue;
    const sameTurnIndexes = result.flatMap((message, index) =>
      message.turnId === thinking.turnId ? [index] : [],
    );
    if (sameTurnIndexes.length === 0) continue;
    const finalAnswerIndex = result.findIndex(
      (message) =>
        message.turnId === thinking.turnId &&
        message.author === "bot" &&
        message.kind !== "thinking",
    );
    const insertionIndex =
      finalAnswerIndex >= 0 ? finalAnswerIndex : (sameTurnIndexes.at(-1) ?? result.length - 1) + 1;
    result.splice(insertionIndex, 0, { ...thinking, streaming: false });
    nextIds.add(thinking.id);
  }
  return result;
}

export function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "now";
  return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(date);
}

export function withoutBot<T>(values: Record<string, T>, botId: string): Record<string, T> {
  const next = { ...values };
  delete next[botId];
  return next;
}
