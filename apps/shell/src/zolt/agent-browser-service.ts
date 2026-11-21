// B1: the agent browser's daemon calls.
import { randomUUID } from "node:crypto";
import type { AgentBrowserProfile, AgentBrowserViewState } from "../shared/agent-browser";
import { IPC_CHANNELS } from "../shared/ipc";
import type { DaemonClient } from "./daemon-client";
import { isObject, requireString } from "./parsers";

const agentId = (input: unknown) =>
  requireString(isObject(input) ? input.agentId : undefined, "agentId");

export function agentBrowserHandlers(
  client: DaemonClient,
): Record<string, (input: unknown) => unknown> {
  return {
    [IPC_CHANNELS.agentBrowserProfile]: async (input) =>
      ((await client.call("browser.profile.get", { agentId: agentId(input) })) ??
        null) as AgentBrowserProfile | null,
    [IPC_CHANNELS.agentBrowserView]: async (input) => {
      if (!isObject(input) || typeof input.open !== "boolean") throw new Error("Invalid view.");
      const view = (await client.call("browser.view", {
        threadId: requireString(input.threadId, "threadId"),
        open: input.open,
      })) as AgentBrowserViewState | null;
      return view ?? { running: false, url: null };
    },
    [IPC_CHANNELS.agentBrowserClearProfile]: async (input) => {
      await client.call(
        "browser.profile.clear",
        { agentId: agentId(input), confirmed: true },
        randomUUID(),
      );
    },
  };
}
