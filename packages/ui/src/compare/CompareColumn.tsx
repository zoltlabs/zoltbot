import { compareSessions } from "@zoltbot/protocol";
import { type ReactNode, useMemo } from "react";
import { Timeline } from "../chat/Timeline.js";
import { groupTimeline } from "../chat/timeline-data.js";
import { type ChatConnection, text } from "../chat/types.js";
import { Avatar } from "../components/primitives.js";
import PendingInteraction from "../interactions/PendingInteraction.js";
export function CompareColumn({
  connection,
  threadId,
  hidden,
  stop,
  tabbed = false,
  readOnly = false,
  actions,
}: {
  connection: ChatConnection;
  threadId: string;
  hidden: boolean;
  stop(): void;
  tabbed?: boolean;
  readOnly?: boolean;
  actions?: ReactNode;
}) {
  const e = connection.snapshot.entities;
  const thread = e.thread?.find((r) => r.id === threadId);
  const profile = e.agent?.find((r) => r.id === thread?.agentId);
  const name = text(profile?.name) || "Profile";
  const definition = e.agentDefinition?.find((r) => r.id === profile?.definitionId);
  const session = e.session?.filter((r) => r.threadId === threadId).sort(compareSessions)[0];
  const turn = e.turn
    ?.filter((r) => r.threadId === threadId)
    .sort((a, b) => text(b.startedAt).localeCompare(text(a.startedAt)))[0];
  const pending = e.interaction?.some((r) => r.threadId === threadId && r.state === "pending");
  const status = pending
    ? "Needs you"
    : turn?.status === "running"
      ? "Running"
      : turn?.status === "failed"
        ? "Failed"
        : turn?.status === "interrupted"
          ? "Stopped"
          : turn?.status === "completed"
            ? "Done"
            : "Starting";
  const items = useMemo(
    () =>
      (e.item ?? [])
        .filter((r) => r.threadId === threadId)
        .sort((a, b) => Number(a.seq) - Number(b.seq)),
    [e.item, threadId],
  );
  const groups = useMemo(() => groupTimeline(items), [items]);
  const sessions = new Set(e.session?.filter((r) => r.threadId === threadId).map((r) => r.id));
  const usage = (e.usage ?? []).filter((r) => sessions.has(r.sessionId));
  const tokens = usage.reduce(
    (n, r) => n + Number(r.inputTokens ?? 0) + Number(r.outputTokens ?? 0),
    0,
  );
  const elapsed = turn?.startedAt
    ? Math.max(
        0,
        Math.round(
          (Date.parse(text(turn.endedAt) || new Date().toISOString()) -
            Date.parse(text(turn.startedAt))) /
            1000,
        ),
      )
    : 0;
  return (
    <section
      className="compare-column"
      id={`${threadId}-panel`}
      role={tabbed ? "tabpanel" : undefined}
      aria-labelledby={tabbed ? `${threadId}-tab` : undefined}
      aria-label={`${name} answer`}
      hidden={hidden}
      data-thread={threadId}
    >
      <header className="compare-column-header">
        <Avatar id={text(profile?.id)} name={name} />
        <div>
          <strong>{name}</strong>
          <small>
            {[text(definition?.displayName), text(profile?.model)].filter(Boolean).join(" · ")}
          </small>
        </div>
        <span className="sp" />
        <output aria-live="polite">{status}</output>
        <details>
          <summary aria-label={`Actions for ${name}`}>•••</summary>
          <button
            type="button"
            className="btn sm"
            disabled={readOnly || turn?.status !== "running"}
            onClick={stop}
          >
            Stop {name}
          </button>
        </details>
      </header>
      <div className="compare-metrics">
        {elapsed}s · {tokens} tokens · {text(session?.providerVersion)}
      </div>
      <Timeline
        items={groups.top}
        nested={groups.nested}
        name={name}
        usage={usage}
        interactions={(e.interaction ?? []).filter((r) => r.threadId === threadId)}
        connection={connection}
        label={`${name} conversation`}
      />
      {readOnly ? null : (
        <PendingInteraction
          connection={connection}
          threadId={threadId}
          profile={name}
          label={`${name} pending request`}
        />
      )}
      {actions}
    </section>
  );
}
