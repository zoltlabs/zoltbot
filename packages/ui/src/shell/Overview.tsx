import { type Interaction, InteractionSchema, parse, terms } from "@zoltbot/protocol";
import { useMemo, useState } from "react";
import { type ChatConnection, type Row, text } from "../chat/types.js";
import { chiefName, chiefNotes, chiefThreadId } from "../chief/data.js";
import { Button, Chip, EmptyState, StatusDot } from "../components/primitives.js";
import { useInteractionActions } from "../interactions/actions.js";
import type { Route } from "../state.js";
import {
  ago,
  type ChatStatus,
  scopeLabel,
  sharedFolders,
  threadProject,
  threadProvider,
} from "../workspaces/activity.js";
import { emptyRows } from "../workspaces/view.js";
import { Icon } from "./icons.js";

const kindLabels: Record<Interaction["type"], string> = {
  question: "Question",
  approval: "Approval",
  plan: "Plan",
  form: "Form",
  gate: "Review",
};

export function Overview({
  connection,
  statuses,
  navigate,
  openThread,
  openRequest,
}: {
  connection: ChatConnection;
  statuses: Map<string, ChatStatus>;
  navigate(route: Route): void;
  openThread(id: string): void;
  openRequest(id: string): void;
}) {
  const entities = connection.snapshot.entities;
  const projects = (entities.project ?? emptyRows).filter((row) => !row.archived),
    directions = entities.subproject ?? emptyRows,
    sessions = entities.session ?? emptyRows,
    profiles = (entities.agent ?? emptyRows).length;
  const [filter, setFilter] = useState("all");
  // The main agent is not one of the chats it oversees; it has its own card.
  const chief = chiefThreadId(entities),
    chiefLabel = chiefName(entities),
    notes = chiefNotes(entities);
  const threads = useMemo(() => {
    const result = new Map<string, Row>();
    for (const row of entities.thread ?? [])
      if (
        !row.archived &&
        row.id !== chief &&
        (filter === "all" || threadProject(row, directions) === filter)
      )
        result.set(text(row.id), row);
    return result;
  }, [entities.thread, directions, filter, chief]);
  const note = (row: Row) => notes.chats[text(row.id)]?.text;
  const requests = useMemo(() => {
    const result: Interaction[] = [];
    for (const row of entities.interaction ?? []) {
      if (row.state !== "pending") continue;
      try {
        result.push(parse(InteractionSchema, row));
      } catch {}
    }
    return result
      .filter((request) => filter === "all" || threads.has(request.threadId))
      .sort(
        (a, b) =>
          Number(b.urgency === "blocking") - Number(a.urgency === "blocking") ||
          a.createdAt.localeCompare(b.createdAt),
      );
  }, [entities.interaction, threads, filter]);
  // Tasks waiting on a review or a retry need you as much as a question does.
  const reviewTasks = (entities.task ?? emptyRows).filter(
    (task) =>
      ["review", "failed"].includes(text(task.state)) &&
      (filter === "all" || task.projectId === filter),
  );
  const withStatus = (status: ChatStatus) =>
    [...threads.values()]
      .filter((row) => statuses.get(text(row.id)) === status)
      .sort((a, b) => text(b.lastActivityAt).localeCompare(text(a.lastActivityAt)));
  const running = withStatus("working"),
    finished = withStatus("done"),
    // Idle chats, including ones outside any project that the sidebar tree does not list.
    recentChats = withStatus("idle").slice(0, 8);
  const overlaps = sharedFolders(sessions).filter((group) =>
    group.threadIds.some((id) => threads.has(id)),
  );
  const place = (thread: Row | undefined) =>
    thread ? scopeLabel(thread, projects, directions) || `Not in a ${terms.workspace.one}` : "";
  const provider = (id: string) => {
    const profile = entities.agent?.find((row) => row.id === threads.get(id)?.agentId);
    const definition = entities.agentDefinition?.find((row) => row.id === profile?.definitionId);
    return text(definition?.displayName) || threadProvider(sessions, id);
  };
  // Approvals the main agent asks for still land in Needs you, under its name.
  const title = (id: string) =>
    id === chief ? chiefLabel : text(threads.get(id)?.title) || "Chat";
  // A tool tag only tells chats apart when more than one tool is in use.
  const showProvider =
    new Set([...threads.keys()].map(provider).filter(Boolean)).size > 1 ? provider : () => "";
  const needCount = requests.length + reviewTasks.length;
  const quiet = !needCount && !running.length && !finished.length;
  return (
    <div className="page-stack overview">
      <header className="overview-head">
        <h1>Overview</h1>
        {projects.length > 1 ? (
          <fieldset className="overview-filter" aria-label={terms.workspace.One}>
            {[{ id: "all", name: `All ${terms.workspace.many}` }, ...projects].map((project) => (
              <button
                key={text(project.id)}
                type="button"
                aria-pressed={filter === project.id}
                onClick={() => setFilter(text(project.id))}
              >
                {text(project.name)}
              </button>
            ))}
          </fieldset>
        ) : null}
      </header>
      {profiles ? (
        <section className="zb-card overview-chief" aria-label={chiefLabel}>
          <Icon name="Chief" />
          <p className="grow">
            {chief ? (
              notes.summary ? (
                <>
                  <strong>{chiefLabel}:</strong> {notes.summary.text}{" "}
                  <span className="chief-muted">· {ago(notes.summary.at)}</span>
                </>
              ) : (
                <>
                  <strong>{chiefLabel}</strong> keeps notes on your chats here as it works.
                </>
              )
            ) : (
              <>
                <strong>{chiefLabel}</strong> is your main agent: one ongoing conversation that sees
                every chat and can act on them with your approval.
              </>
            )}
          </p>
          <Button variant="secondary" size="sm" onClick={() => navigate("Chief")}>
            {chief ? `Open ${chiefLabel}` : `Meet ${chiefLabel}`}
          </Button>
        </section>
      ) : null}
      {!profiles ? (
        <section className="zb-card overview-setup" aria-label="Setup">
          <div className="grow">
            <h2>Choose your coding agents</h2>
            <p>
              Pick which signed-in coding tools Zoltbot can use, such as Claude Code or Codex. It
              uses each tool’s own login.
            </p>
          </div>
          <Button variant="primary" onClick={() => navigate("Setup")}>
            Set up coding agents
          </Button>
        </section>
      ) : null}
      {quiet ? null : (
        <section className="summary-grid" aria-label="Workspace summary">
          {(
            [
              ["Need you", needCount, "attention"],
              ["Running now", running.length, ""],
              ["Finished, last 24 h", finished.length, ""],
            ] as const
          ).map(([label, value, tone]) => (
            <div className={`zb-card summary-card ${value ? tone : ""}`.trimEnd()} key={label}>
              <strong>{value}</strong>
              <span className="summary-label">{label}</span>
            </div>
          ))}
        </section>
      )}
      {overlaps.map((group) => (
        <section key={group.cwd} className="overview-overlap" aria-label="Shared folder">
          <span className="grow">
            {group.threadIds.length} chats are working in the same folder: <code>{group.cwd}</code>
          </span>
          <span className="overview-overlap-chats">
            {group.threadIds.map((id) => (
              <button
                key={id}
                type="button"
                className="overview-link"
                onClick={() => openThread(id)}
              >
                {title(id)}
              </button>
            ))}
          </span>
        </section>
      ))}
      {quiet && threads.size ? (
        <p className="overview-quiet">Nothing needs you and nothing is running.</p>
      ) : null}
      {needCount ? (
        <section className="overview-section" aria-labelledby="overview-needs">
          <h2 id="overview-needs">
            Needs you <Chip tone="attention">{needCount}</Chip>
          </h2>
          <div className="overview-needs">
            {requests.map((request) => (
              <NeedCard
                key={`${request.id}:${request.version}`}
                request={request}
                connection={connection}
                chat={title(request.threadId)}
                place={place(threads.get(request.threadId))}
                provider={showProvider(request.threadId)}
                onOpen={() => openRequest(request.id)}
                onChat={() => openThread(request.threadId)}
              />
            ))}
          </div>
          {reviewTasks.length ? (
            <ul className="zb-card overview-list">
              {reviewTasks.map((task) => (
                <li key={text(task.id)}>
                  <button type="button" onClick={() => navigate("Tasks")}>
                    <StatusDot status="needs_you" label={false} />
                    <strong className="truncate">{text(task.title)}</strong>
                    <span className="overview-place truncate">
                      {task.state === "failed"
                        ? "Task stopped, try again"
                        : "Task ready for review"}
                    </span>
                    <span className="overview-meta">Open in Tasks</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}
      {running.length ? (
        <ChatList
          title="Running now"
          rows={running}
          status="working"
          detail={(row) => `Updated ${ago(row.lastActivityAt)}`}
          place={place}
          note={note}
          provider={showProvider}
          openThread={openThread}
        />
      ) : null}
      {finished.length ? (
        <ChatList
          title="Finished in the last 24 hours"
          rows={finished}
          status="done"
          detail={(row) => `Finished ${ago(row.lastActivityAt)}`}
          place={place}
          note={note}
          provider={showProvider}
          openThread={openThread}
        />
      ) : null}
      {recentChats.length ? (
        <ChatList
          title="Recent chats"
          rows={recentChats}
          status="idle"
          detail={(row) => `Last active ${ago(row.lastActivityAt)}`}
          place={place}
          note={note}
          provider={showProvider}
          openThread={openThread}
        />
      ) : null}
      {!threads.size && !requests.length ? (
        <section className="zb-card">
          <EmptyState icon="Projects" title="A fresh start">
            Create a {terms.workspace.one}, add {terms.team.many} for the work you run, and start{" "}
            {terms.chat.many} inside them.
          </EmptyState>
          <div className="overview-empty-action">
            <Button variant="secondary" onClick={() => navigate("Projects")}>
              Create a {terms.workspace.one}
            </Button>
          </div>
        </section>
      ) : null}
    </div>
  );
}

function ChatList({
  title,
  rows,
  status,
  detail,
  place,
  note,
  provider,
  openThread,
}: {
  title: string;
  rows: Row[];
  status: ChatStatus;
  detail(row: Row): string;
  place(row: Row): string;
  /** The main agent's one-line note on this chat, when it has written one. */
  note(row: Row): string | undefined;
  provider(id: string): string;
  openThread(id: string): void;
}) {
  return (
    <section className="overview-section" aria-label={title}>
      <h2>{title}</h2>
      <ul className="zb-card overview-list">
        {rows.map((row) => {
          const id = text(row.id),
            tool = provider(id),
            remark = note(row);
          return (
            <li key={id}>
              <button type="button" onClick={() => openThread(id)}>
                <StatusDot status={status} label={false} />
                <strong className="truncate">{text(row.title)}</strong>
                <span className="overview-place truncate">{place(row)}</span>
                {remark ? <span className="overview-note truncate">{remark}</span> : null}
                <span className="overview-meta">{detail(row)}</span>
                {tool ? (
                  <span className={`overview-provider ${tool.toLowerCase()}`}>{tool}</span>
                ) : null}
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function NeedCard({
  request,
  connection,
  chat,
  place,
  provider,
  onOpen,
  onChat,
}: {
  request: Interaction;
  connection: ChatConnection;
  chat: string;
  place: string;
  provider: string;
  onOpen(): void;
  onChat(): void;
}) {
  const actions = useInteractionActions(connection, request);
  const disabled = actions.pending || connection.status !== "online";
  const item = request.items[0];
  const choices = new Set(item?.choices?.map((choice) => choice.id));
  // Answer in place only when one click is a complete answer; anything richer opens the Inbox.
  const quickOptions =
    request.type === "question" &&
    request.items.length === 1 &&
    item &&
    !item.multi &&
    !item.secret &&
    !item.schema &&
    item.options?.length &&
    item.options.length <= 4
      ? item.options
      : undefined;
  const command = request.context?.command;
  return (
    <article
      className="zb-card overview-need"
      aria-label={`${kindLabels[request.type]} from ${chat}`}
    >
      <div className="overview-need-meta">
        <Chip tone="attention">{kindLabels[request.type]}</Chip>
        {place ? <span>{place}</span> : null}
        <button type="button" className="overview-chat-link" onClick={onChat}>
          {chat}
        </button>
        {provider ? (
          <span className={`overview-provider ${provider.toLowerCase()}`}>{provider}</span>
        ) : null}
        <span className="grow" />
        <span>{ago(request.createdAt)}</span>
      </div>
      <p className="overview-need-text">{request.title || item?.prompt}</p>
      {command ? <pre className="overview-command">{command}</pre> : null}
      <div className="overview-need-actions">
        {request.type === "approval" && choices.has("allow_once") ? (
          <>
            <Button
              variant="primary"
              disabled={disabled}
              onClick={() => void actions.submit({ action: "accept", choice: "allow_once" })}
            >
              Approve once
            </Button>
            <Button
              variant="secondary"
              disabled={disabled}
              onClick={() => void actions.submit({ action: "decline" })}
            >
              Deny
            </Button>
          </>
        ) : quickOptions && item ? (
          quickOptions.map((option) => (
            <Button
              key={option.id}
              variant={option.recommended ? "primary" : "secondary"}
              disabled={disabled}
              onClick={() =>
                void actions.submit({
                  action: "accept",
                  answers: { [item.id]: { options: [option.id] } },
                })
              }
            >
              {option.label}
            </Button>
          ))
        ) : (
          <Button variant="primary" onClick={onOpen}>
            Review
          </Button>
        )}
        <Button
          variant="ghost"
          onClick={request.type === "approval" || quickOptions ? onOpen : onChat}
        >
          {request.type === "approval" || quickOptions ? "More options" : "Open chat"}
        </Button>
      </div>
      {actions.error ? <p role="alert">{actions.error}</p> : null}
    </article>
  );
}
