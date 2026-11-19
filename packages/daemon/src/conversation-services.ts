import type { InteractionDraft } from "@zoltbot/protocol";
import type { OwnedRuntime, RuntimeContext } from "./api.js";
import { backupModelsApi } from "./backup-models/service.js";
import { backupSupervisor } from "./backup-models/supervisor.js";
import { entityEditsApi } from "./entity-edits.js";
import { orchestrationService } from "./orchestration/service.js";
import { type QuickChatHostOptions, quickChatService } from "./quick-chat/service.js";
import type { runtimeApi } from "./runtime-api.js";
import type { SetupService } from "./setup-api.js";
import type { taskRunner } from "./task-runner.js";
import { threadActionsApi } from "./thread-actions.js";

/** Shared chat services use the same privacy boundary and task execution path. */
export function conversationServices(host: {
  context: RuntimeContext;
  quickOptions: QuickChatHostOptions | undefined;
  definitions?: SetupService["definitions"];
  tasks: ReturnType<typeof taskRunner>;
  runtime: ReturnType<typeof runtimeApi>;
  createThread(value: Record<string, unknown>, commandId: string): Promise<unknown>;
  stopThread(threadId: string, force?: boolean): Promise<void> | undefined;
  clearInteractions(threadId: string, commandId: string): Promise<unknown> | undefined;
  /** Accounts and backup orders: sign-in folders live under the data folder. */
  dataDir: string;
  owned: OwnedRuntime | undefined;
  requestInteraction(draft: InteractionDraft, commandId: string): Promise<unknown>;
  onError(code: string): void;
}) {
  const { store, privacy, publish } = host.context;
  const entityEdits = entityEditsApi({ store, privacy, publish });
  const threadActions = threadActionsApi({
    store,
    privacy,
    publish,
    stopThread: host.stopThread,
    clearInteractions: host.clearInteractions,
  });
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
  const backupModels = backupModelsApi({
    store,
    publish,
    prepareData: (value) => privacy.prepareData(value),
    dataDir: host.dataDir,
    owned: host.owned,
  });
  const backup = backupSupervisor({
    store,
    publish,
    stopThread: host.stopThread,
    setModel: async (id, model, commandId) =>
      host.runtime("session.setModel", { id, model }, commandId),
    request: host.requestInteraction,
    wake: host.context.wake,
    onError: host.onError,
  });
  return {
    quick,
    orchestration,
    async api(method: string, params: Record<string, unknown>, commandId?: string) {
      return (
        (await quick.api(method, params, commandId)) ??
        (await entityEdits(method, params, commandId)) ??
        (await backupModels(method, params, commandId)) ??
        (await threadActions(method, params, commandId))
      );
    },
    async close() {
      await backup.close();
      await orchestration.close();
      quick.close();
    },
  };
}
