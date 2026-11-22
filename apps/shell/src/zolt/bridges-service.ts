// I1: the Mac's bridge settings, passed through to the daemon's bridge.* methods.
import { randomUUID } from "node:crypto";
import type { BridgeView } from "@zoltbot/protocol";
import { type BridgeTargets, BRIDGE_CHANNELS as C } from "../shared/bridges";
import type { DaemonClient } from "./daemon-client";
import { isObject, requireString } from "./parsers";

type Client = Pick<DaemonClient, "rows" | "call">;

/** Chats the owner talks in (not tasks, asides or archived ones) and live channels. */
export function bridgeTargets(client: Client): BridgeTargets {
  const chats = client
    .rows("thread")
    .filter((row) => row.archived !== true && (row.kind === "main" || row.kind === "side"))
    .map((row) => ({ id: String(row.id), label: String(row.title ?? "") || "Chat" }))
    .sort((a, b) => a.label.localeCompare(b.label));
  const channels = client
    .rows("channel")
    .filter((row) => !row.archivedAt)
    .map((row) => ({ id: String(row.id), label: `#${String(row.name ?? "")}` }))
    .sort((a, b) => a.label.localeCompare(b.label));
  return { chats, channels };
}

export function bridgeHandlers(client: Client): Record<string, (input: unknown) => unknown> {
  return {
    [C.bridgesList]: async () =>
      ((await client.call("bridge.list", {})) as { items: BridgeView[] }).items,
    [C.bridgesSave]: async (input) => {
      if (!isObject(input) || !isObject(input.bridge)) throw new Error("Invalid bridge.");
      return client.call(
        "bridge.save",
        {
          bridge: input.bridge,
          ...(isObject(input.credentials) ? { credentials: input.credentials } : {}),
        },
        randomUUID(),
      );
    },
    [C.bridgesRemove]: async (id) => {
      await client.call(
        "bridge.remove",
        { id: requireString(id, "id"), confirmed: true },
        randomUUID(),
      );
    },
    [C.bridgesTargets]: () => bridgeTargets(client),
  };
}
