import type { TSchema } from "@sinclair/typebox";
import { browserMacOnlyMethods } from "./browser.js";
import type { MethodName } from "./catalog.js";
import { quickChatMacOnlyMethods } from "./quick-chat.js";
import { shippingMacOnlyMethods } from "./shipping.js";
import { skillMacOnlyMethods } from "./skills.js";
import { viewMacOnlyMethods } from "./views.js";

const localDesktopOnlyMethods: readonly MethodName[] = [
  ...viewMacOnlyMethods,
  "compare.create",
  "compare.widen",
  ...shippingMacOnlyMethods,
  ...skillMacOnlyMethods,
  ...browserMacOnlyMethods,
  ...quickChatMacOnlyMethods,
  "routine.checkSource",
  "routine.connectionHandoff",
  "routine.prepare",
  "routine.editEvent",
  "routine.preview",
  "routine.commit",
  "routine.retrySource",
  "routine.archiveHistory",
  "routine.create",
  "connection.install",
  "connection.auth.start",
  "connection.auth.status",
  "connection.auth.cancel",
  "connection.import",
  "connection.save",
  "device.pair.start",
  "device.pair.confirm",
  "detect.startLogin",
  "native.openCommand",
  "diagnostics.export",
];
export type MethodWhere = "local" | "cloud" | "both";
const cloudOnlyMethods: readonly MethodName[] = [
  "cloud.project.create",
  "cloud.project.list",
  "usage.get",
  "cloud.mac.output",
];
const cloudSharedMethods: readonly MethodName[] = [
  "hello",
  "snapshot.get",
  "events.subscribe",
  "events.unsubscribe",
  "project.list",
  "agent.list",
  "agentDefinition.list",
  "thread.list",
  "thread.create",
  "thread.rename",
  "thread.archive",
  "thread.history",
  "thread.search",
  "turn.send",
  "turn.cancelQueued",
  "turn.interrupt",
  "turn.retry",
  "interaction.list",
  "interaction.answer",
  "interaction.defer",
  "interaction.forwardLate",
  "interaction.batchAnswer",
  "rule.list",
  "rule.test",
  "rule.revoke",
  "task.list",
  "task.create",
  "task.update",
  "task.cancel",
  "task.retry",
  "task.review",
  "task.changes",
  "shipping.get",
  "shipping.refresh",
  "audit.list",
];

/** Unclassified methods are local until their cell implementation is added. */
export function withMethodLocations<T extends Record<string, { params: TSchema; result: TSchema }>>(
  catalog: T,
) {
  return Object.fromEntries(
    Object.entries(catalog).map(([name, contract]) => {
      const method = name as MethodName;
      const where: MethodWhere = cloudOnlyMethods.includes(method)
        ? "cloud"
        : cloudSharedMethods.includes(method)
          ? "both"
          : "local";
      return [name, { ...contract, where, pairedPhone: !localDesktopOnlyMethods.includes(method) }];
    }),
  ) as { [M in keyof T]: T[M] & { where: MethodWhere; pairedPhone: boolean } };
}
