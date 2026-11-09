import { useId, useRef, useState } from "react";
import { Icon } from "../shell/icons.js";
import type { BackgroundTask } from "./parity-data.js";
import type { ChatConnection } from "./types.js";
import "./parity.css";

const stateLabels = {
  running: "Running",
  completed: "Completed",
  failed: "Failed",
  stopped: "Stopped",
};
/** A compact strip above the composer; expands to the task list with Stop buttons. */
export function BackgroundTasks({
  connection,
  sessionId,
  tasks,
  canStop,
}: {
  connection: ChatConnection;
  sessionId: string;
  tasks: BackgroundTask[];
  canStop: boolean;
}) {
  const id = useId();
  const [open, setOpen] = useState(false),
    [stopping, setStopping] = useState<Set<string>>(new Set()),
    [error, setError] = useState("");
  const attempts = useRef(new Map<string, string>());
  const running = tasks.filter((task) => task.state === "running").length;
  const stop = async (task: BackgroundTask) => {
    const commandId = attempts.current.get(task.id) ?? crypto.randomUUID();
    attempts.current.set(task.id, commandId);
    setStopping((previous) => new Set([...previous, task.id]));
    setError("");
    try {
      await connection.call(
        "session.stopBackground",
        { id: sessionId, taskId: task.id },
        commandId,
      );
    } catch {
      setError("Stopping could not be confirmed. Check the task's state before trying again.");
    } finally {
      setStopping((previous) => {
        const next = new Set(previous);
        next.delete(task.id);
        return next;
      });
    }
  };
  return (
    <section className="chat-background" aria-label="Background tasks">
      <button
        type="button"
        className="chat-background-toggle"
        aria-expanded={open}
        aria-controls={open ? `${id}-list` : undefined}
        onClick={() => setOpen(!open)}
      >
        {running ? (
          <span className="chat-spin" aria-hidden="true">
            <Icon name="Loader" size="sm" />
          </span>
        ) : (
          <Icon name="Terminal" size="sm" />
        )}
        <strong>
          {running
            ? `${running} background task${running === 1 ? "" : "s"} running`
            : `${tasks.length} background task${tasks.length === 1 ? "" : "s"}`}
        </strong>
        {!open && tasks.length ? (
          <span className="truncate dim">
            {(tasks.findLast((task) => task.state === "running") ?? tasks.at(-1))?.description}
          </span>
        ) : null}
        <span className="sp" />
        <Icon name={open ? "ChevronDown" : "ChevronRight"} size="sm" />
      </button>
      {error ? <p role="alert">{error}</p> : null}
      {open ? (
        <ul id={`${id}-list`} className="chat-background-list">
          {tasks.map((task) => (
            <li key={task.id} className={task.state}>
              <span className="chat-background-state">
                {task.state === "running" ? (
                  <span className="chat-spin" aria-hidden="true">
                    <Icon name="Loader" size="sm" />
                  </span>
                ) : null}
                {stateLabels[task.state]}
              </span>
              <span className="chat-background-text">
                <span className="truncate" title={task.description}>
                  {task.kind === "agent" ? "Agent · " : task.kind === "shell" ? "Shell · " : ""}
                  {task.description}
                </span>
                {task.summary ? <span className="dim truncate">{task.summary}</span> : null}
              </span>
              {canStop && task.state === "running" ? (
                <button
                  type="button"
                  className="btn sm"
                  aria-label={`Stop ${task.description}`}
                  disabled={stopping.has(task.id) || connection.status !== "online"}
                  onClick={() => void stop(task)}
                >
                  {stopping.has(task.id) ? "Stopping…" : "Stop"}
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
