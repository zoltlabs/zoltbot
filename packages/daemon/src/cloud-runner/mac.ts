import path from "node:path";
import { parse } from "@zoltbot/protocol";
import { type RunnerHello, RunnerHelloSchema } from "@zoltbot/runner-protocol";
import { type RunnerAccountOptions, runnerAccount } from "./account.js";
import { RunnerConnection } from "./connection.js";
import { MacExecutionHost, type MacExecutionOptions } from "./mac-exec.js";
import { type MacProcessOptions, macCommandProcess } from "./mac-exec-process.js";
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
  /** Local settings/folder ports only; this host always constructs its own approval gate. */
  macExecution?: Omit<
    MacExecutionOptions,
    "directory" | "orgId" | "userId" | "deviceId" | "deviceKeys" | "execute"
  > &
    Pick<MacProcessOptions, "environment" | "shell" | "chunk">;
  localRepository?(repository: string): string;
}

/** No Local store or runtime is accepted. Creating this host is the explicit opt-in. */
export function startMacRunner(options: MacRunnerOptions) {
  const capabilities = structuredClone(options.capabilities),
    privateValues = new Set<string>();
  let closed = false;
  if (
    (!capabilities.canRunTasks && !capabilities.canMacExec) ||
    (capabilities.canMacExec && !options.macExecution) ||
    typeof capabilities.canRunTasks !== "boolean" ||
    typeof capabilities.canMacExec !== "boolean"
  )
    throw new Error("runner_opt_in_required");
  const hello = parse(RunnerHelloSchema, {
    kind: "mac",
    runnerId: options.account.deviceId,
    protocolVersion: 1,
    acceptTasks: capabilities.canRunTasks,
    sleepKeepsProcesses: true,
    versions: structuredClone(options.versions),
    clis: structuredClone(options.clis),
  });
  const remember = (value: string | undefined) => {
    if (value && !closed) privateValues.add(value);
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
    ...(options.account.accessToken
      ? {
          accessToken: async (signal: AbortSignal) =>
            remember(await options.account.accessToken?.(signal)) as string,
        }
      : {}),
  });
  const bridgeOptions = options.macExecution;
  const bridge =
    capabilities.canMacExec && bridgeOptions
      ? new MacExecutionHost({
          directory: path.join(options.directory, "mac-exec"),
          orgId: options.account.orgId,
          userId: options.memberId,
          deviceId: options.account.deviceId,
          mac: bridgeOptions.mac,
          ...(bridgeOptions.osVersion ? { osVersion: bridgeOptions.osVersion } : {}),
          mode: bridgeOptions.mode,
          task: bridgeOptions.task,
          deviceKeys: (signal) => account.deviceKeys(signal),
          ...(bridgeOptions.now ? { now: bridgeOptions.now } : {}),
          execute: macCommandProcess({
            directory: path.join(options.directory, "mac-output"),
            mac: bridgeOptions.mac,
            environment: bridgeOptions.environment,
            privateValues: () => [...privateValues, ...(options.privateValues?.() ?? [])],
            ...(bridgeOptions.shell ? { shell: bridgeOptions.shell } : {}),
            chunk(frame) {
              connection.chunk(frame);
              bridgeOptions.chunk?.(frame);
            },
          }),
        })
      : undefined;
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
    privateValues: () => [...privateValues, ...(options.privateValues?.() ?? [])],
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
    hello,
    async credentials(signal) {
      const credentials = await account.credentials(signal);
      remember(credentials.token);
      return credentials;
    },
    task: native.task,
    ...(bridge
      ? {
          macExec: (request, signal) => bridge.request(request, signal),
          macStatus: (request, signal) => bridge.status(request, signal),
        }
      : {}),
    ...(options.account.allowLoopback ? { allowLoopback: true } : {}),
    status(code) {
      try {
        options.status?.(code);
      } catch {}
      if (code === "runner_access_revoked")
        void close().catch(() => {
          try {
            options.status?.("runner_cleanup_required");
          } catch {}
        });
    },
  });
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      closed = true;
      try {
        await connection.close();
      } finally {
        try {
          await native.close();
        } finally {
          try {
            await bridge?.close();
          } finally {
            privateValues.clear();
          }
        }
      }
    })());
  connection.start();
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
