import path from "node:path";
import type { RunnerHello } from "@zoltbot/runner-protocol";
import { type RunnerAccountOptions, runnerAccount } from "./account.js";
import { RunnerConnection, type RunnerConnectionOptions } from "./connection.js";
import { type NativeCloudTasksOptions, nativeCloudTasks } from "./native.js";
import { ManagedWorkspaces } from "./workspaces.js";

export interface MacRunnerOptions
  extends Omit<NativeCloudTasksOptions, "directory" | "workspaces" | "orgId"> {
  directory: string;
  account: RunnerAccountOptions;
  /** Supplied only after the owner explicitly enables these capabilities. */
  capabilities: { canRunTasks: boolean; canMacExec: boolean };
  versions: RunnerHello["versions"];
  clis: RunnerHello["clis"];
  githubToken?(signal: AbortSignal): Promise<string | undefined>;
  /** W7's verified execution host, never a raw Cell-approved shell callback. */
  macExec?: RunnerConnectionOptions["macExec"];
  localRepository?(repository: string): string;
}

/** No Local store or runtime is accepted. Creating this host is the explicit opt-in. */
export function startMacRunner(options: MacRunnerOptions) {
  const capabilities = structuredClone(options.capabilities),
    privateValues = new Set<string>();
  if (
    (!capabilities.canRunTasks && !capabilities.canMacExec) ||
    (capabilities.canMacExec && !options.macExec) ||
    typeof capabilities.canRunTasks !== "boolean" ||
    typeof capabilities.canMacExec !== "boolean"
  )
    throw new Error("runner_opt_in_required");
  const remember = (value: string | undefined) => {
    if (value) privateValues.add(value);
    return value;
  };
  const guard = (value: unknown) => {
    options.guard(value);
    const encoded = JSON.stringify(value);
    if ([...privateValues].some((secret) => encoded.includes(secret)))
      throw new Error("runner_private_value");
  };
  const account = runnerAccount({
    ...options.account,
    accessToken: async (signal) => remember(await options.account.accessToken(signal)) as string,
  });
  const native = nativeCloudTasks({
    orgId: options.account.orgId,
    memberId: options.memberId,
    directory: path.join(options.directory, "runtime"),
    guard,
    workspaces: new ManagedWorkspaces({
      directory: path.join(options.directory, "workspaces"),
      ...(options.githubToken
        ? { githubToken: async (signal) => remember(await options.githubToken?.(signal)) }
        : {}),
      ...(options.localRepository ? { localRepository: options.localRepository } : {}),
    }),
    vault: options.vault,
    tools: options.tools,
    ...(options.native ? { native: options.native } : {}),
    ...(options.providerKey
      ? {
          providerKey: async (provider, taskId, signal) =>
            remember(await options.providerKey?.(provider, taskId, signal)),
        }
      : {}),
    ...(options.status ? { status: options.status } : {}),
  });
  const connection = new RunnerConnection({
    orgId: options.account.orgId,
    outboxDirectory: path.join(options.directory, "outbox"),
    guard,
    hello: {
      kind: "mac",
      runnerId: options.account.deviceId,
      protocolVersion: 1,
      acceptTasks: capabilities.canRunTasks,
      sleepKeepsProcesses: true,
      versions: structuredClone(options.versions),
      clis: structuredClone(options.clis),
    },
    async credentials(signal) {
      const credentials = await account.credentials(signal);
      remember(credentials.token);
      return credentials;
    },
    task: native.task,
    ...(capabilities.canMacExec && options.macExec ? { macExec: options.macExec } : {}),
    ...(options.account.allowLoopback ? { allowLoopback: true } : {}),
    ...(options.status ? { status: options.status } : {}),
  });
  connection.start();
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      try {
        await connection.close();
      } finally {
        try {
          await native.close();
        } finally {
          privateValues.clear();
        }
      }
    })());
  return {
    close,
    async disable(signal: AbortSignal) {
      const results = await Promise.allSettled([
        close(),
        account.setGrant({ canRunTasks: false, canMacExec: false }, signal),
      ]);
      if (results.some((result) => result.status === "rejected"))
        throw new Error("runner_disable_unconfirmed");
    },
  };
}
