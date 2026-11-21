// R5: where a running daemon listens. The desktop and the zolt command read the same receipt in
// the data folder, so neither needs a secret of its own.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DaemonConnectionInfo } from "./client.js";

/** The packaged app's data folder, or ZOLTBOT_DATA_DIR when set. */
export function defaultDataDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.ZOLTBOT_DATA_DIR ?? join(homedir(), "Library/Application Support/Zoltbot");
}

function alive(pid: unknown): boolean {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    // EPERM means another user's process has the pid now, so it isn't our daemon.
    return false;
  }
}

/** The running daemon's address and token, or undefined when none is running. Local only. */
export function readConnection(dataDir: string): DaemonConnectionInfo | undefined {
  let info: { url?: unknown; token?: unknown; pid?: unknown };
  try {
    info = JSON.parse(readFileSync(join(dataDir, "daemon.json"), "utf8"));
  } catch {
    return undefined;
  }
  if (typeof info.url !== "string" || typeof info.token !== "string" || !alive(info.pid))
    return undefined;
  try {
    if (new URL(info.url).hostname !== "127.0.0.1") return undefined;
  } catch {
    return undefined;
  }
  return { url: info.url, token: info.token };
}
