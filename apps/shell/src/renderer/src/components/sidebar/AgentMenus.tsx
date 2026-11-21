import type { JSX } from "solid-js";
import type { ThreadAction } from "../../../../shared/thread-actions";
import type { BotProfile } from "../../data";
import { type MessageKey, t } from "../../i18n";
import { type Anchor, ConfirmDialog, Menu, type MenuItem } from "../../kit";
import { DeleteIcon, EditIcon, RenameIcon } from "../SidebarIcons";
import { ArchiveIcon, MutedIcon, PinIcon, UnreadIcon } from "./ChatIcons";

export interface BotContextMenu {
  botId: string;
  /** The row's actions button, or the point that was right-clicked. */
  anchor: Anchor;
  /** The agent's row, which gets focus back when the menu closes. */
  owner: HTMLElement;
}

/**
 * Pin, read state and archive for a plain chat. Agents keep the company's order and task chats
 * can't be archived, so they get none. Archive waits until the chat is idle, since it stops work.
 */
export function chatMenuItems(
  bot: BotProfile | undefined,
  state: { unread: boolean; working: boolean },
  run: ((bot: BotProfile, action: ThreadAction) => void) | undefined,
): MenuItem[] {
  if (!bot || !run || bot.kind === "task" || (bot.companyRole && bot.companyRole !== "chat"))
    return [];
  const item = (id: ThreadAction, label: MessageKey, Icon: () => JSX.Element): MenuItem => ({
    id,
    label: t(label),
    icon: <Icon />,
    run: () => run(bot, id),
  });
  return [
    bot.pinned
      ? item("unpin", "sidebar.chat.unpin", PinIcon)
      : item("pin", "sidebar.chat.pin", PinIcon),
    state.unread
      ? item("markRead", "sidebar.chat.markRead", UnreadIcon)
      : item("markUnread", "sidebar.chat.markUnread", UnreadIcon),
    bot.muted
      ? item("unmute", "sidebar.chat.unmute", MutedIcon)
      : item("mute", "sidebar.chat.mute", MutedIcon),
    ...(state.working ? [] : [item("archive", "sidebar.chat.archive", ArchiveIcon)]),
  ];
}

export function AgentContextMenu(props: {
  menu: BotContextMenu;
  /** Pin, read state and archive, when the chat supports them. */
  chatItems?: MenuItem[];
  onClose: () => void;
  onRename: (botId: string) => void;
  onEdit: (botId: string) => void;
  onDelete: (botId: string) => void;
}) {
  const botId = props.menu.botId;
  return (
    <Menu
      anchor={props.menu.anchor}
      owner={props.menu.owner}
      label="Agent actions"
      groups={[
        [
          { id: "rename", label: "Rename", icon: <RenameIcon />, run: () => props.onRename(botId) },
          { id: "edit", label: "Edit agent", icon: <EditIcon />, run: () => props.onEdit(botId) },
        ],
        props.chatItems ?? [],
        [
          {
            id: "delete",
            label: "Delete agent",
            icon: <DeleteIcon />,
            danger: true,
            run: () => props.onDelete(botId),
          },
        ],
      ]}
      onClose={props.onClose}
    />
  );
}

export function DeleteAgentDialog(props: {
  bot: BotProfile;
  deleting: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <ConfirmDialog
      title={`Delete ${props.bot.name}?`}
      body="Removes the agent, its queue and the files only this chat used. Its workspace and history stay on your Mac."
      confirmLabel="Delete agent"
      busyLabel="Deleting…"
      danger
      busy={props.deleting}
      error={props.error ?? undefined}
      onConfirm={props.onConfirm}
      onCancel={props.onCancel}
    />
  );
}
