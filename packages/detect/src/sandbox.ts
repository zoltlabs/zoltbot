import { access, lstat, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import path from "node:path";
import type { ProbeSandbox } from "./probe.js";
import { type CommandRunner, runCommand } from "./process.js";

const request = `${JSON.stringify({ jsonrpc: "2.0", id: "zoltbot-probe", method: "initialize", params: { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "zoltbot", version: "0.1.0" } } })}\n`;
function response(stdout: string): unknown {
  for (const line of stdout.split("\n")) {
    try {
      const value = JSON.parse(line);
      if (value?.jsonrpc === "2.0" && value.id === "zoltbot-probe" && value.result && !value.error)
        return value.result;
    } catch {
      /* Ignore incomplete frames. */
    }
  }
}
function literal(value: string) {
  if (/[\0\n\r]/.test(value)) throw new Error("invalid_sandbox_path");
  return JSON.stringify(value);
}
export function macProbeSandbox(options: {
  dataDir: string;
  paths: string[];
  runtimeReadRoots?: string[];
  runtimeReadFiles?: string[];
  runner?: CommandRunner;
  platform?: NodeJS.Platform;
}): ProbeSandbox {
  return {
    async initialize(argv) {
      if ((options.platform ?? process.platform) !== "darwin")
        throw new Error("probe_sandbox_unavailable");
      const executable = await resolveExecutable(argv[0] ?? "", options.paths);
      if (!executable) throw new Error("probe_binary_not_found");
      const root = path.join(await realpath(options.dataDir), "probes");
      await mkdir(root, { recursive: true, mode: 0o700 });
      if ((await lstat(root)).isSymbolicLink() || (await realpath(root)) !== root)
        throw new Error("unsafe_probe_directory");
      const temporary = await mkdtemp(path.join(root, "acp-"));
      try {
        const home = path.join(temporary, "home"),
          cwd = path.join(temporary, "workspace");
        await mkdir(home);
        await mkdir(cwd);
        const reads = [
          "/usr",
          "/bin",
          "/sbin",
          "/System",
          "/private/var/db/dyld",
          "/Library/Apple",
          "/opt/homebrew",
          ...(options.runtimeReadRoots ?? []),
        ];
        const profile = [
          "(version 1)",
          "(deny default)",
          "(allow process*)",
          "(allow file-map-executable)",
          "(allow sysctl-read)",
          "(allow file-read-metadata)",
          "(allow mach-lookup)",
          `(allow file-read* (literal "/") (literal ${literal(executable)}) ${(options.runtimeReadFiles ?? []).map((file) => `(literal ${literal(file)})`).join(" ")} (subpath ${literal(temporary)}) ${reads.map((item) => `(subpath ${literal(item)})`).join(" ")} (subpath "/dev"))`,
          `(allow file-write* (subpath ${literal(temporary)}) (literal "/dev/null"))`,
        ].join("\n");
        const result = await (options.runner ?? runCommand)(
          "/usr/bin/sandbox-exec",
          ["-p", profile, executable, ...argv.slice(1)],
          {
            cwd,
            inherited: {},
            env: {
              HOME: home,
              PATH: options.paths.join(path.delimiter),
              TMPDIR: temporary,
              XDG_CONFIG_HOME: path.join(home, ".config"),
              XDG_CACHE_HOME: path.join(home, ".cache"),
              XDG_DATA_HOME: path.join(home, ".local/share"),
              XDG_STATE_HOME: path.join(home, ".local/state"),
            },
            timeoutMs: 10000,
            maxOutputBytes: 262144,
            input: request,
            stopWhen: (text) => response(text) !== undefined,
          },
        );
        if (result.failure) throw new Error("probe_failed");
        const value = response(result.stdout);
        if (!value) throw new Error("not_an_acp_agent");
        return value;
      } finally {
        await rm(temporary, { recursive: true, force: true });
      }
    },
  };
}
export async function resolveExecutable(command: string, paths: string[]) {
  const candidates = path.isAbsolute(command)
    ? [command]
    : paths.map((directory) => path.join(directory, command));
  for (const candidate of candidates) {
    if (!path.isAbsolute(candidate)) continue;
    try {
      await access(candidate, 1);
      if ((await lstat(candidate)).isDirectory()) continue;
      return await realpath(candidate);
    } catch {
      /* Try the next install. */
    }
  }
}
