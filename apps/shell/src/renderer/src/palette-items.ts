// What the command palette lists, built from the app's stores. App.tsx passes the actions.
import type { ChannelSummary } from "../../shared/channels";
import type { TaskSummary } from "../../shared/tasks";
import { shortcuts } from "./app-shortcuts";
import type { BotProfile } from "./data";
import { t } from "./i18n";
import { PAGES } from "./pages";
import type { PaletteItem } from "./palette";

const DONE: ReadonlySet<TaskSummary["state"]> = new Set(["completed", "failed", "cancelled"]);

export interface PaletteSources {
  bots: readonly BotProfile[];
  channels: readonly ChannelSummary[];
  tasks: readonly TaskSummary[];
  openChat: (botId: string) => void;
  openChannel: (channelId: string) => void;
  openTasks: (projectId?: string | null) => void;
  openMap: () => void;
  openModels: () => void;
  openMemory: () => void;
  openUsage: () => void;
  openVault?: () => void;
  newChat: () => void;
}

export function paletteItems(sources: PaletteSources): PaletteItem[] {
  const items: PaletteItem[] = [];
  for (const bot of sources.bots) {
    const agent = Boolean(bot.companyRole);
    const detail = agent ? bot.roleLabel : bot.projectName;
    items.push({
      id: `chat:${bot.id}`,
      group: agent ? "agents" : "chats",
      label: bot.name,
      ...(detail ? { detail } : {}),
      run: () => sources.openChat(bot.id),
    });
  }
  for (const channel of sources.channels)
    items.push({
      id: `channel:${channel.id}`,
      group: "channels",
      label: channel.name,
      run: () => sources.openChannel(channel.id),
    });
  for (const task of sources.tasks) {
    if (DONE.has(task.state)) continue;
    const threadId = task.threadId;
    items.push({
      id: `task:${task.id}`,
      group: "tasks",
      label: task.title,
      ...(task.projectName ? { detail: task.projectName } : {}),
      run: () =>
        threadId && sources.bots.some((bot) => bot.id === threadId)
          ? sources.openChat(threadId)
          : sources.openTasks(task.projectId),
    });
  }
  const pageActions = {
    tasks: () => sources.openTasks(),
    map: sources.openMap,
    models: sources.openModels,
    memory: sources.openMemory,
    usage: sources.openUsage,
    ...(sources.openVault ? { vault: sources.openVault } : {}),
  } as const;
  for (const [id, open] of Object.entries(pageActions))
    items.push({
      id: `page:${id}`,
      group: "pages",
      label: PAGES[id as keyof typeof PAGES].label,
      run: open,
    });
  items.push({
    id: "command:new-chat",
    group: "commands",
    label: t("palette.command.newChat"),
    run: sources.newChat,
  });
  // App-wide commands registered with keys. Ones that only make sense in place, such as
  // Escape, and ones that repeat a page above are left out.
  const repeats = new Set(["app.palette", "app.tasks", "app.map", "app.models"]);
  for (const shortcut of shortcuts.list()) {
    if (shortcut.when !== "global" || repeats.has(shortcut.id) || shortcut.keys === "Escape")
      continue;
    items.push({
      id: `command:${shortcut.id}`,
      group: "commands",
      label: shortcut.label,
      run: () => {
        shortcut.run(new KeyboardEvent("keydown"));
      },
    });
  }
  return items;
}
