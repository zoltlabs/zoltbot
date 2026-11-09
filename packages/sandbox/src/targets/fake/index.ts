import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  cp,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
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
  type SnapshotRef,
} from "../../interface.js";
import { ExecChannel } from "../../stream.js";

// The fake target: each sandbox is a private folder on this machine and its processes run in their
// own process group with a clean environment. Sleep stops the group and wake continues it, so the
// fake keeps processes across sleep like a pause-capable target. Nothing reaches the network.

export interface FakeTargetOptions {
  /** Folder that holds sandboxes and snapshots. Defaults to a folder in the OS temp directory. */
  root?: string;
  capabilities?: Partial<SandboxCapabilities>;
}

interface FakeSandbox {
  root: string;
  env: Record<string, string>;
  state: "running" | "sleeping";
  groups: Set<number>;
}

const capabilities: SandboxCapabilities = {
  snapshot: true,
  persistentVolume: true,
  maxLifetimeMs: null,
  ssh: false,
  gpu: false,
  sleepKeepsProcesses: true,
  ports: "any",
  sizing: "per_sandbox",
};

export function createFakeTarget(options: FakeTargetOptions = {}): ExecutionTarget & {
  dispose(): Promise<void>;
} {
  const base = path.resolve(options.root ?? path.join(tmpdir(), "zoltbot-sandbox-fake"));
  const sandboxes = new Map<string, FakeSandbox>();
  const snapshots = new Map<string, string>();
  const id = "fake";

  function get(ref: SandboxRef, running = true): FakeSandbox {
    const box = ref.target === id ? sandboxes.get(ref.id) : undefined;
    if (!box) throw new SandboxError("gone", "Sandbox does not exist");
    if (running && box.state !== "running")
      throw new SandboxError("not_running", "Sandbox is asleep");
    return box;
  }

  function inside(box: FakeSandbox, file: string): string {
    const resolved = path.resolve(box.root, file);
    if (resolved !== box.root && !resolved.startsWith(`${box.root}${path.sep}`))
      throw new SandboxError("invalid", "Path is outside the sandbox");
    return resolved;
  }

  function signal(box: FakeSandbox, name: NodeJS.Signals) {
    for (const group of box.groups) {
      try {
        process.kill(-group, name);
      } catch {
        box.groups.delete(group);
      }
    }
  }

  async function missing<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        throw new SandboxError("not_found", "No such file or directory");
      throw error;
    }
  }

  const target: ExecutionTarget & { dispose(): Promise<void> } = {
    id,
    capabilities: { ...capabilities, ...options.capabilities },
    versions: { component: "none", tested: "0.0.0", range: "*" },

    async create(spec: SandboxSpec = {}) {
      if (spec.from && !snapshots.has(spec.from.id))
        throw new SandboxError("not_found", "Snapshot does not exist");
      const sandboxId = randomUUID();
      const from = spec.from && snapshots.get(spec.from.id);
      const folder = path.join(base, "sandboxes", sandboxId);
      if (from) await cp(from, folder, { recursive: true });
      else await mkdir(folder, { recursive: true });
      // Real path, so `pwd` inside the sandbox matches the workdir (macOS temp is a symlink).
      const root = await realpath(folder);
      sandboxes.set(sandboxId, {
        root,
        env: { ...spec.env },
        state: "running",
        groups: new Set(),
      });
      return { target: id, id: sandboxId, workdir: root };
    },

    async wake(ref) {
      const box = get(ref, false);
      if (box.state === "running") return;
      signal(box, "SIGCONT");
      box.state = "running";
    },

    async sleep(ref) {
      const box = get(ref, false);
      if (box.state === "sleeping") return;
      signal(box, "SIGSTOP");
      box.state = "sleeping";
    },

    async destroy(ref) {
      const box = ref.target === id ? sandboxes.get(ref.id) : undefined;
      if (!box) return;
      signal(box, "SIGKILL");
      sandboxes.delete(ref.id);
      await rm(box.root, { recursive: true, force: true });
    },

    async exec(ref, argv, options: ExecOptions = {}): Promise<ExecProcess> {
      const box = get(ref);
      const [command, ...args] = argv;
      if (!command) throw new SandboxError("invalid", "Empty command");
      const cwd = inside(box, options.cwd ?? box.root);
      let child: ChildProcess | undefined;
      let killed = false;
      const channel = new ExecChannel(async () => {
        if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
        killed = true;
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          // Already gone.
        }
      });
      child = spawn(command, args, {
        cwd,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          HOME: box.root,
          LANG: "C.UTF-8",
          ...box.env,
          ...options.env,
        },
      });
      const group = child.pid;
      if (group) box.groups.add(group);
      child.stdout?.setEncoding("utf8").on("data", (data: string) => channel.push("stdout", data));
      child.stderr?.setEncoding("utf8").on("data", (data: string) => channel.push("stderr", data));
      child.once("error", (error: NodeJS.ErrnoException) => {
        // Match a shell: a missing command exits 127.
        if (error.code !== "ENOENT")
          return channel.error(new SandboxError("provider", error.message));
        if (group) box.groups.delete(group);
        channel.push("stderr", `${command}: not found\n`);
        channel.end({ code: 127 });
      });
      // The group stays tracked after close: background children keep it alive.
      child.once("close", (code) => {
        channel.end({ code, ...(killed ? { killed: true } : {}) });
      });
      return channel;
    },

    files: {
      async read(ref, file) {
        const box = get(ref);
        return new Uint8Array(await missing(() => readFile(inside(box, file))));
      },
      async write(ref, file, data) {
        const box = get(ref);
        const target = inside(box, file);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, data);
      },
      async list(ref, dir): Promise<FileEntry[]> {
        const box = get(ref);
        const folder = inside(box, dir);
        if (!(await missing(() => stat(folder))).isDirectory())
          throw new SandboxError("not_found", "Not a directory");
        const entries = await readdir(folder);
        return Promise.all(
          entries.sort().map(async (name) => {
            const full = path.join(folder, name);
            const info = await lstat(full);
            return {
              name,
              path: full,
              type: info.isSymbolicLink() ? "symlink" : info.isDirectory() ? "dir" : "file",
              size: info.size,
            } satisfies FileEntry;
          }),
        );
      },
    },

    ports: {
      async expose(ref, port) {
        get(ref);
        return `http://127.0.0.1:${port}`;
      },
    },

    async snapshot(ref): Promise<SnapshotRef> {
      const box = get(ref, false);
      const snapshotId = randomUUID();
      const folder = path.join(base, "snapshots", snapshotId);
      await cp(box.root, folder, { recursive: true });
      snapshots.set(snapshotId, folder);
      return { target: id, id: snapshotId };
    },

    async status(ref): Promise<SandboxStatus> {
      const box = ref.target === id ? sandboxes.get(ref.id) : undefined;
      return { state: box ? box.state : "destroyed" };
    },

    async dispose() {
      for (const [sandboxId, box] of sandboxes)
        await target.destroy({ target: id, id: sandboxId, workdir: box.root });
      for (const folder of snapshots.values()) await rm(folder, { recursive: true, force: true });
      snapshots.clear();
    },
  };
  return target;
}
