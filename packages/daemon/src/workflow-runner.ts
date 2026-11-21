// R7: starts workflow runs and moves them along as their steps' tasks change and their waits
// end. Every move is worked out again from the store (core's advanceWorkflowRun), so a restart
// loses nothing.
import {
  advanceWorkflowRun,
  type CommandContext,
  type DomainState,
  decideWorkflowStep,
  handle,
  type Outcome,
  startWorkflowRun,
  workflowPausedKey,
} from "@zoltbot/core";
import type { DomainEvent, PipelineVersion } from "@zoltbot/protocol";
import type { Store } from "@zoltbot/store";
import type { PublicWriteCheck } from "./private-input.js";

type Run = (
  commandId: string,
  actor: CommandContext["actor"],
  work: (state: DomainState, context: CommandContext) => Outcome,
  check?: PublicWriteCheck,
) => unknown;

const owner = { kind: "human", id: "local-owner" } as const;
const system = { kind: "system", id: "workflow" } as const;

export function workflowRunner(options: {
  store: Store;
  run: Run;
  checkPublic(value: unknown): Promise<PublicWriteCheck>;
  /** Stops the turn of a task the run has just cancelled. */
  stop?(taskId: string): Promise<void>;
  now?(): string;
  onError?(code: string): void;
}) {
  const { store } = options;
  const now = () => options.now?.() ?? new Date().toISOString();
  /** Run a command, then stop the turns of any step tasks it cancelled. */
  function act(
    commandId: string,
    actor: CommandContext["actor"],
    work: (state: DomainState, context: CommandContext) => Outcome,
    check?: PublicWriteCheck,
  ) {
    const before = store.lastSeq();
    const result = options.run(commandId, actor, work, check);
    for (const event of store.eventsSince(before)) {
      const payload = event.payload as { state?: unknown; workflowRunId?: unknown };
      if (event.aggregateType === "task" && payload.state === "cancelled" && payload.workflowRunId)
        void options
          .stop?.(event.aggregateId)
          .catch(() => options.onError?.("workflow_stop_uncertain"));
    }
    return result;
  }
  function advance(runId: string) {
    try {
      // Only write when something moves, so a quiet tick leaves no receipt behind.
      const at = now();
      const preview = advanceWorkflowRun(store.snapshot(), runId, {
        commandId: "preview",
        at,
        actor: system,
      });
      if (!preview.events.length) return;
      act(`workflow:advance:${runId}:${store.lastSeq()}:${at}`, system, (state, context) =>
        advanceWorkflowRun(state, runId, context),
      );
    } catch {
      options.onError?.("workflow_advance_failed");
    }
  }
  const active = () =>
    (store.snapshot(["workflowRun"]).workflowRun ?? [])
      .filter((row) => ["running", "at_gate"].includes(String(row.state)))
      .map((row) => String(row.id));
  function setPaused(workflowId: string, paused: boolean, commandId: string) {
    act(commandId, owner, (state, context) => {
      const key = workflowPausedKey(workflowId);
      const exists = state.settings?.some((row) => row.key === key);
      return handle(
        state,
        exists
          ? { type: "update", kind: "settings", id: key, changes: { value: paused } }
          : { type: "create", kind: "settings", value: { key, value: paused } },
        context,
      );
    });
    if (!paused) for (const runId of active()) advance(runId);
    return { ok: true };
  }
  return {
    /** A run by hand: the owner asked for it. */
    async start(workflow: PipelineVersion, inputs: unknown, commandId: string) {
      const check = store.receipt(commandId) ? undefined : await options.checkPublic(inputs);
      return act(
        commandId,
        owner,
        (state, context) =>
          startWorkflowRun(
            state,
            {
              runId: `run:${commandId}`,
              workflowId: workflow.workflowId,
              version: workflow.version,
              trigger: "manual",
              inputs,
            },
            context,
          ),
        check,
      );
    },
    /** workflow.pause, workflow.resume and workflow.decide, all from the owner. */
    control(method: string, params: Record<string, unknown>, commandId: string) {
      const id = String(params.id ?? "");
      if (method === "workflow.pause") return setPaused(id, true, commandId);
      if (method === "workflow.resume") return setPaused(id, false, commandId);
      const decision = params.decision;
      if (decision !== "stop" && decision !== "continue") throw new Error("invalid_decision");
      return act(commandId, owner, (state, context) =>
        decideWorkflowStep(
          state,
          { runId: id, stepId: String(params.stepId ?? ""), decision },
          context,
        ),
      );
    },
    /** Move each run whose step tasks just changed. */
    observe(events: readonly DomainEvent[]) {
      const runs = new Set<string>();
      for (const event of events) {
        if (event.aggregateType !== "task") continue;
        const runId = (event.payload as { workflowRunId?: unknown }).workflowRunId;
        if (typeof runId === "string") runs.add(runId);
      }
      // Orchestration tasks carry a workflowRunId too; only R7 runs are moved here.
      for (const runId of runs) if (store.record("workflowRun", runId)) advance(runId);
    },
    /** After a restart: catch every unfinished run up with its tasks. */
    resume() {
      for (const runId of active()) advance(runId);
    },
    /** On each scheduler tick: only runs that wait on the clock can move without an event. */
    tick() {
      const state = store.snapshot(["workflowRun", "workflow"]);
      for (const row of state.workflowRun ?? []) {
        if (!["running", "at_gate"].includes(String(row.state))) continue;
        const saved = state.workflow?.find(
          (entry) => entry.workflowId === row.workflowId && entry.version === row.version,
        );
        const graph = (saved?.graph ?? { nodes: [] }) as { nodes: { id: string; kind: string }[] };
        const steps = (row.steps ?? []) as { id: string; state: string }[];
        const timed =
          (saved?.budget as { wallClockMinutes?: number } | undefined)?.wallClockMinutes !==
            undefined ||
          steps.some(
            (step) =>
              step.state === "running" &&
              graph.nodes.some((node) => node.id === step.id && node.kind === "wait"),
          );
        if (timed) advance(String(row.id));
      }
    },
  };
}
