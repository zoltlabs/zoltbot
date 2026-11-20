import type { BotProfile } from "../../data";
import { type Anchor, ConfirmDialog, Menu } from "../../kit";
import { DeleteIcon, EditIcon, RenameIcon } from "../SidebarIcons";

export interface BotContextMenu {
  botId: string;
  /** The row's actions button, or the point that was right-clicked. */
  anchor: Anchor;
  /** The agent's row, which gets focus back when the menu closes. */
  owner: HTMLElement;
}

export function AgentContextMenu(props: {
  menu: BotContextMenu;
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
