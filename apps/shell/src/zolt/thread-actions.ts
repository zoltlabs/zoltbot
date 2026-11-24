// S9: pin, read state and archive for a chat, as daemon commands.
import { randomUUID } from "node:crypto";
import { mutedKey } from "@zoltbot/protocol";
import { IPC_CHANNELS } from "../shared/ipc";
import {
  THREAD_ACTIONS,
  type ThreadAction,
  type ThreadActionInput,
} from "../shared/thread-actions";
import type { DaemonClient } from "./daemon-client";
import { requireString } from "./parsers";

export function parseThreadAction(input: unknown): ThreadActionInput {
  const row = (input ?? {}) as Record<string, unknown>;
  const action = row.action;
  if (!THREAD_ACTIONS.includes(action as ThreadAction)) throw new Error("Unknown chat action.");
  return { botId: requireString(row.botId, "botId"), action: action as ThreadAction };
}

/** The daemon command and parameters for an action. */
export function threadCommand({ botId: id, action }: ThreadActionInput): [string, object] {
  switch (action) {
    case "pin":
    case "unpin":
      return ["thread.pin", { id, pinned: action === "pin" }];
    case "markUnread":
      return ["thread.markUnread", { id }];
    case "markRead":
      return ["thread.markRead", { id }];
    case "archive":
      return ["thread.archive", { id, confirmed: true }];
    case "unarchive":
      return ["thread.unarchive", { id }];
    case "mute":
    case "unmute":
      return ["settings.set", { key: mutedKey(id), value: action === "mute" }];
    case "clear":
      return ["chief.clear", {}];
  }
}

export function threadActionHandlers(
  client: DaemonClient,
): Record<string, (input: unknown) => unknown> {
  return {
    [IPC_CHANNELS.agentThreadAction]: async (input) => {
      const [method, params] = threadCommand(parseThreadAction(input));
      const result = (await client.call(method, params, randomUUID())) as
        | { threadId?: unknown }
        | undefined;
      return typeof result?.threadId === "string" ? { threadId: result.threadId } : undefined;
    },
  };
}
