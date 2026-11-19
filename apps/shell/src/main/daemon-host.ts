import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Logger, Redactor } from "@zoltbot/daemon/logging";
import { Supervisor } from "@zoltbot/daemon/supervisor";
import WebSocket from "ws";
import type { DaemonConnectionInfo } from "../zolt/daemon-client";

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

  /** `env` adds settings for a daemon this window starts, such as the hosted service origins. */
  constructor(
    private readonly paths: DaemonPaths,
    env: Record<string, string> = {},
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
    this.attachedPid = await this.findRunning();
    if (this.attachedPid) return;
    if (!existsSync(this.paths.entry))
      throw new Error(
        `Zoltbot's background service isn't built. Run "pnpm build:desktop" first (${this.paths.entry}).`,
      );
    this.supervisor.start();
  }

  /** Stops only a daemon this window started; one another app started keeps running. */
  async stop(): Promise<void> {
    if (this.attachedPid) return;
    await this.supervisor.close();
  }

  private read(): { url: string; token: string; pid: number } | undefined {
    try {
      return JSON.parse(readFileSync(join(this.paths.dataDir, "daemon.json"), "utf8"));
    } catch {
      return undefined;
    }
  }

  private async findRunning(): Promise<number | undefined> {
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
            params: { token: info.token, protocolVersion: 1 },
          }),
        ),
      );
      socket.on("message", (data) => {
        clearTimeout(timer);
        const reply = JSON.parse(String(data));
        socket.close();
        done(reply.error ? undefined : info.pid);
      });
      socket.on("error", () => {
        clearTimeout(timer);
        done(undefined);
      });
    });
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
