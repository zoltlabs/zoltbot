import { type ChatConnection, text } from "../chat/types.js";
import { StatusDot, statusLabels } from "../components/primitives.js";
import { useShell } from "../state.js";
import { chatStatuses } from "../workspaces/activity.js";
import { compareAnswers } from "./compare-state.js";
export function CompareSidebar({ connection }: { connection: ChatConnection }) {
  const e = connection.snapshot.entities;
  const statuses = chatStatuses(e);
  const groups = (e.compare ?? [])
    .slice()
    .sort((a, b) => text(b.createdAt).localeCompare(text(a.createdAt)));
  if (!groups.length) return null;
  return (
    <ul className="compare-sidebar" aria-label="Compare history">
      {groups.map((group) => {
        const id = text(group.id),
          answers = compareAnswers(e, id),
          resolution = group.resolution as { threadId?: string } | undefined,
          winner = answers.find((a) => a.threadId === resolution?.threadId);
        return (
          <li key={id}>
            <button
              className="item"
              type="button"
              onClick={() =>
                winner
                  ? useShell.getState().openThread(winner.threadId)
                  : useShell.getState().openCompare(id)
              }
            >
              <span className="truncate">
                {winner ? `${text(group.title)} · ${winner.name}` : text(group.title)}
              </span>
              <span className="compare-sidebar-chip">
                {group.state === "open" ? "Compare" : winner ? "Chosen" : "Closed"}
              </span>
              {group.state === "open" ? (
                <span className="compare-member-dots">
                  {answers.map((a) => (
                    <span
                      key={a.threadId}
                      role="img"
                      aria-label={`${a.name}: ${statusLabels[statuses.get(a.threadId) ?? "idle"]}`}
                    >
                      <StatusDot status={statuses.get(a.threadId) ?? "idle"} label={false} />
                    </span>
                  ))}
                </span>
              ) : null}
            </button>
            {group.state !== "open" ? (
              <details>
                <summary>Other answers</summary>
                <ul>
                  {answers
                    .filter((a) => a.threadId !== winner?.threadId)
                    .map((a) => (
                      <li key={a.threadId}>
                        <button
                          className="item"
                          type="button"
                          onClick={() => useShell.getState().openThread(a.threadId)}
                        >
                          {a.name}’s answer
                        </button>
                      </li>
                    ))}
                </ul>
                <button
                  className="btn sm"
                  type="button"
                  onClick={() => useShell.getState().openCompare(id)}
                >
                  View side by side
                </button>
              </details>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
