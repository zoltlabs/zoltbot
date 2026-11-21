// R3: the Routines page's IPC handlers. The daemon checks every change; this side shapes input and
// turns error codes into words.
import { randomUUID } from "node:crypto";
import {
  ROUTINE_CHANNELS as C,
  type RoutineItem,
  type RoutineRun,
  type RoutineSchedule,
} from "../shared/routines";
import type { DaemonClient } from "./daemon-client";
import { isObject, requireString } from "./parsers";

type Client = Pick<DaemonClient, "call" | "rows">;

const MESSAGES: Record<string, string> = {
  stale_revision: "It changed somewhere else. Try again.",
  invalid_routine_schedule: "That schedule can't run. Check the time.",
  use_event_routine_commands: "Run it from its chat.",
  scope_unavailable: "Its project was archived or deleted.",
  routine_running: "It's already running.",
};

function failure(error: unknown, fallback: string): Error {
  const message = error instanceof Error ? error.message : "";
  const code = Object.keys(MESSAGES).find((key) => message.includes(key));
  return new Error(code ? MESSAGES[code] : fallback);
}

const text = (value: unknown) => (typeof value === "string" ? value : undefined);

export function parseRoutine(value: unknown, agents: Map<string, string>): RoutineItem | null {
  if (!isObject(value) || !isObject(value.schedule) || !isObject(value.template)) return null;
  const id = text(value.id);
  const cron = text(value.schedule.cron);
  const timezone = text(value.schedule.timezone);
  const nextRunAt = text(value.nextRunAt);
  const updatedAt = text(value.updatedAt);
  if (!id || !cron || !timezone || !nextRunAt || !updatedAt) return null;
  const source = isObject(value.event) && isObject(value.event.source) ? value.event.source : null;
  const profileId = text(value.template.profileId) ?? "";
  const at = text(value.schedule.at);
  const doneAt = text(value.doneAt);
  return {
    id,
    name: text(value.name) ?? "Routine",
    agent: agents.get(profileId) ?? profileId,
    schedule: { cron, timezone, ...(at ? { at } : {}) },
    paused: value.paused === true,
    ...(doneAt ? { doneAt } : {}),
    ...(text(value.workflowId) ? { workflow: true } : {}),
    nextRunAt,
    updatedAt,
    ...(source && text(source.kind) && text(source.resource)
      ? {
          trigger: {
            kind: source.kind as NonNullable<RoutineItem["trigger"]>["kind"],
            resource: String(source.resource),
          },
        }
      : {}),
  };
}

function parseSchedule(value: unknown): RoutineSchedule {
  if (!isObject(value)) throw new Error("Invalid schedule.");
  const at = text(value.at);
  return {
    cron: requireString(value.cron, "cron"),
    timezone: requireString(value.timezone, "timezone"),
    ...(at ? { at } : {}),
  };
}

export function routineHandlers(client: Client): Record<string, (input: unknown) => unknown> {
  const agents = () =>
    new Map(client.rows("agent").map((row) => [String(row.id), String(row.name ?? row.id)]));
  const one = (value: unknown) => {
    const item = parseRoutine(value, agents());
    if (!item) throw new Error("Invalid routine.");
    return item;
  };
  const current = async (id: string) => {
    const { items } = (await client.call("routine.list", {})) as { items: unknown[] };
    const found = items.find((row) => isObject(row) && row.id === id);
    if (!found) throw new Error("It was already removed.");
    return found as { updatedAt: string; event?: unknown; revision?: number };
  };
  return {
    [C.routinesList]: async (): Promise<RoutineItem[]> => {
      const result = (await client.call("routine.list", {})) as { items?: unknown[] };
      const names = agents();
      return (result.items ?? [])
        .map((row) => parseRoutine(row, names))
        .filter((item): item is RoutineItem => !!item)
        .sort((a, b) => a.name.localeCompare(b.name));
    },
    [C.routinesHistory]: async (input): Promise<RoutineRun[]> => {
      const result = (await client.call("routine.history", {
        id: requireString(input, "id"),
      })) as { items?: unknown[] };
      return (result.items ?? [])
        .flatMap((row): RoutineRun[] => {
          if (!isObject(row) || !text(row.id) || !text(row.scheduledAt) || !text(row.status))
            return [];
          return [
            {
              id: String(row.id),
              scheduledAt: String(row.scheduledAt),
              status: String(row.status),
              ...(text(row.outcome) ? { outcome: String(row.outcome) } : {}),
              ...(row.manual === true ? { manual: true } : {}),
              ...(text(row.reason) ? { reason: String(row.reason) } : {}),
            },
          ];
        })
        .sort((a, b) => b.scheduledAt.localeCompare(a.scheduledAt))
        .slice(0, 20);
    },
    [C.routinesSetPaused]: async (input) => {
      if (!isObject(input) || typeof input.paused !== "boolean")
        throw new Error("Invalid request.");
      const id = requireString(input.id, "id");
      try {
        const routine = await current(id);
        // Event routines have their own pause and enable commands.
        if (routine.event) {
          const revision = (routine.event as { revision?: number }).revision ?? 1;
          return one(
            await client.call(
              input.paused ? "routine.pause" : "routine.enable",
              { id, revision },
              randomUUID(),
            ),
          );
        }
        return one(
          await client.call(
            "routine.update",
            { id, expectedUpdatedAt: routine.updatedAt, paused: input.paused },
            randomUUID(),
          ),
        );
      } catch (error) {
        throw failure(error, "Couldn't change it. Try again.");
      }
    },
    [C.routinesSetSchedule]: async (input) => {
      if (!isObject(input)) throw new Error("Invalid request.");
      const id = requireString(input.id, "id");
      const schedule = parseSchedule(input.schedule);
      try {
        const routine = await current(id);
        return one(
          await client.call(
            "routine.update",
            { id, expectedUpdatedAt: routine.updatedAt, schedule },
            randomUUID(),
          ),
        );
      } catch (error) {
        throw failure(error, "Couldn't save the schedule. Try again.");
      }
    },
    [C.routinesRunNow]: async (input) => {
      try {
        await client.call("routine.runNow", { id: requireString(input, "id") }, randomUUID());
      } catch (error) {
        throw failure(error, "Couldn't start it. Try again.");
      }
    },
  };
}
