// S6: the Usage page's rows, read from the daemon snapshot. Each usage record is tied to the
// chat or agent that ran it through its session.
import type { SpendBudget, SpendRow, SpendView } from "../shared/spend";
import { text } from "./mapping";

type Row = Record<string, unknown>;
type Entities = Record<string, Row[] | undefined>;

const count = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);

export function toSpendView(snapshot: { entities: Entities }, from: string): SpendView {
  const { entities } = snapshot;
  const start = Date.parse(from);
  const byId = (kind: string) => new Map((entities[kind] ?? []).map((row) => [text(row.id), row]));
  const sessions = byId("session");
  const threads = byId("thread");
  const agents = byId("agent");
  const projects = byId("project");
  const rows: SpendRow[] = [];
  for (const record of entities.usage ?? []) {
    const at = text(record.recordedAt);
    if (!(Date.parse(at) >= start)) continue;
    const session = sessions.get(text(record.sessionId));
    const botId = text(session?.threadId);
    const thread = threads.get(botId);
    const agent = agents.get(text(thread?.agentId));
    // The record's own project, as budgets count it; a chat moved later doesn't move its runs.
    const projectId = text(record.projectId) || null;
    rows.push({
      at,
      botId,
      botName: text(thread?.title) || text(agent?.name),
      projectId,
      projectName: text(projects.get(projectId ?? "")?.name),
      model: text(session?.model),
      costUsd: count(record.costUsd),
      costKnown: record.costKnown === true,
      tokens: count(record.inputTokens) + count(record.outputTokens),
    });
  }
  rows.sort((a, b) => a.at.localeCompare(b.at));
  const budgets: SpendBudget[] = [];
  for (const setting of entities.settings ?? []) {
    const key = text(setting.key);
    if (!key.startsWith("budget.project.")) continue;
    const value = (setting.value ?? {}) as Row;
    budgets.push({
      projectId: key.slice("budget.project.".length),
      ...(typeof value.usd === "number" ? { usd: value.usd } : {}),
      ...(typeof value.tokens === "number" ? { tokens: value.tokens } : {}),
    });
  }
  return {
    rows,
    budgets,
    projects: (entities.project ?? [])
      .filter((row) => row.archived !== true)
      .map((row) => ({ id: text(row.id), name: text(row.name) || "Untitled project" }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}

/** Rows the Usage page shows: records, budgets in settings, and chat and project names. */
const SPEND_ROWS = new Set(["usage", "settings", "thread", "project"]);

/** Whether a snapshot change alters what the Usage page shows. */
export function changesSpend(aggregateType: string, rows: readonly Row[]): boolean {
  if (!SPEND_ROWS.has(aggregateType)) return false;
  return aggregateType !== "settings" || rows.some((row) => text(row.key).startsWith("budget."));
}
