import type { CompanyChange, CompanyPlan, InitiativeRecord, ManagerRemit } from "@zoltbot/protocol";
import { useEffect, useId, useRef, useState } from "react";
import { type ChatConnection, type Row, text } from "../chat/types.js";
import { useShell } from "../state.js";
import { InitiativeEditor, RemitEditor, StructureEditor } from "./CompanyEditors.js";
import "./company.css";

type View = "organization" | "work" | "reports";
export function CompanyPanel({
  connection,
  projectId,
}: {
  connection: ChatConnection;
  projectId: string;
}) {
  const rows = connection.snapshot.entities;
  const openThread = useShell((s) => s.openThread);
  const [view, setView] = useState<View>("organization");
  const [editing, setEditing] = useState<InitiativeRecord | "new" | undefined>();
  const [remit, setRemit] = useState<Row | undefined>();
  const [initiativeFilter, setInitiativeFilter] = useState("");
  const [managerFilter, setManagerFilter] = useState("");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const status = useRef<HTMLOutputElement>(null);
  useEffect(() => {
    if (notice) status.current?.focus();
  }, [notice]);
  const ids = useId();
  const online = connection.status === "online";
  const teams = (rows.subproject ?? []).filter((r) => r.projectId === projectId && !r.archived);
  const chats = (rows.thread ?? []).filter((r) => r.projectId === projectId && !r.archived);
  const managers = chats.filter((r) => r.kind === "manager");
  const initiatives = (rows.initiativeRecord ?? []).filter(
    (r) => r.projectId === projectId,
  ) as InitiativeRecord[];
  const tasks = (rows.task ?? []).filter((r) => r.projectId === projectId);
  const plans = (rows.companyPlan ?? []).filter((r) => r.projectId === projectId) as CompanyPlan[];
  const briefs = (rows.projectBrief ?? [])
    .filter((r) => r.projectId === projectId)
    .sort((a, b) => text(b.createdAt).localeCompare(text(a.createdAt)));
  const name = (id: unknown) =>
    text(
      [
        ...chats,
        ...teams,
        ...initiatives,
        ...tasks,
        ...(rows.agent ?? []),
        ...(rows.project ?? []),
      ].find((r) => r.id === id)?.title ??
        [...chats, ...teams, ...(rows.project ?? [])].find((r) => r.id === id)?.name,
    ) ||
    text(id) ||
    "Unassigned";
  const run = async (work: () => Promise<unknown>, message: string) => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await work();
      setNotice(message);
    } catch (e) {
      setError(
        `${e instanceof Error ? e.message : "Unable to save"}. Read the current work and create a fresh proposal before trying again.`,
      );
    } finally {
      setBusy(false);
    }
  };
  const propose = (changes: CompanyChange[], title: string) =>
    connection.call(
      "company.propose",
      { id: crypto.randomUUID(), projectId, title, explanation: title, changes },
      crypto.randomUUID(),
    );
  const pending = plans.filter((r) => r.state === "proposed");
  return (
    <details className="company-panel card">
      <summary>
        Organization and work{pending.length ? ` · ${pending.length} awaiting review` : ""}
      </summary>
      <p className="dim">
        Shape the organization as work grows. You can always start a chat or task directly.
      </p>
      <div className="r wrap">
        {(["organization", "work", "reports"] as const).map((v) => (
          <button
            className="btn"
            type="button"
            key={v}
            aria-pressed={view === v}
            onClick={() => setView(v)}
          >
            {v === "organization"
              ? "Organization"
              : v === "work"
                ? "Initiatives and tasks"
                : "Project reports"}
          </button>
        ))}
      </div>
      {error ? <p role="alert">{error}</p> : null}
      <output ref={status} tabIndex={-1}>
        {notice}
      </output>
      {pending.length ? (
        <section aria-labelledby={`${ids}-plans`}>
          <h3 id={`${ids}-plans`}>Proposed changes</h3>
          {pending.map((plan) => (
            <article className="company-item" key={plan.id}>
              <h4>{plan.title}</h4>
              <p>{plan.explanation}</p>
              <ol>
                {plan.changes.map((change, index) => (
                  <li key={`${plan.id}:${JSON.stringify(change)}`}>
                    <p>{describeChange(change, name)}</p>
                    <p className="dim">{change.why}</p>
                    <details>
                      <summary>Inspect before and after</summary>
                      <ChangePreview change={change} preview={plan.preview[index]} name={name} />
                    </details>
                  </li>
                ))}
              </ol>
              {plan.authority ? (
                <p>
                  Authorize up to {plan.authority.maxTasks} additional tasks for{" "}
                  {name(plan.authority.initiativeId)}, with a total task budget reservation of $
                  {plan.authority.budgetUsd}.{" "}
                  {plan.authority.reviewTasks
                    ? "Managers may accept task results within this initiative. "
                    : "Task results require human review. "}
                  Permission ceiling: {plan.authority.permissionCeiling.replaceAll("_", " ")}.
                </p>
              ) : null}
              <p className="dim">
                Running tasks keep their execution context. Accountability changes take effect after
                the current execution finishes. Moving a chat changes its inherited context and
                access on its next session.
              </p>
              <div className="r wrap">
                <button
                  type="button"
                  className="btn primary"
                  disabled={!online || busy}
                  onClick={() =>
                    void run(
                      () =>
                        connection.call(
                          "company.decide",
                          {
                            id: plan.id,
                            version: plan.version,
                            baseline: plan.baseline,
                            approve: true,
                          },
                          crypto.randomUUID(),
                        ),
                      "Plan applied.",
                    )
                  }
                >
                  Approve {plan.title}
                </button>
                <button
                  type="button"
                  className="btn"
                  disabled={!online || busy}
                  onClick={() =>
                    void run(
                      () =>
                        connection.call(
                          "company.decide",
                          {
                            id: plan.id,
                            version: plan.version,
                            baseline: plan.baseline,
                            approve: false,
                          },
                          crypto.randomUUID(),
                        ),
                      "Proposal declined.",
                    )
                  }
                >
                  Decline {plan.title}
                </button>
              </div>
            </article>
          ))}
        </section>
      ) : null}
      {view === "organization" ? (
        <section aria-labelledby={`${ids}-org`}>
          <h3 id={`${ids}-org`}>Teams and responsibilities</h3>
          {[{ id: projectId, name: "Workspace", depth: 0 }, ...teams].map((team) => {
            const manager = managers.find((r) => (r.node as { id?: string })?.id === team.id);
            const saved = (rows.managerRemit ?? []).find((r) => r.threadId === manager?.id);
            return (
              <article className="company-item" key={text(team.id)}>
                <h4>{text(team.name)}</h4>
                {team.parentId ? <p>Reports through {name(team.parentId)}</p> : null}
                {manager ? (
                  <>
                    <button
                      className="btn"
                      type="button"
                      onClick={() => openThread(text(manager.id))}
                    >
                      Open {name(manager.id)}
                    </button>
                    <p>
                      {text(saved?.responsibilities) ||
                        "Responsibilities can be agreed with this manager."}
                    </p>
                    {saved ? (
                      <dl>
                        <dt>Capabilities</dt>
                        <dd>{text(saved.capabilities)}</dd>
                        <dt>Boundaries</dt>
                        <dd>{text(saved.boundaries)}</dd>
                        <dt>Escalation</dt>
                        <dd>{text(saved.escalation)}</dd>
                      </dl>
                    ) : null}
                    <button
                      className="btn"
                      type="button"
                      disabled={!online || busy}
                      onClick={() => setRemit(manager)}
                    >
                      Edit responsibilities for {name(manager.id)}
                    </button>
                  </>
                ) : (
                  <p className="dim">No manager assigned. Work can go directly to a chat.</p>
                )}
                <ul>
                  {initiatives
                    .filter(
                      (r) =>
                        (r.teamId ?? projectId) === team.id &&
                        !["completed", "cancelled"].includes(r.state),
                    )
                    .map((r) => (
                      <li key={r.id}>
                        {r.title} · {r.priority} priority · {r.state}
                      </li>
                    ))}
                </ul>
              </article>
            );
          })}
          <StructureEditor
            teams={teams}
            chats={chats}
            projectId={projectId}
            disabled={!online || busy}
            name={name}
            onPropose={(changes) =>
              void run(
                () => propose(changes, "Update organization"),
                "Organization proposal ready for review.",
              )
            }
          />
          {remit ? (
            <RemitEditor
              key={text(remit.id)}
              chat={remit}
              saved={
                (rows.managerRemit ?? []).find((r) => r.threadId === remit.id) as
                  | ManagerRemit
                  | undefined
              }
              projectId={projectId}
              disabled={!online || busy}
              onCancel={() => setRemit(undefined)}
              onSave={(value) =>
                void run(async () => {
                  await propose(
                    [{ kind: "remit", value, why: "Clarify responsibility and escalation" }],
                    "Update responsibilities",
                  );
                  setRemit(undefined);
                }, "Responsibilities proposal ready for review.")
              }
            />
          ) : null}
        </section>
      ) : null}
      {view === "work" ? (
        <section aria-labelledby={`${ids}-work`}>
          <h3 id={`${ids}-work`}>Initiatives and tasks</h3>
          <button
            type="button"
            className="btn"
            disabled={!online || busy}
            onClick={() => setEditing("new")}
          >
            Create initiative
          </button>
          {editing ? (
            <InitiativeEditor
              key={editing === "new" ? "new" : editing.id}
              value={editing === "new" ? undefined : editing}
              projectId={projectId}
              teams={teams}
              chats={chats}
              disabled={!online || busy}
              onCancel={() => setEditing(undefined)}
              onSave={(value) =>
                void run(async () => {
                  await propose(
                    [{ kind: "initiative", value, why: "Set the outcome and accountable owner" }],
                    `Update initiative: ${value.title}`,
                  );
                  setEditing(undefined);
                }, "Initiative proposal ready for review.")
              }
            />
          ) : null}
          {!initiatives.length ? (
            <p>
              No initiatives yet. Create one for an ongoing outcome, or keep working through direct
              tasks.
            </p>
          ) : (
            initiatives.map((r) => {
              const work = tasks.filter((t) => t.initiativeId === r.id);
              const leaves = work.filter((t) => !work.some((c) => c.parentId === t.id));
              return (
                <article className="company-item" key={r.id}>
                  <h4>{r.title}</h4>
                  <p>{r.outcome}</p>
                  <p>
                    Acceptance:{" "}
                    {r.acceptance || "Agree acceptance criteria before reviewing results."}
                  </p>
                  <p>
                    {r.state} · {r.priority} priority · Accountable: {name(r.managerThreadId)}
                  </p>
                  <p>
                    {leaves.filter((t) => ["review", "completed"].includes(text(t.state))).length}/
                    {leaves.length} finished ·{" "}
                    {leaves.filter((t) => t.state === "completed").length}/{leaves.length} accepted
                  </p>
                  {r.targetDate ? (
                    <p>Target: {new Date(r.targetDate).toLocaleDateString()}</p>
                  ) : null}
                  <p>{r.constraints}</p>
                  <button
                    type="button"
                    className="btn"
                    disabled={!online || busy}
                    onClick={() => setEditing(r)}
                  >
                    Edit {r.title}
                  </button>
                </article>
              );
            })
          )}
          <div className="company-fields">
            <label htmlFor={`${ids}-initiative`}>
              Filter by initiative
              <select
                id={`${ids}-initiative`}
                value={initiativeFilter}
                onChange={(e) => setInitiativeFilter(e.target.value)}
              >
                <option value="">All initiatives and direct work</option>
                {initiatives.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.title}
                  </option>
                ))}
              </select>
            </label>
            <label htmlFor={`${ids}-manager`}>
              Filter by accountable owner
              <select
                id={`${ids}-manager`}
                value={managerFilter}
                onChange={(e) => setManagerFilter(e.target.value)}
              >
                <option value="">All owners</option>
                {chats
                  .filter((r) => r.kind !== "task")
                  .map((r) => (
                    <option key={text(r.id)} value={text(r.id)}>
                      {name(r.id)}
                    </option>
                  ))}
              </select>
            </label>
          </div>
          <ul className="company-task-list">
            {tasks
              .filter(
                (t) =>
                  (!initiativeFilter || t.initiativeId === initiativeFilter) &&
                  (!managerFilter || t.accountableThreadId === managerFilter),
              )
              .map((task) => (
                <li key={text(task.id)}>
                  <button
                    type="button"
                    className="btn"
                    disabled={!task.threadId}
                    onClick={() => openThread(text(task.threadId))}
                  >
                    {text(task.title)}
                  </button>
                  <p>
                    {task.planned ? "Planned" : text(task.state)} · Accountable:{" "}
                    {name(task.accountableThreadId)}
                    {task.parentId ? ` · Part of ${name(task.parentId)}` : ""}
                  </p>
                  {task.holdReason ? <p>{text(task.holdReason)}</p> : null}
                  <p>Acceptance: {text(task.acceptance)}</p>
                  {Array.isArray(task.dependencies) && task.dependencies.length ? (
                    <p>Depends on: {task.dependencies.map(name).join(", ")}</p>
                  ) : null}
                  {task.pendingAccountableThreadId ? (
                    <p>
                      Next accountable owner: {name(task.pendingAccountableThreadId)} after this
                      execution finishes.
                    </p>
                  ) : null}
                  <details>
                    <summary>Assignment history and result</summary>
                    <ul>
                      {((task.assignmentHistory as Row[]) ?? []).map((h) => (
                        <li key={`${text(h.at)}:${text(h.threadId)}`}>
                          {name(h.threadId)} · {new Date(text(h.at)).toLocaleString()}
                        </li>
                      ))}
                    </ul>
                    {(rows.taskResult ?? [])
                      .filter((r) => r.taskId === task.id)
                      .map((r) => (
                        <p key={String(r.revision)}>{text(r.summary)}</p>
                      ))}
                  </details>
                </li>
              ))}
          </ul>
          {!tasks.length ? (
            <p>No tracked work yet. Start a task directly or ask Zolt to propose a plan.</p>
          ) : null}
        </section>
      ) : null}
      {view === "reports" ? (
        <section aria-labelledby={`${ids}-reports`}>
          <h3 id={`${ids}-reports`}>Project reports</h3>
          <details>
            <summary>Priorities across workspaces</summary>
            <ul>
              {(rows.initiativeRecord ?? [])
                .filter((r) => ["active", "review", "paused"].includes(text(r.state)))
                .sort(
                  (a, b) =>
                    ["urgent", "high", "normal", "low"].indexOf(text(a.priority)) -
                    ["urgent", "high", "normal", "low"].indexOf(text(b.priority)),
                )
                .map((r) => (
                  <li key={text(r.id)}>
                    {text(r.title)} · {text(r.priority)} · {text(r.state)} ·{" "}
                    {text((rows.project ?? []).find((p) => p.id === r.projectId)?.name)} ·{" "}
                    {name(r.managerThreadId)}
                  </li>
                ))}
            </ul>
          </details>
          <button
            className="btn"
            type="button"
            disabled={!online || busy}
            onClick={() =>
              void run(
                () => connection.call("company.brief", { projectId }, crypto.randomUUID()),
                "Project report saved.",
              )
            }
          >
            Save current project report
          </button>
          {!briefs.length ? (
            <p>
              Reports appear as tracked work develops. Save a report to capture the current state.
            </p>
          ) : (
            briefs.map((b) => {
              const evidence = b.evidence as { tasks?: Row[]; decisions?: Row[] };
              return (
                <article className="company-item" key={text(b.id)}>
                  <h4>
                    {text(b.day)} · Revision {String(b.revision)}
                  </h4>
                  <p>{text(b.summary)}</p>
                  <details>
                    <summary>Inspect work and decisions</summary>
                    <ul>
                      {(evidence.tasks ?? []).map((t) => (
                        <li key={text(t.id)}>
                          {t.threadId ? (
                            <button
                              className="btn"
                              type="button"
                              onClick={() => openThread(text(t.threadId))}
                            >
                              {text(t.title)}
                            </button>
                          ) : (
                            text(t.title)
                          )}{" "}
                          · {text(t.state)}
                          {t.holdReason ? ` · ${text(t.holdReason)}` : ""}
                        </li>
                      ))}
                    </ul>
                    <ul>
                      {(evidence.decisions ?? []).map((d) => (
                        <li key={text(d.id)}>{text(d.title)}</li>
                      ))}
                    </ul>
                  </details>
                </article>
              );
            })
          )}
          <details>
            <summary>Organization change history</summary>
            <ul>
              {plans
                .filter((p) => p.state !== "proposed")
                .map((p) => (
                  <li key={p.id}>
                    {p.title} · {p.state} ·{" "}
                    {p.approvedAt ? new Date(p.approvedAt).toLocaleString() : ""}
                    <ul>
                      {p.changes.map((c) => (
                        <li key={`${p.id}:${JSON.stringify(c)}`}>
                          {describeChange(c, name)} — {c.why}
                        </li>
                      ))}
                    </ul>
                  </li>
                ))}
            </ul>
          </details>
        </section>
      ) : null}
    </details>
  );
}
function describeChange(change: CompanyChange, name: (id: unknown) => string) {
  switch (change.kind) {
    case "assignManager":
      return `Assign ${name(change.id)} as manager of ${name(change.parent.id)}; retain the previous manager as a chat`;
    case "moveTask":
      return `Move ${name(change.id)} to ${name(change.initiativeId)}; execution history stays attached`;
    case "team":
      return `Create team ${change.name} under ${name(change.parent.id)}`;
    case "chat":
      return `Create ${change.manager ? "manager" : "chat"} ${change.title} in ${name(change.parent.id)}`;
    case "initiative":
      return `Set initiative ${change.value.title}: ${change.value.outcome}`;
    case "remit":
      return `Set responsibilities for ${name(change.value.threadId)}: ${change.value.responsibilities}`;
    case "task":
      return `Assign ${change.value.title}: ${change.value.brief}`;
    case "renameTeam":
      return `Rename ${name(change.id)} to ${change.name}`;
    case "archiveTeam":
      return `Archive ${name(change.id)} after its work moves`;
    case "moveTeam":
      return `Move ${name(change.id)} under ${name(change.parent.id)}; inherited context and reporting follow the new parent`;
    case "moveChat":
      return `Move ${name(change.id)} to ${name(change.parent.id)}; inherited context and manager access change`;
    case "assignTask":
      return `Transfer accountability for ${name(change.id)} to ${name(change.accountableThreadId)}`;
    case "releaseTask":
      return `Dispatch planned task ${name(change.id)}`;
  }
}
function ChangePreview({
  change,
  preview,
  name,
}: {
  change: CompanyChange;
  preview: CompanyPlan["preview"][number] | undefined;
  name: (id: unknown) => string;
}) {
  const before = preview?.before as Row | null;
  return (
    <div>
      <p>
        Before:{" "}
        {before
          ? text(before.title ?? before.name ?? before.responsibilities) || "Existing record"
          : "New record"}
      </p>
      {before?.node ? <p>Current team: {name((before.node as { id?: string }).id)}</p> : null}
      {before?.accountableThreadId ? (
        <p>Current accountable owner: {name(before.accountableThreadId)}</p>
      ) : null}
      <p>After: {describeChange(change, name)}</p>
      {change.kind === "initiative" ? (
        <dl>
          <dt>Acceptance</dt>
          <dd>{change.value.acceptance}</dd>
          <dt>Owner</dt>
          <dd>{name(change.value.managerThreadId)}</dd>
          <dt>Priority and status</dt>
          <dd>
            {change.value.priority} · {change.value.state}
          </dd>
          <dt>Constraints</dt>
          <dd>{change.value.constraints || "None specified"}</dd>
        </dl>
      ) : null}
      {change.kind === "remit" ? (
        <dl>
          <dt>Capabilities</dt>
          <dd>{change.value.capabilities}</dd>
          <dt>Boundaries</dt>
          <dd>{change.value.boundaries}</dd>
          <dt>Escalation</dt>
          <dd>{change.value.escalation}</dd>
        </dl>
      ) : null}
      {change.kind === "task" ? (
        <p>
          Acceptance: {change.value.acceptance || "Review the result"}. Dependencies:{" "}
          {(change.value.dependencies ?? []).map(name).join(", ") || "None"}.{" "}
          {change.value.planned ? "Held until dispatch." : "Queued after approval."}
        </p>
      ) : null}
    </div>
  );
}
