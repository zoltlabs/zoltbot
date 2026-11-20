import { type Accessor, createSignal, For, Show } from "solid-js";
import type { MessageReaction } from "../../../../shared/ipc";
import { MESSAGE_REACTIONS, MORE_MESSAGE_REACTIONS } from "../../../../shared/ipc";
import type { BotMessage } from "../../data";
import { t } from "../../i18n";
import { type Anchor, Menu, Popover, showToast } from "../../kit";
import type { BranchMode } from "./Branching";
import { requestHide, setHidden } from "./hide-flow";
import { MoreIcon, PlusIcon, ReactionIcon, ReplyIcon } from "./icons";
import { messageMenuGroups } from "./messageMenu";
import { isPinned, setPinned } from "./pins-store";

export function MessageActions(props: { message: BotMessage; actions: MessageActionsState }) {
  let reactionButton: HTMLButtonElement | undefined;
  let moreButton: HTMLButtonElement | undefined;
  const author = () => ({ author: props.message.author });
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
      aria-label={t("chat.message.react", { emoji })}
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
      aria-label={t("chat.message.actions", author())}
    >
      <button
        ref={reactionButton}
        type="button"
        class="message-action-button"
        aria-label={t("chat.message.addReaction")}
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
            label={t("chat.message.chooseReaction")}
            placement={props.message.author === "you" ? "top-end" : "top-start"}
            onClose={() => props.actions.closeAll()}
          >
            <div class="reaction-picker">
              <div class="reaction-picker-row">
                <For each={MESSAGE_REACTIONS}>{emojiButton}</For>
                <button
                  type="button"
                  class="reaction-more-button"
                  aria-label={t("chat.message.moreEmoji")}
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
        aria-label={t("chat.message.replyTo", author())}
        onClick={() => props.actions.reply(props.message)}
      >
        <ReplyIcon />
      </button>
      <button
        ref={moreButton}
        type="button"
        class="message-action-button message-more-button"
        aria-label={t("chat.message.moreActions")}
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
            label={t("chat.message.menu")}
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
  /** Text selected in the message when it was right-clicked. Copy copies it instead. */
  selection?: string;
}

/** Which message's reaction picker or menu is open, and the actions they run. */
export function createMessageActionsState(deps: {
  botId: Accessor<string | undefined>;
  onReply: (message: BotMessage) => void;
  onBranch: (message: BotMessage, mode: BranchMode) => void;
  onError: (message: string) => void;
}) {
  const [openReactionMessageId, setOpenReactionMessageId] = createSignal<string | null>(null);
  const [menu, setMenu] = createSignal<OpenMessageMenu | null>(null);
  const [expandedEmojiMessageId, setExpandedEmojiMessageId] = createSignal<string | null>(null);
  // The menu closes before its item runs, so Copy reads the selection from here.
  let lastSelection: { messageId: string; text: string } | null = null;

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
    lastSelection = null;
    if (opening) setMenu({ messageId, anchor: button });
  }

  /** Opens the message menu for a right-click on the message, at the pointer. */
  function openMenuAt(messageId: string, anchor: Anchor, owner?: HTMLElement, selection?: string) {
    closeAll();
    setMenu({ messageId, anchor, owner, selection });
    lastSelection = selection ? { messageId, text: selection } : null;
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
    const text = lastSelection?.messageId === message.id ? lastSelection.text : message.body;
    lastSelection = null;
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
      showToast({ message: t("chat.message.copied") });
    } catch {
      showToast({ message: t("chat.message.copyFailed") });
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
    branch: (message: BotMessage, mode: BranchMode) => deps.onBranch(message, mode),
    isPinned: (message: BotMessage) => isPinned(deps.botId(), message.id),
    hide: (message: BotMessage) => {
      const botId = deps.botId();
      closeAll();
      if (botId) void requestHide(botId, message.id, deps.onError);
    },
    show: (message: BotMessage) => {
      const botId = deps.botId();
      if (botId) void setHidden(botId, message.id, false, deps.onError);
    },
    pin: (message: BotMessage, pinned: boolean) => {
      const botId = deps.botId();
      closeAll();
      if (!botId) return;
      setPinned(botId, message.id, pinned)
        .then(() =>
          showToast({ message: t(pinned ? "chat.message.pinned" : "chat.message.unpinned") }),
        )
        .catch((error: unknown) =>
          deps.onError(error instanceof Error ? error.message : String(error)),
        );
    },
  };
}

export type MessageActionsState = ReturnType<typeof createMessageActionsState>;
