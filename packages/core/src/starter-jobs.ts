// D5: first jobs offered at the end of setup, for the apps the owner has connected. Each one
// is saved as a paused routine, and the owner turns it on from the Routines page.
import { type PermissionProfile, parse, type Routine, RoutineSchema } from "@zoltbot/protocol";
import type { CommandContext, Outcome } from "./commands.js";
import type { DomainState } from "./projectors.js";
import { nextRoutineRun } from "./routine-time.js";
import { clampRoutinePermission, routineEvent } from "./routines.js";

export interface StarterJob {
  id: string;
  /** Catalog services that must all be connected, in one project. */
  requires: readonly string[];
  name: string;
  brief: string;
  acceptance: string;
  /** Minute hour * * weekdays, in the owner's time zone. */
  cron: string;
  notify: Routine["notify"];
}

const WEEKDAYS = "1,2,3,4,5";

export const STARTER_JOBS: readonly StarterJob[] = [
  {
    id: "weekly-inbox",
    requires: ["gmail"],
    name: "Weekly inbox summary",
    brief:
      "Read my Gmail inbox from the past seven days. List the messages that need a reply or a decision from me, most urgent first, and note any deadlines. Don't send, archive or label anything.",
    acceptance: "A short list of the messages that need me, with their deadlines.",
    cron: "0 9 * * 1",
    notify: "always",
  },
  {
    id: "pull-request-review",
    requires: ["github"],
    name: "Pull request review",
    brief:
      "Find the open GitHub pull requests that ask for my review. For each one, read the change and list the problems you find, most serious first. Don't comment, approve or merge.",
    acceptance: "One section for each pull request, with its link and its problems.",
    cron: `0 9 * * ${WEEKDAYS}`,
    notify: "actionable_only",
  },
  {
    id: "morning-briefing",
    requires: ["google_calendar"],
    name: "Morning briefing",
    brief:
      "Read today's events in my Google Calendar. List them in order with their times, and point out clashes and meetings without an agenda. Don't change any event.",
    acceptance: "Today's events in order, with clashes marked.",
    cron: `0 8 * * ${WEEKDAYS}`,
    notify: "always",
  },
];

/** What a starter job needs from a connection; the connection registry's rows fit it. */
export interface StarterConnection {
  id: string;
  projectId: string;
  source: string;
  enabled: boolean;
  credentialStatus: string;
}

export interface StarterMatch {
  job: StarterJob;
  projectId: string;
  connectionIds: string[];
}

/** The catalog service a connection was installed from, such as "gmail". */
export function connectionService(source: string): string | undefined {
  return /^catalog:([a-z_]+):v1$/.exec(source)?.[1];
}

/**
 * The starter jobs whose apps are signed in, each in the first project (by id) that has all of
 * them. A job whose routine already exists is left out.
 */
export function matchStarterJobs(
  connections: readonly StarterConnection[],
  activeProjects: ReadonlySet<string>,
  existingRoutineIds: ReadonlySet<string> = new Set(),
): StarterMatch[] {
  const ready = connections.filter(
    (row) =>
      row.enabled && row.credentialStatus === "connected" && activeProjects.has(row.projectId),
  );
  const projects = [...new Set(ready.map((row) => row.projectId))].sort();
  return STARTER_JOBS.flatMap((job): StarterMatch[] => {
    if (existingRoutineIds.has(starterRoutineId(job.id))) return [];
    for (const projectId of projects) {
      const connectionIds = job.requires.map(
        (service) =>
          ready.find(
            (row) => row.projectId === projectId && connectionService(row.source) === service,
          )?.id,
      );
      if (connectionIds.every((id): id is string => !!id))
        return [{ job, projectId, connectionIds }];
    }
    return [];
  });
}

/** One routine per starter job, so adding it twice changes nothing. */
export function starterRoutineId(jobId: string) {
  return `routine-starter-${jobId}`;
}

/**
 * Saves a matched starter job as a paused routine. It only reads, whatever the agent may do
 * elsewhere, and it uses only the connections the job needs.
 */
export function routineFromStarter(
  state: DomainState,
  input: { match: StarterMatch; profileId: string; timezone: string },
  context: CommandContext,
): Outcome {
  if (context.actor.kind !== "human") throw new Error("human_routine_required");
  const { job, projectId, connectionIds } = input.match;
  const id = starterRoutineId(job.id);
  const old = state.routine?.find((row) => row.id === id);
  if (old) return { events: [], result: old };
  const profile = state.agent?.find(
    (row) => row.id === input.profileId && !row.archived && row.kind === "profile",
  );
  if (!profile) throw new Error("profile_unavailable");
  if (!state.project?.some((row) => row.id === projectId && !row.archived))
    throw new Error("scope_unavailable");
  const schedule = { cron: job.cron, timezone: input.timezone };
  const routine = parse(RoutineSchema, {
    id,
    name: job.name,
    template: {
      title: job.name,
      brief: job.brief,
      acceptance: job.acceptance,
      profileId: profile.id,
      node: { type: "project", id: projectId },
      inputs: { knowledge: "inherit", skills: "inherit", connections: connectionIds },
    },
    schedule,
    permissionCeiling: clampRoutinePermission(
      "read_only",
      profile.permissionProfile as PermissionProfile,
    ),
    notify: job.notify,
    paused: true,
    nextRunAt: nextRoutineRun(schedule, context.at),
    createdAt: context.at,
    updatedAt: context.at,
  });
  return { events: [routineEvent("routine", routine, context)], result: routine };
}
