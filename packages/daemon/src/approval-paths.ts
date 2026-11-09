import { lstatSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

function resolveTarget(target: string): string | undefined {
  let current = target;
  const missing: string[] = [];
  for (let depth = 0; depth < 256; depth++) {
    try {
      lstatSync(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return undefined;
      const parent = path.dirname(current);
      if (parent === current) return undefined;
      missing.unshift(path.basename(current));
      current = parent;
      continue;
    }
    // An existing dangling symlink must not be treated as a missing ordinary directory.
    try {
      const actual = realpathSync(current);
      if (missing.length && !statSync(actual).isDirectory()) return undefined;
      return path.join(actual, ...missing);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export interface ApprovalRoot {
  path: string;
  device: bigint;
  inode: bigint;
}

export function canonicalApprovalRoot(cwd: string): ApprovalRoot | undefined {
  if (!path.isAbsolute(cwd)) return undefined;
  try {
    const root = realpathSync(cwd);
    const info = statSync(root, { bigint: true });
    return info.isDirectory() ? { path: root, device: info.dev, inode: info.ino } : undefined;
  } catch {
    return undefined;
  }
}

/** Read-only approval evidence at decision time. Execution still uses the native filesystem policy. */
export function approvalPaths(cwd: string, targets: readonly string[]): string[] | undefined {
  if (!targets.length || targets.length > 100) return undefined;
  const root = canonicalApprovalRoot(cwd)?.path;
  if (!root) return undefined;
  const result: string[] = [];
  for (const target of targets) {
    if (
      !target ||
      target.length > 4096 ||
      target.includes("\0") ||
      target.includes("\\") ||
      target.split(path.sep).includes("..")
    )
      return undefined;
    const actual = resolveTarget(path.isAbsolute(target) ? target : `${root}${path.sep}${target}`);
    if (!actual) return undefined;
    const relative = path.relative(root, actual);
    if (
      !relative ||
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    )
      return undefined;
    result.push(relative.split(path.sep).join("/"));
  }
  return result;
}
