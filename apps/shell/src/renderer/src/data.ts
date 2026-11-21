import type { BranchOrigin } from "../../shared/branches";
import {
  type AgentExchangeSummary,
  type AgentModelId,
  type AgentReasoningEffort,
  type ArtifactSummary,
  type AttachmentSummary,
  BOT_AVATAR_COLORS,
  BOT_AVATAR_SHAPES,
  type BotAvatarColor,
  type BotAvatarShape,
  type ContextFullAction,
  type TalkingStyle,
  type ConversationNotice,
  type ManagerCard,
  type MessageReaction,
} from "../../shared/ipc";

export type BotAccent = "teal" | "orange" | "purple" | "blue" | "violet" | "coral" | "neutral";

export const AVATAR_SHAPES: BotAvatarShape[] = [...BOT_AVATAR_SHAPES];

export const AVATAR_COLORS: BotAvatarColor[] = [...BOT_AVATAR_COLORS];

export type MessageKind = "text" | "thinking" | "exchange" | "notice";

export interface BotMessage {
  id: string;
  turnId?: string;
  author: "you" | "bot";
  body: string;
  time: string;
  /** C20: when the message was made, as an ISO time, for the day rail. */
  createdAt?: string;
  streaming?: boolean;
  animate?: boolean;
  itemType?: string;
  kind?: MessageKind;
  status?: string;
  /** C12: written while Zoltbot was unreachable; sends once it is back. */
  waiting?: boolean;
  senderBotId?: string;
  replyToMessageId?: string | null;
  attachments?: AttachmentSummary[];
  artifacts?: ArtifactSummary[];
  exchange?: AgentExchangeSummary;
  reaction?: MessageReaction | null;
  /** C8: the agent's reaction to this message. */
  agentReaction?: MessageReaction | null;
  items?: string[];
  notice?: ConversationNotice;
  card?: ManagerCard;
  /** C2: part of a side question; holds the aside's thread id. */
  aside?: { threadId: string };
  /** C5: hidden from the chat; the agent still remembers it. */
  hidden?: boolean;
  /** C10: a progress note the agent posted during a long task. */
  progress?: boolean;
}

export interface BotProfile {
  id: string;
  name: string;
  role: string;
  description: string;
  notifications: boolean;
  model: AgentModelId;
  reasoningEffort: AgentReasoningEffort;
  /** A5: null when the provider has no faster tier. */
  fastMode?: boolean | null;
  /** C11: continue replies that end on a promise. */
  continueTurns?: boolean;
  /** A10: the model the agent switches to once its turn ends. */
  pendingModel?: AgentModelId | null;
  threadId: string | null;
  accent: BotAccent;
  avatarShape: BotAvatarShape;
  avatarColor: BotAvatarColor;
  time: string;
  preview: string;
  profileId?: string;
  projectId?: string | null;
  kind?: string;
  pinned?: boolean;
  /** A3: the owner muted this chat. */
  muted?: boolean;
  /** Marked unread, or a reply came after the owner last read it. */
  unread?: boolean;
  /** When the chat last had activity, for sorting. */
  updatedAt?: string | null;
  onboarding?: boolean;
  depth?: number;
  companyRole?: string;
  roleLabel?: string;
  parentId?: string | null;
  projectName?: string;
  contextFull?: ContextFullAction;
  talkingStyle?: TalkingStyle;
  branchedFrom?: BranchOrigin;
}

export function accentForAvatarColor(color: BotAvatarColor): BotAccent {
  const accents: Record<BotAvatarColor, BotAccent> = {
    black: "neutral",
    brown: "coral",
    red: "coral",
    orange: "orange",
    yellow: "orange",
    green: "teal",
    cyan: "teal",
    blue: "blue",
    violet: "violet",
    magenta: "purple",
    gray: "neutral",
  };
  return accents[color];
}

export function accentForBot(id: string): BotAccent {
  const accents: BotAccent[] = ["teal", "orange", "purple", "blue", "violet", "coral"];
  let hash = 0;
  for (const character of id) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return accents[hash % accents.length] ?? "neutral";
}
