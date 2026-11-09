import {
  parse,
  type Routine,
  RoutineOccurrenceSchema,
  RoutineSchema,
  terms,
} from "@zoltbot/protocol";
import { useId, useState } from "react";
import { permissionLabel } from "../chat/mode-data.js";
import type { ChatConnection } from "../chat/types.js";
import { Button, EmptyState } from "../components/primitives.js";
import { useShell } from "../state.js";
import { EventRoutineCard, EventRoutineForm } from "./EventRoutine.js";
import "./tasks.css";

export function RoutineForm({
  connection,
  taskId,
  routine,
  onClose,
}: {
  connection: ChatConnection;
  taskId?: string;
  routine?: Routine;
  onClose(): void;
}) {
  const id = useId();
  const [cron, setCron] = useState(routine?.schedule.cron ?? "0 9 * * *");
  const [timezone, setTimezone] = useState(
    routine?.schedule.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
  );
  const [notify, setNotify] = useState<Routine["notify"]>(routine?.notify ?? "actionable_only");
  const [brief, setBrief] = useState(routine?.template.brief ?? "");
  const [profileId, setProfileId] = useState(routine?.template.profileId ?? "");
  const [workspaceId, setWorkspaceId] = useState(routine?.template.workspaceId ?? "");
  const [ceiling, setCeiling] = useState(routine?.permissionCeiling ?? "read_only");
  const [inputs, setInputs] = useState(
    routine?.template.inputs ?? { knowledge: "inherit", skills: "inherit", connections: "inherit" },
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const navigate = useShell((s) => s.navigate);
  return (
    <form
      className="zb-card task-form"
      aria-label={routine ? "Edit routine" : "Make this a routine"}
      onSubmit={async (event) => {
        event.preventDefault();
        setPending(true);
        setError("");
        try {
          await connection.call(
            routine ? "routine.update" : "routine.create",
            routine
              ? {
                  id: routine.id,
                  expectedUpdatedAt: routine.updatedAt,
                  schedule: { cron, timezone },
                  notify,
                  template: {
                    ...routine.template,
                    brief,
                    profileId,
                    workspaceId: workspaceId || undefined,
                    inputs,
                  },
                  permissionCeiling: ceiling,
                }
              : { taskId, name: "", schedule: { cron, timezone }, notify },
            crypto.randomUUID(),
          );
          onClose();
          navigate("Routines");
        } catch {
          setError(
            "Could not save. Use daily/weekly cron (minute hour * * weekday) or @every Nm and a valid IANA timezone.",
          );
        } finally {
          setPending(false);
        }
      }}
    >
      <h2>{routine ? "Edit routine" : "Make this a routine"}</h2>
      <p className="dim">
        Each run starts a fresh task. Runs need your Mac awake and Zoltbot running.
      </p>
      <label htmlFor={`${id}-cron`}>Schedule</label>
      <input id={`${id}-cron`} value={cron} onChange={(e) => setCron(e.target.value)} required />
      <p className="dim">Daily at 9:00: 0 9 * * * · Mondays: 0 9 * * 1 · Hourly: @every 60m</p>
      <label htmlFor={`${id}-zone`}>Timezone</label>
      <input
        id={`${id}-zone`}
        value={timezone}
        onChange={(e) => setTimezone(e.target.value)}
        required
      />
      {routine ? (
        <>
          <label htmlFor={`${id}-brief`}>Brief for future runs</label>
          <textarea
            id={`${id}-brief`}
            value={brief}
            maxLength={4000}
            required
            onChange={(e) => setBrief(e.target.value)}
          />
        </>
      ) : null}
      {routine ? (
        <>
          <label htmlFor={`${id}-profile`}>Profile for future runs</label>
          <select
            id={`${id}-profile`}
            value={profileId}
            onChange={(event) => setProfileId(event.target.value)}
          >
            {(connection.snapshot.entities.agent ?? [])
              .filter((row) => !row.archived && !row.hidden)
              .map((row) => (
                <option key={String(row.id)} value={String(row.id)}>
                  {String(row.name)}
                </option>
              ))}
          </select>
          <label htmlFor={`${id}-folder`}>Folder for future runs</label>
          <select
            id={`${id}-folder`}
            value={workspaceId}
            onChange={(event) => setWorkspaceId(event.target.value)}
          >
            <option value="">
              {terms.workspace.One} folder or private {terms.task.one} folder
            </option>
            {(connection.snapshot.entities.workspace ?? [])
              .filter((row) => row.state === "active")
              .map((row) => (
                <option key={String(row.id)} value={String(row.id)}>
                  {String(row.path)}
                </option>
              ))}
          </select>
          <label htmlFor={`${id}-permission`}>Permission ceiling for future runs</label>
          <select
            id={`${id}-permission`}
            value={ceiling}
            onChange={(event) => setCeiling(event.target.value as Routine["permissionCeiling"])}
          >
            {["read_only", "workspace_write", "workspace_write_net", "full_access"]
              .slice(
                0,
                ["read_only", "workspace_write", "workspace_write_net", "full_access"].indexOf(
                  routine.permissionCeiling,
                ) + 1,
              )
              .map((permission) => (
                <option key={permission} value={permission}>
                  {permissionLabel(permission)}
                </option>
              ))}
          </select>
          <p className="dim">
            Inputs resolve from the selected {terms.profile.one} and {terms.workspace.one} at each
            launch, then freeze for that task. Narrow a selection with comma-separated IDs, or use
            inherit.
          </p>
          {(["knowledge", "skills", "connections"] as const).map((kind) => (
            <div key={kind}>
              <label htmlFor={`${id}-${kind}`}>
                {kind[0]?.toUpperCase()}
                {kind.slice(1)} selection
              </label>
              <input
                id={`${id}-${kind}`}
                value={
                  inputs[kind] === "inherit" ? "inherit" : (inputs[kind] as string[]).join(", ")
                }
                onChange={(event) =>
                  setInputs({
                    ...inputs,
                    [kind]:
                      event.target.value === "inherit"
                        ? "inherit"
                        : event.target.value
                            .split(",")
                            .map((value) => value.trim())
                            .filter(Boolean),
                  })
                }
              />
            </div>
          ))}
        </>
      ) : null}
      <label htmlFor={`${id}-notify`}>Notify</label>
      <select
        id={`${id}-notify`}
        value={notify}
        onChange={(e) => setNotify(e.target.value as Routine["notify"])}
      >
        <option value="actionable_only">Only actionable or needs you</option>
        <option value="always">Every result</option>
      </select>
      {error ? <p role="alert">{error}</p> : null}
      <div className="task-actions">
        <Button
          type="submit"
          variant="primary"
          disabled={pending || connection.status !== "online"}
        >
          {pending ? "Saving…" : "Save routine"}
        </Button>
        <Button onClick={onClose}>Cancel</Button>
      </div>
    </form>
  );
}

export default function Routines({ connection }: { connection: ChatConnection }) {
  const rows = connection.snapshot.entities;
  const routines = (rows.routine ?? []).map((row) => parse(RoutineSchema, row));
  const history = (rows.routineOccurrence ?? []).map((row) => parse(RoutineOccurrenceSchema, row));
  const [editing, setEditing] = useState<string>();
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const openThread = useShell((s) => s.openThread);
  return (
    <section className="tasks-page" aria-label="Routines">
      <header className="tasks-heading">
        <div>
          <h1>Routines</h1>
          <p className="dim">
            Runs need your Mac awake and Zoltbot running. Local routines are free.
          </p>
        </div>
        <Button onClick={() => setCreating(!creating)}>New routine</Button>
      </header>
      {creating ? (
        <EventRoutineForm connection={connection} onClose={() => setCreating(false)} />
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
      {!routines.length ? (
        <EmptyState level={2} icon="Routines" title="No routines yet">
          Create an event routine, or open a finished task and choose “Make this a routine”.
        </EmptyState>
      ) : null}
      {routines.map((routine) => (
        <section
          key={routine.id}
          className={routine.event ? "event-routine-history" : "zb-card task-card"}
          aria-label={`${routine.name} routine and history`}
        >
          {routine.event ? (
            <EventRoutineCard connection={connection} routine={routine} />
          ) : (
            <>
              <h2>{routine.name}</h2>
              <p>
                {routine.paused
                  ? "Paused"
                  : `Next run: ${new Date(routine.nextRunAt).toLocaleString(undefined, { timeZone: routine.schedule.timezone })} (${routine.schedule.timezone})`}
              </p>
              <p className="dim">
                {routine.schedule.cron} ·{" "}
                {routine.notify === "always"
                  ? "Notify every result"
                  : "Notify when attention is needed"}
              </p>
              <div className="task-actions">
                <Button onClick={() => setEditing(routine.id)}>Edit routine</Button>
                <Button
                  disabled={connection.status !== "online"}
                  onClick={async () => {
                    try {
                      await connection.call(
                        "routine.update",
                        {
                          id: routine.id,
                          expectedUpdatedAt: routine.updatedAt,
                          paused: !routine.paused,
                        },
                        crypto.randomUUID(),
                      );
                    } catch {
                      setError("Could not change this routine. Refresh and try again.");
                    }
                  }}
                >
                  {routine.paused ? "Resume routine" : "Pause routine"}
                </Button>
              </div>
              {editing === routine.id ? (
                <RoutineForm
                  connection={connection}
                  routine={routine}
                  onClose={() => setEditing(undefined)}
                />
              ) : null}
            </>
          )}
          <h3>Run history</h3>
          <ul>
            {history
              .filter((row) => row.routineId === routine.id)
              .sort((a, b) => b.scheduledAt.localeCompare(a.scheduledAt))
              .map((row) => {
                const task = (rows.task ?? []).find((task) => task.id === row.taskId);
                return (
                  <li key={row.id}>
                    {new Date(row.scheduledAt).toLocaleString()} ·{" "}
                    {row.sourceEvent && task ? String(task.state) : row.status}
                    {row.sourceEvent
                      ? ` · ${row.sourceEvent.resource} · ${(row.sourceEvent.sha ?? row.sourceEvent.subjectId ?? "").slice(0, 7)} · revision ${row.routineRevision}`
                      : ""}
                    {row.sourceEvent ? (
                      <details>
                        <summary>Event and admission details</summary>
                        <p>
                          Received {new Date(row.sourceEvent.receivedAt).toLocaleString()} ·
                          Admitted/recorded {new Date(row.createdAt).toLocaleString()}
                        </p>
                        <p>
                          Normalizer v{row.sourceEvent.normalizerVersion}
                          {row.sourceEvent.attempt ? ` · Attempt ${row.sourceEvent.attempt}` : ""}
                          {row.sourceEvent.kind === "github.review_requested"
                            ? ` · PR #${row.sourceEvent.subjectId} · Base ${row.sourceEvent.baseSha?.slice(0, 7)}`
                            : ""}
                        </p>
                        {row.sourceEvent.kind.startsWith("github.") ? (
                          <a
                            href={`https://github.com/${row.sourceEvent.resource.split("/").map(encodeURIComponent).join("/")}/${row.sourceEvent.kind === "github.review_requested" ? `pull/${row.sourceEvent.subjectId}` : `actions/runs/${row.sourceEvent.runId}`}`}
                            target="_blank"
                            rel="noreferrer"
                          >
                            Open source on GitHub
                          </a>
                        ) : null}
                        <p>
                          {String(
                            (rows.taskResult ?? []).find((result) => result.taskId === row.taskId)
                              ?.summary ?? "No findings yet.",
                          )}
                        </p>
                      </details>
                    ) : null}
                    {row.duplicates ? <p>Duplicate deliveries: {row.duplicates}</p> : null}
                    {row.expiresAt && row.status === "waiting" ? (
                      <p>Waiting until {new Date(row.expiresAt).toLocaleString()}</p>
                    ) : null}
                    {row.sourceEvent && !row.archivedAt && routine.event?.phase === "saved" ? (
                      <Button
                        onClick={async () => {
                          try {
                            await connection.call(
                              "routine.runOnce",
                              {
                                id: routine.id,
                                revision: routine.event!.revision,
                                occurrenceId: row.id,
                              },
                              crypto.randomUUID(),
                            );
                          } catch {
                            setError(
                              "Could not start this event again. Check current source state and routine details.",
                            );
                          }
                        }}
                      >
                        Run again · Starts a real task
                      </Button>
                    ) : null}
                    {row.frozenBrief ? (
                      <details>
                        <summary>Frozen inputs</summary>
                        <pre style={{ whiteSpace: "pre-wrap" }}>{row.frozenBrief}</pre>
                      </details>
                    ) : null}
                    {row.outcome ? ` · ${row.outcome.replace("_", " ")}` : ""}
                    {row.reason ? ` · ${row.reason}` : ""}
                    {task?.threadId ? (
                      <Button onClick={() => openThread(String(task.threadId))}>Open task</Button>
                    ) : null}
                  </li>
                );
              })}
          </ul>
          {!history.some((row) => row.routineId === routine.id) ? (
            <p className="dim">No runs yet.</p>
          ) : null}
        </section>
      ))}
    </section>
  );
}
