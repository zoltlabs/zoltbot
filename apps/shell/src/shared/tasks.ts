/** Task types the Tasks page and the sidebar share across the IPC boundary. */

export const TASK_STATES = [
  "queued",
  "running",
  "blocked",
  "review",
  "completed",
  "failed",
  "cancelled",
] as const;
export type TaskState = (typeof TASK_STATES)[number];

/**
 * The employee a task belongs to: the profile that runs it (`ownerAgentId`) within the task's
 * project. The daemon limits how many tasks each employee runs at once.
 */
export interface TaskOwner {
  profileId: string;
  name: string;
}

/** One task as the Tasks page lists it. */
export interface TaskSummary {
  id: string;
  title: string;
  projectId: string | null;
  projectName: string;
  state: TaskState;
  revision: number;
  /** Why the task waits, failed or stopped, in a few words. Empty when there's nothing to add. */
  reason: string;
  /** True when it waits only because its employee already runs as many tasks as allowed. */
  atLimit: boolean;
  /** The task's own chat, when the sidebar shows it. */
  threadId: string | null;
  owner: TaskOwner | null;
  teamId: string | null;
  teamName: string;
  /** The document a document task edits, relative to the project folder. */
  document: { path: string } | null;
  createdAt: string;
  updatedAt: string;
}

export const TASK_REVIEW_DECISIONS = ["accept", "changes"] as const;
export type TaskReviewDecision = (typeof TASK_REVIEW_DECISIONS)[number];

export interface ReviewTaskInput {
  taskId: string;
  revision: number;
  decision: TaskReviewDecision;
  /** What to change; required when sending the task back. */
  feedback?: string;
}
