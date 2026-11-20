import { type Accessor, createSignal, For, Show } from "solid-js";
import type { MessageReaction } from "../../../../shared/ipc";
import { MESSAGE_REACTIONS, MORE_MESSAGE_REACTIONS } from "../../../../shared/ipc";
import type { BotMessage } from "../../data";
import { type Anchor, Menu, Popover, showToast } from "../../kit";
import { MoreIcon, PlusIcon, ReactionIcon, ReplyIcon } from "./icons";
import { messageMenuGroups } from "./messageMenu";

export function MessageActions(props: { message: BotMessage; actions: MessageActionsState }) {
  let reactionButton: HTMLButtonElement | undefined;
  let moreButton: HTMLButtonElement | undefined;
  const who = () => (props.message.author === "you" ? "User" : "Agent");
  const pickerOpen = () => props.actions.openReactionMessageId() === props.message.id;
  const menu = () => {
    const open = props.actions.menu();
    return open?.messageId === props.message.id ? open : null;
  };
  const expandedEmoji = () => props.actions.expandedEmojiMessageId() === props.message.id;
  const react = (emoji: MessageReaction) =>
    props.actions.react(props.message, props.message.reaction === emoji ? null : emoji);

  const emojiButton = (emoji: MessageReaction) => (
    <button
      type="button"
      aria-pressed={props.message.reaction === emoji}
      aria-label={`React with ${emoji}`}
      onClick={() => react(emoji)}
    >
      {emoji}
    </button>
  );

  return (
    <div
      class="message-actions"
      classList={{ "message-actions-open": pickerOpen() || menu() !== null }}
      role="toolbar"
      aria-label={`${who()} message actions`}
    >
      <button
        ref={reactionButton}
        type="button"
        class="message-action-button"
        aria-label="Add reaction"
        aria-haspopup="dialog"
        aria-expanded={pickerOpen()}
        onClick={() => props.actions.togglePicker(props.message.id)}
      >
        <ReactionIcon />
      </button>
      <Show when={pickerOpen() && reactionButton}>
        {(anchor) => (
          <Popover
            anchor={anchor()}
            label="Choose a reaction"
            placement={props.message.author === "you" ? "top-end" : "top-start"}
            onClose={() => props.actions.closeAll()}
          >
            <div class="reaction-picker">
              <div class="reaction-picker-row">
                <For each={MESSAGE_REACTIONS}>{emojiButton}</For>
                <button
                  type="button"
                  class="reaction-more-button"
                  aria-label="More emoji"
                  aria-expanded={expandedEmoji()}
                  onClick={() => props.actions.toggleExpandedEmoji(props.message.id)}
                >
                  <PlusIcon />
                </button>
              </div>
              <Show when={expandedEmoji()}>
                <div class="reaction-picker-row reaction-picker-more">
                  <For each={MORE_MESSAGE_REACTIONS}>{emojiButton}</For>
                </div>
              </Show>
            </div>
          </Popover>
        )}
      </Show>
      <button
        type="button"
        class="message-action-button"
        aria-label={`Reply to ${who()} message`}
        onClick={() => props.actions.reply(props.message)}
      >
        <ReplyIcon />
      </button>
      <button
        ref={moreButton}
        type="button"
        class="message-action-button message-more-button"
        aria-label="More message actions"
        aria-haspopup="menu"
        aria-expanded={menu() !== null}
        onClick={() => moreButton && props.actions.toggleMenu(props.message.id, moreButton)}
      >
        <MoreIcon />
      </button>
      <Show when={menu()}>
        {(open) => (
          <Menu
            anchor={open().anchor}
            owner={open().owner}
            label="Message actions"
            placement={props.message.author === "you" ? "bottom-end" : "bottom-start"}
            groups={messageMenuGroups(props.message, props.actions)}
            onClose={() => props.actions.closeAll()}
          />
        )}
      </Show>
    </div>
  );
}

interface OpenMessageMenu {
  messageId: string;
  /** The More button, or the point of a right-click. */
  anchor: Anchor;
  /** For a right-click, the message's More button, which gets focus back. */
  owner?: HTMLElement;
}

/** Which message's reaction picker or menu is open, and the actions they run. */
export function createMessageActionsState(deps: {
  botId: Accessor<string | undefined>;
  onReply: (message: BotMessage) => void;
  onError: (message: string) => void;
}) {
  const [openReactionMessageId, setOpenReactionMessageId] = createSignal<string | null>(null);
  const [menu, setMenu] = createSignal<OpenMessageMenu | null>(null);
  const [expandedEmojiMessageId, setExpandedEmojiMessageId] = createSignal<string | null>(null);

  function closeAll() {
    setOpenReactionMessageId(null);
    setMenu(null);
    setExpandedEmojiMessageId(null);
  }

  function togglePicker(messageId: string) {
    const opening = openReactionMessageId() !== messageId;
    closeAll();
    if (opening) setOpenReactionMessageId(messageId);
  }

  function toggleMenu(messageId: string, button: HTMLElement) {
    const opening = menu()?.messageId !== messageId;
    closeAll();
    if (opening) setMenu({ messageId, anchor: button });
  }

  /** Opens the message menu for a right-click on the message, at the pointer. */
  function openMenuAt(messageId: string, anchor: Anchor, owner?: HTMLElement) {
    closeAll();
    setMenu({ messageId, anchor, owner });
  }

  function toggleExpandedEmoji(messageId: string) {
    setExpandedEmojiMessageId((current) => (current === messageId ? null : messageId));
  }

  function reply(message: BotMessage) {
    deps.onReply(message);
    closeAll();
  }

  async function react(message: BotMessage, emoji: MessageReaction | null) {
    const botId = deps.botId();
    if (!botId) return;
    closeAll();
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
      showToast({ message: "Copied" });
    } catch {
      showToast({ message: "Couldn't copy the message" });
    }
  }

  return {
    openReactionMessageId,
    menu,
    expandedEmojiMessageId,
    closeAll,
    togglePicker,
    toggleMenu,
    openMenuAt,
    toggleExpandedEmoji,
    reply,
    react: (message: BotMessage, emoji: MessageReaction | null) => void react(message, emoji),
    copy: (message: BotMessage) => void copy(message),
  };
}

export type MessageActionsState = ReturnType<typeof createMessageActionsState>;
