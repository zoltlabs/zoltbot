import { terms } from "@zoltbot/protocol";
import { useRef, useState } from "react";
import Chat from "../chat/Chat.js";
import { type ChatConnection, type Row, text } from "../chat/types.js";
import { Button, Chip, Field, Select, StatusDot } from "../components/primitives.js";
import { ago, type ChatStatus, scopeLabel } from "../workspaces/activity.js";
import { emptyRows } from "../workspaces/view.js";
import {
  type ChiefBrief,
  chiefAgreement,
  chiefDefaultProfile,
  chiefKeys,
  chiefName,
  chiefNotes,
  chiefQueueKeys,
  chiefThreadId,
  chiefWakeSummary,
} from "./data.js";
import "./chief.css";

/** The main agent's page: its one ongoing chat beside a live overview of every other chat. */
export function ChiefPage({
  connection,
  statuses,
  openThread,
  openRequest,
}: {
  connection: ChatConnection;
  statuses: Map<string, ChatStatus>;
  openThread(id: string): void;
  openRequest(id: string): void;
}) {
  const entities = connection.snapshot.entities;
  const threadId = chiefThreadId(entities);
  if (!threadId) return <ChiefStart connection={connection} />;
  return (
    <div className="chief-page">
      <div className="chief-chat">
        <Chat key={threadId} connection={connection} threadId={threadId} />
      </div>
      <ChiefRail
        connection={connection}
        statuses={statuses}
        self={threadId}
        openThread={openThread}
        openRequest={openRequest}
      />
    </div>
  );
}

function ChiefStart({ connection }: { connection: ChatConnection }) {
  const entities = connection.snapshot.entities;
  const name = chiefName(entities);
  const profiles = (entities.agent ?? emptyRows).filter((row) => !row.archived && !row.hidden);
  const [profileId, setProfileId] = useState(() => chiefDefaultProfile(entities) ?? "");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  // One id per attempt, so a retry after a dropped reply finds the chat it already made.
  const attempt = useRef<{ profileId: string; thread: string } | undefined>(undefined);
  async function start() {
    const selected = profileId || chiefDefaultProfile(entities);
    if (!selected) return;
    if (attempt.current?.profileId !== selected)
      attempt.current = { profileId: selected, thread: crypto.randomUUID() };
    const id = attempt.current.thread,
      at = new Date().toISOString();
    setPending(true);
    setError("");
    try {
      await connection.call(
        "thread.create",
        {
          value: {
            id,
            agentId: selected,
            kind: "main",
            title: name,
            titleSource: "human",
            pinned: false,
            archived: false,
            createdAt: at,
            lastActivityAt: at,
          },
        },
        `chief:thread:${id}`,
      );
      await connection.call(
        "settings.set",
        { key: chiefKeys.thread, value: id },
        `chief:pointer:${id}`,
      );
      // Open the session now, as a new workspace chat does, so the first message runs at once.
      await connection
        .call("session.connect", { threadId: id }, crypto.randomUUID())
        .catch(() => undefined);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setPending(false);
    }
  }
  return (
    <section className="chief-start" aria-labelledby="chief-start-title">
      <div className="zb-card chief-start-card">
        <h1 id="chief-start-title">Meet {name}</h1>
        <p>
          {name} is your main agent. It keeps one conversation that never ends, sees what every chat
          across your {terms.workspace.many} is doing, and can start, message or stop chats once you
          approve.
        </p>
        <p className="chief-muted">
          Each message you send carries a fresh status summary, so {name} answers from what is
          happening now. Use Quick chat for side questions.
        </p>
        {profiles.length ? (
          <>
            <Field label="Runs on">
              <Select value={profileId} onChange={(event) => setProfileId(event.target.value)}>
                {profiles.map((row) => (
                  <option key={text(row.id)} value={text(row.id)}>
                    {text(row.name)}
                  </option>
                ))}
              </Select>
            </Field>
            <div className="chief-start-actions">
              <Button
                variant="primary"
                disabled={pending || connection.status !== "online"}
                onClick={() => void start()}
              >
                {pending ? "Starting…" : `Start ${name}`}
              </Button>
            </div>
          </>
        ) : (
          <output>Set up a coding agent first, then come back to start {name}.</output>
        )}
        {error ? (
          <p role="alert">
            Could not start {name}: {error}
          </p>
        ) : null}
      </div>
    </section>
  );
}

const railSections: { status: ChatStatus; title: string; limit: number }[] = [
  { status: "needs_you", title: "Needs you", limit: 8 },
  { status: "working", title: "Running", limit: 8 },
  { status: "done", title: "Finished, last 24 h", limit: 6 },
];

/** A compact Overview: what needs you, what runs, what finished, with the chief's notes. */
export function ChiefRail({
  connection,
  statuses,
  self,
  openThread,
  openRequest,
}: {
  connection: ChatConnection;
  statuses: Map<string, ChatStatus>;
  self: string;
  openThread(id: string): void;
  openRequest(id: string): void;
}) {
  const entities = connection.snapshot.entities;
  const name = chiefName(entities),
    notes = chiefNotes(entities);
  const projects = entities.project ?? emptyRows,
    directions = entities.subproject ?? emptyRows;
  const threads = (entities.thread ?? emptyRows).filter((row) => !row.archived && row.id !== self);
  // The chief's own approvals belong in its chat, not in this list.
  const requestFor = (id: string) =>
    entities.interaction?.find((row) => row.threadId === id && row.state === "pending");
  const rows = (status: ChatStatus) =>
    threads
      .filter((row) => statuses.get(text(row.id)) === status)
      .sort((a, b) => text(b.lastActivityAt).localeCompare(text(a.lastActivityAt)));
  const quiet = railSections.every(({ status }) => !rows(status).length);
  return (
    <aside className="chief-rail" aria-label={`What ${name} is watching`}>
      <h2 className="chief-rail-title">Overview</h2>
      {notes.summary ? (
        <p className="chief-summary">
          <span>{notes.summary.text}</span>
          <span className="chief-muted"> · {ago(notes.summary.at)}</span>
        </p>
      ) : null}
      {quiet ? <p className="chief-muted">Nothing needs you and nothing is running.</p> : null}
      <ChiefWakeups connection={connection} name={name} />
      {railSections.map(({ status, title, limit }) => {
        const list = rows(status);
        if (!list.length) return null;
        return (
          <section key={status} className="chief-rail-section" aria-label={title}>
            <h3>
              {title}{" "}
              <Chip tone={status === "needs_you" ? "attention" : "neutral"}>{list.length}</Chip>
            </h3>
            <ul>
              {list.slice(0, limit).map((row) => (
                <RailRow
                  key={text(row.id)}
                  row={row}
                  status={status}
                  place={scopeLabel(row, projects, directions)}
                  note={notes.chats[text(row.id)]?.text}
                  onOpen={() => {
                    const request = status === "needs_you" ? requestFor(text(row.id)) : undefined;
                    if (request) openRequest(text(request.id));
                    else openThread(text(row.id));
                  }}
                />
              ))}
            </ul>
            {list.length > limit ? (
              <p className="chief-muted">{list.length - limit} more on the Overview</p>
            ) : null}
          </section>
        );
      })}
    </aside>
  );
}

function RailRow({
  row,
  status,
  place,
  note,
  onOpen,
}: {
  row: Row;
  status: ChatStatus;
  place: string;
  note: string | undefined;
  onOpen(): void;
}) {
  return (
    <li>
      <button type="button" className="chief-rail-row" onClick={onOpen}>
        <StatusDot status={status} label={false} />
        <span className="chief-rail-text">
          <strong className="truncate">{text(row.title) || "Chat"}</strong>
          <span className="chief-muted truncate">
            {[place, ago(row.lastActivityAt)].filter(Boolean).join(" · ")}
          </span>
          {note ? <span className="chief-note">{note}</span> : null}
        </span>
      </button>
    </li>
  );
}

/** Whether the chief wakes itself, how often it did today, and how often you agreed with it. */
function ChiefWakeups({ connection, name }: { connection: ChatConnection; name: string }) {
  const entities = connection.snapshot.entities;
  const now = Date.now();
  const wake = chiefWakeSummary(entities, now),
    agreement = chiefAgreement(entities, now);
  const [pending, setPending] = useState(false),
    [wanted, setWanted] = useState<{ enabled?: boolean; brief?: ChiefBrief }>({});
  // Shows your choice at once; the saved setting takes over when it arrives or the save fails.
  const enabled = wanted.enabled ?? wake.enabled,
    brief = wanted.brief ?? wake.brief;
  const save = async (changes: { enabled?: boolean; brief?: ChiefBrief }) => {
    setWanted(changes);
    const current = entities.settings?.find((row) => row.key === chiefQueueKeys.proactive)?.value;
    setPending(true);
    try {
      await connection.call(
        "settings.set",
        {
          key: chiefQueueKeys.proactive,
          value: { ...(current && typeof current === "object" ? current : {}), ...changes },
        },
        crypto.randomUUID(),
      );
    } finally {
      setPending(false);
      setWanted({});
    }
  };
  const disabled = pending || connection.status !== "online";
  return (
    <section className="chief-rail-section chief-wakeups" aria-label="Wake-ups">
      <label className="chief-wake-toggle">
        <input
          type="checkbox"
          checked={enabled}
          disabled={disabled}
          onChange={(event) => void save({ enabled: event.target.checked })}
        />
        Wake on its own
      </label>
      <p className="chief-muted">
        {enabled
          ? `${wake.used} of ${wake.allowance} wake-ups today${wake.used ? ` · ${wake.useful} useful` : ""}. ${name} wakes only when something needs a decision, and never in quiet hours.`
          : `${name} wakes only for the morning brief, if it is on.`}
      </p>
      <div className="chief-brief">
        <label className="chief-wake-toggle">
          <input
            type="checkbox"
            checked={brief.enabled}
            disabled={disabled}
            onChange={(event) => void save({ brief: { ...brief, enabled: event.target.checked } })}
          />
          Morning brief
        </label>
        {brief.enabled ? (
          <input
            type="time"
            aria-label="Morning brief time"
            value={brief.time}
            disabled={disabled}
            onChange={(event) =>
              event.target.value && void save({ brief: { ...brief, time: event.target.value } })
            }
          />
        ) : null}
      </div>
      <p className="chief-muted">
        {brief.enabled
          ? `Each day at ${brief.time}, a short brief of what finished and what needs you. Skipped when nothing happened.`
          : "A short daily brief of what finished and what needs you."}
      </p>
      {agreement.total ? (
        <p className="chief-muted">
          Your calls matched {name}'s on {agreement.agreed} of {agreement.total} this week.
        </p>
      ) : null}
    </section>
  );
}
