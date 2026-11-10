import type { InjectionFragment } from "@zoltbot/core";
import type { Store } from "@zoltbot/store";
import { chiefFragments } from "./chief/digest.js";
export function companyFragments(
  store: Pick<Store, "snapshot">,
  threadId: string,
): InjectionFragment[] {
  const state = store.snapshot(["managerRemit", "initiativeRecord", "task", "companyPlan"]);
  const remit = state.managerRemit?.find((r) => r.threadId === threadId);
  const initiatives = (state.initiativeRecord ?? []).filter(
    (r) => r.managerThreadId === threadId && !["completed", "cancelled"].includes(String(r.state)),
  );
  if (!remit && !initiatives.length) return [];
  const lines = ["Current responsibility and commitments (read company_work for full records):"];
  if (remit)
    lines.push(
      `Responsibilities: ${remit.responsibilities}`,
      `Capabilities: ${remit.capabilities}`,
      `Boundaries: ${remit.boundaries}`,
      `Escalation: ${remit.escalation}`,
    );
  for (const initiative of initiatives.slice(0, 4)) {
    const authority = state.companyPlan
      ?.filter(
        (r) =>
          r.state === "applied" &&
          (r.authority as { initiativeId?: string })?.initiativeId === initiative.id,
      )
      .map((r) => r.id);
    lines.push(
      `${initiative.id}: ${initiative.outcome}; ${initiative.state}, ${initiative.priority}. Applied authority plans: ${authority?.join(", ") || "none"}.`,
    );
  }
  return [
    {
      id: "company.responsibility",
      kind: "status",
      text: lines.join("\n").slice(0, 1400),
      reference: "company_work",
    },
  ];
}

export function coordinationFragments(
  store: Pick<Store, "snapshot">,
  threadId: string,
): InjectionFragment[] {
  return [...chiefFragments(store, threadId), ...companyFragments(store, threadId)];
}
