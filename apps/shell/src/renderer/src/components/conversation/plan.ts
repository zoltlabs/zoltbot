import type { PlanStep } from "../../../../shared/ipc";

/** How far a plan has got: steps done, steps in all, and the step being worked on. */
export function planProgress(steps: readonly PlanStep[]) {
  return {
    done: steps.filter((step) => step.status === "completed").length,
    total: steps.length,
    current: steps.find((step) => step.status === "in_progress"),
  };
}

/**
 * Whether the checklist shows its steps. It opens while work is left and folds to one line once
 * every step is done. Opening or closing it by hand wins until the chat changes.
 */
export function planExpanded(steps: readonly PlanStep[], choice: boolean | undefined): boolean {
  if (choice !== undefined) return choice;
  const { done, total } = planProgress(steps);
  return done < total;
}
