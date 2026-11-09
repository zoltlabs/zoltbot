import { type EventRoutineInput, parse, type Routine, RoutineSchema } from "@zoltbot/protocol";
import { useId, useRef, useState } from "react";
import type { ChatConnection } from "../chat/types.js";
import { Button } from "../components/primitives.js";
import { useShell } from "../state.js";
import "./event-routines.css";
function routineError(error: unknown) {
  const message = error instanceof Error ? error.message : "";
  const reasons: [string, string][] = [
    ["stale_revision", "This draft changed. Review its latest details and preview again."],
    [
      "event_execution_requires_claude",
      "Choose a Claude profile for this initial investigation flow. Other adapters do not yet enforce the required tool restrictions.",
    ],
    [
      "github_account_review_required",
      "Check the GitHub account, review its identity, then preview again before enabling.",
    ],
    [
      "github_account_changed",
      "The GitHub account changed. Keep this routine paused and edit its draft to review the intended account.",
    ],
    [
      "github_auth_required",
      "GitHub needs sign-in through the existing GitHub settings. Your draft is saved.",
    ],
    [
      "github_cli_unavailable",
      "The GitHub CLI is unavailable. Review GitHub setup in Settings; your draft is saved.",
    ],
    [
      "github_access_denied",
      "This GitHub account cannot access the repository. Review repository access before trying again.",
    ],
    [
      "event_delivery_setup_unavailable",
      "Event delivery is unavailable for this source. Agent tool sign-in does not authorize events; your draft stays paused.",
    ],
    ["preview", "Preview the latest draft and save it paused before enabling."],
  ];
  return (
    reasons.find(([code]) => message.includes(code))?.[1] ??
    "Could not complete this action. Your draft is saved. Check setup and retry, or reload the latest draft."
  );
}

const eventDefaults = {
  "github.ci_failed": {
    name: "Diagnose failed CI",
    brief:
      "Investigate the failed workflow at the exact commit. Return likely cause, evidence and proposed verification steps for review.",
  },
  "github.review_requested": {
    name: "Review requested changes",
    brief:
      "Review the requested pull request at its exact head and base commits. Return actionable findings and supporting evidence for human review; do not post a review.",
  },
  "sentry.issue_created": {
    name: "Investigate new error issues",
    brief:
      "Investigate the newly grouped error issue. Return likely cause, affected scope and evidence for human review.",
  },
};

export function EventRoutineForm({
  connection,
  routine,
  onClose,
}: {
  connection: ChatConnection;
  routine?: Routine;
  onClose(): void;
}) {
  const id = useId();
  const rows = connection.snapshot.entities;
  const [name, setName] = useState(routine?.name ?? "Diagnose failed CI");
  const [brief, setBrief] = useState(
    routine?.template.brief ??
      "Investigate the failed workflow at the exact commit. Return likely cause, evidence and proposed verification steps for review.",
  );
  const [project, setProject] = useState(routine?.template.node.id ?? "");
  const [profile, setProfile] = useState(routine?.template.profileId ?? "");
  const [kind, setKind] = useState<EventRoutineInput["source"]["kind"]>(
    routine?.event?.source.kind ?? "github.ci_failed",
  );
  const [resource, setResource] = useState(routine?.event?.source.resource ?? "");
  const [branch, setBranch] = useState(routine?.event?.source.branch ?? "");
  const [dailyLimit, setDailyLimit] = useState(routine?.event?.dailyLimit ?? 5);
  const [team, setTeam] = useState(routine?.event?.source.reviewTeamId ?? "");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const key = useRef(crypto.randomUUID());
  const submittedInput = useRef("");
  return (
    <form
      className="zb-card event-routine-form"
      aria-label="New event routine"
      onSubmit={async (e) => {
        e.preventDefault();
        setPending(true);
        setError("");
        const input: EventRoutineInput = {
          name,
          brief,
          profileId: profile,
          node: routine?.template.node ?? { type: "project", id: project },
          dailyLimit,
          source: {
            kind,
            resource,
            ...(kind === "github.ci_failed" && branch ? { branch } : {}),
            ...(kind === "github.review_requested" && team ? { reviewTeamId: team } : {}),
          },
        };
        const serialized = JSON.stringify(input);
        if (submittedInput.current && submittedInput.current !== serialized)
          key.current = crypto.randomUUID();
        submittedInput.current = serialized;
        try {
          await connection.call(
            routine ? "routine.editEvent" : "routine.prepare",
            routine ? { id: routine.id, revision: routine.event?.revision, input } : input,
            key.current,
          );
          onClose();
        } catch {
          setError(
            "Could not save this draft. Check the workspace and profile, or reload the current revision before editing.",
          );
        } finally {
          setPending(false);
        }
      }}
    >
      <h2>{routine ? "Edit event routine" : "New event routine"}</h2>
      <div className="event-routine-grid">
        <div>
          <label htmlFor={`${id}-name`}>Routine name</label>
          <input
            id={`${id}-name`}
            value={name}
            maxLength={150}
            required
            onChange={(e) => setName(e.target.value)}
          />
          <label htmlFor={`${id}-kind`}>When this happens</label>
          <select
            id={`${id}-kind`}
            value={kind}
            onChange={(e) => {
              const next = e.target.value as typeof kind;
              if (name === eventDefaults[kind].name) setName(eventDefaults[next].name);
              if (brief === eventDefaults[kind].brief) setBrief(eventDefaults[next].brief);
              setKind(next);
            }}
          >
            <option value="github.ci_failed">GitHub · CI workflow fails</option>
            <option value="sentry.issue_created">
              Sentry · New error issue (setup unavailable)
            </option>
            <option value="github.review_requested">GitHub · Review requested</option>
          </select>
          <label htmlFor={`${id}-resource`}>
            {kind.startsWith("sentry") ? "Sentry organization/project" : "GitHub owner/repository"}
          </label>
          <input
            id={`${id}-resource`}
            value={resource}
            required
            pattern="[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+"
            onChange={(e) => setResource(e.target.value)}
          />
          {kind === "github.ci_failed" ? (
            <>
              <label htmlFor={`${id}-branch`}>Branch (optional)</label>
              <input
                id={`${id}-branch`}
                value={branch}
                maxLength={200}
                onChange={(e) => setBranch(e.target.value)}
              />
            </>
          ) : null}
          {kind === "github.review_requested" ? (
            <>
              <label htmlFor={`${id}-team`}>
                Review team ID (optional; otherwise your account)
              </label>
              <input
                id={`${id}-team`}
                value={team}
                pattern="[0-9]*"
                onChange={(e) => setTeam(e.target.value)}
              />
            </>
          ) : null}
          <label htmlFor={`${id}-limit`}>Maximum runs per UTC day</label>
          <input
            id={`${id}-limit`}
            type="number"
            min={1}
            max={100}
            required
            value={dailyLimit}
            onChange={(e) => setDailyLimit(Number(e.target.value))}
          />
          <label htmlFor={`${id}-project`}>Workspace</label>
          <select
            id={`${id}-project`}
            required
            value={project}
            disabled={!!routine}
            onChange={(e) => setProject(e.target.value)}
          >
            <option value="">Choose workspace</option>
            {(rows.project ?? [])
              .filter((p) => !p.archived)
              .map((p) => (
                <option key={String(p.id)} value={String(p.id)}>
                  {String(p.name)}
                </option>
              ))}
          </select>
          <label htmlFor={`${id}-profile`}>Profile</label>
          <select
            id={`${id}-profile`}
            required
            value={profile}
            onChange={(e) => setProfile(e.target.value)}
          >
            <option value="">Choose profile</option>
            {(rows.agent ?? [])
              .filter((p) => !p.archived)
              .map((p) => (
                <option key={String(p.id)} value={String(p.id)}>
                  {String(p.name)}
                </option>
              ))}
          </select>
          <label htmlFor={`${id}-brief`}>Task brief</label>
          <textarea
            id={`${id}-brief`}
            required
            maxLength={2400}
            value={brief}
            onChange={(e) => setBrief(e.target.value)}
          />
        </div>
        <div className="event-location">
          <h3>This Mac · Free</h3>
          <p>No Zoltbot subscription required. Your coding provider’s usage still applies.</p>
          <p>
            Initial execution requires Claude, which blocks shell execution and file edits.
            Read-only investigation · Findings for review · No inherited connections, skills or
            knowledge.
          </p>
          <p>
            One active run per routine, two event runs per Mac, 50 runs per workspace per UTC day.
            Busy events wait up to 15 minutes.
          </p>
          <p>
            Checks recent runs while awake. Offline events may be missed. No guaranteed offline
            queue or cloud fallback.
          </p>
          <p className="dim">Zoltbot Cloud execution is not available.</p>
        </div>
      </div>
      {error ? <p role="alert">{error}</p> : null}
      <div className="task-actions">
        <Button
          type="submit"
          variant="primary"
          disabled={pending || connection.status !== "online"}
        >
          {pending ? "Saving…" : "Save draft"}
        </Button>
        <Button onClick={onClose}>Cancel</Button>
      </div>
    </form>
  );
}

export function EventRoutineCard({
  connection,
  routine,
}: {
  connection: ChatConnection;
  routine: Routine;
}) {
  const config = routine.event!;
  const navigate = useShell((s) => s.navigate);
  const [preview, setPreview] = useState<Record<string, unknown>>();
  const [editing, setEditing] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  async function action(method: string, extra: Record<string, unknown> = {}) {
    setPending(true);
    setError("");
    try {
      const result = await connection.call(
        method,
        { id: routine.id, revision: config.revision, ...extra },
        crypto.randomUUID(),
      );
      if (method === "routine.preview") setPreview(result as Record<string, unknown>);
      if (method === "routine.connectionHandoff") navigate("Connections");
    } catch (error) {
      setError(routineError(error));
    } finally {
      setPending(false);
    }
  }
  const previewRoutine = preview?.routine as Routine | undefined;
  const reviewBasis = (r: Routine) =>
    JSON.stringify([
      r.template,
      r.event?.source,
      r.event?.accountId,
      r.event?.repositoryId,
      r.event?.generation,
      r.event?.dailyLimit,
    ]);
  const previewCurrent = previewRoutine && reviewBasis(previewRoutine) === reviewBasis(routine);
  const health = connection.snapshot.entities.settings?.find(
    (row) => row.key === `routine.event.health.${routine.id}`,
  )?.value as Record<string, unknown> | undefined;
  return (
    <section className="zb-card event-routine-card" aria-label={routine.name}>
      <header>
        <h2>{routine.name}</h2>
        <span>
          {config.phase === "draft" ? "Draft" : routine.paused ? "Saved · Paused" : "Enabled"}
        </span>
      </header>
      <p>
        {config.source.kind.replaceAll(".", " · ").replaceAll("_", " ")} · {config.source.resource}
        {config.source.branch ? ` · ${config.source.branch}` : ""}
      </p>
      <p>
        Target:{" "}
        {String(
          [
            ...(connection.snapshot.entities.project ?? []),
            ...(connection.snapshot.entities.subproject ?? []),
          ].find((row) => row.id === routine.template.node.id)?.name ?? routine.template.node.id,
        )}{" "}
        · Profile:{" "}
        {String(
          connection.snapshot.entities.agent?.find((row) => row.id === routine.template.profileId)
            ?.name ?? routine.template.profileId,
        )}
      </p>
      <p>
        <strong>This Mac · Free</strong> · Read only · Human review
      </p>
      <p>{routine.template.brief}</p>
      <p className="dim">
        1 active run · {config.dailyLimit} runs per UTC day · Recent-run polling; offline
        completeness unknown
      </p>
      {config.accountId ? (
        <p>
          Verified GitHub account {config.accountLabel ?? config.accountId} (ID {config.accountId})
          · Repository ID {config.repositoryId}
        </p>
      ) : null}
      {health ? (
        <output>
          Receiving: {routine.paused ? "Paused" : String(health.state)}
          {health.reason ? ` · ${String(health.reason)}` : ""} · Last check{" "}
          {String(health.checkedAt)} · Historical completeness unknown
        </output>
      ) : null}
      {preview && previewCurrent ? (
        <div className="event-preview" aria-live="polite">
          <h3>Test-event preview</h3>
          <strong>Dry run · No task started</strong>
          <p>{String(preview.explanation)}</p>
          <p>{String(preview.limits)}</p>
          <p>{String(preview.offlinePolicy)}</p>
          <p>{String(preview.setup)}</p>
        </div>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
      <div className="task-actions">
        {config.source.kind.startsWith("github.") && !config.accountId ? (
          <Button
            disabled={pending || connection.status !== "online"}
            onClick={() => action("routine.checkSource")}
          >
            Check GitHub account
          </Button>
        ) : null}
        <Button
          disabled={pending || connection.status !== "online"}
          onClick={() => action("routine.preview")}
        >
          Preview test event
        </Button>
        {config.phase === "draft" ? (
          <Button
            disabled={
              pending ||
              config.previewRevision !== config.revision ||
              connection.status !== "online"
            }
            onClick={() => action("routine.commit")}
          >
            Save paused
          </Button>
        ) : (
          <Button
            variant="primary"
            disabled={
              pending ||
              connection.status !== "online" ||
              (routine.paused &&
                (!config.source.kind.startsWith("github.") ||
                  !config.accountId ||
                  config.previewRevision !== config.revision))
            }
            onClick={() => action(routine.paused ? "routine.enable" : "routine.pause")}
          >
            {routine.paused ? "Enable routine" : "Pause routine"}
          </Button>
        )}
        {health && !routine.paused ? (
          <Button disabled={pending} onClick={() => action("routine.retrySource")}>
            Retry receiving
          </Button>
        ) : null}
        <Button
          disabled={pending}
          onClick={() =>
            action("routine.archiveHistory", {
              before: new Date(Date.now() - 7 * 86400000).toISOString(),
            })
          }
        >
          Archive history older than 7 days
        </Button>
        <Button onClick={() => setEditing(!editing)}>Edit details</Button>
        <Button onClick={() => navigate("Routines")}>Open routines</Button>
        {config.source.kind === "sentry.issue_created" ? (
          <Button
            disabled={pending || connection.status !== "online"}
            onClick={() => action("routine.connectionHandoff")}
          >
            Open Connections
          </Button>
        ) : null}
      </div>
      {!config.source.kind.startsWith("github.") ? (
        <p>
          Event delivery setup is not available yet. This draft stays paused; signing into agent
          tools does not authorize events.
        </p>
      ) : null}
      <p className="dim">
        Archiving removes detailed context from history; deduplication records and the audit log
        remain.
      </p>
      {editing ? (
        <EventRoutineForm
          key={config.revision}
          connection={connection}
          routine={routine}
          onClose={() => setEditing(false)}
        />
      ) : null}
    </section>
  );
}
export function ChatRoutineCards({
  connection,
  threadId,
}: {
  connection: ChatConnection;
  threadId: string;
}) {
  return (
    <>
      {(connection.snapshot.entities.routine ?? [])
        .map((row) => parse(RoutineSchema, row))
        .filter((r) => r.event?.chatId === threadId)
        .map((routine) => (
          <EventRoutineCard key={routine.id} connection={connection} routine={routine} />
        ))}
    </>
  );
}
