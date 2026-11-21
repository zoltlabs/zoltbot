import { mutedThreads, requestNotifies } from "./chat-mute.js";

// P3: what a phone's Live Activity shows. One rule for the Mac, which pushes it, and the phone,
// which draws it while open, so the Lock Screen never flips between two counts.

type Row = Record<string, unknown>;
/** The settings row holding the main agent's ranking of what needs the owner. */
export const CHIEF_QUEUE_KEY = "chief.queue";

/** Ids ranked `later`, which never notify. */
export function laterRanked(value: unknown): Set<string> {
  const items = (
    value as { items?: Record<string, { rank?: unknown; outcome?: unknown }> } | undefined
  )?.items;
  return new Set(
    Object.entries(items && typeof items === "object" ? items : {})
      .filter(([, triage]) => triage?.rank === "later" && !triage.outcome)
      .map(([id]) => id),
  );
}

export interface ActivityCounts {
  working: number;
  needsYou: number;
  /** The oldest counted request, which the phone names on the Lock Screen. An id only. */
  topId?: string;
}

const cap = (count: number) => Math.max(0, Math.min(999, count));

export function activityCounts(entities: {
  task?: readonly Row[];
  interaction?: readonly Row[];
  settings?: readonly Row[];
}): ActivityCounts {
  const later = laterRanked(entities.settings?.find((row) => row.key === CHIEF_QUEUE_KEY)?.value);
  const muted = mutedThreads(entities.settings as { key?: unknown; value?: unknown }[] | undefined);
  const tasks = entities.task ?? [];
  const asks = (entities.interaction ?? [])
    .filter(
      (row) =>
        row.state === "pending" &&
        !later.has(String(row.id)) &&
        requestNotifies(row as { type?: unknown; threadId?: unknown }, muted),
    )
    .sort((a, b) => String(a.createdAt ?? "").localeCompare(String(b.createdAt ?? "")));
  const top = asks.find(
    (row) => typeof row.id === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(row.id),
  );
  return {
    working: cap(tasks.filter((row) => row.state === "running").length),
    needsYou: cap(
      asks.length +
        tasks.filter((row) => row.state === "review" && !row.routineOccurrenceId).length,
    ),
    ...(top ? { topId: top.id as string } : {}),
  };
}
