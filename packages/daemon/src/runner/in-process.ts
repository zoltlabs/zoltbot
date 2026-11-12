import { randomUUID } from "node:crypto";
import type { DomainEvent } from "@zoltbot/protocol";
import type { Store } from "@zoltbot/store";
import { changes } from "../../../gitkit/src/index.js";
import type { InteractionEngine } from "../interaction-engine.js";
import { runtimeApi } from "../runtime-api.js";
import type { SessionManagerOptions } from "../runtime-host.js";
import type { RuntimeObservation } from "../runtime-observer.js";
import type { RuntimeStream } from "../runtime-worker.js";
import { SessionManager } from "../session-manager.js";
import { RunnerEvents } from "./events.js";
import type { Runner, RunnerAnswer, RunnerSession, RunnerTurn } from "./interface.js";

export class InProcessRunner implements Runner {
  private readonly api: ReturnType<typeof runtimeApi>;
  constructor(
    private readonly options: {
      manager: SessionManager;
      store: Store;
      publish(events: DomainEvent[]): void;
      observations: RunnerEvents;
      interactions?: () => Promise<InteractionEngine>;
      onError?(code: string): void;
    },
  ) {
    this.api = runtimeApi(options);
  }
  prepareWorkspace(input: RunnerSession) {
    return this.options.manager.preflight(input.threadId);
  }
  async startSession(input: RunnerSession) {
    await (await this.options.manager.ensure(input.threadId)).wake();
  }
  async sendTurn(input: RunnerTurn) {
    return this.api(
      "turn.send",
      { threadId: input.threadId, input: input.input, mode: input.mode },
      input.commandId,
    );
  }
  async answerInteraction(input: RunnerAnswer) {
    const engine = await this.options.interactions?.();
    if (!engine) throw new Error("runtime_interaction_host_required");
    return engine.answer(
      input.id,
      input.version,
      input.answer,
      input.commandId,
      input.actor ?? { kind: "human", id: "local-owner" },
    );
  }
  interrupt(input: RunnerSession & { turnId: string; commandId: string }) {
    return this.options.manager.interrupt(input.threadId, input.turnId, input.commandId);
  }
  stop(input: RunnerSession) {
    return this.options.manager.stopUnattended(input.threadId);
  }
  collectResult(input: { cwd: string; baseRef: string }) {
    return changes(input.cwd, input.baseRef);
  }
  events() {
    return this.options.observations.events();
  }
  async close() {
    try {
      await this.options.manager.close();
    } finally {
      this.options.observations.close();
    }
  }
}
export function createInProcessRuntime(
  options: Omit<SessionManagerOptions, "observe"> & {
    persistObservation?(observation: RuntimeObservation): Promise<void>;
  },
) {
  const observations = new RunnerEvents();
  const { persistObservation, ...runtimeOptions } = options;
  const manager = new SessionManager({
    ...runtimeOptions,
    observe: (threadId, sessionId) => {
      const scope = observations.scope(threadId, sessionId);
      if (!persistObservation) return scope;
      return {
        active: () => true,
        emit: async (event, context) => {
          await persistObservation(structuredClone({ threadId, sessionId, event, ...context }));
          await scope.emit(event, context);
        },
      };
    },
  });
  const runner = new InProcessRunner({
    manager,
    store: options.store,
    publish: options.publish,
    observations,
    ...(options.interactions ? { interactions: options.interactions } : {}),
    ...(options.onError ? { onError: options.onError } : {}),
  });
  return { manager, runner };
}
/** Keep the existing local stream publication byte-for-byte in the runner wiring. */
export function publishRuntimeStream(publish: (events: DomainEvent[]) => void) {
  return (update: RuntimeStream) => {
    if (update.item)
      publish([
        {
          eventId: randomUUID(),
          aggregateType: "item",
          aggregateId: update.itemId,
          type: "item.stream",
          occurredAt: new Date().toISOString(),
          payload: update.item,
        },
      ]);
  };
}
