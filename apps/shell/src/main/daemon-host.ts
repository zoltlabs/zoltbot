import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Logger, Redactor } from "@zoltbot/daemon/logging";
import { Supervisor } from "@zoltbot/daemon/supervisor";
import WebSocket from "ws";
import type { DaemonConnectionInfo } from "../zolt/daemon-client";
import { newerVersion } from "./updater";

/** The protocol this app speaks. */
export const PROTOCOL_VERSION = 1;

/**
 * D3: whether to attach to a running daemon or replace it. After an update the app is newer
 * than the daemon the old app left running: an older protocol, or an older app version, means
 * the daemon must restart into the bundled one. A daemon that refuses the hello is left alone.
 */
export function attachDecision(
  reply: { result?: { protocolVersion?: unknown; version?: unknown }; error?: unknown },
  app: { protocolVersion: number; version: string | undefined },
): "attach" | "replace" | "refused" {
  if (reply.error || !reply.result) return "refused";
  const { protocolVersion, version } = reply.result;
  if (typeof protocolVersion !== "number" || protocolVersion < app.protocolVersion)
    return "replace";
  // A daemon with no version came from a dev build or another launcher: leave it be.
  if (app.version && typeof version === "string" && version && newerVersion(app.version, version))
    return "replace";
  return "attach";
}

export interface DaemonPaths {
  root: string;
  dataDir: string;
  entry: string;
  packaged: boolean;
}

/**
 * Where the shell finds the daemon. It shares the data folder with the current desktop app,
 * so both attach to the same daemon and the same chats.
 */
export function daemonPaths(packaged: boolean, appPath: string): DaemonPaths {
  const root = process.env.ZOLTBOT_REPO_ROOT ?? (packaged ? appPath : resolve(appPath, "../.."));
  const dataDir =
    process.env.ZOLTBOT_DATA_DIR ??
    (packaged
      ? join(homedir(), "Library/Application Support/Zoltbot")
      : join(root, ".cache/desktop-data"));
  const entry =
    process.env.ZOLTBOT_DAEMON_ENTRY ??
    (packaged ? join(root, "daemon.mjs") : join(root, ".cache/desktop/daemon.mjs"));
  return { root, dataDir, entry, packaged };
}

/** Starts the daemon, or attaches to one another Zoltbot window already started. */
export class DaemonHost {
  private readonly supervisor: Supervisor;
  private attachedPid: number | undefined;

  /**
   * `env` adds settings for a daemon this window starts, such as the hosted service origins.
   * `appVersion` is passed to the daemon and compared with a running one's (D3).
   */
  constructor(
    private readonly paths: DaemonPaths,
    env: Record<string, string> = {},
    private readonly appVersion?: string,
  ) {
    mkdirSync(paths.dataDir, { recursive: true, mode: 0o700 });
    const logger = new Logger(join(paths.dataDir, "shell.log"), new Redactor());
    this.supervisor = new Supervisor(
      {
        // A packaged app carries its own Node and native helpers in bin/.
        command:
          process.env.ZOLTBOT_NODE_BINARY ??
          (paths.packaged ? join(paths.root, "bin/node") : "node"),
        args: [paths.entry],
        surviveParentExit: true,
        cwd: paths.root,
        env: {
          ...env,
          ...(appVersion ? { ZOLTBOT_APP_VERSION: appVersion } : {}),
          ZOLTBOT_DATA_DIR: resolve(paths.dataDir),
          ...(process.env.ZOLTBOT_KEYCHAIN_HELPER
            ? { ZOLTBOT_KEYCHAIN_HELPER: process.env.ZOLTBOT_KEYCHAIN_HELPER }
            : paths.packaged
              ? { ZOLTBOT_KEYCHAIN_HELPER: join(paths.root, "bin/zoltbot-keychain") }
              : {}),
          TSX_DISABLE_CACHE: "1",
        },
        frameFile: join(paths.dataDir, "shell-supervisor-frames.jsonl"),
      },
      logger,
    );
  }

  connection = async (): Promise<DaemonConnectionInfo> => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const info = this.read();
      if (info && alive(info.pid) && new URL(info.url).hostname === "127.0.0.1")
        return { url: info.url, token: info.token };
      await new Promise((done) => setTimeout(done, 100));
    }
    throw new Error("Zoltbot's background service didn't start.");
  };

  async start(): Promise<void> {
    const running = await this.findRunning();
    if (running?.decision === "attach") {
      this.attachedPid = running.pid;
      return;
    }
    // An older daemon from before an update: stop it so the bundled one takes over the data.
    // Its running turns end as interrupted, as after any daemon restart.
    if (running?.decision === "replace") await stopProcess(running.pid);
    if (!existsSync(this.paths.entry))
      throw new Error(
        `Zoltbot's background service isn't built. Run "pnpm build:desktop" first (${this.paths.entry}).`,
      );
    this.supervisor.start();
  }

  /** Stops only a daemon this window started; one another app started keeps running. */
  async stop(force = false): Promise<void> {
    // D6: Start fresh stops a daemon another window started too.
    if (this.attachedPid) {
      if (force) await stopProcess(this.attachedPid);
      return;
    }
    await this.supervisor.close();
  }

  private read(): { url: string; token: string; pid: number } | undefined {
    try {
      return JSON.parse(readFileSync(join(this.paths.dataDir, "daemon.json"), "utf8"));
    } catch {
      return undefined;
    }
  }

  private async findRunning(): Promise<
    { pid: number; decision: "attach" | "replace" | "refused" } | undefined
  > {
    const info = this.read();
    if (!info || !alive(info.pid) || new URL(info.url).hostname !== "127.0.0.1") return undefined;
    return new Promise((done) => {
      const socket = new WebSocket(info.url);
      const timer = setTimeout(() => {
        socket.terminate();
        done(undefined);
      }, 1000);
      socket.on("open", () =>
        socket.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "hello",
            params: { token: info.token, protocolVersion: PROTOCOL_VERSION },
          }),
        ),
      );
      socket.on("message", (data) => {
        clearTimeout(timer);
        const reply = JSON.parse(String(data));
        socket.close();
        const decision = attachDecision(reply, {
          protocolVersion: PROTOCOL_VERSION,
          version: this.appVersion,
        });
        done(decision === "refused" ? undefined : { pid: info.pid, decision });
      });
      socket.on("error", () => {
        clearTimeout(timer);
        done(undefined);
      });
    });
  }
}

/** Asks a process to stop, waits up to 5 seconds, then ends it, so two never share the data. */
async function stopProcess(pid: number): Promise<void> {
  const gone = async (tries: number) => {
    for (let attempt = 0; attempt < tries && alive(pid); attempt++)
      await new Promise((done) => setTimeout(done, 100));
    return !alive(pid);
  };
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }
  if (await gone(50)) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    return;
  }
  if (!(await gone(20))) throw new Error("Zoltbot's old background service didn't stop.");
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
