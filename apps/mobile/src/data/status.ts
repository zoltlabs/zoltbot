// C9: what the agent is doing, in its own words or from the tool it runs, as on the Mac.
import { chatStatusKey, nextStatus, statusLine } from "@zoltbot/protocol";
import { useEffect, useRef, useState } from "react";
import type { Snapshot } from "./transport";
import { runningTurn } from "./view";

/** The working line for a chat, or undefined when its agent isn't working or said nothing. */
export function workingStatus(snapshot: Snapshot, threadId: string): string | undefined {
  const turn = runningTurn(snapshot, threadId);
  if (!turn) return undefined;
  const stored = (snapshot.entities.settings ?? []).find(
    (row) => row.key === chatStatusKey(threadId),
  )?.value;
  const tools = (snapshot.entities.item ?? []).filter(
    (item) => item.threadId === threadId && item.kind === "tool",
  );
  const line = statusLine({ stored, turnId: String(turn.id), tools });
  // "Working" is the fallback; the phone's own "Thinking…" and "Using tools…" say more.
  return line === "Working" ? undefined : line;
}

/** Holds each line for at least 3 seconds so it reads calmly. */
export function useCalmStatus(wanted: string | undefined): string | undefined {
  const shown = useRef<{ text: string; at: number } | undefined>(undefined);
  const [, redraw] = useState(0);
  const next = wanted === undefined ? undefined : nextStatus(shown.current, wanted, Date.now());
  useEffect(() => {
    if (!next) {
      shown.current = undefined;
      return;
    }
    shown.current = { text: next.text, at: next.at };
    if (next.waitMs === undefined) return;
    const timer = setTimeout(() => redraw((n) => n + 1), next.waitMs);
    return () => clearTimeout(timer);
  });
  return next?.text;
}
