// P3: when the Lock Screen's Live Activity starts, changes and ends. Pure, so it is testable;
// state/live-activity.ts drives the native bridge from it.
import { activityCounts } from "@zoltbot/protocol";
import type { Snapshot } from "./transport.js";
import { needsYou } from "./view.js";

export interface ActivityCounts {
  working: number;
  needsYou: number;
}
/** What the widget shows beside the counts. Stays on the phone, in the App Group cache. */
export interface ActivityTop {
  interactionId: string;
  threadId: string;
  title: string;
}
export interface ActivityView extends ActivityCounts {
  top?: ActivityTop;
}
export type ActivityStep =
  | { kind: "start" | "update"; view: ActivityView }
  | { kind: "end" }
  | { kind: "none" };

const clip = (value: unknown, max: number) =>
  typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";

/**
 * The counts and the top request, from the shown Mac's snapshot. Counted by the same rule the
 * Mac uses for its pushes, so the two never disagree on the Lock Screen.
 */
export function activityView(snapshot: Snapshot): ActivityView {
  const { working, needsYou: waiting, topId } = activityCounts(snapshot.entities);
  const row = topId
    ? (snapshot.entities.interaction ?? []).find((entry) => entry.id === topId)
    : undefined;
  const item = topId ? needsYou(snapshot).find((entry) => entry.id === topId) : undefined;
  return {
    working,
    needsYou: waiting,
    ...(topId && row
      ? {
          top: {
            interactionId: topId,
            threadId: clip(row.threadId, 200),
            title: clip(item?.title ?? row.title, 120),
          },
        }
      : {}),
  };
}

const same = (a: ActivityView, b: ActivityView) =>
  a.working === b.working &&
  a.needsYou === b.needsYou &&
  a.top?.interactionId === b.top?.interactionId &&
  a.top?.title === b.top?.title;

/**
 * The next step. It runs only while agents work or something waits, and only when the owner
 * turned it on; `running` is whether an activity is up now.
 */
export function planActivity(
  running: boolean,
  shown: ActivityView | undefined,
  next: ActivityView,
  enabled: boolean,
): ActivityStep {
  const busy = next.working > 0 || next.needsYou > 0;
  if (!enabled || !busy) return running ? { kind: "end" } : { kind: "none" };
  if (!running) return { kind: "start", view: next };
  return shown && same(shown, next) ? { kind: "none" } : { kind: "update", view: next };
}
