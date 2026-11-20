import { Show } from "solid-js";
import { Portal } from "solid-js/web";
import type { BotProfile } from "../../data";
import { AgentAvatar } from "../AgentAvatar";
import { DeleteIcon, EditIcon, RenameIcon } from "../SidebarIcons";

export interface BotContextMenu {
  botId: string;
  x: number;
  y: number;
}

export function AgentContextMenu(props: {
  menu: BotContextMenu;
  mount: HTMLElement | undefined;
  firstItemRef: (element: HTMLButtonElement) => void;
  onClose: () => void;
  onRename: (botId: string) => void;
  onEdit: (botId: string) => void;
  onDelete: (botId: string) => void;
}) {
  return (
    // Mounted in the sidebar so the menu stays inside its landmark.
    <Portal mount={props.mount}>
      <div
        class="bot-context-menu"
        role="menu"
        aria-label="Agent actions"
        style={{ left: `${props.menu.x}px`, top: `${props.menu.y}px` }}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <button
          ref={props.firstItemRef}
          type="button"
          role="menuitem"
          onClick={() => {
            const botId = props.menu.botId;
            props.onClose();
            props.onRename(botId);
          }}
        >
          <RenameIcon />
          <span>Rename</span>
        </button>
        <button
          type="button"
          role="menuitem"
          onClick={() => {
            const botId = props.menu.botId;
            props.onClose();
            props.onEdit(botId);
          }}
        >
          <EditIcon />
          <span>Edit agent</span>
        </button>
        <div class="bot-context-separator" />
        <button
          type="button"
          role="menuitem"
          class="bot-context-danger"
          onClick={() => {
            const botId = props.menu.botId;
            props.onClose();
            props.onDelete(botId);
          }}
        >
          <DeleteIcon />
          <span>Delete agent</span>
        </button>
      </div>
    </Portal>
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
    <Portal>
      <div
        class="bot-delete-backdrop"
        role="presentation"
        onPointerDown={(event) => {
          if (event.currentTarget === event.target && !props.deleting) props.onCancel();
        }}
      >
        <section
          class="bot-delete-dialog"
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="bot-delete-title"
          aria-describedby="bot-delete-description"
        >
          <AgentAvatar
            bot={props.bot}
            style={{ width: "44px", height: "44px", "margin-bottom": "15px" }}
          />
          <h2 id="bot-delete-title">Delete {props.bot.name}?</h2>
          <p id="bot-delete-description">
            This removes the agent, its Zoltbot queue, and managed files used only by that
            conversation. Its workspace and CLI history stay on your Mac.
          </p>
          <Show when={props.error}>{(message) => <p class="bot-delete-error">{message()}</p>}</Show>
          <div class="bot-delete-actions">
            <button type="button" disabled={props.deleting} onClick={() => props.onCancel()}>
              Cancel
            </button>
            <button
              type="button"
              class="bot-delete-confirm"
              disabled={props.deleting}
              onClick={props.onConfirm}
            >
              {props.deleting ? "Deleting…" : "Delete"}
            </button>
          </div>
        </section>
      </div>
    </Portal>
  );
}
