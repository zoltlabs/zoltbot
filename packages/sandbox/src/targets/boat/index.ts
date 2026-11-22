import { randomUUID } from "node:crypto";
import { posix } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  BoatApi,
  type CommandFrame,
  Configuration,
  followCommand,
  ResponseError,
  waitUntilReady,
} from "@boatdev/sdk";
import {
  type ExecutionTarget,
  SandboxError,
  type SandboxRef,
  type SandboxSize,
  type SandboxStatus,
} from "../../interface.js";
import { lookupLabels, matchesLabels } from "../../labels.js";
import { collect, ExecChannel, resolvePath, shellJoin } from "../../stream.js";
import { execWithEnvironment } from "./ssh.js";

export const SDK_VERSION = "1.13.0";
export const BOAT_TEMPLATE = "zoltbot-base";
export const BOAT_HOURLY_RATES = { small: 0.018, default: 0.036, large: 0.072 } as const;
const WORKDIR = "/home/user";
const READY_TIMEOUT_MS = 300_000;
const SNAPSHOT_TIMEOUT_MS = 900_000;
const COMMAND_RESTORE_RETRY_MS = 60_000;
export const BOAT_SIZES = {
  small: { cpus: 2, memoryMiB: 4096 },
  default: { cpus: 4, memoryMiB: 8192 },
  large: { cpus: 8, memoryMiB: 16384 },
} as const;
const tiers = ["small", "default", "large"] as const;

export function boatSize(size?: SandboxSize): keyof typeof BOAT_HOURLY_RATES {
  if (!size) return "default";
  if (
    !Number.isSafeInteger(size.cpus) ||
    size.cpus < 1 ||
    !Number.isSafeInteger(size.memoryMiB) ||
    size.memoryMiB < 1
  ) {
    throw new SandboxError("invalid", "Invalid Boat sandbox size");
  }
  const tier = tiers.find((name) => {
    const limit = BOAT_SIZES[name];
    return size.cpus <= limit.cpus && size.memoryMiB <= limit.memoryMiB;
  });
  if (!tier) throw new SandboxError("unsupported", "Size exceeds the largest supported Boat tier");
  return tier;
}

type BoatMethods = Pick<
  BoatApi,
  | "create"
  | "deleteSandbox"
  | "getDeletionOperation"
  | "get"
  | "stop"
  | "resume"
  | "sandboxes"
  | "command"
  | "stopCommand"
  | "readFile"
  | "writeFile"
  | "listFiles"
  | "hostPort"
  | "saveSavedSnapshot"
  | "getSavedSnapshot"
  | "sshKey"
>;

export interface BoatSdk extends BoatMethods {
  ready(sandboxId: string): Promise<unknown>;
  follow(sandboxId: string, processId: number, signal: AbortSignal): AsyncIterable<CommandFrame>;
  execWithEnvironment: typeof execWithEnvironment;
}

export interface BoatTargetOptions {
  apiKey: string;
  /** A saved snapshot name. Pass null for a fresh VM when building the snapshot. */
  template?: string | null;
  /** Seconds before automatic stop. Pass null to disable automatic stop. */
  ttlSeconds?: number | null;
  sdk?: BoatSdk;
}

export function createBoatApi(apiKey: string) {
  if (!apiKey) throw new SandboxError("invalid", "A Boat API key is required");
  return new BoatApi(
    new Configuration({ accessToken: apiKey, basePath: "https://boat.dev/api/v1" }),
  );
}

function defaultSdk(apiKey: string): BoatSdk {
  const api = createBoatApi(apiKey);
  return Object.assign(api, {
    ready: (sandboxId: string) => waitUntilReady(api, sandboxId, { timeoutMs: READY_TIMEOUT_MS }),
    follow: (sandboxId: string, processId: number, signal: AbortSignal) =>
      followCommand(api, sandboxId, processId, { signal }),
    execWithEnvironment,
  });
}

/** Boat errors may carry credentials, signed URLs, or command arguments. */
export async function boatRequest<T>(work: () => Promise<T>, file = false): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof SandboxError) throw error;
    if (error instanceof ResponseError && error.response.status === 404)
      throw new SandboxError(
        file ? "not_found" : "gone",
        file ? "No such file or directory" : "Sandbox does not exist",
      );
    throw new SandboxError("provider", "Boat request failed");
  }
}

async function startBoatCommand(sdk: BoatSdk, request: Parameters<BoatSdk["command"]>[0]) {
  return boatRequest(async () => {
    // Boat can mark a VM ready while its disk is still restoring. Only retry a
    // provider response that guarantees the previous command never started.
    const deadline = Date.now() + COMMAND_RESTORE_RETRY_MS;
    for (;;) {
      try {
        return await sdk.command(request);
      } catch (error) {
        if (!(error instanceof ResponseError) || Date.now() + 1000 >= deadline) throw error;
        const body = await error.response
          .clone()
          .json()
          .catch(() => undefined);
        if (body?.retryable !== true) throw error;
      }
      await delay(1000);
    }
  });
}

async function until<T>(
  timeout: number,
  message: string,
  sample: () => Promise<T | undefined>,
): Promise<T> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const result = await sample();
    if (result !== undefined) return result;
    if (Date.now() >= deadline) throw new SandboxError("provider", message);
    await delay(1000);
  }
}

export async function saveBoatSnapshot(
  sdk: Pick<BoatSdk, "saveSavedSnapshot" | "getSavedSnapshot">,
  sandboxId: string,
  name: string,
) {
  await boatRequest(() => sdk.saveSavedSnapshot({ sandboxId, name }));
  await until(SNAPSHOT_TIMEOUT_MS, "Timed out saving the Boat snapshot", async () => {
    const { snapshot } = await boatRequest(() => sdk.getSavedSnapshot({ name }));
    if (snapshot.status === "failed")
      throw new SandboxError("provider", "Boat could not save the snapshot");
    if (snapshot.status === "ready" && snapshot.sourceSandboxId === sandboxId) return true;
  });
  return { target: "boat", id: name };
}

function reference(id: string): SandboxRef {
  return { target: "boat", id, workdir: WORKDIR };
}

function sandboxId(ref: SandboxRef) {
  if (ref.target !== "boat") throw new SandboxError("gone", "Sandbox does not exist");
  return ref.id;
}

function filePath(path: string) {
  const absolute = posix.resolve(WORKDIR, path);
  if ([WORKDIR, "/tmp"].some((root) => absolute === root || absolute.startsWith(`${root}/`))) {
    return absolute;
  }
  throw new SandboxError("invalid", "Boat file paths must stay within the sandbox home or /tmp");
}

export interface BoatExecutionTarget extends ExecutionTarget {
  /** Starts the Cloud worker independently of the hosted service's connection. */
  startWorker(ref: SandboxRef, env: Record<string, string>): Promise<void>;
}

export function createBoatTarget(options: BoatTargetOptions): BoatExecutionTarget {
  if (!options.apiKey) throw new SandboxError("invalid", "A Boat API key is required");
  const sdk = options.sdk ?? defaultSdk(options.apiKey);
  const ttlSeconds = options.ttlSeconds === undefined ? 3600 : options.ttlSeconds;
  if (
    ttlSeconds !== null &&
    (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 2_592_000)
  ) {
    throw new SandboxError("invalid", "Invalid Boat auto-stop interval");
  }

  async function status(ref: SandboxRef): Promise<SandboxStatus> {
    const id = sandboxId(ref);
    try {
      const { sandbox } = await boatRequest(() => sdk.get({ sandboxId: id }));
      if (sandbox.dataExpiredAt || sandbox.state === "cancelled") return { state: "destroyed" };
      if (["archived", "archiving", "error"].includes(sandbox.state)) return { state: "sleeping" };
      return { state: "running" };
    } catch (error) {
      if (error instanceof SandboxError && error.code === "gone") return { state: "destroyed" };
      throw error;
    }
  }

  async function running(ref: SandboxRef) {
    const current = (await status(ref)).state;
    if (current === "destroyed") throw new SandboxError("gone", "Sandbox does not exist");
    if (current !== "running") throw new SandboxError("not_running", "Sandbox is asleep");
    return ref.id;
  }

  async function destroy(ref: SandboxRef) {
    const id = sandboxId(ref);
    const deleted = await boatRequest(() =>
      sdk.deleteSandbox({ sandboxId: id, xAsciiConfirmDelete: id }),
    ).catch((error: unknown) => {
      if (error instanceof SandboxError && error.code === "gone") return undefined;
      throw error;
    });
    if (!deleted || deleted.operation.status === "completed") return;
    const operationId = deleted.operation.id;
    await until(SNAPSHOT_TIMEOUT_MS, "Timed out deleting the Boat sandbox", async () => {
      const { operation } = await boatRequest(() => sdk.getDeletionOperation({ operationId }));
      if (operation.status === "completed") return true;
    });
  }

  async function waitForStop(id: string) {
    await until(SNAPSHOT_TIMEOUT_MS, "Timed out stopping the Boat sandbox", async () => {
      const { sandbox } = await boatRequest(() => sdk.get({ sandboxId: id }));
      if (sandbox.state === "archived") return true;
      if (sandbox.state === "error" || sandbox.stop?.status === "failing")
        throw new SandboxError("provider", "Boat could not stop and save the sandbox");
    });
  }

  const target: BoatExecutionTarget = {
    id: "boat",
    versions: { component: "@boatdev/sdk", tested: "none", range: `^${SDK_VERSION}` },
    capabilities: {
      snapshot: true,
      persistentVolume: true,
      maxLifetimeMs: ttlSeconds === null ? null : ttlSeconds * 1000,
      ssh: true,
      gpu: false,
      sleepKeepsProcesses: false,
      ports: "any",
      // B8: no private route to a Boat sandbox's ports is known, so no desktop.
      privatePorts: false,
      sizing: "per_sandbox",
    },
    async create(spec = {}) {
      if (spec.from && spec.from.target !== "boat")
        throw new SandboxError("invalid", "Snapshot belongs to a different target");
      const from =
        spec.from?.id ??
        spec.template ??
        (options.template === null ? null : (options.template ?? BOAT_TEMPLATE));
      const type = boatSize(spec.size);
      const { sandbox } = await boatRequest(() =>
        sdk.create({
          idempotencyKey: randomUUID(),
          createSandboxRequest: {
            ...(from ? { from } : {}),
            type,
            ttlSeconds,
            ...(spec.labels ? { labels: spec.labels } : {}),
            ...(spec.env ? { env: spec.env } : {}),
            noEnv: true,
            visibility: "private",
            snapshots: true,
          },
        }),
      );
      const ref = reference(sandbox.id);
      try {
        await boatRequest(() => sdk.ready(ref.id));
      } catch (error) {
        await destroy(ref).catch(() => undefined);
        throw error;
      }
      return ref;
    },
    async find(raw) {
      const labels = lookupLabels(raw);
      const matches = new Map<string, SandboxRef>();
      let cursor: string | null | undefined;
      for (let page = 0; page < 16; page++) {
        const result = await boatRequest(() =>
          sdk.sandboxes({
            label: Object.entries(labels).map(([key, value]) => `${key}=${value}`),
            limit: 100,
            ...(cursor ? { cursor } : {}),
          }),
        );
        for (const row of result.sandboxes) {
          if (!row.dataExpiredAt && row.state !== "cancelled" && matchesLabels(labels, row.labels))
            matches.set(row.id, reference(row.id));
        }
        if (matches.size > 256) break;
        if (!result.pageInfo?.hasMore) return [...matches.values()];
        const next = result.pageInfo.nextCursor;
        if (!next || next === cursor) break;
        cursor = next;
      }
      throw new SandboxError("provider", "Boat sandbox lookup limit exceeded");
    },
    async sleep(ref) {
      const id = sandboxId(ref);
      const { sandbox } = await boatRequest(() => sdk.get({ sandboxId: id }));
      if (sandbox.state === "archived") return;
      if (sandbox.state !== "archiving") await boatRequest(() => sdk.stop({ sandboxId: id }));
      await waitForStop(id);
    },
    async wake(ref) {
      const id = sandboxId(ref);
      const { sandbox } = await boatRequest(() => sdk.get({ sandboxId: id }));
      if (sandbox.dataExpiredAt || sandbox.state === "cancelled")
        throw new SandboxError("gone", "Sandbox does not exist");
      if (sandbox.state === "archiving") await waitForStop(id);
      if (["archived", "archiving", "error"].includes(sandbox.state))
        await boatRequest(() => sdk.resume({ sandboxId: id, noEnv: true, ttlSeconds }));
      await boatRequest(() => sdk.ready(id));
    },
    destroy,
    status,
    async startWorker(ref, env) {
      const id = await running(ref);
      const process = await boatRequest(() =>
        sdk.execWithEnvironment(
          sdk,
          id,
          ["node", "/opt/zoltbot/apps/worker/dist/main.mjs"],
          WORKDIR,
          env,
          true,
        ),
      );
      const exit = await boatRequest(() => process.exit);
      if (exit.code !== 0) throw new SandboxError("provider", "Boat Cloud worker could not start");
    },
    async exec(ref, argv, options = {}) {
      if (!argv.length) throw new SandboxError("invalid", "Command is empty");
      const id = await running(ref);
      const cwd = resolvePath(WORKDIR, options.cwd ?? WORKDIR);
      const env = options.env;
      if (env && Object.keys(env).length)
        return boatRequest(() => sdk.execWithEnvironment(sdk, id, argv, cwd, env));
      const relative = posix.relative(WORKDIR, cwd) || ".";
      const outsideHome = relative === ".." || relative.startsWith("../");
      const command = outsideHome
        ? `cd -- ${shellJoin([cwd])} && exec ${shellJoin(argv)}`
        : shellJoin(argv);
      const started = await startBoatCommand(sdk, {
        sandboxId: id,
        command,
        cwd: outsideHome ? "." : relative,
        detached: true,
      });
      if (!("processId" in started) || !started.success)
        throw new SandboxError("provider", "Boat did not start the detached command");
      const processId = started.processId;
      const follow = new AbortController();
      let finished = false;
      let stopping: Promise<void> | undefined;
      const output = new ExecChannel(async () => {
        if (finished) return;
        stopping ??= (async () => {
          await boatRequest(() => sdk.stopCommand({ sandboxId: id, processId }));
          finished = true;
          output.end({ code: null, killed: true });
          follow.abort();
        })();
        return stopping;
      });
      void (async () => {
        try {
          for await (const frame of sdk.follow(id, processId, follow.signal)) {
            if (frame.type === "stdout" || frame.type === "stderr")
              output.push(frame.type, frame.data ?? "");
            if (frame.type === "exit") {
              await stopping?.catch(() => undefined);
              if (!finished) output.end({ code: frame.exitCode ?? null });
              return;
            }
            if (frame.type === "error") break;
          }
          if (!finished)
            output.error(new SandboxError("provider", "Boat command stream ended without an exit"));
        } catch {
          if (!finished)
            output.error(new SandboxError("provider", "Boat command output could not be read"));
        } finally {
          finished = true;
        }
      })();
      return output;
    },
    files: {
      async read(ref, path) {
        const id = await running(ref);
        const file = filePath(path);
        const response = await boatRequest(
          () => sdk.readFile({ sandboxId: id, path: file, encoding: "base64" }),
          true,
        );
        return Buffer.from(response.content, "base64");
      },
      async write(ref, path, data) {
        const id = await running(ref);
        const file = filePath(path);
        const parent = posix.dirname(file);
        if (parent !== WORKDIR && parent !== "/tmp") {
          const relative = posix.relative(WORKDIR, parent);
          const mkdir = await collect(await target.exec(ref, ["mkdir", "-p", "--", relative]));
          if (mkdir.code !== 0)
            throw new SandboxError("provider", "Boat could not create the parent directory");
        }
        const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
        const content = Buffer.from(bytes).toString("base64");
        await boatRequest(
          () => sdk.writeFile({ sandboxId: id, path: file, content, encoding: "base64" }),
          true,
        );
      },
      async list(ref, path) {
        const id = await running(ref);
        const folder = filePath(path);
        const response = await boatRequest(
          () => sdk.listFiles({ sandboxId: id, path: folder }),
          true,
        );
        if (response.truncated)
          throw new SandboxError("provider", "Boat directory listing was truncated");
        return response.files.map((file) => ({
          name: file.name,
          path: posix.join(folder, file.name),
          type: file.isSymlink ? "symlink" : file.isDir ? "dir" : "file",
          size: file.size,
        }));
      },
    },
    ports: {
      async expose(ref, port) {
        const id = await running(ref);
        const result = await boatRequest(() =>
          sdk.hostPort({ sandboxId: id, port, _public: false }),
        );
        if (!result.url || result.access !== "private")
          throw new SandboxError("provider", "Boat did not return a private port URL");
        const url = URL.parse(result.url);
        if (url?.protocol !== "https:" || !url.searchParams.get("_token"))
          throw new SandboxError("provider", "Boat did not return a token-gated port URL");
        return url.href;
      },
    },
    snapshot(ref) {
      return saveBoatSnapshot(sdk, sandboxId(ref), `zoltbot-${randomUUID()}`);
    },
  };
  return target;
}
