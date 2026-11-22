import type { CloudAnswer, CloudSetting } from "../../shared/cloud";
import { IPC_CHANNELS } from "../../shared/ipc";
import type { Handler } from "../../zolt/agent-handlers";
import { isObject } from "../../zolt/parsers";
import type { desktopCloudSettings } from "./cloud-settings";

const methods = new Set([
  "cloud.project.create",
  "task.create",
  "task.changes",
  "task.review",
  "task.reviewCommitPreview",
  "task.reviewCommit",
  "shipping.get",
  "thread.history",
]);

export function cloudHandlers(
  cloud: ReturnType<typeof desktopCloudSettings>,
): Record<string, Handler> {
  return {
    [IPC_CHANNELS.cloudSettings]: () => cloud.status(),
    [IPC_CHANNELS.cloudWorkspace]: () => cloud.workspace(),
    [IPC_CHANNELS.cloudUpdate]: (input: unknown) => {
      if (!isObject(input) || typeof input.sessionId !== "string")
        throw new Error("cloud_setting_invalid");
      const { type, sessionId, value, projectId } = input;
      let setting: CloudSetting;
      if ((type === "enabled" || type === "runner") && typeof value === "boolean")
        setting = { type, sessionId, value };
      else if (
        type === "execution" &&
        (value === "off" || value === "ask" || value === "allow_listed")
      )
        setting = { type, sessionId, value };
      else if (type === "folder" && typeof projectId === "string")
        setting = { type, sessionId, projectId };
      else throw new Error("cloud_setting_invalid");
      return cloud.update(setting);
    },
    [IPC_CHANNELS.cloudSaveSecret]: (input: unknown) => {
      if (
        !isObject(input) ||
        typeof input.sessionId !== "string" ||
        typeof input.value !== "string" ||
        (input.name !== "anthropic" && input.name !== "openai" && input.name !== "github")
      )
        throw new Error("cloud_secret_invalid");
      return cloud.saveSecret({ sessionId: input.sessionId, name: input.name, value: input.value });
    },
    [IPC_CHANNELS.cloudAnswer]: (input: unknown) => {
      if (
        !isObject(input) ||
        !isObject(input.owner) ||
        input.owner.kind !== "cloud" ||
        typeof input.owner.orgId !== "string" ||
        typeof input.owner.sessionId !== "string" ||
        typeof input.id !== "string" ||
        !Number.isSafeInteger(input.version) ||
        (input.action !== "accept" && input.action !== "decline") ||
        (input.choice !== undefined &&
          input.choice !== "allow_once" &&
          input.choice !== "allow_task_prefix" &&
          input.choice !== "reject_once")
      )
        throw new Error("cloud_request_invalid");
      return cloud.answer(input as unknown as CloudAnswer);
    },
    [IPC_CHANNELS.cloudCall]: (input: unknown) => {
      if (!isObject(input)) throw new Error("cloud_request_invalid");
      const { owner, method, params, commandId } = input;
      if (
        !isObject(owner) ||
        owner.kind !== "cloud" ||
        typeof owner.orgId !== "string" ||
        typeof owner.sessionId !== "string" ||
        typeof method !== "string" ||
        !methods.has(method) ||
        (commandId !== undefined && (typeof commandId !== "string" || commandId.length > 200))
      )
        throw new Error("cloud_request_invalid");
      return cloud.call(
        { kind: "cloud", orgId: owner.orgId, sessionId: owner.sessionId },
        method,
        params,
        commandId,
      );
    },
  };
}
