// R6: "Add to calendar" on the Routines page. The coming runs go into an iCalendar file that the
// Calendar app opens and imports. A hosted feed that stays current needs the cloud (see R6 gaps).
import { randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse, RoutineSchema, routineCalendar, upcomingRuns } from "@zoltbot/protocol";
import { ROUTINE_CHANNELS } from "../../shared/routines";

const DAYS = 30;

export function calendarHandlers(options: {
  client: { call(method: string, params: unknown): Promise<unknown> };
  /** Where the file is written before Calendar opens it. */
  folder: string;
  /** Opens a file in its app; resolves to an error message, or "" when it opened. */
  open(path: string): Promise<string>;
  now?: () => Date;
}): Record<string, (input: unknown) => unknown> {
  return {
    [ROUTINE_CHANNELS.routinesAddToCalendar]: async (input) => {
      const names = (input as { names?: unknown } | null)?.names;
      if (typeof names !== "boolean") throw new Error("Invalid request.");
      const { items = [] } = (await options.client.call("routine.list", {})) as {
        items?: unknown[];
      };
      const routines = items.flatMap((row) => {
        try {
          return [parse(RoutineSchema, row)];
        } catch {
          return [];
        }
      });
      const from = (options.now?.() ?? new Date()).toISOString();
      const until = new Date(Date.parse(from) + DAYS * 86_400_000).toISOString();
      const runs = upcomingRuns(routines, from, until).length;
      if (!runs) return { runs };
      await mkdir(options.folder, { recursive: true });
      const path = join(options.folder, "Zoltbot routines.ics");
      // A new file renamed into place: a symlink planted at the path is replaced, never followed.
      const draft = join(options.folder, `.calendar-${randomUUID()}.ics`);
      await writeFile(draft, routineCalendar(routines, { from, until, names }), { flag: "wx" });
      await rename(draft, path);
      const failed = await options.open(path);
      if (failed) throw new Error("Couldn't open Calendar.");
      return { runs };
    },
  };
}
