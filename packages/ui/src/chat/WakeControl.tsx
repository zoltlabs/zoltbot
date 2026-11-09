import { parse, type Wake, type WakeCondition, WakeSchema, wakeLabel } from "@zoltbot/protocol";
import { useId, useRef, useState } from "react";
import { Dialog } from "../components/primitives.js";
import { type ChatConnection, type Row, text } from "./types.js";
import "./wakes.css";

const live = (w: Wake) => ["draft", "waiting", "ready", "needs_attention"].includes(w.status);
const dateInput = (at: string) => {
  const d = new Date(at);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};
export function WakeControl({
  connection,
  threadId,
}: {
  connection: ChatConnection;
  threadId: string;
}) {
  const [editing, setEditing] = useState<Wake | "new">(),
    [pending, setPending] = useState(false),
    [error, setError] = useState("");
  const trigger = useRef<HTMLButtonElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const wakes = (connection.snapshot.entities.wake ?? [])
    .map((w) => parse(WakeSchema, w))
    .filter((w) => w.threadId === threadId && live(w));
  const close = () => {
    setEditing(undefined);
    requestAnimationFrame(() => {
      (opener.current?.isConnected ? opener.current : trigger.current)?.focus();
    });
  };
  async function action(wake: Wake, method: string) {
    setError("");
    setPending(true);
    try {
      await connection.call(method, { id: wake.id, revision: wake.revision }, crypto.randomUUID());
    } catch {
      setError(
        "This wait changed or the request could not be confirmed. Check its current state and try again.",
      );
    } finally {
      setPending(false);
    }
  }
  return (
    <section className="chat-wakes" aria-label="Wake when">
      <button
        ref={trigger}
        className="btn sm"
        type="button"
        onClick={(event) => {
          opener.current = event.currentTarget;
          setEditing("new");
        }}
        disabled={connection.status !== "online"}
      >
        Wake when…
      </button>
      <output className="dim sm">{error}</output>
      {wakes.map((wake) => (
        <div className="wake-card" key={wake.id}>
          <strong>
            {wake.status === "draft"
              ? "Proposed wait"
              : wake.status === "ready"
                ? "Ready · waiting for this chat to be idle"
                : wake.status === "needs_attention"
                  ? "Wait needs attention"
                  : "Waiting for"}
          </strong>
          <p>{wake.label}</p>
          <dl>
            <div>
              <dt>Then</dt>
              <dd>
                {wake.behavior === "resume"
                  ? wake.continuation
                  : "Bring this chat back to the inbox"}
              </dd>
            </div>
            <div>
              <dt>Fallback</dt>
              <dd>
                <time dateTime={wake.fallbackAt}>{new Date(wake.fallbackAt).toLocaleString()}</time>
              </dd>
            </div>
            <div>
              <dt>Monitoring</dt>
              <dd>On this Mac while Zoltbot is running. Checks pause while it sleeps.</dd>
            </div>
            {wake.lastCheckedAt ? (
              <div>
                <dt>Last checked</dt>
                <dd>{new Date(wake.lastCheckedAt).toLocaleString()}</dd>
              </div>
            ) : null}
          </dl>
          {wake.error ? <p>{wake.error}</p> : null}
          {wake.evidenceUrl ? <a href={wake.evidenceUrl}>View wake evidence</a> : null}
          <div className="wake-actions">
            {!wake.itemId ? (
              <button
                className="btn sm"
                type="button"
                onClick={(event) => {
                  opener.current = event.currentTarget;
                  setEditing(wake);
                }}
                disabled={pending}
              >
                {wake.status === "draft" ? "Review and save" : "Edit"}
              </button>
            ) : null}
            {wake.status !== "draft" && !wake.itemId ? (
              <button
                className="btn sm"
                type="button"
                onClick={() => void action(wake, "wake.resumeNow")}
                disabled={pending || connection.status !== "online"}
              >
                {wake.behavior === "resume" ? "Resume now" : "Bring back now"}
              </button>
            ) : null}
            <button
              className="btn sm ghost"
              type="button"
              onClick={() => void action(wake, "wake.cancel")}
              disabled={pending || connection.status !== "online"}
            >
              Cancel wait
            </button>
          </div>
        </div>
      ))}
      {editing ? (
        <WakeEditor
          key={typeof editing === "string" ? editing : editing.id}
          connection={connection}
          threadId={threadId}
          existing={editing === "new" ? undefined : editing}
          onClose={close}
        />
      ) : null}
    </section>
  );
}
function WakeEditor({
  connection,
  threadId,
  existing,
  onClose,
}: {
  connection: ChatConnection;
  threadId: string;
  existing: Wake | undefined;
  onClose(): void;
}) {
  const ids = useId(),
    form = useRef<HTMLFormElement>(null),
    entities = connection.snapshot.entities;
  const [kind, setKind] = useState<WakeCondition["kind"]>(existing?.condition.kind ?? "job");
  const [selected, setSelected] = useState(() => {
    const c = existing?.condition;
    return c?.kind === "job"
      ? `${encodeURIComponent(c.sessionId)}|${encodeURIComponent(c.jobId)}`
      : c?.kind === "task"
        ? c.taskId
        : c?.kind === "turn"
          ? c.turnId
          : "";
  });
  const original = existing?.condition;
  const [repository, setRepository] = useState(
    original?.kind === "pr" || original?.kind === "ci" ? original.repository : "",
  );
  const [number, setNumber] = useState(
    original?.kind === "pr"
      ? String(original.number)
      : original?.kind === "ci"
        ? original.runId
        : "",
  );
  const [attempt, setAttempt] = useState(original?.kind === "ci" ? original.attempt : 1);
  const [phrase, setPhrase] = useState(original?.kind === "topic" ? original.phrase : "");
  const [outcome, setOutcome] = useState<"finished" | "passed">(
    original && "outcome" in original ? original.outcome : "finished",
  );
  const [behavior, setBehavior] = useState(existing?.behavior ?? "inbox"),
    [continuation, setContinuation] = useState(existing?.continuation ?? "");
  const [fallback, setFallback] = useState(
    dateInput(existing?.fallbackAt ?? new Date(Date.now() + 86400000).toISOString()),
  );
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const projectId = text(entities.thread?.find((t) => t.id === threadId)?.projectId);
  const threads = (entities.thread ?? []).filter(
    (t) => !t.archived && text(t.projectId) === projectId,
  );
  const threadIds = new Set(threads.map((t) => t.id));
  const choices: { id: string; label: string }[] =
    kind === "job"
      ? (entities.session ?? [])
          .filter((s) => threadIds.has(s.threadId))
          .flatMap((s) =>
            ((s.background ?? []) as Row[]).map((j) => ({
              id: `${encodeURIComponent(text(s.id))}|${encodeURIComponent(text(j.id))}`,
              label: `${text(j.description)} · ${text(j.id)} · ${text(s.id)} · ${text(j.state)}`,
            })),
          )
      : kind === "task"
        ? (entities.task ?? [])
            .filter((t) => t.threadId !== threadId && threadIds.has(t.threadId))
            .map((t) => ({
              id: text(t.id),
              label: `${text(t.title)} · ${text(t.id)} · ${text(t.state)}`,
            }))
        : (entities.turn ?? [])
            .filter((t) => t.threadId !== threadId && threadIds.has(t.threadId))
            .map((t) => ({
              id: text(t.id),
              label: `${text(threads.find((th) => th.id === t.threadId)?.title)} · ${new Date(text(t.startedAt)).toLocaleString()} · ${text(t.status)}`,
            }));
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      let condition: WakeCondition;
      if (kind === "pr") condition = { kind, repository, number: Number(number) };
      else if (kind === "ci") condition = { kind, repository, runId: number, attempt, outcome };
      else if (kind === "topic") condition = { kind, projectId, phrase: phrase.trim() };
      else if (kind === "job") {
        const [sessionId, jobId] = selected.split("|");
        condition = {
          kind,
          sessionId: decodeURIComponent(sessionId ?? ""),
          jobId: decodeURIComponent(jobId ?? ""),
          outcome,
        };
      } else if (kind === "task") condition = { kind, taskId: selected, outcome };
      else condition = { kind, turnId: selected, outcome };
      await connection.call(
        "wake.save",
        {
          input: {
            threadId,
            condition,
            fallbackAt: new Date(fallback).toISOString(),
            behavior: kind === "topic" ? "inbox" : behavior,
            continuation,
          },
          ...(existing ? { id: existing.id, revision: existing.revision } : {}),
        },
        crypto.randomUUID(),
      );
      onClose();
    } catch (cause) {
      const code = cause instanceof Error ? cause.message : "";
      setError(
        code.includes("future_fallback")
          ? "Choose a fallback time in the future."
          : code.includes("already_waiting")
            ? "This chat already has a wait. Cancel or edit that wait first."
            : code.includes("cycle") || code.includes("self_dependency")
              ? "These chats would wait on each other. Choose a different dependency."
              : "The wait could not be saved. Check the selected source, GitHub sign-in, and fallback time, then try again.",
      );
      form.current
        ?.querySelector<HTMLElement>(
          code.includes("future_fallback") ? 'input[type="datetime-local"]' : '[role="alert"]',
        )
        ?.focus();
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      open
      title={existing ? "Edit wake condition" : "Wake when…"}
      description="Put this chat aside until a specific condition happens. The fallback brings it back even if the condition cannot be confirmed."
      onClose={onClose}
    >
      <form ref={form} onSubmit={submit} className="wake-form">
        <label htmlFor={`${ids}-kind`}>Condition</label>
        <select
          id={`${ids}-kind`}
          value={kind}
          onChange={(e) => {
            setKind(e.target.value as WakeCondition["kind"]);
            setSelected("");
          }}
        >
          <option value="job">Background job finishes</option>
          <option value="task">Task finishes</option>
          <option value="turn">Another chat turn finishes</option>
          <option value="pr">Pull request merges</option>
          <option value="ci">CI run finishes</option>
          {projectId ? <option value="topic">A topic resurfaces</option> : null}
        </select>
        {["job", "task", "turn"].includes(kind) ? (
          <>
            <label htmlFor={`${ids}-source`}>Exact {kind === "turn" ? "chat turn" : kind}</label>
            <select
              id={`${ids}-source`}
              value={selected}
              required
              onChange={(e) => setSelected(e.target.value)}
            >
              <option value="">Choose a tracked {kind}</option>
              {choices.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
            {selected ? (
              <p className="dim sm">
                Selected: {choices.find((c) => c.id === selected)?.label ?? selected}
              </p>
            ) : null}
            {!choices.length ? (
              <p className="dim">
                No tracked{" "}
                {kind === "job"
                  ? "background jobs"
                  : kind === "task"
                    ? "tasks"
                    : "turns in other chats"}{" "}
                in this workspace yet. Choose another condition or start the work first.
              </p>
            ) : null}
          </>
        ) : null}
        {kind === "pr" || kind === "ci" ? (
          <>
            <label htmlFor={`${ids}-repo`}>GitHub repository</label>
            <input
              id={`${ids}-repo`}
              value={repository}
              onChange={(e) => setRepository(e.target.value)}
              placeholder="owner/repository"
              required
              pattern="[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+"
            />
            <label htmlFor={`${ids}-number`}>
              {kind === "pr" ? "Pull request number" : "Workflow run ID"}
            </label>
            <input
              id={`${ids}-number`}
              value={number}
              onChange={(e) => setNumber(e.target.value)}
              required
              inputMode="numeric"
              pattern="[0-9]+"
            />
            {kind === "ci" ? (
              <>
                <label htmlFor={`${ids}-attempt`}>Run attempt</label>
                <input
                  id={`${ids}-attempt`}
                  type="number"
                  min="1"
                  value={attempt}
                  onChange={(e) => setAttempt(Number(e.target.value))}
                  required
                />
              </>
            ) : null}
            <p className="dim sm">
              Uses your GitHub CLI sign-in. The repository and account are verified before saving.
            </p>
          </>
        ) : null}
        {kind === "topic" ? (
          <>
            <label htmlFor={`${ids}-phrase`}>Phrase to watch for</label>
            <input
              id={`${ids}-phrase`}
              value={phrase}
              onChange={(e) => setPhrase(e.target.value)}
              required
              minLength={2}
              maxLength={200}
            />
            <p className="dim sm">
              Matches this phrase, ignoring case, in your new messages in other chats in this
              workspace. Agent messages do not match.
            </p>
          </>
        ) : null}
        {kind !== "pr" && kind !== "topic" ? (
          <>
            <label htmlFor={`${ids}-outcome`}>Wake after</label>
            <select
              id={`${ids}-outcome`}
              value={outcome}
              onChange={(e) => setOutcome(e.target.value as "finished" | "passed")}
            >
              <option value="finished">
                Any terminal result, including failure or cancellation
              </option>
              <option value="passed">Successful completion only</option>
            </select>
          </>
        ) : null}
        {kind !== "topic" ? (
          <>
            <label htmlFor={`${ids}-behavior`}>Then</label>
            <select
              id={`${ids}-behavior`}
              value={behavior}
              onChange={(e) => setBehavior(e.target.value as "inbox" | "resume")}
            >
              <option value="inbox">Bring back to inbox</option>
              <option value="resume">Resume automatically in this chat</option>
            </select>
          </>
        ) : null}
        {behavior === "resume" && kind !== "topic" ? (
          <>
            <label htmlFor={`${ids}-next`}>Next step</label>
            <textarea
              id={`${ids}-next`}
              value={continuation}
              onChange={(e) => setContinuation(e.target.value)}
              required
              maxLength={2400}
            />
            <p className="dim sm">
              Uses this chat’s existing permissions. Pending approvals still require your answer.
            </p>
          </>
        ) : null}
        <label htmlFor={`${ids}-fallback`}>Fallback time (your local timezone)</label>
        <input
          id={`${ids}-fallback`}
          type="datetime-local"
          value={fallback}
          onChange={(e) => setFallback(e.target.value)}
          required
          aria-describedby={`${ids}-fallback-help${error.includes("fallback time in the future") ? ` ${ids}-error` : ""}`}
          aria-invalid={error.includes("fallback time in the future") || undefined}
        />
        <p id={`${ids}-fallback-help`} className="dim sm">
          At this time, return to the inbox without running the next step if the condition is
          unconfirmed. Checks run only while this Mac and Zoltbot are awake.
        </p>
        <p id={`${ids}-error`} role="alert" tabIndex={-1}>
          {error}
        </p>
        <div className="wake-actions">
          <button className="btn" type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn pri"
            type="submit"
            disabled={busy || connection.status !== "online"}
          >
            {busy ? "Saving…" : "Save wait"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
export { wakeLabel };
