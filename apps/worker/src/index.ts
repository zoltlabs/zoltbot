import { chmod, lstat, mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import {
  cloudMacTools,
  EncryptedTaskVault,
  ManagedWorkspaces,
  type NativeCloudTasksOptions,
  nativeCloudTasks,
  RunnerConnection,
} from "@zoltbot/daemon/cloud-runner";
import type { RunnerHello } from "@zoltbot/runner-protocol";
import { acquireOwnerLock } from "@zoltbot/store";
import { workerCredentials } from "./credentials.js";
import type { WorkerEnvironment } from "./environment.js";
import { prepareWorkerRepository } from "./setup.js";

export interface WorkerOptions {
  environment: WorkerEnvironment;
  /** Fixed /home/user paths in production; disposable roots in headless tests. */
  directory?: string;
  workDirectory?: string;
  tools?: NativeCloudTasksOptions["tools"];
  native?: NativeCloudTasksOptions["native"];
  clis: RunnerHello["clis"] | ((directory: string) => Promise<RunnerHello["clis"]>);
  versions: RunnerHello["versions"];
  fetch?: typeof fetch;
  status?(code: string): void;
  allowLoopback?: boolean;
  localRepository?(repository: string): string;
}

/** One worker owns one injected task, one native session cache and one managed repository. */
export async function startWorker(options: WorkerOptions) {
  const config = options.environment,
    directory = options.directory ?? "/home/user/.zoltbot";
  let owner: ReturnType<typeof acquireOwnerLock> | undefined, vault: EncryptedTaskVault | undefined;
  let native: ReturnType<typeof nativeCloudTasks> | undefined,
    connection: RunnerConnection | undefined;
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      const cleanup = await Promise.allSettled([Promise.resolve().then(() => connection?.close())]);
      try {
        await native?.close();
      } finally {
        vault?.close();
        owner?.release();
        config.clear();
      }
      if (cleanup.some((result) => result.status === "rejected"))
        throw new Error("worker_cleanup_required");
    })());
  const status = (code: string) => {
    try {
      options.status?.(code);
    } catch {}
    if (code === "runner_access_revoked")
      void close().catch(() => {
        try {
          options.status?.("worker_cleanup_required");
        } catch {}
      });
  };
  try {
    if (!path.isAbsolute(directory)) throw new Error();
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error();
    await chmod(directory, 0o700);
    const root = await realpath(directory);
    owner = acquireOwnerLock(path.join(root, "worker.lock"));
    const key = config.read("ZOLTBOT_PRIVATE_CONTEXT_KEY");
    if (!key) throw new Error();
    vault = new EncryptedTaskVault(
      path.join(root, "private-context"),
      { orgId: config.orgId, taskId: config.taskId },
      key,
    );
    const workspaces = new ManagedWorkspaces({
      directory: path.join(root, "checkouts"),
      sandbox: {
        orgId: config.orgId,
        taskId: config.taskId,
        workDirectory: options.workDirectory ?? "/home/user/work",
      },
      githubToken: async () => config.read("GITHUB_TOKEN"),
      ...(options.localRepository ? { localRepository: options.localRepository } : {}),
    });
    native = nativeCloudTasks({
      orgId: config.orgId,
      memberId: config.memberId,
      directory: path.join(root, "runtime"),
      workspaces,
      guard: (value) => config.guard(value),
      privateValues: () => config.privateValues(),
      vault: async () => {
        if (!vault) throw new Error("worker_private_context_unavailable");
        return vault;
      },
      providerKey: async (provider) => {
        if (provider !== config.provider) throw new Error("worker_scope_conflict");
        const value = config.read(provider === "claude" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY");
        if (!value) throw new Error("worker_api_key_required");
        return value;
      },
      native: options.native ?? {
        home: path.dirname(options.workDirectory ?? "/home/user/work"),
        inherited: {},
        paths: async () =>
          (process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin")
            .split(path.delimiter)
            .filter(path.isAbsolute),
      },
      status,
      async tools(input) {
        const project = input.lease.execution?.project;
        if (!project?.cloud) throw new Error("worker_scope_conflict");
        await prepareWorkerRepository(
          {
            directory: path.join(root, "setup"),
            orgId: config.orgId,
            taskId: config.taskId,
            cwd: input.cwd,
            baseCommit: input.baseCommit,
            script: project.cloud.setupScript,
            guard: (value) => config.guard(value),
            environment: {
              PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
              HOME: path.dirname(options.workDirectory ?? "/home/user/work"),
              GITHUB_TOKEN: config.read("GITHUB_TOKEN") ?? "",
            },
          },
          input.signal,
        );
        if (options.tools) return options.tools(input);
        if (!connection) throw new Error("worker_scope_conflict");
        return cloudMacTools(input, {
          call: connection.call.bind(connection),
          flush: connection.flush.bind(connection),
        });
      },
    });
    const tasks = native.task;
    const clis = typeof options.clis === "function" ? await options.clis(root) : options.clis;
    connection = new RunnerConnection({
      orgId: config.orgId,
      taskId: config.taskId,
      hello: {
        kind: "sandbox",
        runnerId: config.runnerId,
        protocolVersion: 1,
        sleepKeepsProcesses: config.sleepKeepsProcesses,
        versions: structuredClone(options.versions),
        clis: structuredClone(clis),
      },
      outboxDirectory: path.join(root, "outbox"),
      guard: (value) => config.guard(value),
      credentials: workerCredentials(config, options.fetch),
      async task(lease, ...args) {
        if (
          lease.taskId !== config.taskId ||
          lease.actor.userId !== config.memberId ||
          lease.execution?.definition.adapter !== config.provider
        )
          throw new Error("worker_scope_conflict");
        return tasks(lease, ...args);
      },
      ...(options.allowLoopback ? { allowLoopback: true } : {}),
      status,
    });
    connection.start();
    return { close };
  } catch {
    await close();
    throw new Error("worker_start_unavailable");
  }
}
