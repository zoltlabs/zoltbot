/** What a manager's chat shows about the work it hands out, beside the ordinary messages. */

import type { StaffCard } from "./staff";

/** One compact centered line: a message between agents, a supervision notice or a wait. */
export interface ConversationNotice {
  kind: "team" | "supervision" | "wait" | "continue" | "waiting" | "zoltbot" | "call";
  /** Who it's from and, for messages, who it's to. `botId` opens that chat. */
  from?: { name: string; botId: string | null };
  to?: { name: string; botId: string | null };
  /** Words between the names and the main text, such as "finished". */
  verb?: string;
  /** The main text, shown emphasized and cut to one line. */
  text: string;
  /** Trailing detail, such as "no reply needed". */
  meta?: string;
  /** The full message, shown when the line is expanded. */
  detail?: string;
  /** Set on a waiting notice: the chat that waits and its wait, for Wake now. */
  threadId?: string;
  waitId?: string;
}

export type TaskStatus =
  | "queued"
  | "running"
  | "blocked"
  | "review"
  | "completed"
  | "failed"
  | "cancelled";

export interface DelegationRow {
  taskId: string;
  revision: number;
  /** The task's chat, which Open shows. */
  botId: string | null;
  owner: string;
  title: string;
  status: TaskStatus;
  /** Why it isn't running, such as "Waits on Refund endpoint". */
  reason?: string;
  startedAt?: string;
  finishedAt?: string;
  costUsd?: number;
  budgetUsd?: number;
}

export type ManagerCard =
  | { kind: "delegation"; rows: DelegationRow[] }
  | {
      kind: "result";
      taskId: string;
      revision: number;
      botId: string | null;
      owner: string;
      title: string;
      status: TaskStatus;
      files: string[];
      tests?: "passed" | "failed" | "partial";
      costUsd?: number;
      budgetUsd?: number;
      note?: string;
    }
  | StaffCard;

export type TaskActionInput =
  | { action: "stop"; taskId: string }
  | { action: "accept"; taskId: string; revision: number }
  | { action: "send_back"; taskId: string; revision: number; feedback: string }
  | { action: "wake_now"; threadId: string; waitId: string };
