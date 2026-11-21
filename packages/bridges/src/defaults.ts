// The real adapters, by app. Each takes the tokens its setup saved in the Keychain entry.
import type { BridgeKind } from "@zoltbot/protocol";
import type { BridgeAdapter } from "./adapter.js";
import { BridgeError } from "./adapter.js";
import { createDiscordAdapter } from "./discord.js";
import { createSlackAdapter } from "./slack.js";
import { createTelegramAdapter } from "./telegram.js";

export type AdapterFactory = (input: { credentials: Record<string, string> }) => BridgeAdapter;

const need = (credentials: Record<string, string>, key: string) => {
  const value = credentials[key];
  if (!value) throw new BridgeError("not_set_up");
  return value;
};

export const defaultBridgeAdapters: Partial<Record<BridgeKind, AdapterFactory>> = {
  slack: ({ credentials }) =>
    createSlackAdapter({
      appToken: need(credentials, "appToken"),
      botToken: need(credentials, "botToken"),
    }),
  telegram: ({ credentials }) => createTelegramAdapter({ token: need(credentials, "token") }),
  discord: ({ credentials }) => createDiscordAdapter({ token: need(credentials, "token") }),
};
