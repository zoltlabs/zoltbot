import type { JSX } from "solid-js";
import type { BotMessage } from "../../data";
import { type MessageKey, t } from "../../i18n";
import type { MenuItem } from "../../kit";
import type { BranchMode } from "./Branching";
import { BranchIcon, CopyIcon, EditIcon, ReplyIcon } from "./icons";

/** What a message menu item can do. The conversation supplies these. */
export interface MessageMenuActions {
  reply: (message: BotMessage) => void;
  copy: (message: BotMessage) => void;
  branch: (message: BotMessage, mode: BranchMode) => void;
}

/**
 * One entry in the message menu. The More button and a right-click on the message open the
 * same menu, built from this list, so a new action is added here once.
 */
export interface MessageMenuEntry {
  id: string;
  label: MessageKey;
  icon: () => JSX.Element;
  /** Entries with the same group sit together; a separator is drawn between groups. */
  group: number;
  /** Whether the entry applies to this message. Defaults to always. */
  when?: (message: BotMessage) => boolean;
  run: (message: BotMessage, actions: MessageMenuActions) => void;
}

/** Gives the message icons, which are drawn with strokes, the menu's size and color. */
function MenuIcon(props: { icon: JSX.Element }) {
  return <span class="message-menu-icon">{props.icon}</span>;
}

export const MESSAGE_MENU: readonly MessageMenuEntry[] = [
  {
    id: "reply",
    label: "chat.message.reply",
    icon: () => <MenuIcon icon={<ReplyIcon />} />,
    group: 0,
    run: (message, actions) => actions.reply(message),
  },
  {
    id: "copy",
    label: "chat.message.copy",
    icon: () => <MenuIcon icon={<CopyIcon />} />,
    group: 0,
    when: (message) => Boolean(message.body),
    run: (message, actions) => actions.copy(message),
  },
  {
    id: "branch",
    label: "chat.message.branch",
    icon: () => <MenuIcon icon={<BranchIcon />} />,
    group: 1,
    when: (message) => Boolean(message.turnId) && !message.streaming,
    run: (message, actions) => actions.branch(message, "branch"),
  },
  {
    id: "edit",
    label: "chat.message.edit",
    icon: () => <MenuIcon icon={<EditIcon />} />,
    group: 1,
    when: (message) => message.author === "you" && Boolean(message.turnId),
    run: (message, actions) => actions.branch(message, "edit"),
  },
];

/** The menu's groups for one message, in order, skipping entries that don't apply. */
export function messageMenuGroups(
  message: BotMessage,
  actions: MessageMenuActions,
  entries: readonly MessageMenuEntry[] = MESSAGE_MENU,
): MenuItem[][] {
  const groups = new Map<number, MenuItem[]>();
  for (const entry of entries) {
    if (entry.when && !entry.when(message)) continue;
    const group = groups.get(entry.group) ?? [];
    group.push({
      id: entry.id,
      label: t(entry.label),
      icon: entry.icon(),
      run: () => entry.run(message, actions),
    });
    groups.set(entry.group, group);
  }
  return [...groups.entries()].sort(([a], [b]) => a - b).map(([, items]) => items);
}
