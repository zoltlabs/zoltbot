import type { Accessor } from "solid-js";
import type { BotProfile } from "../../data";
import { OrganizationPanel } from "../OrganizationPanel";
import { PanelResizer } from "../PanelResizer";
import {
  CONVERSATION_PANEL_MIN,
  SETTINGS_PANEL_DEFAULT,
  SETTINGS_PANEL_MAX,
  SETTINGS_PANEL_MIN,
} from "./constants";

export function OrganizationSidePanel(props: {
  projectId: string;
  bots: BotProfile[];
  width: number;
  containerWidth: Accessor<number>;
  onResize: (width: number) => void;
  onResizeEnd: (width: number) => void;
  onOpenChat: (botId: string) => void;
  onOpenTasks?: (projectId: string) => void;
  onClose: () => void;
}) {
  return (
    <aside
      id="organization-side-panel"
      class="agent-settings-panel organization-panel"
      aria-label="Organization"
    >
      <PanelResizer
        class="right-panel-resizer"
        label="Resize right panel"
        controls="organization-side-panel"
        direction="right"
        value={props.width}
        defaultValue={SETTINGS_PANEL_DEFAULT}
        min={SETTINGS_PANEL_MIN}
        max={() =>
          Math.min(
            SETTINGS_PANEL_MAX,
            Math.max(SETTINGS_PANEL_MIN, props.containerWidth() - CONVERSATION_PANEL_MIN),
          )
        }
        onResize={props.onResize}
        onResizeEnd={props.onResizeEnd}
      />
      <OrganizationPanel
        projectId={props.projectId}
        bots={props.bots}
        onOpenChat={props.onOpenChat}
        onOpenTasks={props.onOpenTasks}
        onClose={props.onClose}
      />
    </aside>
  );
}
