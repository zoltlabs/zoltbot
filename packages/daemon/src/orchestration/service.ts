import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  type DomainEvent,
  type Orchestration,
  OrchestrationSchema,
  parse,
  parseEvent,
  type UserInput,
} from "@zoltbot/protocol";
import type { Store } from "@zoltbot/store";
import type { PrivateInputGuard } from "../private-input.js";
import type { InferenceAdapter } from "../quick-chat/providers.js";
import { routingContext } from "./catalog.js";
import { followUpInstructions, resolveFollowUp } from "./follow-up.js";
import { routeRequest, routerInference } from "./routing.js";
import { orchestrationRunner } from "./runner.js";

type RouterConnection = {
  adapter: InferenceAdapter;
  model: string;
  entries: { definitionId: string; models: { id: string; label: string; efforts?: string[] }[] }[];
};
export function orchestrationService(host: {
  store: Store;
  privacy: PrivateInputGuard;
  publish(events: DomainEvent[]): void;
  router(): Promise<RouterConnection | undefined>;
  schedule(): Promise<unknown>;
  prepare(taskId: string): Promise<unknown>;
  cancel(taskId: string, commandId: string): Promise<unknown>;
  onError?(code: string): void;
  forward?(threadId: string, input: UserInput, commandId: string): Promise<unknown>;
}) {
  type FollowDecision = {
    signature: string;
    run: Orchestration;
    follow: Awaited<ReturnType<typeof resolveFollowUp>>;
    targetThreadId?: string;
  };
  const runner = orchestrationRunner(host);
  const pending = new Map<string, Promise<unknown>>();
  const controllers = new Set<AbortController>();
  async function send(params: Record<string, unknown>, commandId: string) {
    const signature = JSON.stringify(params);
    const receipt = host.store.receipt<{ signature?: string; value?: unknown }>(commandId);
    if (receipt) {
      if (!receipt.result.signature) return undefined; // ordinary turn.send receipt
      if (receipt.result.signature !== signature) throw Error("command_receipt_conflict");
      return receipt.result.value;
    }
    const savedFollow = host.store.receipt<FollowDecision>(`${commandId}:route`);
    if (savedFollow) {
      if (savedFollow.result.signature !== signature) throw Error("command_receipt_conflict");
      return applyFollowUp(savedFollow.result, params.input as UserInput, commandId);
    }
    const threadId = String(params.threadId);
    const state = host.store.snapshot();
    const thread = state.thread?.find((row) => row.id === threadId && !row.archived);
    if (!thread?.projectId || thread.kind === "task") return undefined;
    const active =
      state.orchestration?.filter(
        (row) => row.threadId === threadId && ["running", "blocked"].includes(String(row.state)),
      ) ?? [];
    if (
      params.mode !== "queue" ||
      params.artifactTarget ||
      (params.outputMode && params.outputMode !== "auto")
    ) {
      if (active.length)
        throw Error("active_phase_required: send this request in the active phase chat.");
      return undefined;
    }
    const input = params.input as UserInput;
    if (!input.length || input.some((part) => part.type !== "text")) {
      if (active.length)
        throw Error("active_phase_required: add attachments in the active phase chat.");
      return undefined;
    }
    const request = input.map((part) => (part.type === "text" ? part.text : "")).join("\n");
    if (request.startsWith("/") || request.length > 4000) {
      if (active.length)
        throw Error("active_phase_required: send this request in the active phase chat.");
      return undefined;
    }
    if (active.length > 1) throw Error("orchestration_ambiguous: select the task to continue.");
    if (state.turn?.some((row) => row.threadId === threadId && row.status === "running"))
      return undefined;
    const check = await host.privacy.prepareData(request);
    const connection = await host.router();
    if (!connection) {
      if (active.length) throw Error("router_unavailable: open the active phase or stop the run.");
      if (/\buse\b.+\bfor\b.+\b(plan(?:ning)?|implement(?:ation)?|review|tests?)\b/i.test(request))
        throw Error(
          "router_connection_required: connect a coding tool or local router to assign models by phase.",
        );
      return undefined;
    }
    const context = routingContext(host.store.snapshot(), threadId, connection.entries);
    const contextCheck = await host.privacy.prepareData(context);
    contextCheck(host.store.snapshot());
    const controller = new AbortController();
    controllers.add(controller);
    if (active[0]) {
      try {
        const run = parse(OrchestrationSchema, active[0]);
        const follow = await resolveFollowUp(
          request,
          run,
          context,
          routerInference(connection.adapter, connection.model, followUpInstructions),
          controller.signal,
        );
        const phase = run.phases.find((phase) => phase.status === "running");
        const target = phase?.taskId
          ? host.store.record("task", phase.taskId)?.threadId
          : undefined;
        const decision: FollowDecision = {
          signature,
          run,
          follow,
          ...(typeof target === "string" ? { targetThreadId: target } : {}),
        };
        const publicCheck = await host.privacy.prepareData(decision);
        const saved = host.store.dispatch(`${commandId}:route`, (state) => {
          publicCheck(state);
          return { events: [], result: decision };
        });
        return await applyFollowUp(saved.result, input, commandId);
      } finally {
        controllers.delete(controller);
      }
    }
    let resolved: Awaited<ReturnType<typeof routeRequest>>;
    try {
      resolved = await routeRequest(
        request,
        context,
        routerInference(connection.adapter, connection.model),
        controller.signal,
      );
    } catch (error) {
      if (
        /^(hi|hello|what|why|how|when|where|who|explain|describe|tell me)\b/i.test(request) &&
        !/\b(use|implement|fix|edit|write|run|create)\b/i.test(request)
      )
        return undefined;
      throw error;
    } finally {
      controllers.delete(controller);
    }
    if (resolved.intent === "chat") return undefined;
    const id = `orchestration-${createHash("sha256").update(commandId).digest("hex").slice(0, 24)}`;
    const at = new Date().toISOString();
    const run: Orchestration = {
      id,
      routing: { model: connection.model, ...(resolved.usage ? { usage: resolved.usage } : {}) },
      threadId,
      projectId: String(thread.projectId),
      brief: request,
      revision: 1,
      state: "running",
      createdAt: at,
      updatedAt: at,
      phases: resolved.phases.map((phase) => {
        const selected = phase.profileId
          ? context.profiles.find((profile) => profile.id === phase.profileId)
          : context.profiles.find((profile) => profile.id === thread.agentId);
        if (!selected) throw Error("execution_profile_unavailable");
        return {
          role: phase.role,
          instruction: phase.instruction,
          profileId: selected.id,
          execution: {
            definitionId: phase.definitionId,
            model: phase.model,
            ...(phase.effort ? { effort: phase.effort } : {}),
            permissionCeiling: ["plan", "review", "security"].some((role) =>
              phase.role.toLowerCase().includes(role),
            )
              ? ("read_only" as const)
              : ("workspace_write" as const),
          },
          status: "pending" as const,
          attempt: 1,
        };
      }),
    };
    const publicCheck = await host.privacy.prepareData(run);
    const before = host.store.lastSeq();
    const value = { id, disposition: "handled" };
    host.store.dispatch(commandId, (current) => {
      check(current);
      contextCheck(current);
      publicCheck(current);
      const latest = current.thread?.find((row) => row.id === threadId && !row.archived);
      if (!isDeepStrictEqual(latest, thread)) throw Error("routing_context_changed");
      if (
        current.orchestration?.some(
          (row) => row.threadId === threadId && ["running", "blocked"].includes(String(row.state)),
        )
      )
        throw Error("orchestration_active");
      if (current.turn?.some((row) => row.threadId === threadId && row.status === "running"))
        throw Error("origin_chat_busy");
      const seq =
        Math.max(
          0,
          ...(current.item ?? [])
            .filter((row) => row.threadId === threadId)
            .map((row) => Number(row.seq)),
        ) + 1;
      const events = [
        parseEvent({
          eventId: `${commandId}:input`,
          commandId,
          aggregateType: "item",
          aggregateId: `${id}:input`,
          type: "item.created",
          occurredAt: at,
          payload: {
            id: `${id}:input`,
            threadId,
            seq,
            kind: "user",
            body: { input, queueState: "handled", mode: "queue" },
            createdAt: at,
            updatedAt: at,
          },
        }),
        parseEvent({
          eventId: `${commandId}:run`,
          commandId,
          aggregateType: "orchestration",
          aggregateId: id,
          type: "orchestration.created",
          occurredAt: at,
          payload: parse(OrchestrationSchema, run),
        }),
      ];
      return { events, result: { signature, value } };
    });
    host.publish(host.store.eventsSince(before));
    void runner.reconcile();
    return value;
  }
  async function applyFollowUp(decision: FollowDecision, input: UserInput, commandId: string) {
    const { run, follow, signature } = decision;
    const threadId = run.threadId;
    const request = input.map((part) => (part.type === "text" ? part.text : "")).join("\n");
    if (follow.action === "cancel") {
      await runner.action("orchestration.cancel", run.id, run.revision, `${commandId}:cancel`);
    } else if (follow.action === "update" && "resolved" in follow) {
      const phases = structuredClone(run.phases);
      const phase = phases[follow.index];
      if (!phase) throw Error("phase_unavailable");
      phase.execution = {
        ...phase.execution,
        definitionId: follow.resolved.definitionId,
        model: follow.resolved.model,
      };
      delete phase.execution.effort;
      if (follow.resolved.effort) phase.execution.effort = follow.resolved.effort;
      if (follow.resolved.profileId) phase.profileId = follow.resolved.profileId;
      await runner.edit(run, phases, `${commandId}:edit`);
    } else if (follow.action === "feedback") {
      if (!decision.targetThreadId || !host.forward)
        throw Error(
          "phase_not_running: retry the blocked phase or send findings back to implementation.",
        );
      await host.forward(decision.targetThreadId, input, `${commandId}:forward`);
    }
    return await recordFollowUp(
      run.id,
      threadId,
      input,
      request,
      signature,
      commandId,
      follow.action === "status"
        ? `${run.state}: ${run.phases.map((phase) => `${phase.role} — ${phase.status} (${phase.execution.model})`).join("; ")}`
        : undefined,
    );
  }
  async function recordFollowUp(
    runId: string,
    threadId: string,
    input: UserInput,
    request: string,
    signature: string,
    commandId: string,
    note?: string,
  ) {
    const check = await host.privacy.prepareData([request, note]);
    const before = host.store.lastSeq();
    const value = { id: `${runId}:follow:${commandId}`, disposition: "handled" };
    host.store.dispatch(commandId, (state) => {
      check(state);
      const at = new Date().toISOString();
      const seq =
        Math.max(
          0,
          ...(state.item ?? [])
            .filter((row) => row.threadId === threadId)
            .map((row) => Number(row.seq)),
        ) + 1;
      return {
        result: { signature, value },
        events: [
          parseEvent({
            eventId: `${commandId}:input`,
            commandId,
            aggregateType: "item",
            aggregateId: value.id,
            type: "item.created",
            occurredAt: at,
            payload: {
              id: value.id,
              threadId,
              seq,
              kind: "user",
              body: { input, queueState: "handled", mode: "queue" },
              createdAt: at,
              updatedAt: at,
            },
          }),
          ...(note
            ? [
                parseEvent({
                  eventId: `${commandId}:status`,
                  commandId,
                  aggregateType: "item",
                  aggregateId: `${value.id}:status`,
                  type: "item.created",
                  occurredAt: at,
                  payload: {
                    id: `${value.id}:status`,
                    threadId,
                    seq: seq + 1,
                    kind: "message",
                    phase: "final",
                    body: { text: note },
                    createdAt: at,
                    updatedAt: at,
                  },
                }),
              ]
            : []),
        ],
      };
    });
    host.publish(host.store.eventsSince(before));
    return value;
  }
  return {
    observe: runner.observe,
    async close() {
      for (const controller of controllers) controller.abort();
      await Promise.allSettled(pending.values());
      await runner.close();
    },
    start: runner.reconcile,
    async api(method: string, params: Record<string, unknown>, commandId?: string) {
      if (method.startsWith("orchestration.")) {
        if (!commandId) throw Error("command_id_required");
        return runner.action(method, String(params.id), Number(params.revision), commandId);
      }
      if (method !== "turn.send") return undefined;
      if (!commandId) throw Error("command_id_required");
      const existing = pending.get(commandId);
      if (existing) return existing;
      const work = send(params, commandId).finally(() => pending.delete(commandId));
      pending.set(commandId, work);
      return work;
    },
  };
}
