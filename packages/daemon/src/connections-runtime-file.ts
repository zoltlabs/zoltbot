import { randomUUID } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { RuntimeFile } from "./runtime-files.js";

export function manifestDirectory(root: string, manifestId: string) {
  if (!/^[a-f0-9]{64}$/.test(manifestId)) throw new Error("invalid_launch_manifest_id");
  return path.join(root, `launch-${manifestId}`);
}
/** Deterministic, private and atomically re-materialized after a daemon crash. */
export function manifestRuntimeFile(
  root: string,
  manifestId: string,
  content: string,
): RuntimeFile {
  const directory = manifestDirectory(root, manifestId);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  if (lstatSync(root).isSymbolicLink()) throw new Error("runtime_directory_unsafe");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (lstatSync(directory).isSymbolicLink() || !lstatSync(directory).isDirectory())
    throw new Error("runtime_directory_unsafe");
  chmodSync(directory, 0o700);
  const target = path.join(directory, "config.json");
  const targetStat = lstatSync(target, { throwIfNoEntry: false });
  if (targetStat && (!targetStat.isFile() || targetStat.isSymbolicLink()))
    throw new Error("runtime_config_unsafe");
  const temporary = path.join(directory, `replacement-${randomUUID()}`);
  try {
    writeFileSync(temporary, content, { flag: "wx", mode: 0o600 });
    renameSync(temporary, target);
  } finally {
    rmSync(temporary, { force: true });
  }
  return {
    path: target,
    dispose: async () => {
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
