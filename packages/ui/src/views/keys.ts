import type { appKeys } from "@zoltbot/view-api";
import { useShell } from "../state.js";
export function viewKey(combo: (typeof appKeys)[number]) {
  const shell = useShell.getState();
  if (combo === "mod+k") shell.setPalette(true);
  if (combo === "mod+b") shell.toggleSidebar();
  if (combo === "mod+i") shell.navigate("Inbox");
  if (combo === "mod+j") shell.openQuickChat();
  if (combo === "mod+,") shell.navigate("Settings");
  if (combo === "escape-exit") {
    if (!shell.sidebar) shell.toggleSidebar();
    document.querySelector<HTMLElement>("#workspace-sidebar button")?.focus();
  }
}
