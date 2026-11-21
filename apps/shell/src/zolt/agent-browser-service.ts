// B1: the agent browser's daemon calls.
import { randomUUID } from "node:crypto";
import type { AgentBrowserProfile } from "../shared/agent-browser";
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
    [IPC_CHANNELS.agentBrowserClearProfile]: async (input) => {
      await client.call(
        "browser.profile.clear",
        { agentId: agentId(input), confirmed: true },
        randomUUID(),
      );
    },
  };
}
