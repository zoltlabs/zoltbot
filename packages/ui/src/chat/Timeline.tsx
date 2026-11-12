import { defaultRangeExtractor, observeElementRect, useVirtualizer } from "@tanstack/react-virtual";
import { type ArtifactTarget, InteractionSchema, parse } from "@zoltbot/protocol";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { InlineArtifact } from "../artifacts/InlineArtifact.js";
import { artifactTimeline } from "../artifacts/occurrences.js";
import { InteractionCard } from "../interactions/InteractionCard.js";
import { Icon } from "../shell/icons.js";
import { ActivityGroup } from "./ActivityGroup.js";
import { groupActivity, markRecovered } from "./activity-data.js";
import { MessageRow } from "./MessageRow.js";
import type { MessageSource } from "./sources.js";
import { createTimelineKeys } from "./timeline-keys.js";
import { DiffDialog } from "./tools/DiffDialog.js";
import { DiffCounts } from "./tools/DiffView.js";
import { diffStats, type FileDiff, fileDiffs } from "./tools/diff-data.js";
import { NestedRowsContext } from "./tools/nested.js";
import { foldTurns, formatDuration, withWorking } from "./turn-fold.js";
import type { ChatConnection } from "./types.js";
import { body, type Row, text } from "./types.js";

/** An approval still waiting, which the conversation shows in place with its buttons. */
function pendingApproval(request: Row | undefined) {
  return request?.type === "approval" && request.state === "pending";
}

export function Timeline({
  items,
  nested,
  name,
  usage,
  interactions,
  turns = [],
  connection,
  onRevise,
  sources,
  onRewind,
  onEdit,
  label = "Conversation",
}: {
  /** Top level rows; subagent rows live in nested under their parent tool item. */
  label?: string;
  items: Row[];
  nested?: Map<string, Row[]>;
  name: string;
  usage: Row[];
  interactions: Row[];
  /** This chat's turns; finished ones fold to "Worked for …" above their answer. */
  turns?: Row[];
  connection?: ChatConnection;
  onRevise?: ((target: ArtifactTarget) => void) | undefined;
  /** Labels for agent-originated inputs by source message id; see messageSources. */
  sources?: Map<string, MessageSource> | undefined;
  onRewind?: ((item: Row) => void) | undefined;
  onEdit?: ((item: Row) => void) | undefined;
}) {
  const [openTurns, setOpenTurns] = useState<ReadonlySet<string>>(() => new Set());
  const grouped = useMemo(
    () =>
      groupActivity(
        artifactTimeline(
          markRecovered(items),
          connection?.snapshot.entities.artifact ?? [],
          connection?.snapshot.entities.artifactVersion ?? [],
        ),
      ),
    [items, connection?.snapshot.entities.artifact, connection?.snapshot.entities.artifactVersion],
  );
  const paused =
    interactions.some((request) => request.state === "pending") ||
    (!!connection && connection.status !== "online");
  const rows = useMemo(
    () => withWorking(foldTurns(grouped, turns, openTurns), turns, paused),
    [grouped, turns, openTurns, paused],
  );
  // Every file change a turn's edit steps reported, in order, for its "Changed N files" link.
  const turnDiffs = useMemo(() => {
    const result = new Map<string, FileDiff[]>();
    for (const item of items) {
      if (item.kind !== "tool" || body(item).kind !== "edit") continue;
      const diffs = fileDiffs(body(item).diffs);
      if (!diffs.length) continue;
      const turnId = String(item.turnId ?? "");
      result.set(turnId, [...(result.get(turnId) ?? []), ...diffs]);
    }
    return result;
  }, [items]);
  const [diffTurn, setDiffTurn] = useState<string>();
  const parent = useRef<HTMLElement>(null),
    programmatic = useRef(false);
  const [following, setFollowing] = useState(true),
    [focused, setFocused] = useState<string | undefined>(),
    [height, setHeight] = useState(0),
    [expanded, setExpanded] = useState<string>();
  const usageByTurn = useMemo(() => new Map(usage.map((row) => [row.turnId, row])), [usage]);
  const requests = useMemo(() => new Map(interactions.map((row) => [row.id, row])), [interactions]);
  const nativeRequests = useMemo(
    () =>
      new Map(
        interactions.flatMap((row) => (text(row.nativeRef) ? [[text(row.nativeRef), row]] : [])),
      ),
    [interactions],
  );
  const interactionFor = useCallback(
    (item: Row) =>
      requests.get(body(item).interactionId) ??
      (item.kind === "tool" && body(item).interactive === true
        ? nativeRequests.get(text(body(item).nativeItemId))
        : undefined),
    [requests, nativeRequests],
  );
  const sourceFor = useCallback(
    (item: Row) =>
      item.kind === "user" && body(item).origin === "agent"
        ? sources?.get(text(body(item).sourceMessageId))
        : undefined,
    [sources],
  );
  const nestedRows = useMemo(
    () => ({
      nested: nested ?? new Map<string, Row[]>(),
      render: (row: Row) => (
        <MessageRow
          item={row}
          name={name}
          interaction={interactionFor(row)}
          source={sourceFor(row)}
        />
      ),
    }),
    [nested, name, interactionFor, sourceFor],
  );
  const rangeExtractor = useCallback(
    (range: Parameters<typeof defaultRangeExtractor>[0]) => {
      const visible = defaultRangeExtractor(range);
      const retained = [focused, expanded].flatMap((key) => {
        const index = key ? rows.findIndex((row) => row.key === key) : -1;
        return index < 0 || visible.includes(index) ? [] : [index];
      });
      return [...new Set([...visible, ...retained])].sort((a, b) => a - b);
    },
    [focused, expanded, rows],
  );
  const [keysForRows] = useState(() => createTimelineKeys());
  const virtual = useVirtualizer<HTMLElement, HTMLLIElement>({
    count: rows.length,
    getItemKey: keysForRows(rows),
    observeElementRect: (instance, notify) =>
      observeElementRect(instance, (rect) => {
        setHeight(rect.height);
        notify(rect);
      }),
    getScrollElement: () => parent.current,
    estimateSize: () => 108,
    overscan: 8,
    rangeExtractor,
    useFlushSync: false,
  });
  const total = virtual.getTotalSize();
  useLayoutEffect(() => {
    if (!following || !rows.length || total <= 0 || height <= 0) return;
    programmatic.current = true;
    virtual.scrollToIndex(rows.length - 1, { align: "end" });
    const frame = requestAnimationFrame(() => {
      programmatic.current = false;
    });
    return () => cancelAnimationFrame(frame);
  }, [following, rows.length, total, height, virtual]);
  return (
    <NestedRowsContext.Provider value={nestedRows}>
      <div className="chat-timeline-wrap">
        <section
          ref={parent}
          className="chat-timeline"
          // biome-ignore lint/a11y/noNoninteractiveTabindex: The named scroll region must support keyboard paging.
          tabIndex={0}
          aria-label={label}
          onWheel={(event) => {
            if (event.deltaY < 0) {
              programmatic.current = false;
              setFollowing(false);
            }
          }}
          onKeyDown={(event) => {
            if (["PageUp", "Home", "ArrowUp"].includes(event.key)) {
              programmatic.current = false;
              setFollowing(false);
            }
          }}
          onScroll={(event) => {
            if (programmatic.current) return;
            const target = event.currentTarget;
            // ResizeObserver has not reported the new viewport yet. Preserve follow until it does.
            if (following && Math.abs(target.clientHeight - height) > 1) return;
            setFollowing(target.scrollHeight - target.scrollTop - target.clientHeight < 72);
          }}
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget)) setFocused(undefined);
          }}
        >
          {items.length ? (
            <ol className="chat-virtual-list" style={{ height: total }} aria-label="Messages">
              {virtual.getVirtualItems().map((row) => {
                const display = rows[row.index];
                if (!display) return null;
                const item = display.type === "message" ? display.item : undefined;
                return (
                  <li
                    ref={virtual.measureElement}
                    data-index={row.index}
                    data-item-id={String(item?.id ?? display.key)}
                    data-thread-id={String(item?.threadId ?? "")}
                    className="chat-virtual-row"
                    style={{ transform: `translateY(${row.start}px)` }}
                    key={display.key}
                    aria-posinset={row.index + 1}
                    aria-setsize={rows.length}
                    onFocus={() => setFocused(display.key)}
                  >
                    {display.type === "working" ? (
                      <WorkingLine startedAt={display.startedAt} />
                    ) : display.type === "fold" ? (
                      <div className="turn-fold-row">
                        <button
                          type="button"
                          className="turn-fold"
                          aria-expanded={display.expanded}
                          onClick={() =>
                            setOpenTurns((old) => {
                              const next = new Set(old);
                              if (next.has(display.turnId)) next.delete(display.turnId);
                              else next.add(display.turnId);
                              return next;
                            })
                          }
                        >
                          <span>{display.label}</span>
                          <Icon
                            name={display.expanded ? "ChevronDown" : "ChevronRight"}
                            size="sm"
                          />
                        </button>
                        <TurnChanges
                          diffs={turnDiffs.get(display.turnId)}
                          onOpen={() => setDiffTurn(display.turnId)}
                        />
                      </div>
                    ) : item && connection && pendingApproval(interactionFor(item)) ? (
                      <section className="chat-inline-request" aria-label="Pending request">
                        <InteractionCard
                          request={parse(InteractionSchema, interactionFor(item))}
                          connection={connection}
                          profile={name}
                          autoFocus={following}
                        />
                      </section>
                    ) : display.type === "activity" ? (
                      <ActivityGroup
                        items={display.items}
                        name={name}
                        active={!paused && rows.at(-1) === display}
                      />
                    ) : display.type === "artifact" && connection ? (
                      <InlineArtifact
                        connection={connection}
                        row={display}
                        onRevise={onRevise}
                        expanded={expanded === display.key}
                        setExpanded={(value) => setExpanded(value ? display.key : undefined)}
                      />
                    ) : item ? (
                      <MessageRow
                        item={item}
                        name={name}
                        compareProfiles={
                          item.kind === "note" && body(item).code === "compare"
                            ? connection?.snapshot.entities.compareMember
                                ?.filter((m) => m.compareId === body(item).compareId)
                                .map((m) => {
                                  const thread = connection.snapshot.entities.thread?.find(
                                    (t) => t.id === m.threadId,
                                  );
                                  const profile = connection.snapshot.entities.agent?.find(
                                    (p) => p.id === thread?.agentId,
                                  );
                                  return { id: text(profile?.id), name: text(profile?.name) };
                                })
                            : undefined
                        }
                        interaction={interactionFor(item)}
                        source={sourceFor(item)}
                        onRewind={onRewind}
                        onEdit={onEdit}
                        {...(usageByTurn.has(item.turnId)
                          ? { usage: usageByTurn.get(item.turnId) }
                          : {})}
                      />
                    ) : null}
                  </li>
                );
              })}
            </ol>
          ) : (
            <div className="chat-empty">
              <h2>Start a conversation</h2>
              <p className="dim">Your profile uses its coding tool’s own session.</p>
            </div>
          )}
        </section>
        {diffTurn && turnDiffs.get(diffTurn) ? (
          <DiffDialog
            title="Changes in this turn"
            diffs={turnDiffs.get(diffTurn) ?? []}
            onClose={() => setDiffTurn(undefined)}
          />
        ) : null}
        {!following && items.length ? (
          <button type="button" className="btn chat-jump" onClick={() => setFollowing(true)}>
            Jump to latest
          </button>
        ) : null}
      </div>
    </NestedRowsContext.Provider>
  );
}

/** "Working for 12s", shimmering, counted from when the turn started. */
function WorkingLine({ startedAt }: { startedAt: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const started = new Date(startedAt).getTime();
  const seconds = Number.isFinite(started) ? Math.max(0, Math.floor((now - started) / 1000)) : 0;
  return (
    <output className="chat-working">
      <span className="chat-shimmer">
        {seconds >= 1 ? `Working for ${formatDuration(seconds * 1000)}` : "Working…"}
      </span>
    </output>
  );
}

/** "Changed 3 files +40 −12" beside a folded turn; opens every change it made. */
function TurnChanges({ diffs, onOpen }: { diffs: FileDiff[] | undefined; onOpen(): void }) {
  const stats = useMemo(() => diffStats(diffs ?? []), [diffs]);
  if (!diffs?.length) return null;
  const files = new Set(diffs.map((diff) => diff.path)).size;
  return (
    <button type="button" className="turn-changes" onClick={onOpen}>
      Changed {files} {files === 1 ? "file" : "files"} <DiffCounts {...stats} />
    </button>
  );
}
