import { createHash } from "node:crypto";
import {
  companyRecord,
  companyView,
  type DomainState,
  type Outcome,
  queueSystemNotice,
  writeProjectBrief,
} from "@zoltbot/core";
import type { RuntimeContext } from "./api.js";

/** Reconciliation uses persisted state and receipts, so missed events and restarts are harmless. */
export function companySupervisor(
  context: RuntimeContext,
  options: { now?: () => string; intervalMs?: number; onError?: (code: string) => void } = {},
) {
  let running = false;
  let closed = false;
  const now = () => options.now?.() ?? new Date().toISOString();
  const system = { kind: "system" as const, id: "company-supervisor" };
  const dispatch = (id: string, build: (s: DomainState) => Outcome) => {
    const before = context.store.lastSeq();
    context.store.dispatch(id, build);
    context.publish(context.store.eventsSince(before));
  };
  async function tick() {
    if (running || closed) return;
    running = true;
    try {
      const state = context.store.snapshot();
      const chief = String(state.settings?.find((r) => r.key === "chief.thread")?.value ?? "");
      const at = now();
      for (const task of state.task ?? []) {
        // An execution's result is the safe boundary for transferring accountability.
        if (
          task.pendingAccountableThreadId &&
          !["running", "blocked"].includes(String(task.state))
        ) {
          const id = `company:handoff:${task.id}:${task.pendingAccountableThreadId}:${task.updatedAt}`;
          dispatch(id, (s) => {
            const current = s.task?.find((r) => r.id === task.id);
            if (
              !current?.pendingAccountableThreadId ||
              ["running", "blocked"].includes(String(current.state))
            )
              return { events: [], result: {} };
            const { pendingAccountableThreadId, ...rest } = current;
            return companyRecord(
              "task",
              {
                ...rest,
                accountableThreadId: pendingAccountableThreadId,
                assignmentHistory: [
                  ...((current.assignmentHistory as unknown[]) ?? []),
                  { threadId: pendingAccountableThreadId, at },
                ],
                updatedAt: at,
              },
              { commandId: id, at, actor: system },
            );
          });
        }
        const checkpoint = state.initiativeRecord?.find((r) => r.id === task.initiativeId);
        const missed =
          checkpoint?.targetDate &&
          String(checkpoint.targetDate) < at &&
          !["completed", "cancelled"].includes(String(task.state));
        if (!["blocked", "review", "failed", "completed"].includes(String(task.state)) && !missed)
          continue;
        const destination = String(
          task.accountableThreadId ?? checkpoint?.managerThreadId ?? chief,
        );
        if (
          !destination ||
          destination === task.threadId ||
          !state.thread?.some((r) => r.id === destination && !r.archived)
        )
          continue;
        const signal = missed ? `checkpoint:${String(checkpoint?.targetDate)}` : String(task.state);
        const id = `company:signal:${task.id}:${task.revision}:${signal}`;
        if (!context.store.receipt(id))
          dispatch(id, (s) =>
            queueSystemNotice(
              s,
              {
                threadId: destination,
                text: `[Work supervision] Task ${task.id} "${task.title}": ${signal}. Read company_work for evidence and dependencies. Follow up within approved authority; bring scope, budget or permission changes to the human. A submitted result still needs acceptance.`,
              },
              `${id}:input`,
              { commandId: id, at, actor: system },
            ),
          );
      }
      for (const initiative of state.initiativeRecord ?? []) {
        if (initiative.state !== "active" || !initiative.managerThreadId) continue;
        const plans = (state.companyPlan ?? []).filter(
          (p) =>
            p.state === "applied" &&
            (p.authority as { initiativeId?: string })?.initiativeId === initiative.id,
        );
        if (!plans.length) continue;
        const id = `company:signal:initiative:${initiative.id}:${initiative.version}:${plans.map((p) => p.id).join(":")}`;
        if (!context.store.receipt(id))
          dispatch(id, (s) =>
            queueSystemNotice(
              s,
              {
                threadId: String(initiative.managerThreadId),
                text: `[Approved initiative] You own ${initiative.id}: ${initiative.outcome}. Acceptance: ${initiative.acceptance}. Read company_work for your remit and applied authority plans ${plans.map((p) => p.id).join(", ")}. Coordinate within those bounds, report exceptions and results. No publishing or permission expansion is implied.`,
              },
              `${id}:input`,
              { commandId: id, at, actor: system },
            ),
          );
      }
      // Retry wakes only while a durable notice is still queued; acknowledgments never wake again.
      const queued = context.store.snapshot(["item"]).item ?? [];
      for (const threadId of new Set(
        queued
          .filter(
            (r) =>
              String(r.id).startsWith("company:signal:") &&
              (r.body as { queueState?: string })?.queueState === "queued",
          )
          .map((r) => String(r.threadId)),
      )) {
        try {
          await context.wake(threadId);
        } catch {
          options.onError?.("company_wake_failed");
        }
      }
      for (const project of state.project ?? []) {
        if (project.archived) continue;
        const view = companyView(context.store.snapshot(), String(project.id));
        if (!view.tasks.length && !view.initiatives.length) continue;
        const day = at.slice(0, 10);
        const fingerprint = createHash("sha256")
          .update(
            JSON.stringify({
              tasks: view.tasks.map((t) => [
                t.id,
                t.state,
                t.revision,
                t.holdReason,
                t.accountableThreadId,
              ]),
              initiatives: view.initiatives.map((i) => [i.id, i.version]),
              decisions: view.decisions.map((d) => [d.id, d.version]),
            }),
          )
          .digest("hex");
        const id = `company:daily:${project.id}:${day}:${fingerprint}`;
        if (context.store.receipt(id)) continue;
        const accepted = view.tasks.filter((r) => r.state === "completed").length;
        const review = view.tasks.filter((r) => r.state === "review").length;
        const blocked = view.tasks.filter(
          (r) => r.state === "blocked" || r.state === "failed" || r.holdReason,
        ).length;
        const summary = `${project.name}: ${accepted} accepted, ${review} awaiting review, ${blocked} blocked or needing attention. ${view.decisions.length} open decisions. See linked tasks and initiative outcomes for next commitments.`;
        dispatch(id, (s) =>
          writeProjectBrief(s, String(project.id), summary, { commandId: id, at, actor: system }),
        );
      }
    } finally {
      running = false;
    }
  }
  const timer = setInterval(() => {
    void tick().catch(() => options.onError?.("company_reconcile_failed"));
  }, options.intervalMs ?? 30_000);
  timer.unref();
  return {
    tick,
    observe() {
      if (!closed)
        setImmediate(() => {
          void tick().catch(() => options.onError?.("company_reconcile_failed"));
        });
    },
    close() {
      closed = true;
      clearInterval(timer);
    },
  };
}
