import { OrchestrationSchema, parse } from "@zoltbot/protocol";
import { useState } from "react";
import { Button } from "../components/primitives.js";
import type { ChatConnection } from "./types.js";

export function OrchestrationRuns({
  connection,
  threadId,
}: {
  connection: ChatConnection;
  threadId: string;
}) {
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const runs = (connection.snapshot.entities.orchestration ?? [])
    .filter((row) => row.threadId === threadId)
    .map((row) => parse(OrchestrationSchema, row));
  async function action(method: string, id: string, revision: number) {
    setSaving(true);
    setError("");
    try {
      await connection.call(method, { id, revision }, crypto.randomUUID());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }
  if (!runs.length) return null;
  return (
    <section aria-label="Task phases" className="orchestration-runs">
      {error ? <p role="alert">{error}</p> : null}
      {runs.map((run) => (
        <article key={run.id} className="orchestration-run">
          <h3>Task phases · {run.state}</h3>
          <ol>
            {run.phases.map((phase) => {
              const task = connection.snapshot.entities.task?.find(
                (row) => row.id === phase.taskId,
              );
              const waiting = connection.snapshot.entities.interaction?.some(
                (row) => row.threadId === task?.threadId && row.state === "pending",
              );
              return (
                <li key={`${phase.role}:${phase.instruction}`}>
                  <strong>{phase.role}</strong> · {phase.execution.model}
                  {phase.execution.effort ? ` · ${phase.execution.effort}` : ""} · {phase.status}
                  {task?.threadId ? (
                    <>
                      {" "}
                      ·{" "}
                      <a href={`#chat/${encodeURIComponent(String(task.threadId))}`}>
                        {waiting ? "Needs your answer" : "Open phase"}
                      </a>
                    </>
                  ) : null}
                  {phase.summary ? (
                    <p>{phase.summary.replace(/\[ZOLTBOT_PHASE:(passed|blocked)\]\s*$/, "")}</p>
                  ) : null}
                </li>
              );
            })}
          </ol>
          {run.state === "running" || run.state === "blocked" ? (
            <Button
              size="sm"
              type="button"
              disabled={saving}
              onClick={() => void action("orchestration.cancel", run.id, run.revision)}
            >
              Stop task
            </Button>
          ) : null}
          {run.state === "blocked" ? (
            <>
              <Button
                size="sm"
                type="button"
                disabled={saving}
                onClick={() => void action("orchestration.retry", run.id, run.revision)}
              >
                Retry phase
              </Button>
              {run.phases.some((phase) => phase.role === "implement") ? (
                <Button
                  size="sm"
                  type="button"
                  disabled={saving}
                  onClick={() => void action("orchestration.repair", run.id, run.revision)}
                >
                  Send findings back to implementation
                </Button>
              ) : null}
            </>
          ) : null}
        </article>
      ))}
    </section>
  );
}
