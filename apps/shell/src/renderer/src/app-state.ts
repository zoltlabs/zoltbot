import { type Accessor, batch, createSignal } from "solid-js";
import { createMutable } from "solid-js/store";
import type { AgentEvent, ConversationSnapshot, QueueSnapshot } from "../../shared/ipc";
import { botMessagesEqual, formatTime, retainThinkingMessages, toBotMessages } from "./app-model";
import type { BotMessage } from "./data";

/** Per-agent conversation state: messages, revisions, turns, queues and reply markers. */
export function createConversationState(activeBotId: Accessor<string>) {
  const [liveMessages, setLiveMessages] = createSignal<Record<string, BotMessage[]>>({});
  const [uiErrors, setUiErrors] = createSignal<Record<string, BotMessage[]>>({});
  const [conversationLoaded, setConversationLoaded] = createSignal<Record<string, boolean>>({});
  const [conversationRevisions, setConversationRevisions] = createSignal<Record<string, number>>(
    {},
  );
  const [activeTurns, setActiveTurns] = createSignal<Record<string, string | null>>({});
  const [unreadReplies, setUnreadReplies] = createSignal<Record<string, number>>({});
  const [recentReplies, setRecentReplies] = createSignal<Record<string, boolean>>({});
  const [queues, setQueues] = createSignal<Record<string, QueueSnapshot>>({});
  const pendingConversationSnapshots = new Map<string, ConversationSnapshot>();
  let conversationFrame: number | undefined;
  const recentReplyTimers = new Map<string, ReturnType<typeof setTimeout>>();

  function scheduleConversation(snapshot: ConversationSnapshot) {
    const botId = snapshot.botId;
    const appliedRevision = conversationRevisions()[botId] ?? -1;
    const pendingRevision = pendingConversationSnapshots.get(botId)?.revision ?? -1;
    if (snapshot.revision < Math.max(appliedRevision, pendingRevision)) return;
    pendingConversationSnapshots.set(botId, snapshot);
    if (conversationFrame !== undefined) return;
    conversationFrame = requestAnimationFrame(() => {
      conversationFrame = undefined;
      const snapshots = [...pendingConversationSnapshots.values()];
      pendingConversationSnapshots.clear();
      batch(() => {
        for (const pending of snapshots) applyConversation(pending);
      });
    });
  }

  function applyConversationDelta(event: Extract<AgentEvent, { type: "conversation-delta" }>) {
    if (event.revision <= (conversationRevisions()[event.botId] ?? -1)) return;
    pendingConversationSnapshots.delete(event.botId);
    setConversationRevisions((current) => ({ ...current, [event.botId]: event.revision }));

    const existing = liveMessages()[event.botId]?.find((message) => message.id === event.messageId);
    if (existing) {
      existing.body += event.delta;
      existing.streaming = true;
    } else {
      const message = createMutable<BotMessage>({
        id: event.messageId,
        turnId: event.turnId,
        author: "bot",
        body: event.delta,
        time: formatTime(event.createdAt),
        streaming: true,
        animate: conversationLoaded()[event.botId] === true,
        kind: "text",
      });
      setLiveMessages((current) => ({
        ...current,
        [event.botId]: [...(current[event.botId] ?? []), message],
      }));
    }
    setConversationLoaded((current) => ({ ...current, [event.botId]: true }));
  }

  function applyConversation(snapshot: ConversationSnapshot) {
    const botId = snapshot.botId;
    if (snapshot.revision < (conversationRevisions()[botId] ?? -1)) return;
    const initialLoad = conversationLoaded()[botId] !== true;
    setConversationRevisions((current) => ({ ...current, [botId]: snapshot.revision }));
    setLiveMessages((current) => {
      const previous = current[botId] ?? [];
      const previousById = new Map(previous.map((message) => [message.id, message]));
      const mappedMessages = retainThinkingMessages(previous, toBotMessages(snapshot.messages));
      const next = mappedMessages.map((mapped) => {
        const existing = previousById.get(mapped.id);
        if (!existing) return createMutable({ ...mapped, animate: !initialLoad });
        if (!botMessagesEqual(existing, mapped)) Object.assign(existing, mapped);
        return existing;
      });
      if (
        previous.length === next.length &&
        previous.every((message, index) => message === next[index])
      ) {
        return current;
      }
      return { ...current, [botId]: next };
    });
    setConversationLoaded((current) => ({ ...current, [botId]: true }));
    setActiveTurns((current) => ({ ...current, [botId]: snapshot.activeTurnId }));
  }

  function markReplyCompleted(botId: string) {
    if (activeBotId() !== botId) {
      setUnreadReplies((current) => ({
        ...current,
        [botId]: Math.min(99, (current[botId] ?? 0) + 1),
      }));
      return;
    }
    clearRecentReply(botId);
    setRecentReplies((current) => ({ ...current, [botId]: true }));
    recentReplyTimers.set(
      botId,
      setTimeout(() => {
        recentReplyTimers.delete(botId);
        setRecentReplies((current) => ({ ...current, [botId]: false }));
      }, 4000),
    );
  }

  function clearRecentReply(botId: string) {
    const timer = recentReplyTimers.get(botId);
    if (timer) clearTimeout(timer);
    recentReplyTimers.delete(botId);
    setRecentReplies((current) => (current[botId] ? { ...current, [botId]: false } : current));
  }

  function clearReplyIndicators(botId: string) {
    clearRecentReply(botId);
    setUnreadReplies((current) => (current[botId] ? { ...current, [botId]: 0 } : current));
  }

  function forgetReplyTimer(botId: string) {
    const replyTimer = recentReplyTimers.get(botId);
    if (replyTimer) clearTimeout(replyTimer);
    recentReplyTimers.delete(botId);
  }

  function dispose() {
    if (conversationFrame !== undefined) cancelAnimationFrame(conversationFrame);
    for (const timer of recentReplyTimers.values()) clearTimeout(timer);
    recentReplyTimers.clear();
  }

  return {
    liveMessages,
    setLiveMessages,
    uiErrors,
    setUiErrors,
    conversationLoaded,
    setConversationLoaded,
    conversationRevisions,
    setConversationRevisions,
    activeTurns,
    setActiveTurns,
    unreadReplies,
    setUnreadReplies,
    recentReplies,
    setRecentReplies,
    queues,
    setQueues,
    scheduleConversation,
    applyConversationDelta,
    markReplyCompleted,
    clearRecentReply,
    clearReplyIndicators,
    forgetReplyTimer,
    dispose,
  };
}
