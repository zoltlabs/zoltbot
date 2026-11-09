import { Sandbox } from "e2b";
import {
  type ExecOptions,
  type ExecProcess,
  type ExecutionTarget,
  type FileEntry,
  type SandboxCapabilities,
  SandboxError,
  type SandboxRef,
  type SandboxSpec,
  type SandboxStatus,
} from "../../interface.js";
import { ExecChannel, resolvePath, shellJoin } from "../../stream.js";

// The managed target (D134): sandboxes on E2B's hosted service, through the official SDK. The API
// key is passed in by the caller (keychain or environment) and only ever handed to the SDK; error
// messages are redacted before they leave this module (I7).

export const SDK_VERSION = "2.62.2";
const WORKDIR = "/home/user";

export interface E2bTargetOptions {
  apiKey: string;
  /** Template for sandboxes whose spec names none. */
  template?: string;
  /** Sandbox timeout the SDK enforces; also the declared max lifetime. One hour on the Hobby plan. */
  timeoutMs?: number;
  /** Self-hosted E2B (Apache-2.0) by domain, for the free tier. */
  domain?: string;
  /** For tests only: stands in for the SDK. */
  sdk?: E2bSdk;
}

export interface E2bHandle {
  wait(): Promise<{ exitCode: number }>;
  kill(): Promise<boolean>;
}

export interface E2bRunOptions {
  background: true;
  cwd: string;
  envs: Record<string, string>;
  timeoutMs: number;
  onStdout(data: string): void;
  onStderr(data: string): void;
}

export interface E2bInstance {
  sandboxId: string;
  run(command: string, options: E2bRunOptions): Promise<E2bHandle>;
  read(path: string): Promise<Uint8Array>;
  write(path: string, data: Uint8Array | string): Promise<unknown>;
  list(path: string): Promise<Array<{ name: string; path: string; type?: string; size: number }>>;
  getHost(port: number): string;
  pause(): Promise<unknown>;
  createSnapshot(): Promise<{ snapshotId: string }>;
}

interface Connection {
  apiKey: string;
  domain?: string;
}

export interface E2bSdk {
  create(
    template: string,
    options: Connection & {
      envs: Record<string, string>;
      metadata: Record<string, string>;
      timeoutMs: number;
    },
  ): Promise<E2bInstance>;
  connect(id: string, options: Connection & { timeoutMs: number }): Promise<E2bInstance>;
  kill(id: string, options: Connection): Promise<unknown>;
  getInfo(id: string, options: Connection): Promise<{ state: "running" | "paused" }>;
  getMetrics(
    id: string,
    options: Connection,
  ): Promise<Array<{ cpuUsedPct: number; memUsed: number }>>;
}

function wrap(sandbox: Sandbox): E2bInstance {
  return {
    sandboxId: sandbox.sandboxId,
    run: (command, options) => sandbox.commands.run(command, options),
    read: (path) => sandbox.files.read(path, { format: "bytes" }),
    write: (path, data) => sandbox.files.write(path, data),
    list: (path) => sandbox.files.list(path),
    getHost: (port) => sandbox.getHost(port),
    pause: () => sandbox.pause(),
    createSnapshot: () => sandbox.createSnapshot(),
  };
}

export const e2bSdk: E2bSdk = {
  create: async (template, options) => wrap(await Sandbox.create(template, options)),
  connect: async (id, options) => wrap(await Sandbox.connect(id, options)),
  kill: (id, options) => Sandbox.kill(id, options),
  getInfo: (id, options) => Sandbox.getInfo(id, options),
  getMetrics: (id, options) => Sandbox.getMetrics(id, options),
};

export function createE2bTarget(options: E2bTargetOptions): ExecutionTarget {
  if (!options.apiKey) throw new SandboxError("invalid", "An E2B API key is required");
  const id = "e2b";
  const sdk = options.sdk ?? e2bSdk;
  const timeoutMs = options.timeoutMs ?? 3_600_000;
  const connection: Connection = {
    apiKey: options.apiKey,
    ...(options.domain ? { domain: options.domain } : {}),
  };
  const live = new Map<string, E2bInstance>();
  const secrets = new Set<string>([options.apiKey]);

  function redact(message: string) {
    let out = message;
    for (const secret of secrets)
      if (secret.length >= 4) out = out.split(secret).join("[redacted]");
    return out;
  }

  // Maps SDK errors by name so a stand-in SDK needs no SDK classes. `file` marks file operations,
  // where a plain NotFoundError is a missing path rather than a missing sandbox.
  function translate(error: unknown, file = false): SandboxError {
    if (error instanceof SandboxError) return error;
    const name = (error as Error | undefined)?.name ?? "";
    const message = redact((error as Error | undefined)?.message ?? String(error));
    if (name === "SandboxNotFoundError") return new SandboxError("gone", "Sandbox does not exist");
    if (name === "FileNotFoundError" || (file && name === "NotFoundError"))
      return new SandboxError("not_found", "No such file or directory");
    if (name === "NotFoundError") return new SandboxError("gone", "Sandbox does not exist");
    if (name === "SandboxNotRunningError")
      return new SandboxError("not_running", "Sandbox is asleep");
    return new SandboxError("provider", `e2b: ${message}`);
  }

  async function guard<T>(work: () => Promise<T>, file = false): Promise<T> {
    try {
      return await work();
    } catch (error) {
      throw translate(error, file);
    }
  }

  function sandboxId(ref: SandboxRef) {
    if (ref.target !== id) throw new SandboxError("gone", "Sandbox does not exist");
    return ref.id;
  }

  // A connect resumes a paused sandbox, so an unknown sandbox is only connected when it is running.
  async function instance(ref: SandboxRef): Promise<E2bInstance> {
    const known = live.get(sandboxId(ref));
    if (known) return known;
    const info = await guard(() => sdk.getInfo(ref.id, connection));
    if (info.state !== "running") throw new SandboxError("not_running", "Sandbox is asleep");
    const connected = await guard(() => sdk.connect(ref.id, { ...connection, timeoutMs }));
    live.set(ref.id, connected);
    return connected;
  }

  const capabilities: SandboxCapabilities = {
    snapshot: true,
    persistentVolume: true,
    maxLifetimeMs: timeoutMs,
    ssh: false,
    gpu: false,
    sleepKeepsProcesses: true,
    ports: "any",
    sizing: "template",
  };

  return {
    id,
    capabilities,
    versions: { component: "e2b", tested: "none", range: `>=${SDK_VERSION} <3` },

    async create(spec: SandboxSpec = {}) {
      if (spec.size)
        throw new SandboxError("unsupported", "Size comes from the template on this target");
      if (spec.from && spec.from.target !== id)
        throw new SandboxError("not_found", "Snapshot does not exist");
      for (const value of Object.values(spec.env ?? {})) secrets.add(value);
      const template = spec.from?.id ?? spec.template ?? options.template ?? "base";
      const sandbox = await guard(() =>
        sdk.create(template, {
          ...connection,
          envs: { ...spec.env },
          metadata: { ...spec.labels },
          timeoutMs,
        }),
      );
      live.set(sandbox.sandboxId, sandbox);
      return { target: id, id: sandbox.sandboxId, workdir: WORKDIR };
    },

    async wake(ref) {
      const info = await guard(() => sdk.getInfo(sandboxId(ref), connection));
      if (info.state === "running" && live.has(ref.id)) return;
      live.set(ref.id, await guard(() => sdk.connect(ref.id, { ...connection, timeoutMs })));
    },

    async sleep(ref) {
      const info = await guard(() => sdk.getInfo(sandboxId(ref), connection));
      if (info.state === "paused") {
        live.delete(ref.id);
        return;
      }
      await guard(async () => (await instance(ref)).pause());
      live.delete(ref.id);
    },

    async destroy(ref) {
      live.delete(ref.id);
      try {
        await sdk.kill(sandboxId(ref), connection);
      } catch (error) {
        const translated = translate(error);
        if (translated.code !== "gone") throw translated;
      }
    },

    async exec(ref, argv, execOptions: ExecOptions = {}): Promise<ExecProcess> {
      if (!argv.length) throw new SandboxError("invalid", "Empty command");
      const sandbox = await instance(ref);
      for (const value of Object.values(execOptions.env ?? {})) secrets.add(value);
      let handle: E2bHandle | undefined;
      let killed = false;
      const channel = new ExecChannel(async () => {
        if (!handle || killed) return;
        killed = true;
        await handle.kill().catch(() => false);
      });
      handle = await guard(() =>
        sandbox.run(shellJoin(argv), {
          background: true,
          cwd: resolvePath(WORKDIR, execOptions.cwd ?? WORKDIR),
          envs: { ...execOptions.env },
          timeoutMs: 0,
          onStdout: (data) => channel.push("stdout", data),
          onStderr: (data) => channel.push("stderr", data),
        }),
      );
      handle.wait().then(
        (result) => channel.end({ code: result.exitCode }),
        (error: { name?: string; exitCode?: number }) => {
          if (killed) channel.end({ code: null, killed: true });
          else if (error?.name === "CommandExitError")
            channel.end({ code: error.exitCode ?? null });
          else channel.error(translate(error));
        },
      );
      return channel;
    },

    files: {
      async read(ref, path) {
        const sandbox = await instance(ref);
        return guard(() => sandbox.read(resolvePath(WORKDIR, path)), true);
      },
      async write(ref, path, data) {
        const sandbox = await instance(ref);
        await guard(() => sandbox.write(resolvePath(WORKDIR, path), data), true);
      },
      async list(ref, path): Promise<FileEntry[]> {
        const sandbox = await instance(ref);
        const entries = await guard(() => sandbox.list(resolvePath(WORKDIR, path)), true);
        return entries
          .map(
            (entry): FileEntry => ({
              name: entry.name,
              path: entry.path,
              type: entry.type === "dir" ? "dir" : entry.type === "symlink" ? "symlink" : "file",
              size: entry.size,
            }),
          )
          .sort((a, b) => a.name.localeCompare(b.name));
      },
    },

    ports: {
      async expose(ref, port) {
        const sandbox = await instance(ref);
        return `https://${sandbox.getHost(port)}`;
      },
    },

    async snapshot(ref) {
      const sandbox = await instance(ref);
      const snapshot = await guard(() => sandbox.createSnapshot());
      return { target: id, id: snapshot.snapshotId };
    },

    async status(ref): Promise<SandboxStatus> {
      let state: SandboxStatus["state"];
      try {
        const info = await sdk.getInfo(sandboxId(ref), connection);
        state = info.state === "running" ? "running" : "sleeping";
      } catch (error) {
        const translated = translate(error);
        if (translated.code === "gone") return { state: "destroyed" };
        throw translated;
      }
      if (state !== "running") return { state };
      const metrics = await sdk.getMetrics(ref.id, connection).catch(() => []);
      const last = metrics.at(-1);
      return last
        ? { state, usage: { cpuPercent: last.cpuUsedPct, memoryBytes: last.memUsed } }
        : { state };
    },
  };
}
