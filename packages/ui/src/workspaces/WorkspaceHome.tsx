import { useQuery } from "@tanstack/react-query";
import { parse, ThreadSchema, terms } from "@zoltbot/protocol";
import { type RefObject, useEffect, useId, useMemo, useRef, useState } from "react";
import { type ChatConnection, type Row, text } from "../chat/types.js";
import { StatusDot, statusLabels } from "../components/primitives.js";
import Knowledge from "../knowledge/Knowledge.js";
import { Icon } from "../shell/icons.js";
import { useShell } from "../state.js";
import { chatStatuses } from "./activity.js";
import { CompanyPanel } from "./CompanyPanel.js";
import type { CreationMode } from "./CreationForm.js";
import { queuedThreads, recentActivity, teamBelow, teamWork } from "./manager-view.js";
import { RecentActivity } from "./TeamSections.js";
import { emptyRows, type WorkspaceScope } from "./view.js";
import { DesignFiles, type Detected, SavedText, SideRow, shortPath } from "./WorkspaceDocuments.js";

const starters = [
  "Explain how this repo is laid out",
  "Find and fix a failing test",
  "Review my uncommitted changes",
];
/**
 * A workspace or team: start a chat, see its chats, and a short list of what every chat starts
 * with. Everything else (lead chat, teams, tasks, knowledge) stays one line until it is used.
 */
export function WorkspaceHome({
  connection,
  scope,
  project,
  manager,
  profiles,
  canAssign,
  canAddTeam,
  onCreate,
  details,
  onCloseDetails,
}: {
  connection: ChatConnection;
  scope: WorkspaceScope;
  project: Row;
  manager: Row | undefined;
  profiles: Row[];
  canAssign: boolean;
  canAddTeam: boolean;
  onCreate(mode: CreationMode, button: HTMLButtonElement): void;
  /** Whether the "Every chat here starts with" panel is open. */
  details: boolean;
  /** Closes Details; `focus` returns focus to the Details button. */
  onCloseDetails(focus: boolean): void;
}) {
  const openThread = useShell((state) => state.openThread),
    openScope = useShell((state) => state.openScope),
    navigate = useShell((state) => state.navigate);
  const rows = connection.snapshot.entities,
    teams = rows.subproject ?? emptyRows,
    threads = rows.thread ?? emptyRows;
  const statuses = useMemo(
    () => chatStatuses({ thread: rows.thread, turn: rows.turn, interaction: rows.interaction }),
    [rows.thread, rows.turn, rows.interaction],
  );
  const queued = useMemo(() => queuedThreads(rows.item ?? emptyRows), [rows.item]);
  const below = useMemo(
    () => teamBelow(scope, { teams, threads, profiles, statuses, queued }),
    [scope, teams, threads, profiles, statuses, queued],
  );
  const work = useMemo(
    () => teamWork(scope, rows.task ?? emptyRows, rows.routine ?? emptyRows, teams),
    [scope, rows.task, rows.routine, teams],
  );
  const managerId = manager ? text(manager.id) : undefined;
  const activity = useMemo(
    () =>
      managerId
        ? recentActivity(scope, managerId, {
            audits: rows.audit ?? emptyRows,
            interactions: rows.interaction ?? emptyRows,
            threads,
            profiles,
            teams,
          })
        : [],
    [scope, managerId, rows.audit, rows.interaction, threads, profiles, teams],
  );
  const knowledgeCount = (rows.knowledge ?? emptyRows).filter((item) => {
    const at = item.scope as { type?: string; id?: string } | undefined;
    return at?.type === scope.type && at.id === scope.id && item.status === "active";
  }).length;
  const roots = (Array.isArray(project.roots) ? (project.roots as Row[]) : [])
    .map((root) => text(root.path))
    .filter(Boolean);
  const projectId = text(project.id),
    online = connection.status === "online";
  const detected = useQuery({
    queryKey: ["project.files", projectId, roots.join("\n")],
    queryFn: async () =>
      (await connection.call("project.files.detect", { id: projectId })) as Detected,
    enabled: online && roots.length > 0,
    staleTime: 30_000,
  });
  const managerProfile = profiles.find((row) => row.id === manager?.agentId);
  const ids = useId();
  const [showKnowledge, setShowKnowledge] = useState(false);
  const composer = useRef<HTMLTextAreaElement>(null);
  const [draft, setDraft] = useState("");
  const panel = useRef<HTMLElement>(null);
  // Details closes on Escape or a click outside it, like a popover.
  useEffect(() => {
    if (!details) return;
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCloseDetails(true);
    };
    const click = (event: PointerEvent) => {
      const target = event.target as HTMLElement;
      if (!panel.current?.contains(target) && !target.closest("[aria-expanded]"))
        onCloseDetails(false);
    };
    window.addEventListener("keydown", key);
    window.addEventListener("pointerdown", click);
    return () => {
      window.removeEventListener("keydown", key);
      window.removeEventListener("pointerdown", click);
    };
  }, [details, onCloseDetails]);
  const defaultProfile =
    [text(project.defaultAgentId), text(manager?.agentId)].find((id) =>
      profiles.some((row) => row.id === id),
    ) || text((profiles.find((p) => p.template !== "artifact_designer") ?? profiles[0])?.id);
  const name = text(
    scope.type === "project" ? project.name : teams.find((row) => row.id === scope.id)?.name,
  );
  return (
    <div className={`ws-home${below.chats.length ? " has-chats" : ""}`}>
      <section className="ws-hero" aria-labelledby={`${ids}-hero`}>
        <h2
          id={`${ids}-hero`}
          className="ws-hero-title"
          aria-label={`What should we build in ${name}?`}
        >
          What should we build in{" "}
          {scope.type === "project" ? (
            <ProjectPicker current={projectId} projects={rows.project ?? emptyRows} />
          ) : (
            <strong>
              <bdi>{name}</bdi>
            </strong>
          )}
          ?
        </h2>
        <StartChat
          key={defaultProfile}
          connection={connection}
          scope={scope}
          projectId={projectId}
          profiles={profiles}
          defaultProfile={defaultProfile}
          draft={draft}
          setDraft={setDraft}
          field={composer}
          onStarted={openThread}
        />
        {below.chats.length ? null : (
          <ul className="ws-starters" aria-label="Ideas to start with">
            {starters.map((starter) => (
              <li key={starter}>
                <button
                  type="button"
                  className="btn ws-starter"
                  onClick={() => {
                    setDraft(starter);
                    composer.current?.focus();
                  }}
                >
                  {starter}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
      <CompanyPanel connection={connection} projectId={projectId} />
      {below.chats.length ? (
        <section className="ws-chats" aria-labelledby={`${ids}-chats`}>
          <h2 id={`${ids}-chats`}>
            {terms.chat.Many} <span className="mo-count">{below.totalChats}</span>
          </h2>
          <ul className="mo-list">
            {below.chats.map((chat) => (
              <li key={chat.id}>
                <button type="button" className="mo-row" onClick={() => openThread(chat.id)}>
                  <StatusDot status={chat.status} label={false} />
                  <span className="mo-row-main">
                    <strong>
                      <bdi>{chat.title}</bdi>
                    </strong>
                    <span className="dim">
                      <bdi>{chat.profileName}</bdi>
                      {chat.teamName ? (
                        <>
                          {" "}
                          · in <bdi>{chat.teamName}</bdi>
                        </>
                      ) : null}
                    </span>
                  </span>
                  <span className={`mo-state ${chat.status}`}>{statusLabels[chat.status]}</span>
                </button>
              </li>
            ))}
          </ul>
          {below.totalChats > below.chats.length ? (
            <p className="dim sm">
              Showing {below.chats.length} of {below.totalChats} {terms.chat.many}.
            </p>
          ) : null}
        </section>
      ) : null}
      {showKnowledge ? <Knowledge connection={connection} scope={scope} /> : null}
      {details ? (
        <section ref={panel} className="ws-side" aria-labelledby={`${ids}-starts`}>
          <div className="ws-side-head">
            <h2 id={`${ids}-starts`}>Every {terms.chat.one} here starts with</h2>
            <button type="button" className="btn sm ghost" onClick={() => onCloseDetails(true)}>
              Close
            </button>
          </div>
          <SideRow title={`New ${terms.chat.many}`}>
            <DefaultProfile
              connection={connection}
              project={project}
              profiles={profiles}
              current={defaultProfile}
              editable={scope.type === "project"}
            />
          </SideRow>
          <SideRow title="Instructions">
            {!roots.length ? (
              <p>No code folder, so no AGENTS.md to read.</p>
            ) : detected.data?.instructions.length ? (
              <p>
                From{" "}
                {detected.data.instructions.map((path, index) => (
                  <span key={path}>
                    {index ? " and " : ""}
                    <code title={path}>{shortPath(path, roots)}</code>
                  </span>
                ))}{" "}
                in the repo.
              </p>
            ) : detected.isPending && online ? (
              <p>Looking for AGENTS.md…</p>
            ) : (
              <p>
                No AGENTS.md in the code folder. Add one to give every {terms.chat.one} the same
                instructions.
              </p>
            )}
          </SideRow>
          <DesignFiles
            connection={connection}
            project={project}
            roots={roots}
            detected={detected.data?.design}
            finding={detected.isPending && online && roots.length > 0}
            editable={scope.type === "project"}
          />
          <SideRow
            title={`Lead ${terms.chat.one}`}
            action={
              manager ? (
                <button
                  type="button"
                  className="btn sm ghost"
                  onClick={() => openThread(text(manager.id))}
                >
                  Open
                </button>
              ) : (
                <button
                  type="button"
                  className="btn sm ghost"
                  disabled={!canAssign}
                  onClick={(event) => onCreate("manager", event.currentTarget)}
                >
                  Turn on
                </button>
              )
            }
          >
            <p>
              {manager ? (
                <>
                  On · <bdi>{text(managerProfile?.name) || `Saved ${terms.profile.one}`}</bdi>
                </>
              ) : (
                `Off. Turn on to have one ${terms.chat.one} plan work and hand it to others.`
              )}
            </p>
          </SideRow>
          <SideRow
            title={terms.team.Many}
            action={
              <button
                type="button"
                className="btn sm ghost"
                disabled={!canAddTeam}
                onClick={(event) => onCreate("direction", event.currentTarget)}
              >
                Add
              </button>
            }
          >
            {below.teams.length ? (
              <ul className="ws-links">
                {below.teams.map((team) => (
                  <li key={team.id}>
                    <button
                      type="button"
                      className="ws-link"
                      onClick={() => openScope({ type: "subproject", id: team.id })}
                    >
                      <bdi>{[...team.path, team.name].join(" / ")}</bdi>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p>None. Group {terms.chat.many} by area when you have many.</p>
            )}
          </SideRow>
          {work.total ? (
            <SideRow
              title={terms.task.Many}
              action={
                <button type="button" className="btn sm ghost" onClick={() => navigate("Tasks")}>
                  Open
                </button>
              }
            >
              <p>
                {work.counts.needs_you ? `${work.counts.needs_you} need you · ` : ""}
                {work.counts.running} running · {work.counts.queued} queued
              </p>
            </SideRow>
          ) : null}
          {work.routines.length ? (
            <SideRow
              title={terms.routine.Many}
              action={
                <button type="button" className="btn sm ghost" onClick={() => navigate("Routines")}>
                  Open
                </button>
              }
            >
              <p>
                {work.routines.length}{" "}
                {work.routines.length === 1 ? terms.routine.one : terms.routine.many}
              </p>
            </SideRow>
          ) : null}
          <SideRow
            title="Knowledge"
            action={
              <button
                type="button"
                className="btn sm ghost"
                aria-expanded={showKnowledge}
                onClick={() => setShowKnowledge((value) => !value)}
              >
                {showKnowledge ? "Hide" : "Show"}
              </button>
            }
          >
            <p>{knowledgeCount ? `${knowledgeCount} saved` : "None saved yet"}</p>
          </SideRow>
          <SavedText connection={connection} scope={scope} />
          {activity.length ? (
            <details className="ws-activity">
              <summary>Recent activity ({activity.length})</summary>
              <RecentActivity entries={activity} />
            </details>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}

/** The workspace name in the draft heading, as a menu that switches to another workspace. */
function ProjectPicker({ current, projects }: { current: string; projects: Row[] }) {
  const openScope = useShell((state) => state.openScope);
  const active = projects.filter((row) => !row.archived || row.id === current);
  const label = text(active.find((row) => row.id === current)?.name);
  return (
    <span className="ws-picker">
      <select
        aria-label={`Switch ${terms.workspace.one}`}
        value={current}
        onChange={(event) => openScope({ type: "project", id: event.target.value })}
      >
        {active.map((row) => (
          <option key={text(row.id)} value={text(row.id)}>
            {text(row.name)}
          </option>
        ))}
      </select>
      {/* The select is transparent over this text, so the heading reads as one sentence. */}
      <strong aria-hidden="true">
        <bdi>{label}</bdi>
        <span className="ws-picker-chevron">
          <Icon name="ChevronDown" size="md" />
        </span>
      </strong>
    </span>
  );
}

/** Which profile new chats here start with; teams use their workspace's choice. */
function DefaultProfile({
  connection,
  project,
  profiles,
  current,
  editable,
}: {
  connection: ChatConnection;
  project: Row;
  profiles: Row[];
  current: string;
  editable: boolean;
}) {
  const ids = useId();
  const [saving, setSaving] = useState(false),
    [error, setError] = useState("");
  if (!profiles.length) return <p>Set up a coding tool first.</p>;
  if (!editable)
    return (
      <p>
        Start with <bdi>{text(profiles.find((row) => row.id === current)?.name)}</bdi>, as set for
        the {terms.workspace.one}.
      </p>
    );
  return (
    <>
      <p className="ws-default">
        <label htmlFor={`${ids}-default`}>Start with</label>
        <select
          id={`${ids}-default`}
          value={current}
          disabled={saving || connection.status !== "online"}
          onChange={async (event) => {
            setSaving(true);
            setError("");
            try {
              await connection.call(
                "project.update",
                { id: text(project.id), changes: { defaultAgentId: event.target.value } },
                crypto.randomUUID(),
              );
            } catch {
              setError("Could not save. New chats still start with the previous profile.");
            } finally {
              setSaving(false);
            }
          }}
        >
          {profiles.map((row) => (
            <option key={text(row.id)} value={text(row.id)}>
              {text(row.name)}
            </option>
          ))}
        </select>
      </p>
      <p className="dim sm">
        Its model and permissions apply. You can still pick another per chat.
      </p>
      {error ? <p role="alert">{error}</p> : null}
    </>
  );
}

function StartChat({
  connection,
  scope,
  projectId,
  profiles,
  defaultProfile,
  draft,
  setDraft,
  field,
  onStarted,
}: {
  connection: ChatConnection;
  scope: WorkspaceScope;
  projectId: string;
  profiles: Row[];
  defaultProfile: string;
  draft: string;
  setDraft(value: string): void;
  field: RefObject<HTMLTextAreaElement | null>;
  onStarted(threadId: string): void;
}) {
  const ids = useId();
  const [profileId, setProfileId] = useState(defaultProfile),
    [pending, setPending] = useState(false),
    [error, setError] = useState("");
  // One id per draft, so a retry after a dropped reply does not create a second chat.
  const request = useRef<{ key: string; thread: string; send: string } | undefined>(undefined);
  const online = connection.status === "online";
  if (!profiles.length)
    return (
      <p className="ws-compose dim">
        Set up a coding tool to start a {terms.chat.one} in this{" "}
        {scope.type === "project" ? terms.workspace.one : terms.team.one}.
      </p>
    );
  return (
    <form
      className="ws-compose"
      onSubmit={async (event) => {
        event.preventDefault();
        const message = draft.trim();
        if (!message) {
          field.current?.focus();
          return;
        }
        if (!profiles.some((row) => row.id === profileId)) {
          setError(`Choose an available ${terms.profile.one}.`);
          return;
        }
        const key = JSON.stringify([scope, profileId, message]);
        if (request.current?.key !== key)
          request.current = { key, thread: crypto.randomUUID(), send: crypto.randomUUID() };
        const attempt = request.current,
          at = new Date().toISOString();
        const firstLine = message.split("\n")[0] ?? message;
        setPending(true);
        setError("");
        try {
          const thread = parse(
            ThreadSchema,
            await connection.call(
              "thread.create",
              {
                value: {
                  id: attempt.thread,
                  agentId: profileId,
                  projectId,
                  node: scope,
                  kind: "side",
                  title: firstLine.length > 80 ? `${firstLine.slice(0, 79)}…` : firstLine,
                  titleSource: "auto",
                  pinned: false,
                  archived: false,
                  createdAt: at,
                  lastActivityAt: at,
                },
              },
              `workspace:thread:${attempt.thread}`,
            ),
          );
          await connection.call(
            "turn.send",
            {
              threadId: thread.id,
              input: [{ type: "text", text: message }],
              mode: "queue",
              outputMode: "auto",
            },
            attempt.send,
          );
          await connection
            .call("session.connect", { threadId: thread.id }, crypto.randomUUID())
            .catch(() => undefined);
          setDraft("");
          request.current = undefined;
          onStarted(thread.id);
        } catch {
          setError("Could not start the chat. Your message is kept so you can retry.");
        } finally {
          setPending(false);
        }
      }}
    >
      <label className="ws-sr" htmlFor={`${ids}-message`}>
        Start a {terms.chat.one} in this{" "}
        {scope.type === "project" ? terms.workspace.one : terms.team.one}
      </label>
      <textarea
        ref={field}
        id={`${ids}-message`}
        rows={3}
        value={draft}
        disabled={pending}
        placeholder="Ask anything. Fix a bug, explain the code, or plan a feature…"
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            event.currentTarget.form?.requestSubmit();
          }
        }}
      />
      <div className="ws-compose-bar">
        <label className="ws-sr" htmlFor={`${ids}-profile`}>
          {terms.profile.One}
        </label>
        <select
          id={`${ids}-profile`}
          value={profileId}
          disabled={pending}
          onChange={(event) => setProfileId(event.target.value)}
        >
          {profiles.map((profile) => (
            <option key={text(profile.id)} value={text(profile.id)}>
              {text(profile.name)}
            </option>
          ))}
        </select>
        <span className="ws-grow" />
        <button type="submit" className="btn pri" disabled={pending || !online || !draft.trim()}>
          {pending ? "Starting…" : `Start ${terms.chat.one}`}
        </button>
      </div>
      {error ? <p role="alert">{error}</p> : null}
    </form>
  );
}
