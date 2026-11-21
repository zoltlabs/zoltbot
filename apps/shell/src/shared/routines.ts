// R3: routines over IPC, for the Routines page. Lists, history and the owner's controls; editing a
// routine's brief stays in its chat.

export const ROUTINE_CHANNELS = {
  routinesList: "routines:list",
  routinesHistory: "routines:history",
  routinesSetPaused: "routines:set-paused",
  routinesSetSchedule: "routines:set-schedule",
  routinesRunNow: "routines:run-now",
  routinesAddToCalendar: "routines:add-to-calendar",
  routinesWebAddress: "routines:web-address",
  routinesStarters: "routines:starters",
  routinesAddStarter: "routines:add-starter",
} as const;

export interface RoutineSchedule {
  /** Five-field cron, "@every Nm", or "@once" with `at`. */
  cron: string;
  timezone: string;
  at?: string;
}

export type RoutineTrigger =
  | "github.ci_failed"
  | "sentry.issue_created"
  | "webhook.received"
  | "github.review_requested";

export interface RoutineItem {
  id: string;
  name: string;
  /** The agent that runs it. */
  agent: string;
  schedule: RoutineSchedule;
  paused: boolean;
  /** A one-time routine that has run. */
  doneAt?: string;
  nextRunAt: string;
  updatedAt: string;
  /** R7: a workflow's own routine; its schedule changes with the workflow. */
  workflow?: boolean;
  /** Routines started by an event rather than a clock, with what they watch. */
  trigger?: { kind: RoutineTrigger; resource: string };
}

export interface RoutineRun {
  id: string;
  scheduledAt: string;
  status: string;
  outcome?: string;
  manual?: boolean;
  reason?: string;
}

/** D5: a first job offered at the end of setup, for an app the owner connected. */
export interface StarterJobItem {
  id: string;
  name: string;
}

export interface RoutinesDesktopApi {
  list: () => Promise<RoutineItem[]>;
  history: (id: string) => Promise<RoutineRun[]>;
  setPaused: (input: { id: string; paused: boolean }) => Promise<RoutineItem>;
  setSchedule: (input: { id: string; schedule: RoutineSchedule }) => Promise<RoutineItem>;
  runNow: (id: string) => Promise<void>;
  /** D5: the first jobs that fit the connected apps; empty when none do. */
  starters?: () => Promise<StarterJobItem[]>;
  /** D5: saves one as a paused routine, run by an agent from `provider` when there is one. */
  addStarter?: (input: { id: string; provider?: string }) => Promise<void>;
  /** R6: opens the coming runs in the Calendar app; only the desktop app has it. */
  addToCalendar?: (input: { names: boolean }) => Promise<{ runs: number }>;
  /** R2: copies, tests or rotates a routine's web address; only the desktop app has it. */
  webAddress?: (input: {
    id: string;
    action: "copy" | "test" | "rotate";
  }) => Promise<{ state: "copied" | "sent" | "rotated" | "elsewhere" }>;
}
