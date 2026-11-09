import { useId, useState } from "react";
import { Icon } from "../shell/icons.js";
import { planEntries, planProgress } from "./timeline-data.js";
import type { Row } from "./types.js";
import "./parity.css";

/** The thread's newest plan as a live checklist above the composer. */
export function PinnedTodo({ plan }: { plan: Row }) {
  const id = useId();
  const entries = planEntries(plan);
  const progress = planProgress(entries);
  const [expanded, setOpen] = useState(false);
  if (!entries.length) return null;
  return (
    <section className="chat-todo" aria-label="To-do list">
      <button
        type="button"
        className="chat-todo-toggle"
        aria-expanded={expanded}
        aria-controls={expanded ? `${id}-list` : undefined}
        onClick={() => setOpen(!expanded)}
      >
        <Icon name={expanded ? "ChevronDown" : "ChevronRight"} size="sm" />
        <Icon name="Todo" size="sm" />
        <strong>To-do</strong>
        <span className="chat-todo-progress">
          {progress.done}/{progress.total}
          <span className="tool-sr"> done</span>
        </span>
        {!expanded && progress.current ? (
          <span className="truncate chat-todo-current">{progress.current.step}</span>
        ) : null}
      </button>
      {expanded ? (
        <ol id={`${id}-list`} className="chat-todo-list">
          {entries.map((entry, index) => (
            <li
              // biome-ignore lint/suspicious/noArrayIndexKey: Steps may repeat; order is identity.
              key={index}
              className={entry.status}
            >
              <span className={`chat-plan-mark ${entry.status}`} aria-hidden="true" />
              <span>{entry.step}</span>
              <span className="tool-sr">
                {entry.status === "completed"
                  ? " (done)"
                  : entry.status === "in_progress"
                    ? " (in progress)"
                    : ""}
              </span>
            </li>
          ))}
        </ol>
      ) : null}
    </section>
  );
}
