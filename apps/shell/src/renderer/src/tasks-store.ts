import { createMemo, createSignal, onCleanup } from "solid-js";
import type { TaskReviewDecision, TaskSummary } from "../../shared/tasks";
import { type PendingReview, withPendingReviews } from "./tasks";

/**
 * Every task, kept current from main. It re-reads after each company change, at most once a
 * frame. Reviews apply at once and roll back with an error if the daemon refuses them.
 */
export function createTasksStore() {
  const [loaded, setLoaded] = createSignal<TaskSummary[]>([]);
  const [pending, setPending] = createSignal<Record<string, PendingReview>>({});
  const [error, setError] = createSignal("");
  let frame: number | undefined;
  let generation = 0;

  function refresh() {
    const current = ++generation;
    void window.openbot.agent
      .listTasks()
      .then((tasks) => {
        if (current !== generation) return;
        // Unchanged tasks keep their object, so their rows (and focus in them) stay put.
        const previous = new Map(loaded().map((task) => [task.id, task]));
        setLoaded(
          tasks.map((task) => {
            const old = previous.get(task.id);
            return old && JSON.stringify(old) === JSON.stringify(task) ? old : task;
          }),
        );
        setPending((reviews) => {
          const waiting = Object.entries(reviews).filter(([id, review]) =>
            tasks.some(
              (task) =>
                task.id === id && task.state === "review" && task.revision === review.revision,
            ),
          );
          return waiting.length === Object.keys(reviews).length
            ? reviews
            : Object.fromEntries(waiting);
        });
      })
      .catch(() => undefined);
  }

  function scheduleRefresh() {
    if (frame !== undefined) return;
    frame = requestAnimationFrame(() => {
      frame = undefined;
      refresh();
    });
  }

  const stop = window.openbot.agent.onEvent((event) => {
    if (
      event.type === "company-changed" ||
      (event.type === "status" && event.status.phase === "ready")
    )
      scheduleRefresh();
  });
  onCleanup(() => {
    stop();
    if (frame !== undefined) cancelAnimationFrame(frame);
  });
  refresh();

  const tasks = createMemo(() => withPendingReviews(loaded(), pending()));

  async function review(
    task: TaskSummary,
    decision: TaskReviewDecision,
    feedback?: string,
  ): Promise<boolean> {
    setError("");
    setPending((current) => ({
      ...current,
      [task.id]: { revision: task.revision, state: decision === "accept" ? "completed" : "queued" },
    }));
    try {
      await window.openbot.agent.reviewTask({
        taskId: task.id,
        revision: task.revision,
        decision,
        ...(feedback ? { feedback } : {}),
      });
      // The row stays moved; the next read drops the pending review once the daemon shows it.
      refresh();
      return true;
    } catch {
      setPending(({ [task.id]: _done, ...rest }) => rest);
      setError(
        decision === "accept"
          ? `Couldn't accept ${task.title}. Try again.`
          : `Couldn't send back ${task.title}. Try again.`,
      );
      return false;
    }
  }

  return { tasks, error, clearError: () => setError(""), review, refresh };
}

export type TasksStore = ReturnType<typeof createTasksStore>;
