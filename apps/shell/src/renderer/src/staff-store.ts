import { createEffect, createSignal, on, onCleanup } from "solid-js";
import type { StaffOverview } from "../../shared/staff";

/**
 * Pending staff approvals and a project's people, kept current from main. It re-reads after each
 * company change, at most once a frame. A null project reads approvals from every project.
 */
export function createStaffStore(projectId: () => string | null) {
  const [overview, setOverview] = createSignal<StaffOverview>({ approvals: [], people: [] });
  let frame: number | undefined;
  let generation = 0;

  function refresh() {
    const current = ++generation;
    void window.openbot.agent
      .readStaff(projectId())
      .then((next) => {
        if (current === generation) setOverview(next);
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
  createEffect(on(projectId, refresh));

  return {
    approvals: () => overview().approvals,
    people: () => overview().people,
    refresh,
  };
}
