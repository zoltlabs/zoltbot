import { sampleChannelRows } from "./fake-channels.js";
import type { Row } from "./transport.js";

// Sample work for the Tasks tab and the drawer, in the sample "Acme web" project that
// fake-channels.ts sets up: Mira leads, Sam and Theo have tasks in every state the Tasks tab
// groups. Rows use the real protocol entity shapes (tasks.test.ts checks them).

const projectId = "acme-web";
const mira = "thread-mira";

/** Tasks for Sam and Theo, plus one project chat. Times are relative to `now`. */
export function sampleCompany(now: number): Record<string, Row[]> {
  const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
  const node = { type: "project", id: projectId };
  const thread = (
    id: string,
    agentId: string,
    kind: string,
    title: string,
    minutes: number,
    taskId?: string,
  ): Row => ({
    id,
    agentId,
    projectId,
    node,
    ...(taskId ? { taskId } : {}),
    kind,
    title,
    titleSource: "human",
    pinned: false,
    archived: false,
    createdAt: ago(minutes + 30),
    lastActivityAt: ago(minutes),
  });
  const task = (
    id: string,
    owner: string,
    title: string,
    state: string,
    minutes: number,
    extra: Row = {},
  ): Row => ({
    id,
    projectId,
    node,
    rootId: id,
    title,
    brief: title,
    acceptance: "",
    expectedDeliverable: "A tested change",
    ownerAgentId: owner,
    threadId: `thread-${id}`,
    workspaceMode: "worktree",
    state,
    revision: 1,
    attempt: 1,
    maxAttempts: 3,
    reviewRequired: true,
    executionLocation: "local",
    createdBy: { kind: "agent", id: "agent-mira" },
    accountableThreadId: mira,
    createdAt: ago(minutes + 20),
    updatedAt: ago(minutes),
    ...extra,
  });
  const tasks = [
    task("task-vat-field", "agent-sam", "Add VAT number field", "review", 12),
    task("task-receipts", "agent-sam", "Update receipt emails", "queued", 20, {
      holdReason: "at_limit",
    }),
    task("task-migrate", "agent-theo", "Migrate invoices table", "failed", 40, {
      holdReason: "Tests failed",
    }),
    task("task-backfill", "agent-theo", "Backfill invoice totals", "blocked", 8, {
      dependencies: ["task-migrate"],
      holdReason: "Waiting for accepted dependencies",
    }),
  ];
  return {
    thread: [
      thread("thread-eu-pricing", "agent-mira", "main", "EU pricing questions", 120),
      ...tasks.map((row) =>
        thread(
          String(row.threadId),
          String(row.ownerAgentId),
          "task",
          String(row.title),
          Math.max(1, (now - Date.parse(String(row.updatedAt))) / 60_000),
          String(row.id),
        ),
      ),
    ],
    task: tasks,
  };
}

/**
 * Adds the sample channel's project and people (fake-channels.ts) and the sample tasks to the
 * fake transport's snapshot, so Tasks and the drawer show them before any channel call.
 */
export function addSampleCompany(entities: Record<string, Row[]>, now: number) {
  for (const rows of [sampleChannelRows(now), sampleCompany(now)])
    for (const [kind, list] of Object.entries(rows)) {
      const existing = entities[kind] ?? [];
      entities[kind] = [
        ...existing,
        ...list.filter((row) => !existing.some((e) => e.id === row.id)),
      ];
    }
}
