import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
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
import { lookupLabels, matchesLabels } from "../../labels.js";
import { ExecChannel, resolvePath } from "../../stream.js";

// The Docker dev target backs the conformance suite and template development. It is not offered to
// users (D134). It drives the docker CLI, so it needs no SDK. Environment values pass through the
// CLI's own environment (`--env NAME`), never its argv, so they do not appear in process listings.

export const DEFAULT_IMAGE = "node:24-bookworm-slim";
const WORKDIR = "/home/user";
const LABEL = "ai.zoltbot.sandbox";
const MISSING = 44;

export interface DockerTargetOptions {
  /** Image used when a spec names no template. */
  image?: string;
  /** The docker CLI. */
  binary?: string;
  /** Value of the label put on every container and snapshot, used by `removeAll`. */
  label?: string;
}

interface Run {
  stdout: Buffer;
  stderr: string;
  code: number | null;
}

const capabilities: SandboxCapabilities = {
  snapshot: true,
  persistentVolume: true,
  maxLifetimeMs: null,
  ssh: false,
  gpu: false,
  sleepKeepsProcesses: true,
  ports: "declared",
  sizing: "per_sandbox",
};

export function createDockerTarget(options: DockerTargetOptions = {}): ExecutionTarget & {
  removeAll(): Promise<void>;
  pull(image?: string): Promise<void>;
} {
  const id = "docker";
  const binary = options.binary ?? "docker";
  const image = options.image ?? DEFAULT_IMAGE;
  const label = options.label ?? "dev";
  const declared = new Map<string, Set<number>>();

  function docker(args: string[], input?: Uint8Array | string, env?: Record<string, string>) {
    return new Promise<Run>((resolve, reject) => {
      const child = spawn(binary, args, {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, ...env },
      });
      const out: Buffer[] = [];
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
        stderr += chunk;
      });
      child.once("error", (error) => reject(new SandboxError("provider", error.message)));
      child.once("close", (code) => resolve({ stdout: Buffer.concat(out), stderr, code }));
      child.stdin.end(input ?? "");
    });
  }

  async function ok(args: string[], input?: Uint8Array | string, env?: Record<string, string>) {
    const result = await docker(args, input, env);
    if (result.code !== 0) throw failure(result.stderr);
    return result.stdout.toString("utf8").trim();
  }

  function failure(stderr: string) {
    if (/No such container|No such object/i.test(stderr))
      return new SandboxError("gone", "Sandbox does not exist");
    if (/is paused|is not running/i.test(stderr))
      return new SandboxError("not_running", "Sandbox is asleep");
    return new SandboxError("provider", `docker: ${stderr.trim().split("\n").pop() ?? "failed"}`);
  }

  function name(ref: SandboxRef) {
    if (ref.target !== id) throw new SandboxError("gone", "Sandbox does not exist");
    return ref.id;
  }

  function envFlags(values: Record<string, string> = {}) {
    for (const key of Object.keys(values))
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
        throw new SandboxError("invalid", "Invalid environment variable name");
    return Object.keys(values).flatMap((key) => ["--env", key]);
  }

  async function state(ref: SandboxRef): Promise<SandboxStatus["state"]> {
    const result = await docker(["inspect", "--format", "{{.State.Status}}", name(ref)]);
    if (result.code !== 0) {
      if (/No such object|No such container/i.test(result.stderr)) return "destroyed";
      throw failure(result.stderr);
    }
    const status = result.stdout.toString("utf8").trim();
    return status === "running" ? "running" : status === "paused" ? "sleeping" : "destroyed";
  }

  // Runs a fixed script as root-free `sh -c`; missing paths exit with MISSING.
  async function shell(
    ref: SandboxRef,
    script: string,
    args: string[],
    input?: Uint8Array | string,
  ) {
    const result = await docker(
      ["exec", "-i", "--workdir", WORKDIR, name(ref), "sh", "-c", script, "sh", ...args],
      input,
    );
    if (result.code === MISSING) throw new SandboxError("not_found", "No such file or directory");
    if (result.code !== 0) throw failure(result.stderr);
    return result.stdout;
  }

  const target = {
    id,
    capabilities,
    versions: { component: "docker-engine", tested: "unknown", range: ">=24" },
    async find(raw: Readonly<Record<string, string>>) {
      const labels = lookupLabels(raw);
      const output = await ok([
        "ps",
        "--all",
        "--filter",
        `label=${LABEL}=${label}`,
        ...Object.entries(labels).flatMap(([key, value]) => ["--filter", `label=${key}=${value}`]),
        "--format",
        "{{.Names}}",
      ]);
      const names = [...new Set(output.split("\n").filter(Boolean))];
      if (
        names.length > 256 ||
        names.some((value) => !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/.test(value))
      )
        throw new SandboxError("provider", "Invalid sandbox lookup result");
      const refs: SandboxRef[] = [];
      for (const container of names) {
        const found = await docker([
          "inspect",
          "--format",
          "{{json .Config.Labels}}|{{.State.Status}}",
          container,
        ]);
        if (found.code !== 0) {
          if (/No such object|No such container/i.test(found.stderr)) continue;
          throw failure(found.stderr);
        }
        const text = found.stdout.toString("utf8").trim(),
          split = text.lastIndexOf("|");
        let saved: Record<string, string>;
        try {
          saved = JSON.parse(text.slice(0, split));
          if (!saved || typeof saved !== "object" || Array.isArray(saved)) throw new Error();
        } catch {
          throw new SandboxError("provider", "Invalid sandbox lookup result");
        }
        if (
          ["running", "paused"].includes(text.slice(split + 1)) &&
          saved[LABEL] === label &&
          matchesLabels(labels, saved)
        )
          refs.push({ target: id, id: container, workdir: WORKDIR });
      }
      return refs.sort((a, b) => a.id.localeCompare(b.id));
    },

    async create(spec: SandboxSpec = {}) {
      if (spec.labels && Object.hasOwn(spec.labels, LABEL))
        throw new SandboxError("invalid", "Reserved sandbox label");
      const container = `zoltbot-sandbox-${randomUUID()}`;
      const ports = spec.ports ?? [];
      const args = [
        "run",
        "--detach",
        "--init",
        "--name",
        container,
        "--label",
        `${LABEL}=${label}`,
        ...Object.entries(spec.labels ?? {}).flatMap(([key, value]) => [
          "--label",
          `${key}=${value}`,
        ]),
        "--workdir",
        WORKDIR,
        "--env",
        `HOME=${WORKDIR}`,
        ...envFlags(spec.env),
        ...ports.flatMap((port) => ["--publish", `127.0.0.1::${port}`]),
        ...(spec.size
          ? ["--cpus", String(spec.size.cpus), "--memory", `${spec.size.memoryMiB}m`]
          : []),
        spec.from?.target === id ? spec.from.id : (spec.template ?? image),
        "sleep",
        "infinity",
      ];
      if (spec.from && spec.from.target !== id)
        throw new SandboxError("not_found", "Snapshot does not exist");
      const result = await docker(args, undefined, spec.env);
      if (result.code !== 0) {
        if (/No such image|Unable to find image|not found/i.test(result.stderr) && spec.from)
          throw new SandboxError("not_found", "Snapshot does not exist");
        throw failure(result.stderr);
      }
      declared.set(container, new Set(ports));
      return { target: id, id: container, workdir: WORKDIR };
    },

    async wake(ref: SandboxRef) {
      if ((await state(ref)) === "sleeping") await ok(["unpause", name(ref)]);
    },

    async sleep(ref: SandboxRef) {
      const current = await state(ref);
      if (current === "destroyed") throw new SandboxError("gone", "Sandbox does not exist");
      if (current === "running") await ok(["pause", name(ref)]);
    },

    async destroy(ref: SandboxRef) {
      const result = await docker(["rm", "--force", "--volumes", name(ref)]);
      if (result.code !== 0 && !/No such container/i.test(result.stderr))
        throw failure(result.stderr);
      declared.delete(ref.id);
    },

    async exec(ref: SandboxRef, argv: string[], options: ExecOptions = {}): Promise<ExecProcess> {
      if (!argv.length) throw new SandboxError("invalid", "Empty command");
      const current = await state(ref);
      if (current === "destroyed") throw new SandboxError("gone", "Sandbox does not exist");
      if (current === "sleeping") throw new SandboxError("not_running", "Sandbox is asleep");
      // Killing the docker client does not stop the process in the container, so the wrapper
      // records its pid and `kill()` signals it inside the container.
      const marker = `/tmp/.zoltbot-exec-${randomUUID()}`;
      const child = spawn(
        binary,
        [
          "exec",
          "--workdir",
          resolvePath(WORKDIR, options.cwd ?? WORKDIR),
          ...envFlags(options.env),
          name(ref),
          "sh",
          "-c",
          'echo $$ > "$0"; exec "$@"',
          marker,
          ...argv,
        ],
        { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...options.env } },
      );
      let killed = false;
      const channel = new ExecChannel(async () => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        killed = true;
        await docker([
          "exec",
          name(ref),
          "sh",
          "-c",
          'kill -KILL "$(cat "$0")" 2>/dev/null; rm -f "$0"',
          marker,
        ]);
      });
      child.stdout.setEncoding("utf8").on("data", (data: string) => channel.push("stdout", data));
      child.stderr.setEncoding("utf8").on("data", (data: string) => channel.push("stderr", data));
      child.once("error", (error) => channel.error(new SandboxError("provider", error.message)));
      child.once("close", (code) => {
        channel.end({ code: killed ? null : code, ...(killed ? { killed: true } : {}) });
        void docker(["exec", name(ref), "rm", "-f", marker]);
      });
      return channel;
    },

    files: {
      async read(ref: SandboxRef, file: string) {
        const bytes = await shell(ref, `test -f "$1" || exit ${MISSING}; cat -- "$1"`, [file]);
        return new Uint8Array(bytes);
      },
      async write(ref: SandboxRef, file: string, data: Uint8Array | string) {
        await shell(ref, 'mkdir -p -- "$(dirname -- "$1")" && cat > "$1"', [file], data);
      },
      async list(ref: SandboxRef, dir: string): Promise<FileEntry[]> {
        const folder = resolvePath(WORKDIR, dir).replace(/\/+$/, "") || "/";
        const output = await shell(
          ref,
          `test -d "$1" || exit ${MISSING}; find "$1" -mindepth 1 -maxdepth 1 -printf '%y\\t%s\\t%f\\0'`,
          [folder],
        );
        return output
          .toString("utf8")
          .split("\0")
          .filter(Boolean)
          .map((line) => {
            const [kind, size, ...rest] = line.split("\t");
            const entryName = rest.join("\t");
            return {
              name: entryName,
              path: `${folder === "/" ? "" : folder}/${entryName}`,
              type: kind === "d" ? "dir" : kind === "l" ? "symlink" : "file",
              size: Number(size),
            } satisfies FileEntry;
          })
          .sort((a, b) => a.name.localeCompare(b.name));
      },
    },

    ports: {
      async expose(ref: SandboxRef, port: number) {
        if (!declared.get(name(ref))?.has(port))
          throw new SandboxError(
            "unsupported",
            "Port was not declared when the sandbox was created",
          );
        const mapping = (await ok(["port", name(ref), `${port}/tcp`])).split("\n")[0] ?? "";
        const host = mapping.slice(mapping.lastIndexOf(":") + 1);
        return `http://127.0.0.1:${host}`;
      },
    },

    async snapshot(ref: SandboxRef) {
      const image = await ok(["commit", "--change", `LABEL ${LABEL}=${label}`, name(ref)]);
      return { target: id, id: image };
    },

    async status(ref: SandboxRef): Promise<SandboxStatus> {
      return { state: await state(ref) };
    },

    /** Pulls the default image ahead of time so the first create is not slowed by a download. */
    async pull(name = image) {
      await ok(["pull", "--quiet", name]);
    },

    /** Removes every container and snapshot image carrying this target's label. */
    async removeAll() {
      const filter = `label=${LABEL}=${label}`;
      const containers = (await ok(["ps", "--all", "--quiet", "--filter", filter])).split("\n");
      if (containers.some(Boolean)) await docker(["rm", "--force", ...containers.filter(Boolean)]);
      const images = (await ok(["images", "--quiet", "--filter", filter])).split("\n");
      if (images.some(Boolean)) await docker(["rmi", "--force", ...images.filter(Boolean)]);
      declared.clear();
    },
  };
  return target;
}

/** True when a docker daemon answers. Used to decide whether the Docker suite can run. */
export async function dockerAvailable(binary = "docker"): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(binary, ["version", "--format", "{{.Server.Version}}"], {
      stdio: "ignore",
    });
    const timer = setTimeout(() => {
      child.kill();
      resolve(false);
    }, 10_000);
    child.once("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
  });
}
