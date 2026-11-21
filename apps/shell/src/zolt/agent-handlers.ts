import { IPC_CHANNELS } from "../shared/ipc";
import { agentTemplateHandlers } from "./agent-templates-service";
import { artifactRepositoryHandlers } from "./artifact-repository-service";
import { asideHandlers } from "./aside-service";
import { bridgeHandlers } from "./bridges-service";
import { branchHandlers } from "./branch-service";
import { parseChannelRequest, parsePostChannel } from "./channel-parsers";
import { coAuthorHandlers } from "./co-author-service";
import { dataHandlers } from "./data-service";
import { hiddenHandlers } from "./hidden-service";
import { linkHandlers } from "./links-service";
import { parseTaskAction } from "./manager-cards";
import { memoryHandlers } from "./memory-service";
import { modelHandlers } from "./model-handlers";
import { outboxHandlers } from "./outbox-service";
import {
  parseCancelQueuedMessage,
  parseCreateBot,
  parseDecidePlan,
  parseInterrupt,
  parseMessageReaction,
  parsePromptResponse,
  parseReviewTask,
  parseSendMessage,
  parseSetQueuePaused,
  parseUpdateBot,
  requireString,
} from "./parsers";
import { pinHandlers } from "./pins-service";
import { queueOrderHandlers } from "./queue-order-service";
import { spendHandlers } from "./spend-service";
import { parseStaffAction } from "./staff-view";
import { threadActionHandlers } from "./thread-actions";
import { vaultHandlers } from "./vault-service";
import { voiceHandlers } from "./voice-service";
import type { ZoltService } from "./zolt-service";

export type Handler = (input: unknown) => unknown;

/**
 * The renderer's agent calls and what main does for each. Electron main registers these as IPC
 * handlers; the headless browser tests call the same table, so both run the same code.
 */
export function agentHandlers(service: ZoltService): Record<string, Handler> {
  return {
    [IPC_CHANNELS.agentGetStatus]: () => service.getStatus(),
    [IPC_CHANNELS.agentRefreshAgents]: () => service.refreshAgents(),
    [IPC_CHANNELS.agentGetUsage]: () => service.getUsage(),
    [IPC_CHANNELS.agentListModels]: () => service.listModels(),
    [IPC_CHANNELS.agentListBots]: () => service.listBots(),
    [IPC_CHANNELS.agentCreateBot]: (input) => service.createBot(parseCreateBot(input)),
    [IPC_CHANNELS.agentUpdateBot]: (input) => service.updateBot(parseUpdateBot(input)),
    [IPC_CHANNELS.agentDeleteBot]: (botId) => service.deleteBot(requireString(botId, "botId")),
    [IPC_CHANNELS.agentReadConversation]: (botId) =>
      service.readConversation(requireString(botId, "botId")),
    [IPC_CHANNELS.agentReadContext]: (botId) => service.context.read(requireString(botId, "botId")),
    [IPC_CHANNELS.agentCompact]: (botId) => service.context.compact(requireString(botId, "botId")),
    [IPC_CHANNELS.agentSendMessage]: (input) => service.sendMessage(parseSendMessage(input)),
    [IPC_CHANNELS.agentSetMessageReaction]: (input) =>
      service.setMessageReaction(parseMessageReaction(input)),
    [IPC_CHANNELS.agentDiscardDraftAttachment]: (id) =>
      service.discardDraftAttachment(requireString(id, "attachmentId")),
    [IPC_CHANNELS.agentListQueue]: (botId) => service.listQueue(requireString(botId, "botId")),
    [IPC_CHANNELS.agentCancelQueuedMessage]: (input) => {
      const parsed = parseCancelQueuedMessage(input);
      return service.cancelQueuedMessage(parsed.botId, parsed.deliveryId);
    },
    [IPC_CHANNELS.agentSetQueuePaused]: (input) => {
      const parsed = parseSetQueuePaused(input);
      return service.setQueuePaused(parsed.botId, parsed.paused);
    },
    [IPC_CHANNELS.agentInterrupt]: (input) => {
      const parsed = parseInterrupt(input);
      return service.interrupt(parsed.botId, parsed.turnId);
    },
    [IPC_CHANNELS.agentRespondToPrompt]: (input) =>
      service.respondToPrompt(parsePromptResponse(input)),
    [IPC_CHANNELS.agentReadCompany]: (projectId) =>
      service.readCompany(requireString(projectId, "projectId")),
    [IPC_CHANNELS.agentDecidePlan]: (input) => service.decidePlan(parseDecidePlan(input)),
    [IPC_CHANNELS.agentRefreshBrief]: (projectId) =>
      service.refreshBrief(requireString(projectId, "projectId")),
    [IPC_CHANNELS.agentTaskAction]: (input) => service.taskAction(parseTaskAction(input)),
    [IPC_CHANNELS.agentListTasks]: () => service.listTasks(),
    [IPC_CHANNELS.agentReviewTask]: (input) => service.reviewTask(parseReviewTask(input)),
    ...modelHandlers(service),
    ...branchHandlers(service.client),
    ...threadActionHandlers(service.client),
    ...memoryHandlers(service.client),
    ...spendHandlers(service.client),
    ...dataHandlers(service.client),
    ...artifactRepositoryHandlers(service.client),
    ...queueOrderHandlers(service.client),
    ...asideHandlers(service.client),
    ...pinHandlers(service.client),
    ...outboxHandlers(service.outbox),
    ...linkHandlers(service.client),
    ...vaultHandlers(service.client),
    ...voiceHandlers(service.client),
    ...hiddenHandlers(service.client),
    ...agentTemplateHandlers(service),
    ...coAuthorHandlers(service.client),
    ...bridgeHandlers(service.client),
    [IPC_CHANNELS.agentListChannels]: () => service.channels.list(),
    [IPC_CHANNELS.agentReadChannel]: (id) => service.channels.read(requireString(id, "channelId")),
    [IPC_CHANNELS.agentReadEarlierPosts]: (input) => {
      const row = (input ?? {}) as Record<string, unknown>;
      return service.channels.read(
        requireString(row.channelId, "channelId"),
        requireString(row.before, "before"),
      );
    },
    [IPC_CHANNELS.agentPostChannel]: (input) => service.channels.post(parsePostChannel(input)),
    [IPC_CHANNELS.agentChannelRequest]: (input) =>
      service.channels.request(parseChannelRequest(input)),
    [IPC_CHANNELS.agentReadStaff]: (projectId) =>
      service.readStaff(projectId === null ? null : requireString(projectId, "projectId")),
    [IPC_CHANNELS.agentStaffAction]: (input) => service.staffAction(parseStaffAction(input)),
  };
}
