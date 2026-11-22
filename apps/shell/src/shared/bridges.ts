// I1: chat app bridges, over IPC. The renderer never sees a token: it sends pasted tokens once
// with `save` and gets back only the bridge, its status and who was refused.
import type { BridgeInput, BridgeView } from "@zoltbot/protocol";

export const BRIDGE_CHANNELS = {
  bridgesList: "bridges:list",
  bridgesSave: "bridges:save",
  bridgesRemove: "bridges:remove",
  bridgesTargets: "bridges:targets",
} as const;

export interface BridgeTargets {
  chats: { id: string; label: string }[];
  channels: { id: string; label: string }[];
}

export interface BridgesDesktopApi {
  list: () => Promise<BridgeView[]>;
  save: (input: {
    bridge: BridgeInput;
    credentials?: Record<string, string>;
  }) => Promise<BridgeView>;
  remove: (id: string) => Promise<void>;
  /** Chats and channels a route can lead to. */
  targets: () => Promise<BridgeTargets>;
}
