import { IPC_CHANNELS } from "../shared/ipc";
import {
  parseCancelQueuedMessage,
  parseCreateBot,
  parseInterrupt,
  parseMessageReaction,
  parsePromptResponse,
  parseSendMessage,
  parseSetQueuePaused,
  parseUpdateBot,
  requireString,
} from "./parsers";
import type { ZoltService } from "./zolt-service";

export type Handler = (input: unknown) => unknown;

/**
 * The renderer's agent calls and what main does for each. Electron main registers these as IPC
 * handlers; the headless browser tests call the same table, so both run the same code.
 */
export function agentHandlers(service: ZoltService): Record<string, Handler> {
  return {
    [IPC_CHANNELS.agentGetStatus]: () => service.getStatus(),
    [IPC_CHANNELS.agentGetUsage]: () => service.getUsage(),
    [IPC_CHANNELS.agentListModels]: () => service.listModels(),
    [IPC_CHANNELS.agentListBots]: () => service.listBots(),
    [IPC_CHANNELS.agentCreateBot]: (input) => service.createBot(parseCreateBot(input)),
    [IPC_CHANNELS.agentUpdateBot]: (input) => service.updateBot(parseUpdateBot(input)),
    [IPC_CHANNELS.agentDeleteBot]: (botId) => service.deleteBot(requireString(botId, "botId")),
    [IPC_CHANNELS.agentReadConversation]: (botId) =>
      service.readConversation(requireString(botId, "botId")),
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
  };
}
