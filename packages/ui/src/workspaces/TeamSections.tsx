import { terms } from "@zoltbot/protocol";
import { useId } from "react";
import { type Row, text } from "../chat/types.js";
import { Chip, StatusDot, statusLabels } from "../components/primitives.js";
import { useShell } from "../state.js";
import { groupTitles, stateLabels, type TaskGroup } from "../tasks/view.js";
import { ago } from "./activity.js";
import type { ActivityEntry, MemberStatus, teamBelow, teamWork } from "./manager-view.js";

type Below = ReturnType<typeof teamBelow>;
type Work = ReturnType<typeof teamWork>;
const taskGroups: TaskGroup[] = ["needs_you", "running", "queued", "done"];

/** "1 needs you · 2 working" for a team's rollup, leaving out idle chats and the manager. */
function rollup(counts: Record<MemberStatus, number>) {
  const parts = (["needs_you", "working", "queued", "done"] as const)
    .filter((key) => counts[key] > 0)
    .map((key) => `${counts[key]} ${statusLabels[key].toLowerCase()}`);
  const total = Object.values(counts).reduce((sum, value) => sum + value, 0);
  if (parts.length) return parts.join(" · ");
  return total
    ? `${total} ${total === 1 ? terms.chat.one : terms.chat.many}, all idle`
    : `No ${terms.chat.many}`;
}

export function TeamBelow({ below }: { below: Below }) {
  const openThread = useShell((state) => state.openThread),
    openScope = useShell((state) => state.openScope);
  const ids = useId();
  return (
    <section className="card scope-content mo-below" aria-labelledby={`${ids}-below`}>
      <h2 id={`${ids}-below`}>Below this {terms.team.one}</h2>
      <section aria-labelledby={`${ids}-teams`}>
        <h3 id={`${ids}-teams`}>
          {terms.team.Many} <span className="mo-count">{below.totalTeams}</span>
        </h3>
        {below.teams.length ? (
          <ul className="mo-list">
            {below.teams.map((team) => (
              <li key={team.id}>
                <button
                  type="button"
                  className="mo-row"
                  onClick={() => openScope({ type: "subproject", id: team.id })}
                >
                  <StatusDot status={team.status} label={false} />
                  <span className="mo-row-main">
                    <strong>
                      {team.path.length ? (
                        <span className="dim">
                          {team.path.map((name) => (
                            <span key={name}>
                              <bdi>{name}</bdi> /{" "}
                            </span>
                          ))}
                        </span>
                      ) : null}
                      <bdi>{team.name}</bdi>
                    </strong>
                    <span className="dim">
                      {team.managerName ? (
                        <>
                          {terms.manager.One}: <bdi>{team.managerName}</bdi>
                        </>
                      ) : (
                        `No ${terms.manager.one}`
                      )}{" "}
                      · {rollup(team.counts)}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="dim">
            No {terms.team.many} below this one yet. Add a {terms.team.one} for each area of work,
            such as Paid ads.
          </p>
        )}
      </section>
      <section aria-labelledby={`${ids}-chats`}>
        <h3 id={`${ids}-chats`}>
          {terms.chat.Many} in this {terms.team.one} and below{" "}
          <span className="mo-count">{below.totalChats}</span>
        </h3>
        {below.chats.length ? (
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
        ) : (
          <p className="dim">
            Create a {terms.chat.one} for a question, a feature change, or an investigation. Each
            conversation stays separate.
          </p>
        )}
        {below.totalChats > below.chats.length ? (
          <p className="dim sm">
            Showing {below.chats.length} of {below.totalChats} {terms.chat.many}.
          </p>
        ) : null}
      </section>
    </section>
  );
}

function scheduleText(routine: Row) {
  const schedule = (routine.schedule ?? {}) as Row,
    next = new Date(text(routine.nextRunAt));
  const when = Number.isNaN(next.getTime())
    ? ""
    : ` · next ${next.toLocaleString(undefined, { timeZone: text(schedule.timezone) || undefined })}`;
  return `${text(schedule.cron)}${routine.paused === true ? "" : when}`;
}

export function TeamWork({ work }: { work: Work }) {
  const openThread = useShell((state) => state.openThread),
    navigate = useShell((state) => state.navigate);
  const ids = useId();
  return (
    <section className="card scope-content" aria-labelledby={`${ids}-work`}>
      <h2 id={`${ids}-work`}>Work</h2>
      <section aria-labelledby={`${ids}-tasks`}>
        <div className="mo-subhead">
          <h3 id={`${ids}-tasks`}>
            {terms.task.Many} <span className="mo-count">{work.total}</span>
          </h3>
          <button type="button" className="btn sm ghost" onClick={() => navigate("Tasks")}>
            Open {terms.task.Many}
          </button>
        </div>
        {work.total ? (
          <dl className="mo-task-counts">
            {taskGroups.map((key) => (
              <div key={key}>
                <dt>{groupTitles[key]}</dt>
                <dd>{work.counts[key]}</dd>
              </div>
            ))}
          </dl>
        ) : (
          <p className="dim">
            No {terms.task.many} in this {terms.team.one} or below.
          </p>
        )}
        {taskGroups.map((key) =>
          work.groups[key].length && key !== "done" ? (
            <ul className="mo-list" key={key} aria-label={groupTitles[key]}>
              {work.groups[key].map((task) => (
                <li key={text(task.id)}>
                  <button
                    type="button"
                    className="mo-row"
                    disabled={!text(task.threadId)}
                    onClick={() => openThread(text(task.threadId))}
                  >
                    <span className="mo-row-main">
                      <strong>
                        <bdi>{text(task.title)}</bdi>
                      </strong>
                    </span>
                    <span className="mo-state">
                      {stateLabels[text(task.state)] ?? text(task.state)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null,
        )}
      </section>
      <section aria-labelledby={`${ids}-routines`}>
        <div className="mo-subhead">
          <h3 id={`${ids}-routines`}>
            {terms.routine.Many} <span className="mo-count">{work.routines.length}</span>
          </h3>
          <button type="button" className="btn sm ghost" onClick={() => navigate("Routines")}>
            Open {terms.routine.Many}
          </button>
        </div>
        {work.routines.length ? (
          <ul className="mo-list">
            {work.routines.map((routine) => (
              <li className="mo-row static" key={text(routine.id)}>
                <span className="mo-row-main">
                  <strong>
                    <bdi>{text(routine.name)}</bdi>
                  </strong>
                  <span className="dim">{scheduleText(routine)}</span>
                </span>
                {routine.paused === true ? <Chip>Paused</Chip> : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="dim">
            No {terms.routine.many} in this {terms.team.one} or below.
          </p>
        )}
      </section>
    </section>
  );
}

export function RecentActivity({ entries }: { entries: ActivityEntry[] }) {
  const openThread = useShell((state) => state.openThread);
  const ids = useId(),
    now = new Date();
  return (
    <section className="card scope-content" aria-labelledby={`${ids}-activity`}>
      <h2 id={`${ids}-activity`}>Recent activity</h2>
      {entries.length ? (
        <ol className="mo-list">
          {entries.map((entry) => (
            <li key={`${entry.kind}:${entry.id}`}>
              <button
                type="button"
                className={`mo-row ${entry.kind}`}
                onClick={() => openThread(entry.threadId)}
              >
                {entry.kind === "needs_you" ? <StatusDot status="needs_you" label={false} /> : null}
                <span className="mo-row-main">
                  <bdi>{entry.text}</bdi>
                </span>
                <time className="dim sm" dateTime={entry.at}>
                  {ago(entry.at, now)}
                </time>
              </button>
            </li>
          ))}
        </ol>
      ) : (
        <p className="dim">
          Briefs the {terms.manager.one} sends and reports that come back appear here.
        </p>
      )}
    </section>
  );
}
