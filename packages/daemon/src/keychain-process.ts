import { spawn } from "node:child_process";
import type { KeychainTransport } from "./secrets.js";

/** A private one shot channel. Never use the frame logging supervisor for secret payloads. */
export function keychainProcess(options: {
  command: string;
  args?: readonly string[];
  cwd: string;
  timeoutMs?: number;
}): KeychainTransport {
  return async (request) => {
    try {
      const input = JSON.stringify(request);
      if (Buffer.byteLength(input) > 65536) throw new Error("keychain_unavailable");
      return await new Promise<unknown>((resolve, reject) => {
        const child = spawn(options.command, [...(options.args ?? [])], {
          cwd: options.cwd,
          env: { PATH: "/usr/bin:/bin", LANG: "en_US.UTF-8" },
          stdio: ["pipe", "pipe", "pipe"],
          detached: true,
          shell: false,
        });
        let failed = false,
          size = 0;
        let killTimer: ReturnType<typeof setTimeout> | undefined;
        const output: Buffer[] = [];
        const kill = (signal: NodeJS.Signals) => {
          if (!child.pid) return;
          try {
            process.kill(-child.pid, signal);
          } catch {
            child.kill(signal);
          }
        };
        const fail = () => {
          if (failed) return;
          failed = true;
          kill("SIGTERM");
          killTimer = setTimeout(() => kill("SIGKILL"), 500);
        };
        const timer = setTimeout(fail, options.timeoutMs ?? 5000);
        child.on("error", fail);
        child.stdin.on("error", fail);
        child.stdout.on("data", (chunk: Buffer) => {
          size += chunk.byteLength;
          if (size > 65536) fail();
          else if (!failed) output.push(chunk);
        });
        child.stderr.on("data", (chunk: Buffer) => {
          size += chunk.byteLength;
          if (size > 65536) fail();
        });
        child.once("close", (code) => {
          clearTimeout(timer);
          clearTimeout(killTimer);
          if (failed || code !== 0) {
            reject(new Error("keychain_unavailable"));
            return;
          }
          try {
            resolve(JSON.parse(Buffer.concat(output).toString("utf8")));
          } catch {
            reject(new Error("keychain_unavailable"));
          }
        });
        child.stdin.end(input);
      });
    } catch {
      throw new Error("keychain_unavailable");
    }
  };
}
