// R6: upcoming routine runs as an iCalendar file. The Mac saves it now; a hosted feed can publish
// the same text later. Only names and times go in, and names can be left out.
import type { Routine } from "./knowledge-workflows.js";
import { upcomingRuns } from "./routine-time.js";

type CalendarRoutine = Pick<
  Routine,
  "id" | "name" | "paused" | "doneAt" | "nextRunAt" | "schedule"
> & {
  event?: unknown;
};

/** RFC 5545 text: backslash, semicolon, comma and line breaks escaped. */
export function icsText(value: string): string {
  return (
    value
      // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters aren't allowed in TEXT.
      .replace(/[\u0000-\u0009\u000b\u000c\u000e-\u001f\u007f\u2028\u2029]/g, "")
      .replace(/\\/g, "\\\\")
      .replace(/;/g, "\\;")
      .replace(/,/g, "\\,")
      .replace(/\r?\n|\r/g, "\\n")
  );
}

/** Lines longer than 75 octets continue on the next line after a space. */
export function icsFold(line: string): string {
  const bytes = new TextEncoder().encode(line);
  if (bytes.length <= 75) return line;
  const parts: string[] = [];
  let current = "";
  let size = 0;
  for (const char of line) {
    const width = new TextEncoder().encode(char).length;
    if (size + width > (parts.length ? 74 : 75)) {
      parts.push(current);
      current = "";
      size = 0;
    }
    current += char;
    size += width;
  }
  parts.push(current);
  return parts.join("\r\n ");
}

/** The title of every run when names are left out, so it still says where it came from. */
const PLACEHOLDER = "Zoltbot routine";

const stamp = (at: string) => `${at.replace(/[-:]/g, "").replace(/\.\d{3}/, "")}`;

export function routineCalendar(
  routines: readonly CalendarRoutine[],
  options: { from: string; until: string; names: boolean; minutes?: number },
): string {
  const names = new Map(routines.map((routine) => [routine.id, routine.name]));
  const minutes = options.minutes ?? 15;
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Zoltbot//Routines//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "X-WR-CALNAME:Zoltbot routines",
  ];
  for (const run of upcomingRuns(routines, options.from, options.until)) {
    const name = options.names
      ? (names.get(run.routineId) ?? PLACEHOLDER).slice(0, 200)
      : PLACEHOLDER;
    lines.push(
      "BEGIN:VEVENT",
      `UID:${icsText(`${run.routineId}-${stamp(run.at)}@zoltbot`)}`,
      `DTSTAMP:${stamp(options.from)}`,
      `DTSTART:${stamp(run.at)}`,
      `DURATION:PT${minutes}M`,
      `SUMMARY:${icsText(name)}`,
      "TRANSP:TRANSPARENT",
      "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");
  return `${lines.map(icsFold).join("\r\n")}\r\n`;
}
