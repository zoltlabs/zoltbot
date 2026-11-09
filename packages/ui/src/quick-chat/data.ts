import type {
  DomainEvent,
  QuickChat,
  QuickConnection,
  QuickContextSource,
  QuickMessage,
  QuickModel,
  QuickRequest,
  QuickSettings,
  QuickToolCall,
} from "@zoltbot/protocol";
import type { ChatConnection } from "../chat/types.js";

export type QuickConnectionProp = ChatConnection & {
  onEvent?(listener: (event: DomainEvent) => void): () => void;
};
const providerNames: Record<QuickConnection["provider"], string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  openai_compatible: "Endpoint",
  antigravity: "Antigravity",
  claude: "Claude Code",
  codex: "Codex",
};
/** Who pays, on which host: shown beside the composer and on every reply. */
export function billingLabel(
  value: Pick<QuickConnection, "billing" | "provider" | "label"> & { hostName: string },
) {
  if (value.billing === "tool_sign_in")
    return `Your ${providerNames[value.provider]} sign-in · ${value.hostName}`;
  if (value.billing === "local") return `Local model · ${value.label} · ${value.hostName}`;
  return `Your API key · ${providerNames[value.provider]} · ${value.hostName}`;
}
export function replyLabel(message: QuickMessage) {
  if (!message.billing || !message.provider) return "";
  return `${message.model ?? ""} · ${billingLabel({
    billing: message.billing,
    provider: message.provider,
    label: message.connectionLabel ?? "",
    hostName: message.hostName ?? "",
  })}`;
}
export const connectionStatus: Record<QuickConnection["status"], string> = {
  ready: "Ready",
  needs_sign_in: "Needs sign in",
  quota_exhausted: "Usage limit reached",
  unavailable: "Unavailable",
};
/** Usable for a new message. A reached limit may have reset, so it stays selectable. */
export const usable = (connection: QuickConnection) =>
  ["ready", "quota_exhausted"].includes(connection.status) && connection.models.length > 0;
/** A cheap conversational model to suggest first, from the connection's own list. */
export function recommendedModel(models: readonly QuickModel[]): string | undefined {
  const fast = /(mini|nano|haiku|flash|luna|small|lite|instant)/i;
  return (models.find((model) => fast.test(model.id)) ?? models[0])?.id;
}
/** The saved default, else the first usable connection with its suggested model. */
export function initialSelection(
  connections: readonly QuickConnection[],
  settings: QuickSettings | undefined,
  previous?: { connectionId?: string | undefined; model?: string | undefined },
): { connectionId: string; model: string } | undefined {
  const pick = (id: string | undefined, model: string | undefined) => {
    const connection = connections.find((row) => row.id === id && usable(row));
    if (!connection) return undefined;
    const chosen = connection.models.find((row) => row.id === model)?.id;
    return {
      connectionId: connection.id,
      model: chosen ?? connection.recommendedModel ?? recommendedModel(connection.models) ?? "",
    };
  };
  return (
    pick(previous?.connectionId, previous?.model) ??
    pick(settings?.defaultConnectionId, settings?.defaultModel) ??
    (() => {
      const first = connections.find(usable);
      return first ? pick(first.id, undefined) : undefined;
    })()
  );
}
export const outcomeText: Partial<Record<QuickMessage["status"], string>> = {
  interrupted: "Stopped before the end. Usage up to this point may still count.",
  uncertain: "Unknown result. The provider may have used quota. It was not retried.",
  failed: "Not answered.",
};
export function sourceLabel(source: QuickContextSource) {
  return source.kind === "workspace"
    ? `@${source.label}`
    : source.kind === "brief"
      ? `${source.label} brief`
      : source.label;
}
/** Applies an unsequenced Quick Chat event to the open list and conversation. */
export function applyQuickEvent(
  state: { chats: QuickChat[]; messages: QuickMessage[]; chatId?: string | undefined },
  event: DomainEvent,
) {
  if (event.type === "quickChat.changed") {
    const chat = event.payload as QuickChat;
    return {
      ...state,
      chats: [chat, ...state.chats.filter((row) => row.id !== chat.id)].sort((a, b) =>
        b.updatedAt.localeCompare(a.updatedAt),
      ),
    };
  }
  if (event.type === "quickChat.removed") {
    const id = (event.payload as { id: string }).id;
    return {
      ...state,
      chats: state.chats.filter((row) => row.id !== id),
      ...(state.chatId === id ? { messages: [] } : {}),
    };
  }
  if (event.type === "quickMessage.changed") {
    const message = event.payload as QuickMessage;
    if (message.chatId !== state.chatId) return state;
    const index = state.messages.findIndex((row) => row.id === message.id);
    const messages =
      index < 0
        ? [...state.messages, message]
        : state.messages.map((row) => (row.id === message.id ? message : row));
    return { ...state, messages };
  }
  return state;
}
/** Readable text for daemon error codes such as `quick_connection_needs_sign_in: ...`. */
export function errorText(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const known: Record<string, string> = {
    quick_connection_unavailable: "Choose a connection first.",
    quick_connection_needs_sign_in: "This connection needs you to sign in again.",
    quick_model_unavailable: "This connection does not offer that model.",
    quick_request_unavailable: "That request is no longer waiting.",
    private_value_requires_secure_field:
      "This draft contains a known private value. Remove it before sending.",
    keychain_unavailable: "Secrets need the Mac Keychain, which is not available.",
  };
  const code = message.split(":")[0]?.trim() ?? "";
  const detail = message.slice(code.length + 1).trim();
  return known[code] ?? (detail || "That did not work. Your draft is still here.");
}
/** `mcp__gmail__send_message` reads as `gmail: send message`; other names stay as they are. */
export function toolName(name: string) {
  const match = /^mcp__(.+?)__(.+)$/.exec(name);
  return match ? `${match[1]}: ${match[2]?.replace(/_/g, " ")}` : name.replace(/_/g, " ");
}
/** One line for the tools a reply used, newest last, without repeats. */
export function toolSummary(calls: readonly QuickToolCall[] | undefined) {
  if (!calls?.length) return "";
  const names = [...new Set(calls.map((call) => call.title || toolName(call.name)))];
  const shown = names.slice(0, 4).join(", ");
  const more = names.length > 4 ? ` and ${names.length - 4} more` : "";
  const running = calls.some((call) => call.status === "running");
  return `${running ? "Using" : "Used"} ${shown}${more}`;
}
export const requestOutcome: Record<QuickRequest["state"], string> = {
  pending: "Waiting for you",
  allowed: "Allowed",
  denied: "Declined",
  answered: "Answered",
  expired: "Not answered in time, declined",
};
