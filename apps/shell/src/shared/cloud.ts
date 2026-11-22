import type { InteractionAnswer } from "@zoltbot/protocol";

export type {
  CloudSecretName,
  CloudSettingsStatus,
  MacExecutionMode,
} from "../../../../packages/ui/src/cloud-settings/types.js";

import type {
  CloudSecretName,
  CloudSettingsStatus,
  MacExecutionMode,
} from "../../../../packages/ui/src/cloud-settings/types.js";
import type {
  ConnectionOwner,
  OwnedConnectionState,
} from "../../../desktop/src/cloud-connections/manager.js";

export type CloudOwner = Extract<ConnectionOwner, { kind: "cloud" }>;
export type CloudWorkspace = Omit<OwnedConnectionState, "owner"> & {
  owner: CloudOwner;
  approvalDeviceId?: string;
};

export type CloudSetting =
  | { type: "enabled"; sessionId: string; value: boolean }
  | { type: "runner"; sessionId: string; value: boolean }
  | { type: "execution"; sessionId: string; value: MacExecutionMode }
  | { type: "folder"; sessionId: string; projectId: string };

export interface CloudAnswer {
  owner: CloudOwner;
  id: string;
  version: number;
  action: "accept" | "decline";
  choice?: "allow_once" | "allow_task_prefix" | "reject_once";
  answers?: InteractionAnswer["answers"];
}

export interface CloudDesktopApi {
  settings(): Promise<CloudSettingsStatus>;
  update(setting: CloudSetting): Promise<CloudSettingsStatus>;
  saveSecret(input: { sessionId: string; name: CloudSecretName; value: string }): Promise<void>;
  answer(input: CloudAnswer): Promise<unknown>;
  workspace(): Promise<CloudWorkspace | undefined>;
  onWorkspace(listener: (workspace: CloudWorkspace | undefined) => void): () => void;
  call(owner: CloudOwner, method: string, params: unknown, commandId?: string): Promise<unknown>;
}
