import type { AgentEvent, BotSummary } from "../shared/ipc";

export interface AgentNotificationContent {
  title: string;
  body: string;
}

export function notificationForAgentEvent(
  event: AgentEvent,
  bots: BotSummary[],
): AgentNotificationContent | null {
  // Agent requests notify through Zoltbot's planner (zolt-notifications.ts), with answer actions.
  if (event.type !== "turn-completed") return null;

  const bot = bots.find((candidate) => candidate.id === event.botId);
  if (!bot?.notifications) return null;

  if (event.status !== "completed") return null;
  return { title: bot.name, body: "Finished working." };
}
