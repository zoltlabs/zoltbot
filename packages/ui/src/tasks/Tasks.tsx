import type { OutputMode, Shipping } from "@zoltbot/protocol";
import { terms } from "@zoltbot/protocol";
import { OutputControl } from "../artifacts/OutputControl.js";
import { ShippingPanel } from "../shipping/ShippingPanel.js";
import { ShippingRow } from "../shipping/ShippingRow.js";
import { attention } from "../shipping/view.js";
import { TaskBrowser } from "./Browser.js";
import { RoutineForm } from "./Routines.js";
import "../skills/register.js";
import { parse, TaskSchema } from "@zoltbot/protocol";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { DictationControl, useDictation } from "../chat/Dictation.js";
import { type ChatConnection, type Row, text } from "../chat/types.js";
import { Button, Chip, EmptyState, type Tone } from "../components/primitives.js";
import { SessionInputsPanel } from "../context/SessionInputsPanel.js";
import "../knowledge/TaskKnowledgeContextSection.js";
import "../knowledge/TaskKnowledgeWritesSection.js";
import "./TaskWorkspaceContextSection.js";
import { useShell } from "../state.js";
import { emptyRows } from "../workspaces/view.js";
import { TaskChangesSection } from "./TaskChangesSection.js";
import {
  currentResult,
  groupTasks,
  groupTitles,
  holdText,
  placeName,
  stateLabels,
  type TaskGroup,
} from "./view.js";
import "./tasks.css";

const tones: Record<string, Tone> = {
  review: "attention",
  failed: "danger",
  running: "accent",
  blocked: "warn",
  queued: "neutral",
  completed: "ok",
  cancelled: "neutral",
};
const errors: Record<string, string> = {
  browser_requires_shell_workspace_write_profile:
    "Choose a workspace-write profile explicitly to use browser verification.",
  browser_url_requires_plain_http_origin_or_path:
    "Use an http(s) URL without credentials, query values or a fragment.",
  profile_unavailable: "Choose an available profile.",
  scope_unavailable: `This ${terms.workspace.one} or ${terms.team.one} is no longer available.`,
  stale_revision: "This task changed. Review its latest result.",
  feedback_required: "Say what should change.",
  private_value_requires_secure_field: "This contains a protected value. Remove it and try again.",
};
const failure = (error: unknown, fallback: string) =>
  errors[(error instanceof Error ? error.message : "").split(":")[0] ?? ""] ?? fallback;

export default function Tasks({ connection }: { connection: ChatConnection }) {
  const designDraft = useShell((s) => s.designTaskDraft);
  const rows = connection.snapshot.entities,
    projects = (rows.project ?? emptyRows).filter((row) => !row.archived),
    directions = (rows.subproject ?? emptyRows).filter((row) => !row.archived),
    profiles = (rows.agent ?? emptyRows).filter((row) => !row.archived && !row.hidden);
  const [shippingOnly, setShippingOnly] = useState(false);
  const [initiativeFilter, setInitiativeFilter] = useState("");
  const [managerFilter, setManagerFilter] = useState("");
  const filterIds = useId();
  const shippingId = useShell((s) => s.shippingTaskId);
  const attentionIds = new Set(
    (rows.shipping ?? []).filter((row) => attention(row as Shipping)).map((row) => row.taskId),
  );
  const groups = groupTasks(
    (rows.task ?? emptyRows).filter(
      (task) =>
        (!shippingOnly || attentionIds.has(task.id)) &&
        (!initiativeFilter || task.initiativeId === initiativeFilter) &&
        (!managerFilter || task.accountableThreadId === managerFilter),
    ),
    shippingOnly,
  );
  const [creating, setCreating] = useState(Boolean(designDraft));
  const online = connection.status === "online";
  const total = (rows.task ?? emptyRows).length;
  return (
    <section className="tasks-page" aria-label="Tasks">
      <header className="tasks-heading">
        <div>
          <h1>Tasks</h1>
          <p className="dim">
            Hand a piece of work to an agent. It runs in its own conversation and comes back for
            your review.
          </p>
        </div>
        <Button
          variant="primary"
          icon="Plus"
          disabled={!online || creating || !projects.length || !profiles.length}
          onClick={() => setCreating(true)}
        >
          New task
        </Button>
      </header>
      {rows.initiativeRecord?.length || (rows.task ?? []).some((r) => r.accountableThreadId) ? (
        <div className="r wrap">
          <label htmlFor={`${filterIds}-initiative`}>
            Initiative{" "}
            <select
              id={`${filterIds}-initiative`}
              value={initiativeFilter}
              onChange={(e) => setInitiativeFilter(e.target.value)}
            >
              <option value="">All initiatives</option>
              {(rows.initiativeRecord ?? []).map((r) => (
                <option key={text(r.id)} value={text(r.id)}>
                  {text(r.title)}
                </option>
              ))}
            </select>
          </label>
          <label htmlFor={`${filterIds}-manager`}>
            Accountable owner{" "}
            <select
              id={`${filterIds}-manager`}
              value={managerFilter}
              onChange={(e) => setManagerFilter(e.target.value)}
            >
              <option value="">All owners</option>
              {(rows.thread ?? [])
                .filter((r) => (rows.task ?? []).some((t) => t.accountableThreadId === r.id))
                .map((r) => (
                  <option key={text(r.id)} value={text(r.id)}>
                    {text(r.title)}
                  </option>
                ))}
            </select>
          </label>
        </div>
      ) : null}
      {attentionIds.size || shippingOnly ? (
        <label className="tasks-attention-filter">
          <input
            type="checkbox"
            checked={shippingOnly}
            onChange={(event) => setShippingOnly(event.target.checked)}
          />
          GitHub needs attention ({attentionIds.size})
        </label>
      ) : null}
      {shippingId ? (
        <ShippingPanel key={shippingId} id={shippingId} connection={connection} />
      ) : null}
      {creating ? (
        <TaskForm
          connection={connection}
          projects={projects}
          directions={directions}
          profiles={profiles}
          initialDesign={designDraft}
          onClose={() => {
            setCreating(false);
            useShell.getState().clearDesignTask();
          }}
        />
      ) : null}
      {!total && !creating ? (
        <section className="zb-card">
          <EmptyState level={2} icon="Tasks" title="No tasks yet">
            {projects.length && profiles.length
              ? "Create a task with a goal. One task runs at a time in each code folder."
              : `Create a ${terms.workspace.one} and set up a coding tool first.`}
          </EmptyState>
        </section>
      ) : null}
      {(Object.keys(groupTitles) as TaskGroup[]).map((group) =>
        groups[group].length ? (
          <section key={group} className="task-group" aria-label={groupTitles[group]}>
            <h2>
              {groupTitles[group]} <span className="dim">{groups[group].length}</span>
            </h2>
            {groups[group].map((task, index) => (
              <TaskCard
                key={text(task.id)}
                task={task}
                ordinal={`${groupTitles[group]} ${index + 1}`}
                connection={connection}
                place={placeName(task, projects, directions)}
                profile={text(profiles.find((row) => row.id === task.ownerAgentId)?.name)}
                result={currentResult(task, rows.taskResult ?? emptyRows)}
              />
            ))}
          </section>
        ) : null,
      )}
    </section>
  );
}

function TaskForm({
  initialDesign,
  connection,
  projects,
  directions,
  profiles,
  onClose,
}: {
  initialDesign: { requestId: string; brief: string } | undefined;
  connection: ChatConnection;
  projects: Row[];
  directions: Row[];
  profiles: Row[];
  onClose(): void;
}) {
  const id = useId();
  const scope = useShell((state) => state.scope);
  const places = [
    ...projects.map((row) => ({ value: `project:${text(row.id)}`, row })),
    ...directions.map((row) => ({ value: `subproject:${text(row.id)}`, row })),
  ]
    .map(({ value, row }) => ({
      value,
      label: placeName(
        { projectId: row.projectId ?? row.id, node: { type: value.split(":")[0], id: row.id } },
        projects,
        directions,
      ),
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
  const [title, setTitle] = useState(""),
    [brief, setBrief] = useState(initialDesign?.brief ?? ""),
    [acceptance, setAcceptance] = useState(""),
    [place, setPlace] = useState(
      scope && places.some((row) => row.value === `${scope.type}:${scope.id}`)
        ? `${scope.type}:${scope.id}`
        : (places[0]?.value ?? ""),
    ),
    [workspaceMode, setWorkspaceMode] = useState("shared"),
    [baseRef, setBaseRef] = useState("HEAD"),
    [profileId, setProfileId] = useState(
      text((profiles.find((p) => p.template !== "artifact_designer") ?? profiles[0])?.id),
    ),
    [pending, setPending] = useState(false),
    [error, setError] = useState("");
  const [outputMode, setOutputMode] = useState<OutputMode>(initialDesign ? "design" : "auto");
  const ownerPicked = useRef(false);
  const [browserEnabled, setBrowserEnabled] = useState(false);
  const [browserUrl, setBrowserUrl] = useState("");
  const [browserMode, setBrowserMode] = useState("visible");
  const browserUnavailable =
    profiles.find((p) => p.id === profileId)?.permissionProfile === "read_only";
  const briefEditor = useRef<HTMLTextAreaElement>(null);
  const briefDictation = useDictation({
    scopeKey: `task-form-brief-${id}`,
    draft: brief,
    disabled: pending,
    editorRef: briefEditor,
    onUpdateDraft: (nextDraft) => setBrief(nextDraft),
    onError: setError,
  });
  const chooseOutput = useCallback(
    async (mode: OutputMode) => {
      setOutputMode(mode);
      if (mode !== "design" || ownerPicked.current) return;
      const [type, id] = place.split(":");
      const projectId =
        type === "project" ? id : text(directions.find((d) => d.id === id)?.projectId);
      setPending(true);
      setError("");
      try {
        const result = (await connection.call(
          "artifact.designer",
          { ...(projectId ? { projectId } : {}) },
          crypto.randomUUID(),
        )) as { id: string };
        setProfileId(result.id);
      } catch {
        setError(
          "Create a Claude profile to use Claude Designer, or choose another profile for this design.",
        );
      } finally {
        setPending(false);
      }
    },
    [connection.call, directions, place],
  );
  const initialDesignerRequest = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!initialDesign || initialDesignerRequest.current === initialDesign.requestId) return;
    initialDesignerRequest.current = initialDesign.requestId;
    void chooseOutput("design");
  }, [initialDesign, chooseOutput]);
  const request = useRef<{ key: string; commandId: string } | undefined>(undefined);
  return (
    <form
      className="zb-card task-form"
      aria-label="New task"
      onSubmit={async (event) => {
        event.preventDefault();
        if (pending) return;
        setError("");
        if (browserEnabled && browserUnavailable) {
          setError("Choose a workspace-write profile to use browser verification.");
          return;
        }
        if (!title.trim() || !brief.trim()) {
          setError("Enter a title and a goal.");
          return;
        }
        const [type, scopeId] = place.split(":");
        const params = {
          outputMode,
          ...(browserEnabled
            ? { browser: { mode: browserMode, ...(browserUrl ? { url: browserUrl } : {}) } }
            : {}),
          workspaceMode,
          ...(workspaceMode === "worktree" ? { baseRef } : {}),
          title: title.trim(),
          brief: brief.trim(),
          acceptance: acceptance.trim(),
          profileId,
          node: { type, id: scopeId },
        };
        const key = JSON.stringify(params);
        if (request.current?.key !== key) request.current = { key, commandId: crypto.randomUUID() };
        setPending(true);
        try {
          parse(
            TaskSchema,
            await connection.call("task.create", params, request.current.commandId),
          );
          onClose();
        } catch (problem) {
          setError(failure(problem, "Could not create the task. Your draft is kept."));
        } finally {
          setPending(false);
        }
      }}
    >
      <h2>New task</h2>
      <label htmlFor={`${id}-title`}>Title</label>
      <input
        id={`${id}-title`}
        value={title}
        maxLength={150}
        required
        disabled={pending}
        onChange={(event) => setTitle(event.target.value)}
      />
      <div className="r wrap">
        <label htmlFor={`${id}-brief`}>Goal</label>
        <span className="sp" />
        <DictationControl dictation={briefDictation} disabled={pending} label="Dictate goal" />
      </div>
      <textarea
        ref={briefEditor}
        id={`${id}-brief`}
        value={brief}
        rows={4}
        maxLength={4000}
        required
        disabled={pending}
        placeholder="What should the agent do?"
        onKeyDown={(event) => {
          briefDictation.handleKeyDown(event);
        }}
        onKeyUp={(event) => {
          briefDictation.handleKeyUp(event);
        }}
        onChange={(event) => setBrief(event.target.value)}
      />
      <label htmlFor={`${id}-acceptance`}>Done when (optional)</label>
      <textarea
        id={`${id}-acceptance`}
        value={acceptance}
        rows={2}
        maxLength={2000}
        disabled={pending}
        placeholder="How you will judge the result"
        onChange={(event) => setAcceptance(event.target.value)}
      />
      <div className="task-form-row">
        <div>
          <label htmlFor={`${id}-place`}>
            {terms.workspace.One} or {terms.team.one}
          </label>
          <select
            id={`${id}-place`}
            value={place}
            disabled={pending}
            onChange={(event) => setPlace(event.target.value)}
          >
            {places.map((row) => (
              <option key={row.value} value={row.value}>
                {row.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor={`${id}-profile`}>Profile</label>
          <select
            id={`${id}-profile`}
            value={profileId}
            disabled={pending}
            onChange={(event) => {
              ownerPicked.current = true;
              setProfileId(event.target.value);
            }}
          >
            {profiles.map((row) => (
              <option key={text(row.id)} value={text(row.id)}>
                {text(row.name)}
              </option>
            ))}
          </select>
        </div>
      </div>
      <OutputControl value={outputMode} disabled={pending} onChange={chooseOutput} />
      <div className="task-option">
        <label className="task-check">
          <input
            type="checkbox"
            checked={browserEnabled}
            onChange={(e) => setBrowserEnabled(e.target.checked)}
          />
          Check the result in a local browser
        </label>
        {browserEnabled ? (
          <>
            <p>
              Generated screenshots are written under output/zoltbot-browser in the task folder.
              Native permissions apply.
            </p>
            {browserUnavailable ? (
              <p role="alert">
                This profile cannot execute shell commands. Choose a workspace-write profile
                explicitly; your draft is preserved.
              </p>
            ) : null}
            <label htmlFor={`${id}-browser-url`}>Application URL (optional)</label>
            <input
              id={`${id}-browser-url`}
              value={browserUrl}
              onChange={(e) => setBrowserUrl(e.target.value)}
              placeholder="http://127.0.0.1:3000"
            />
            <label htmlFor={`${id}-browser-mode`}>Browser mode</label>
            <select
              id={`${id}-browser-mode`}
              value={browserMode}
              onChange={(e) => setBrowserMode(e.target.value)}
            >
              <option value="visible">Visible</option>
              <option value="background">Background</option>
            </select>
          </>
        ) : null}
      </div>
      <SessionInputsPanel
        connection={connection}
        mode="preview"
        task={{
          id: "draft",
          ...(browserEnabled ? { browser: { mode: browserMode, url: browserUrl } } : {}),
          workspaceMode,
          baseRef,
          state: "queued",
          brief,
          ownerAgentId: profileId,
          projectId: place.startsWith("project:")
            ? place.slice(8)
            : directions.find((row) => row.id === place.slice(11))?.projectId,
          node: { type: place.split(":")[0], id: place.split(":")[1] },
        }}
      />
      <p className="dim sm">
        The task starts in a new conversation with this brief, the {terms.workspace.one}’s
        instructions and the session inputs above. If another task is running in the same code
        folder, it waits.
      </p>
      <label htmlFor={`${id}-workspace`}>Work location</label>
      <select
        id={`${id}-workspace`}
        value={workspaceMode}
        onChange={(event) => setWorkspaceMode(event.target.value)}
      >
        <option value="shared">Shared folder</option>
        <option value="worktree">Separate Git worktree</option>
      </select>
      {workspaceMode === "worktree" ? (
        <>
          <label htmlFor={`${id}-base`}>Base ref</label>
          <input
            id={`${id}-base`}
            value={baseRef}
            maxLength={256}
            onChange={(event) => setBaseRef(event.target.value)}
          />
          <p className="dim sm">Resolved to a fixed commit before setup starts.</p>
        </>
      ) : null}
      <p className="dim sm">
        Separate worktrees require one Git root. Ports, databases and external services are still
        shared.
      </p>
      {error ? <p role="alert">{error}</p> : null}
      <div className="r wrap">
        <Button
          type="submit"
          variant="primary"
          disabled={pending || connection.status !== "online"}
        >
          {pending ? "Creating…" : "Create task"}
        </Button>
        <Button disabled={pending} onClick={onClose}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function TaskCard({
  task,
  ordinal,
  connection,
  place,
  profile,
  result,
}: {
  task: Row;
  connection: ChatConnection;
  place: string;
  profile: string;
  ordinal: string;
  result: Row | undefined;
}) {
  const [routineForm, setRoutineForm] = useState(false);
  const openThread = useShell((state) => state.openThread);
  const id = useId();
  const state = text(task.state),
    revision = Number(task.revision) || 1;
  const [mode, setMode] = useState<"idle" | "changes" | "stop">("idle"),
    [feedback, setFeedback] = useState(""),
    [pending, setPending] = useState(false),
    [error, setError] = useState("");
  const feedbackEditor = useRef<HTMLTextAreaElement>(null);
  const feedbackDictation = useDictation({
    scopeKey: `task-feedback-${text(task.id)}-${revision}`,
    draft: feedback,
    disabled: pending || mode !== "changes",
    editorRef: feedbackEditor,
    onUpdateDraft: (nextDraft) => setFeedback(nextDraft),
    onError: setError,
  });
  const online = connection.status === "online";
  const act = async (method: string, params: Row) => {
    setPending(true);
    setError("");
    try {
      await connection.call(method, { id: task.id, ...params }, crypto.randomUUID());
      setMode("idle");
      setFeedback("");
    } catch (problem) {
      setError(failure(problem, "That did not go through. Try again."));
    } finally {
      setPending(false);
    }
  };
  const stoppable = ["queued", "running", "blocked", "review"].includes(state);
  const hold = holdText(task);
  return (
    <article className="zb-card task-card" aria-labelledby={`${id}-title`}>
      <header>
        <div className="task-title">
          <h3 id={`${id}-title`}>
            <bdi>{text(task.title)}</bdi>
          </h3>
          <p className="dim sm">
            <bdi>{place}</bdi>
            {profile ? (
              <>
                {" · "}
                <bdi>{profile}</bdi>
              </>
            ) : null}
            {revision > 1 ? ` · Revision ${revision}` : ""}
          </p>
        </div>
        <Chip tone={tones[state] ?? "neutral"} dot>
          {stateLabels[state] ?? state}
        </Chip>
      </header>
      <ShippingRow task={task} connection={connection} />
      <SessionInputsPanel
        connection={connection}
        task={task}
        mode={state === "queued" ? "preview" : "frozen"}
      />
      {hold && state !== "completed" ? <p className="task-hold">{hold}</p> : null}
      {state === "review" && result ? (
        <section className="task-result" aria-label={`Result for ${text(task.title)}, ${ordinal}`}>
          <p>{text(result.summary)}</p>
        </section>
      ) : null}
      {task.workspaceMode === "worktree" && !task.workspaceId ? (
        <Button
          aria-disabled={!online || pending}
          onClick={() => {
            if (online && !pending) void act("task.prepareWorkspace", {});
          }}
        >
          Retry worktree setup
        </Button>
      ) : null}
      <TaskBrowser
        id={String(task.id)}
        title={`${text(task.title)}, ${ordinal}`}
        connection={connection}
      />
      <TaskChangesSection task={task} connection={connection} />
      {mode === "changes" ? (
        <div className="task-feedback">
          <div className="r wrap">
            <label htmlFor={`${id}-feedback`}>What should change?</label>
            <span className="sp" />
            <DictationControl
              dictation={feedbackDictation}
              disabled={pending}
              label="Dictate feedback"
            />
          </div>
          <textarea
            ref={feedbackEditor}
            id={`${id}-feedback`}
            value={feedback}
            rows={3}
            maxLength={2000}
            disabled={pending}
            onKeyDown={(event) => {
              feedbackDictation.handleKeyDown(event);
            }}
            onKeyUp={(event) => {
              feedbackDictation.handleKeyUp(event);
            }}
            onChange={(event) => setFeedback(event.target.value)}
          />
        </div>
      ) : null}
      {routineForm ? (
        <RoutineForm
          connection={connection}
          taskId={String(task.id)}
          onClose={() => setRoutineForm(false)}
        />
      ) : null}
      {result && !task.routineOccurrenceId ? (
        <Button onClick={() => setRoutineForm(true)}>Make this a routine</Button>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
      <div className="r wrap task-actions">
        {state === "review" && mode === "idle" ? (
          <>
            <Button
              variant="primary"
              disabled={!online || pending}
              onClick={() => act("task.review", { revision, decision: "accept", confirmed: true })}
            >
              Accept
            </Button>
            <Button disabled={!online || pending} onClick={() => setMode("changes")}>
              Request changes
            </Button>
          </>
        ) : null}
        {mode === "changes" ? (
          <>
            <Button
              variant="primary"
              disabled={!online || pending || !feedback.trim()}
              onClick={() =>
                act("task.review", {
                  revision,
                  decision: "changes",
                  feedback: feedback.trim(),
                  confirmed: true,
                })
              }
            >
              Send back
            </Button>
            <Button disabled={pending} onClick={() => setMode("idle")}>
              Cancel
            </Button>
          </>
        ) : null}
        {state === "failed" && mode === "idle" ? (
          <Button
            variant="primary"
            disabled={!online || pending}
            onClick={() => act("task.retry", {})}
          >
            Try again
          </Button>
        ) : null}
        {mode === "stop" ? (
          <>
            <Button
              variant="danger"
              disabled={!online || pending}
              onClick={() => act("task.cancel", { confirmed: true })}
            >
              Stop task
            </Button>
            <Button disabled={pending} onClick={() => setMode("idle")}>
              Keep it
            </Button>
          </>
        ) : null}
        <span className="sp" />
        {task.threadId && state !== "queued" ? (
          <Button variant="ghost" onClick={() => openThread(text(task.threadId))}>
            Open conversation
          </Button>
        ) : null}
        {stoppable && mode === "idle" ? (
          <Button variant="ghost" disabled={!online || pending} onClick={() => setMode("stop")}>
            Stop
          </Button>
        ) : null}
      </div>
    </article>
  );
}
