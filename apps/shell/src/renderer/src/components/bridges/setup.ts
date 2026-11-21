// I1: how each chat app is added: the tokens it needs and anything shown with them. Each app's
// feature (I2–I5) adds its entry; the Add bridge list shows only apps with one.
import type { BridgeKind } from "@zoltbot/protocol";
import type { JSX } from "solid-js";
import type { MessageKey } from "../../i18n";
import { SlackSteps } from "./SlackSteps";
import { TelegramSteps } from "./TelegramSteps";

export interface SetupField {
  /** The credential's name in the keychain entry. */
  key: string;
  label: MessageKey;
  /** An example of the value's shape, never an instruction. */
  placeholder?: string;
  /** Optional fields can stay empty, such as a token only some setups need. */
  optional?: boolean;
}

export interface BridgeSetupSpec {
  kind: BridgeKind;
  fields: SetupField[];
  /** Shown above the fields: a numbered step, a link, a file to copy. */
  before?: () => JSX.Element;
  /** Options saved with the bridge, such as the manifest version. */
  options?: () => Record<string, unknown>;
}

export const BRIDGE_SETUPS: BridgeSetupSpec[] = [
  {
    kind: "slack",
    before: SlackSteps,
    fields: [
      { key: "appToken", label: "bridges.slack.appToken", placeholder: "xapp-…" },
      { key: "botToken", label: "bridges.slack.botToken", placeholder: "xoxb-…" },
    ],
  },
  {
    kind: "telegram",
    before: TelegramSteps,
    fields: [{ key: "token", label: "bridges.telegram.tokenLabel", placeholder: "123456:ABC…" }],
  },
];
