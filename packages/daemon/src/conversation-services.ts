import type { RuntimeContext } from "./api.js";
import { orchestrationService } from "./orchestration/service.js";
import { type QuickChatHostOptions, quickChatService } from "./quick-chat/service.js";
import type { runtimeApi } from "./runtime-api.js";
import type { SetupService } from "./setup-api.js";
import type { taskRunner } from "./task-runner.js";

/** Shared chat services use the same privacy boundary and task execution path. */
export function conversationServices(host: {
  context: RuntimeContext;
  quickOptions: QuickChatHostOptions | undefined;
  definitions?: SetupService["definitions"];
  tasks: ReturnType<typeof taskRunner>;
  runtime: ReturnType<typeof runtimeApi>;
  createThread(value: Record<string, unknown>, commandId: string): Promise<unknown>;
  onError(code: string): void;
}) {
  const { store, privacy, publish } = host.context;
  const quick = quickChatService({
    store,
    publish,
    ...(host.context.secrets ? { vault: host.context.secrets } : {}),
    privacy: {
      prepareData: (value) => privacy.prepareData(value),
      containsSecret: (value) => privacy.containsSecret(value),
      remember(value) {
        privacy.remember(value);
      },
    },
    createThread: host.createThread,
    ...host.quickOptions,
    ...(host.definitions ? { definitions: host.definitions } : {}),
    onError: host.onError,
  });
  const orchestration = orchestrationService({
    store,
    privacy,
    publish,
    router: () => quick.router(),
    forward: async (threadId, input, commandId) =>
      host.runtime("turn.send", { threadId, input, mode: "queue" }, commandId),
    schedule: () => host.tasks.schedule(),
    prepare: (id) => host.tasks.api("task.prepareWorkspace", { id }, `orchestration:prepare:${id}`),
    cancel: (id, commandId) => host.tasks.api("task.cancel", { id, confirmed: true }, commandId),
    onError: host.onError,
  });
  queueMicrotask(() => {
    void orchestration.start();
  });
  return {
    quick,
    orchestration,
    async close() {
      await orchestration.close();
      quick.close();
    },
  };
}
