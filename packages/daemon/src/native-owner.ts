import path from "node:path";
import { type CommandRunner, runCommand } from "@zoltbot/detect";

export type NativeOwner =
  | { state: "clear"; pids: number[] }
  | { state: "busy" | "unknown"; pids: number[]; recommendation: "fork" };

/** An open file is conservative evidence of possible ownership, not proof of a write. */
export async function inspectNativeOwner(
  file: string,
  options: {
    platform?: NodeJS.Platform;
    ownedPids?: readonly number[];
    runner?: CommandRunner;
  } = {},
): Promise<NativeOwner> {
  const unknown: NativeOwner = { state: "unknown", pids: [], recommendation: "fork" };
  if (
    (options.platform ?? process.platform) !== "darwin" ||
    !path.isAbsolute(file) ||
    /[\0\n\r]/.test(file)
  )
    return unknown;
  try {
    const result = await (options.runner ?? runCommand)(
      "/usr/sbin/lsof",
      ["-t", "-n", "-P", "--", file],
      {
        cwd: path.dirname(file),
        inherited: {},
        timeoutMs: 2000,
        maxOutputBytes: 16384,
      },
    );
    if (result.failure || (result.code !== 0 && result.code !== 1) || result.stderr.trim())
      return unknown;
    const lines = result.stdout.trim() ? result.stdout.trim().split(/\s+/) : [];
    if (
      lines.length > 1024 ||
      lines.some((line) => !/^[1-9][0-9]*$/.test(line) || !Number.isSafeInteger(Number(line)))
    )
      return unknown;
    const owned = new Set(options.ownedPids ?? []);
    const pids = [...new Set(lines.map(Number))]
      .filter((pid) => !owned.has(pid))
      .sort((a, b) => a - b);
    return pids.length
      ? { state: "busy", pids, recommendation: "fork" }
      : { state: "clear", pids: [] };
  } catch {
    return unknown;
  }
}
