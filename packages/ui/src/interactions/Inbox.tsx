import {
  type Interaction,
  InteractionSchema,
  type Mailbox,
  mailboxes,
  parse,
} from "@zoltbot/protocol";
import { useEffect, useMemo, useRef, useState } from "react";
import { type ChatConnection, type Row, text } from "../chat/types.js";
import { waitingState } from "../chat/waiting-state.js";
import { type ChiefTriage, chiefName, chiefTriage } from "../chief/data.js";
import { Avatar, Button, Chip, EmptyState, Kbd, Menu } from "../components/primitives.js";
import {
  inboxFromSnapshot,
  mailboxHints,
  mailboxLabels,
  openedInboxRow,
  pendingChips,
  rowTime,
} from "../inbox/data.js";
import { markRead } from "../inbox/read-state.js";
import { ThreadLetters } from "../inbox/ThreadLetters.js";
import { KnowledgeInbox } from "../knowledge/KnowledgeReview.js";
import { useShell } from "../state.js";
import { scopeLabel } from "../workspaces/activity.js";
import type { AnswerDraft } from "./actions.js";
import { BatchActions } from "./BatchActions.js";
import { describeAnswer, recommendedAnswer } from "./batch.js";
import { QueueVoice } from "./QueueVoice.js";

const lower = (value: string) => `${value[0]?.toLowerCase() ?? ""}${value.slice(1)}`;
const rankOrder: Record<ChiefTriage["rank"], number> = { now: 0, today: 1, later: 2 };
const rankLabel: Record<ChiefTriage["rank"], string> = {
  now: "Now",
  today: "Today",
  later: "Later",
};
const hour = 3_600_000;
function snoozeTimes(now = new Date()) {
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  tomorrow.setHours(9, 0, 0, 0);
  const monday = new Date(now);
  monday.setDate(now.getDate() + ((8 - now.getDay()) % 7 || 7));
  monday.setHours(9, 0, 0, 0);
  return [
    { label: "In 3 hours", at: new Date(now.getTime() + 3 * hour) },
    { label: "Tomorrow, 9:00", at: tomorrow },
    { label: "Monday, 9:00", at: monday },
  ];
}

/** "Needs you": the Inbox. Conversations sorted into mailboxes, read and answered like mail. */
export default function Inbox({ connection }: { connection: ChatConnection }) {
  const entities = connection.snapshot.entities;
  const [box, setBox] = useState<Mailbox>("needs_you"),
    [selected, setSelected] = useState<string | undefined>(() => {
      // Opened from a request elsewhere: start on its conversation.
      const request = useShell.getState().requestId;
      return text(entities.interaction?.find((row) => row.id === request)?.threadId) || undefined;
    }),
    [checked, setChecked] = useState(new Set<string>()),
    [pending, setPending] = useState(false),
    [error, setError] = useState(""),
    [reviewPicks, setReviewPicks] = useState(false);
  const review = useRef<(() => void) | undefined>(undefined);
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const reply = useRef<HTMLTextAreaElement>(null);
  const online = connection.status === "online";
  const triage = useMemo(() => chiefTriage(entities), [entities]);
  const chief = chiefName(entities);
  const { items, counts } = useMemo(() => inboxFromSnapshot(entities), [entities]);
  const requests = useMemo(() => {
    const result: Interaction[] = [];
    for (const row of entities.interaction ?? []) {
      if (row.state !== "pending") continue;
      try {
        result.push(parse(InteractionSchema, row));
      } catch {}
    }
    return result;
  }, [entities.interaction]);
  const requestsOf = (threadId: string) =>
    requests.filter((request) => request.threadId === threadId);
  // A conversation ranks as its most urgent request, so Zolt's "now" picks lead Needs you.
  const rankOf = (threadId: string) =>
    Math.min(
      3,
      ...requestsOf(threadId).map((request) =>
        triage[request.id] ? rankOrder[triage[request.id]?.rank ?? "later"] : 3,
      ),
    );
  const visible = items
    .filter((row) => row.mailbox === box)
    .sort((a, b) => (box === "needs_you" ? rankOf(a.thread.id) - rankOf(b.thread.id) : 0));
  // The open conversation stays open after answering moves it to another mailbox, as in mail.
  const current =
    visible.find((row) => row.thread.id === selected) ??
    openedInboxRow(items, entities, selected) ??
    visible[0];
  const currentId = current?.thread.id;
  // Pin what is on screen, so answering it does not swap in the next conversation.
  useEffect(() => {
    if (!selected && currentId) setSelected(currentId);
  }, [selected, currentId]);
  const profileOf = (thread: Row) =>
    entities.agent?.find((profile) => profile.id === thread.agentId);
  const definitionOf = (thread: Row) =>
    entities.agentDefinition?.find((row) => row.id === profileOf(thread)?.definitionId);
  const nameOf = (thread: Row) => text(profileOf(thread)?.name) || "Agent";
  const draftFor = (request: Interaction) =>
    recommendedAnswer(request, triage[request.id]?.recommend);
  const picks = requests.filter(
    (request) =>
      triage[request.id]?.rank === "now" && triage[request.id]?.recommend && draftFor(request),
  );
  const selectedRequests = requests.filter((request) => checked.has(request.threadId));
  const currentRequests = currentId ? requestsOf(currentId) : [];
  const currentPick = currentRequests.find(
    (request) => triage[request.id]?.recommend && draftFor(request),
  );
  const running = (threadId: string) =>
    entities.turn?.some((turn) => turn.threadId === threadId && turn.status === "running") ?? false;

  // Reading a conversation here counts as opening it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: marks once per open thread and finished turn
  useEffect(() => {
    if (current?.unread && current.lastTurnEndedAt)
      markRead(connection, current.thread, current.lastTurnEndedAt);
  }, [currentId, current?.lastTurnEndedAt]);

  const call = async (method: string, params: Record<string, unknown>, failure: string) => {
    if (pending || !online) return false;
    setPending(true);
    setError("");
    try {
      await connection.call(method, params, crypto.randomUUID());
      return true;
    } catch {
      setError(failure);
      return false;
    } finally {
      setPending(false);
    }
  };
  const nextAfter = (id: string | undefined) => {
    const index = visible.findIndex((row) => row.thread.id === id);
    return visible.filter((row) => row.thread.id !== id)[Math.max(0, index)]?.thread.id;
  };
  const settle = async (ids: string[]) => {
    const next = nextAfter(currentId);
    for (const id of ids)
      if (!(await call("thread.settle", { id }, "Some conversations could not be settled.")))
        return;
    setChecked(new Set());
    setSelected(next);
  };
  const snooze = async (ids: string[], at: Date) => {
    const next = nextAfter(currentId);
    for (const id of ids)
      if (
        !(await call(
          "thread.snooze",
          { id, until: at.toISOString() },
          "Some conversations could not be snoozed.",
        ))
      )
        return;
    setChecked(new Set());
    setSelected(next);
  };
  const answer = async (request: Interaction, draft: AnswerDraft) =>
    call(
      "interaction.answer",
      {
        id: request.id,
        version: request.version,
        answer: {
          ...draft,
          by: { kind: "human", id: "local-owner" },
          at: new Date().toISOString(),
        },
      },
      "That answer could not be sent. Review the request's current state.",
    );

  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        (event.target as HTMLElement)?.matches("input,textarea,select,[contenteditable=true]")
      )
        return;
      const act = (run: () => void) => {
        event.preventDefault();
        run();
      };
      if (event.key === "z" && currentPick) {
        const draft = draftFor(currentPick);
        if (draft) act(() => void answer(currentPick, draft));
        return;
      }
      if (!currentId) return;
      if (event.key === "o") return act(() => useShell.getState().openThread(currentId));
      if (event.key === "e") return act(() => void settle([currentId]));
      if (event.key === "h")
        return act(() => void snooze([currentId], snoozeTimes()[1]?.at ?? new Date()));
      if (event.key === "u")
        return act(
          () =>
            void call(
              "thread.markUnread",
              { id: currentId },
              "That conversation could not be marked unread.",
            ),
        );
      if (event.key === "r") return act(() => reply.current?.focus());
      if (event.key !== "j" && event.key !== "k") return;
      const index = visible.findIndex((row) => row.thread.id === currentId),
        next =
          visible[Math.max(0, Math.min(visible.length - 1, index + (event.key === "j" ? 1 : -1)))];
      if (next)
        act(() => {
          setSelected(next.thread.id);
          buttons.current.get(next.thread.id)?.focus();
        });
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  });
  // "Review Zolt's picks" selects their conversations, then opens the batch review.
  useEffect(() => {
    if (!reviewPicks) return;
    setReviewPicks(false);
    review.current?.();
  }, [reviewPicks]);

  const reviewTasks = (entities.task ?? []).filter((task) =>
    ["review", "failed"].includes(text(task.state)),
  ).length;
  const empty = !visible.length;
  return (
    <section className={`inbox-workspace${empty ? " empty" : ""}`} aria-label="Inbox">
      <div className="inbox-list">
        <header>
          <div className="inbox-title">
            <h1>Inbox</h1>
            {counts.needs_you ? <Chip tone="attention">{counts.needs_you} need you</Chip> : null}
          </div>
          <div className="inbox-filters" role="tablist" aria-label="Mailboxes">
            {mailboxes.map((id) => (
              <button
                key={id}
                className="inbox-filter"
                type="button"
                role="tab"
                aria-selected={box === id}
                onClick={() => {
                  setBox(id);
                  setSelected(undefined);
                  setChecked(new Set());
                }}
              >
                {mailboxLabels[id]}
                {counts[id] ? <span className="inbox-filter-count">{counts[id]}</span> : null}
              </button>
            ))}
          </div>
          <p className="inbox-hint">{mailboxHints[box]}</p>
          {box === "needs_you" && picks.length ? (
            <button
              type="button"
              className="btn sm inbox-picks"
              disabled={pending || !online}
              onClick={() => {
                setChecked(new Set(picks.map((request) => request.threadId)));
                setReviewPicks(true);
              }}
            >
              Review {chief}'s {picks.length === 1 ? "pick" : `${picks.length} picks`} for now
            </button>
          ) : null}
          {box === "needs_you" && reviewTasks ? (
            <button
              type="button"
              className="inbox-tasks-link"
              onClick={() => useShell.getState().navigate("Tasks")}
            >
              {reviewTasks === 1 ? "1 task is" : `${reviewTasks} tasks are`} waiting for you in
              Tasks
            </button>
          ) : null}
        </header>
        {checked.size ? (
          <div className="inbox-batch" role="toolbar" aria-label="Selected conversations">
            <strong>{checked.size} selected</strong>
            <Button
              size="sm"
              disabled={pending || !online}
              onClick={() => void settle([...checked])}
            >
              Settle selected
            </Button>
            {selectedRequests.length ? (
              <BatchActions
                connection={connection}
                requests={selectedRequests}
                pending={pending}
                setPending={setPending}
                triage={triage}
                reviewRef={review}
                onComplete={() => setChecked(new Set())}
              />
            ) : null}
          </div>
        ) : null}
        {error ? <p role="alert">{error}</p> : null}
        {visible.length ? (
          <ul aria-label="Conversations">
            {visible.map((row) => {
              const thread = row.thread as Row,
                id = row.thread.id,
                pick = requestsOf(id).find((request) => triage[request.id]);
              return (
                <li key={id} className={`inbox-row${currentId === id ? " selected" : ""}`}>
                  <input
                    type="checkbox"
                    aria-label={`Select ${row.thread.title || "conversation"}`}
                    disabled={pending}
                    checked={checked.has(id)}
                    onChange={(event) =>
                      setChecked((previous) => {
                        const next = new Set(previous);
                        if (event.target.checked) next.add(id);
                        else next.delete(id);
                        return next;
                      })
                    }
                  />
                  <button
                    type="button"
                    ref={(button) => {
                      if (button) buttons.current.set(id, button);
                      else buttons.current.delete(id);
                    }}
                    className="inbox-row-button"
                    aria-pressed={currentId === id}
                    onClick={() => setSelected(id)}
                  >
                    <span className="inbox-row-head">
                      <span
                        className={`inbox-row-mark${row.unread || row.mailbox === "needs_you" ? " pending" : ""}`}
                        aria-hidden
                      />
                      {row.unread ? <span className="sr-only">Unread</span> : null}
                      <Avatar
                        name={nameOf(thread)}
                        id={text(profileOf(thread)?.id)}
                        size={16}
                        tool={text(definitionOf(thread)?.id)}
                      />
                      <span className="inbox-row-profile truncate">
                        {nameOf(thread)}
                        <span className="inbox-row-scope">
                          {" "}
                          {scopeLabel(thread, entities.project ?? [], entities.subproject ?? [])}
                        </span>
                      </span>
                      <span className="inbox-row-time">
                        {rowTime(row.lastTurnEndedAt ?? row.thread.lastActivityAt)}
                      </span>
                    </span>
                    <span className="inbox-row-title">{row.thread.title || "Conversation"}</span>
                    {row.preview ? <span className="inbox-row-preview">{row.preview}</span> : null}
                    <span className="inbox-row-chips">
                      {pick && triage[pick.id] ? (
                        <Chip tone={triage[pick.id]?.rank === "now" ? "attention" : "neutral"}>
                          {rankLabel[triage[pick.id]?.rank ?? "later"]}
                        </Chip>
                      ) : null}
                      {pendingChips(row.pending).map((label) => (
                        <Chip key={label} tone="attention">
                          {label}
                        </Chip>
                      ))}
                      {(() => {
                        const wait = waitingState(entities, row.thread.id, connection.status);
                        return wait && (wait.kind === "provider" || wait.kind === "work") ? (
                          <Chip>{wait.label}</Chip>
                        ) : null;
                      })()}
                      {row.mailbox === "working" && row.thread.archiveWhenIdle ? (
                        <Chip>Settles when done</Chip>
                      ) : null}
                      {row.mailbox === "later" && row.thread.snoozedUntil ? (
                        <Chip>Until {rowTime(row.thread.snoozedUntil)}</Chip>
                      ) : null}
                    </span>
                    {pick && triage[pick.id] ? (
                      <ChiefPick request={pick} triage={triage[pick.id]} chief={chief} />
                    ) : null}
                  </button>
                </li>
              );
            })}
          </ul>
        ) : (
          <EmptyState
            icon="Inbox"
            title={box === "needs_you" ? "Nothing needs you" : `Nothing in ${mailboxLabels[box]}`}
          >
            {box === "needs_you"
              ? "Questions and approvals will appear here, one row per conversation."
              : mailboxHints[box]}
          </EmptyState>
        )}
        {box === "needs_you" ? <KnowledgeInbox connection={connection} /> : null}
      </div>
      {current ? (
        <section className="inbox-detail" aria-label="Conversation">
          <header className="inbox-detail-head">
            <div className="inbox-detail-title">
              <span className="inbox-row-scope truncate">
                {nameOf(current.thread as Row)} ·{" "}
                {scopeLabel(
                  current.thread as Row,
                  entities.project ?? [],
                  entities.subproject ?? [],
                ) || "Not in a workspace"}
              </span>
              <h2>{current.thread.title || "Conversation"}</h2>
            </div>
            <div className="inbox-detail-actions">
              <Button
                size="sm"
                kbd="o"
                onClick={() => useShell.getState().openThread(current.thread.id)}
              >
                Open as chat
              </Button>
              <Button
                size="sm"
                kbd="u"
                disabled={pending || !online}
                onClick={() =>
                  void call(
                    "thread.markUnread",
                    { id: current.thread.id },
                    "That conversation could not be marked unread.",
                  )
                }
              >
                Mark unread
              </Button>
              <Menu
                label="Snooze"
                icon="Snooze"
                items={snoozeTimes().map((time) => ({
                  label: time.label,
                  onSelect: () => void snooze([current.thread.id], time.at),
                }))}
              />
              {current.mailbox === "settled" ? (
                <Button
                  size="sm"
                  disabled={pending || !online}
                  onClick={() =>
                    void call(
                      "thread.unarchive",
                      { id: current.thread.id },
                      "That conversation could not be moved back.",
                    )
                  }
                >
                  Move to Inbox
                </Button>
              ) : (
                <Button
                  size="sm"
                  kbd="e"
                  disabled={pending || !online || !!current.thread.archiveWhenIdle}
                  onClick={() => void settle([current.thread.id])}
                >
                  {current.mailbox === "working" ? "Settle when done" : "Settle"}
                </Button>
              )}
            </div>
          </header>
          {currentRequests.length ? (
            <QueueVoice
              request={currentRequests[0]}
              recommend={currentRequests[0] ? triage[currentRequests[0].id]?.recommend : undefined}
              disabled={pending || !online}
              onAnswer={answer}
              onNext={() => setSelected(nextAfter(currentId))}
            />
          ) : null}
          <ThreadLetters
            key={current.thread.id}
            connection={connection}
            threadId={current.thread.id}
            name={nameOf(current.thread as Row)}
            busy={running(current.thread.id)}
            steer={false}
            replyRef={reply}
          />
        </section>
      ) : null}
    </section>
  );
}

/** "Zolt: approve once. Unblocks the release." Under a conversation it triaged. */
function ChiefPick({
  request,
  triage,
  chief,
}: {
  request: Interaction;
  triage: ChiefTriage | undefined;
  chief: string;
}) {
  if (!triage) return null;
  const draft = recommendedAnswer(request, triage.recommend);
  return (
    <span className="inbox-row-meta inbox-row-pick">
      {chief}
      {draft ? `: ${lower(describeAnswer(request, draft))}` : ""}
      {triage.why ? `${draft ? " · " : ": "}${triage.why}` : ""}
      {draft ? <Kbd>z</Kbd> : null}
    </span>
  );
}
