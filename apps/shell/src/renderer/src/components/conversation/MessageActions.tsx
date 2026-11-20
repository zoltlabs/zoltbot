import { type Accessor, createSignal, For, Show } from "solid-js";
import type { MessageReaction } from "../../../../shared/ipc";
import { MESSAGE_REACTIONS, MORE_MESSAGE_REACTIONS } from "../../../../shared/ipc";
import type { BotMessage } from "../../data";
import { CheckIcon, CopyIcon, MoreIcon, PlusIcon, ReactionIcon, ReplyIcon } from "./icons";

export function MessageActions(props: {
  message: BotMessage;
  pickerOpen: boolean;
  moreOpen: boolean;
  expandedEmoji: boolean;
  copied: boolean;
  onTogglePicker: () => void;
  onToggleMore: () => void;
  onExpandEmoji: () => void;
  onReact: (emoji: MessageReaction | null) => void;
  onReply: () => void;
  onCopy: () => void;
}) {
  return (
    <div
      class="message-actions"
      classList={{ "message-actions-open": props.pickerOpen || props.moreOpen }}
      role="toolbar"
      aria-label={`${props.message.author === "you" ? "User" : "Agent"} message actions`}
    >
      <div class="message-action-popover-anchor">
        <button
          type="button"
          class="message-action-button"
          aria-label="Add reaction"
          aria-expanded={props.pickerOpen}
          onClick={props.onTogglePicker}
        >
          <ReactionIcon />
        </button>
        <Show when={props.pickerOpen}>
          <div class="reaction-picker" role="menu" aria-label="Choose a reaction">
            <div class="reaction-picker-row">
              <For each={MESSAGE_REACTIONS}>
                {(emoji) => (
                  <button
                    type="button"
                    role="menuitemradio"
                    aria-checked={props.message.reaction === emoji}
                    aria-label={`React with ${emoji}`}
                    onClick={() => props.onReact(props.message.reaction === emoji ? null : emoji)}
                  >
                    {emoji}
                  </button>
                )}
              </For>
              <button
                type="button"
                class="reaction-more-button"
                aria-label="More emoji"
                aria-expanded={props.expandedEmoji}
                onClick={props.onExpandEmoji}
              >
                <PlusIcon />
              </button>
            </div>
            <Show when={props.expandedEmoji}>
              <div class="reaction-picker-row reaction-picker-more">
                <For each={MORE_MESSAGE_REACTIONS}>
                  {(emoji) => (
                    <button
                      type="button"
                      role="menuitemradio"
                      aria-checked={props.message.reaction === emoji}
                      aria-label={`React with ${emoji}`}
                      onClick={() => props.onReact(props.message.reaction === emoji ? null : emoji)}
                    >
                      {emoji}
                    </button>
                  )}
                </For>
              </div>
            </Show>
          </div>
        </Show>
      </div>
      <button
        type="button"
        class="message-action-button"
        aria-label={`Reply to ${props.message.author === "you" ? "User" : "Agent"} message`}
        onClick={props.onReply}
      >
        <ReplyIcon />
      </button>
      <div class="message-action-popover-anchor">
        <button
          type="button"
          class="message-action-button"
          aria-label="More message actions"
          aria-expanded={props.moreOpen}
          onClick={props.onToggleMore}
        >
          <MoreIcon />
        </button>
        <Show when={props.moreOpen}>
          <div class="message-more-menu" role="menu">
            <button type="button" role="menuitem" onClick={props.onCopy}>
              {props.copied ? <CheckIcon /> : <CopyIcon />}
              <span>{props.copied ? "Copied" : "Copy"}</span>
            </button>
          </div>
        </Show>
      </div>
    </div>
  );
}

/** Which message's reaction picker or More menu is open, and the actions they run. */
export function createMessageActionsState(deps: {
  botId: Accessor<string | undefined>;
  onReply: (message: BotMessage) => void;
  onError: (message: string) => void;
}) {
  const [openReactionMessageId, setOpenReactionMessageId] = createSignal<string | null>(null);
  const [openMoreMessageId, setOpenMoreMessageId] = createSignal<string | null>(null);
  const [expandedEmojiMessageId, setExpandedEmojiMessageId] = createSignal<string | null>(null);
  const [copiedMessageId, setCopiedMessageId] = createSignal<string | null>(null);

  function closeAll() {
    setOpenReactionMessageId(null);
    setOpenMoreMessageId(null);
    setExpandedEmojiMessageId(null);
  }

  function togglePicker(messageId: string) {
    setOpenReactionMessageId((current) => (current === messageId ? null : messageId));
    setOpenMoreMessageId(null);
    setExpandedEmojiMessageId(null);
  }

  function toggleMore(messageId: string) {
    setOpenMoreMessageId((current) => (current === messageId ? null : messageId));
    setOpenReactionMessageId(null);
    setExpandedEmojiMessageId(null);
  }

  function toggleExpandedEmoji(messageId: string) {
    setExpandedEmojiMessageId((current) => (current === messageId ? null : messageId));
  }

  function reply(message: BotMessage) {
    deps.onReply(message);
    setOpenReactionMessageId(null);
    setOpenMoreMessageId(null);
  }

  async function react(message: BotMessage, emoji: MessageReaction | null) {
    const botId = deps.botId();
    if (!botId) return;
    setOpenReactionMessageId(null);
    setExpandedEmojiMessageId(null);
    try {
      await window.openbot.agent.setMessageReaction({ botId, messageId: message.id, emoji });
    } catch (error) {
      deps.onError(error instanceof Error ? error.message : String(error));
    }
  }

  async function copy(message: BotMessage) {
    const text = message.body;
    if (!text) return;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const input = document.createElement("textarea");
        input.value = text;
        input.style.position = "fixed";
        input.style.opacity = "0";
        document.body.append(input);
        input.select();
        document.execCommand("copy");
        input.remove();
      }
      setCopiedMessageId(message.id);
      window.setTimeout(() => {
        if (copiedMessageId() === message.id) setCopiedMessageId(null);
      }, 1_400);
    } catch (error) {
      deps.onError(error instanceof Error ? error.message : "Could not copy the message.");
    }
  }

  return {
    openReactionMessageId,
    openMoreMessageId,
    expandedEmojiMessageId,
    copiedMessageId,
    closeAll,
    togglePicker,
    toggleMore,
    toggleExpandedEmoji,
    reply,
    react: (message: BotMessage, emoji: MessageReaction | null) => void react(message, emoji),
    copy: (message: BotMessage) => void copy(message),
  };
}

export type MessageActionsState = ReturnType<typeof createMessageActionsState>;
