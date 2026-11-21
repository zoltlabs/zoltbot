// R7: starts workflow runs and moves them along as their steps' tasks change. Every move is
// worked out again from the store (core's advanceWorkflowRun), so a restart loses nothing.
import {
  advanceWorkflowRun,
  type CommandContext,
  type DomainState,
  type Outcome,
  startWorkflowRun,
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
  onError?(code: string): void;
}) {
  const { store } = options;
  function advance(runId: string) {
    try {
      options.run(`workflow:advance:${runId}:${store.lastSeq()}`, system, (state, context) =>
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
  return {
    /** A run by hand: the owner asked for it. */
    async start(workflow: PipelineVersion, inputs: unknown, commandId: string) {
      const check = store.receipt(commandId) ? undefined : await options.checkPublic(inputs);
      return options.run(
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
    /** After a restart, catch every unfinished run up with its tasks. */
    resume() {
      for (const runId of active()) advance(runId);
    },
  };
}
