// R7: workflows over IPC, for the Workflows view on the Routines page. The daemon checks every
// change; this side only shapes what the page shows.

export const WORKFLOW_CHANNELS = {
  workflowsList: "workflows:list",
  workflowsRun: "workflows:run",
  workflowsSetPaused: "workflows:set-paused",
  workflowsDecide: "workflows:decide",
} as const;

export type WorkflowStepKind = "trigger" | "agent" | "condition" | "wait" | "connection" | "media";
export type WorkflowStepState = "waiting" | "running" | "needs_you" | "done" | "skipped" | "failed";

export interface WorkflowStep {
  id: string;
  kind: WorkflowStepKind;
  name: string;
  /** The agent's name, for agent, media and connection steps. */
  agent?: string;
  /** What an agent or media step is asked to do. */
  brief?: string;
  /** A condition: which step it tests, and how. */
  test?: { from: string; kind: "contains" | "equals" | "outcome"; value: string };
  /** A wait: minutes, or until the owner approves. */
  wait?: { minutes: number } | { approval: true };
  /** A connection step's one action. */
  action?: { connection: string; action: string };
  /** A media step's file. */
  output?: "image" | "video";
  x?: number;
  y?: number;
}

export interface WorkflowEdge {
  from: string;
  to: string;
  /** Which branch of a condition this edge leaves from. */
  port?: "true" | "false";
}

export interface WorkflowRunStep {
  id: string;
  state: WorkflowStepState;
  branch?: "true" | "false";
}

export interface WorkflowRunItem {
  id: string;
  state: "running" | "at_gate" | "completed" | "failed" | "cancelled" | "scheduled" | "looping";
  startedAt?: string;
  reason?: string;
  steps: WorkflowRunStep[];
}

export interface WorkflowItem {
  id: string;
  name: string;
  version: number;
  /** How a run starts: by hand, or on the routine's schedule. */
  trigger: { type: "manual" } | { type: "schedule"; cron: string; timezone: string; at?: string };
  paused: boolean;
  steps: WorkflowStep[];
  edges: WorkflowEdge[];
  /** Newest first, at most 10. */
  runs: WorkflowRunItem[];
}

export interface WorkflowsDesktopApi {
  list: () => Promise<WorkflowItem[]>;
  run: (id: string) => Promise<void>;
  setPaused: (input: { id: string; paused: boolean }) => Promise<void>;
  decide: (input: {
    runId: string;
    stepId: string;
    decision: "continue" | "stop";
  }) => Promise<void>;
}
