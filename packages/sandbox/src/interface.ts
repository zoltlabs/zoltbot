// The execution target interface (docs/cloud/sandboxes.md §2). Everything outside a target works on
// these types and the declared capabilities; provider names stay inside src/targets/* (I4).

export interface SandboxSize {
  cpus: number;
  memoryMiB: number;
}

export interface SandboxSpec {
  /** Target-specific template or image. The target's default when omitted. */
  template?: string;
  /** Start from a snapshot taken by the same target instead of a template. */
  from?: SnapshotRef;
  /** Only for targets whose capabilities declare `sizing: "per_sandbox"`. */
  size?: SandboxSize;
  /** Environment for every process in the sandbox. Values are never logged (I7). */
  env?: Record<string, string>;
  /** Ports to make exposable. Required up front by targets that declare `ports: "declared"`. */
  ports?: number[];
  labels?: Record<string, string>;
}

export interface SandboxRef {
  target: string;
  id: string;
  /** Home and default working directory. Relative paths resolve against it. */
  workdir: string;
}

export interface SnapshotRef {
  target: string;
  id: string;
}

export type SandboxState = "running" | "sleeping" | "destroyed";

export interface SandboxUsage {
  cpuPercent?: number;
  memoryBytes?: number;
}

export interface SandboxStatus {
  state: SandboxState;
  usage?: SandboxUsage;
}

export interface ExecOptions {
  cwd?: string;
  env?: Record<string, string>;
}

export interface ExecChunk {
  stream: "stdout" | "stderr";
  data: string;
}

export interface ExecExit {
  /** Exit status, or null when the process ended by a signal. */
  code: number | null;
  /** Set when the process was ended by `kill()`. */
  killed?: boolean;
}

/** A running process. Iterate it for output; `exit` settles after the last chunk. */
export interface ExecProcess extends AsyncIterable<ExecChunk> {
  readonly exit: Promise<ExecExit>;
  kill(): Promise<void>;
}

export interface FileEntry {
  name: string;
  path: string;
  type: "file" | "dir" | "symlink";
  size: number;
}

export interface SandboxCapabilities {
  snapshot: boolean;
  persistentVolume: boolean;
  /** Longest a sandbox may run before it must be snapshotted and recreated; null when unbounded. */
  maxLifetimeMs: number | null;
  ssh: boolean;
  gpu: boolean;
  /** Sleep keeps memory and processes (pause and resume) rather than only files. */
  sleepKeepsProcesses: boolean;
  /** "declared": only ports listed in the spec at create can be exposed. */
  ports: "any" | "declared";
  /** "template": size comes from the template and `spec.size` is rejected. */
  sizing: "per_sandbox" | "template";
}

export interface TargetVersions {
  /** What the target drives: an SDK package, a CLI, or nothing for the fake. */
  component: string;
  /** Version the conformance suite last ran against. */
  tested: string;
  /** Semver range the target is declared to support. */
  range: string;
}

export interface ExecutionTarget {
  readonly id: string;
  readonly capabilities: SandboxCapabilities;
  readonly versions: TargetVersions;
  create(spec?: SandboxSpec): Promise<SandboxRef>;
  /** Find live or sleeping resources by every supplied label, without waking them. */
  find(labels: Readonly<Record<string, string>>): Promise<SandboxRef[]>;
  wake(ref: SandboxRef): Promise<void>;
  sleep(ref: SandboxRef): Promise<void>;
  destroy(ref: SandboxRef): Promise<void>;
  exec(ref: SandboxRef, argv: string[], options?: ExecOptions): Promise<ExecProcess>;
  files: {
    read(ref: SandboxRef, path: string): Promise<Uint8Array>;
    write(ref: SandboxRef, path: string, data: Uint8Array | string): Promise<void>;
    list(ref: SandboxRef, path: string): Promise<FileEntry[]>;
  };
  ports: {
    expose(ref: SandboxRef, port: number): Promise<string>;
  };
  snapshot(ref: SandboxRef): Promise<SnapshotRef>;
  status(ref: SandboxRef): Promise<SandboxStatus>;
}

export type SandboxErrorCode =
  | "not_found"
  | "gone"
  | "not_running"
  | "unsupported"
  | "invalid"
  | "provider";

export class SandboxError extends Error {
  constructor(
    readonly code: SandboxErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SandboxError";
  }
}
