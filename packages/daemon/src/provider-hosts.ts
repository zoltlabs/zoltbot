import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { AcpAdapter } from "@zoltbot/adapters-acp";
import { ClaudeAdapter } from "@zoltbot/adapters-claude";
import { CodexAdapter } from "@zoltbot/adapters-codex";
import type { AgentAdapter } from "@zoltbot/adapters-sdk";
import {
  type CommandRunner,
  checkLogin,
  discoverBinaries,
  knownDirectories,
  LoginPath,
  runCommand,
  versionFromOutput,
} from "@zoltbot/detect";
import type { AgentDefinition } from "@zoltbot/protocol";
import type { Redactor } from "./logging.js";
import { NativeProcesses } from "./native-processes.js";
import { RuntimeFiles } from "./runtime-files.js";

/** Production launch ports. Provider protocol and launch flags remain in adapters. */
export function providerHosts(options: {
  directory: string;
  home?: string;
  inherited?: NodeJS.ProcessEnv;
  paths?(): Promise<string[]>;
  resolve?(definition: AgentDefinition): Promise<string>;
  overrides?(): Record<string, string>;
  run?: CommandRunner;
}) {
  const processes = new NativeProcesses(path.join(options.directory, "logs/native")),
    files = new RuntimeFiles(path.join(options.directory, "private-runtime")),
    loginPath = new LoginPath(),
    run = options.run ?? runCommand;
  const paths =
    options.paths ??
    (() =>
      loginPath.resolve(process.env.SHELL ?? "/bin/zsh", {
        cwd: options.directory,
        inherited: { HOME: homedir(), PATH: process.env.PATH },
      }));
  const inherited = options.inherited ?? process.env;
  const home = options.home ?? inherited.HOME ?? homedir();
  const discoveryHome = path.join(options.directory, "discovery-home");
  async function environment() {
    mkdirSync(discoveryHome, { recursive: true, mode: 0o700 });
    return {
      // Claude on macOS looks its Keychain login up by account name, so keep it.
      ...Object.fromEntries(
        ["USER", "LOGNAME"].flatMap((key) => (inherited[key] ? [[key, inherited[key]]] : [])),
      ),
      HOME: discoveryHome,
      TMPDIR: discoveryHome,
      PATH: (await paths()).join(path.delimiter),
    };
  }
  async function definition(input: AgentDefinition): Promise<AgentDefinition> {
    if (!["claude", "codex", "acp"].includes(input.adapter))
      throw new Error("runtime_adapter_unavailable");
    const value = structuredClone(input);
    if (value.launch.command === "{binary}" || !path.isAbsolute(value.launch.command)) {
      if (options.resolve) value.launch.command = await options.resolve(value);
      else {
        const found = await discoverBinaries({
          binaryNames: value.binaryNames,
          versionCommand: value.versionCommand,
          testedVersions: value.testedVersions,
          cwd: options.directory,
          path: await paths(),
          knownDirectories: await knownDirectories(home),
          ...(options.overrides?.()[value.id]
            ? { override: options.overrides()[value.id] as string }
            : {}),
          inherited: await environment(),
          runner: run,
        });
        if (!found.selected) throw new Error("binary_not_found");
        value.launch.command = found.selected.path;
      }
    }
    if (!path.isAbsolute(value.launch.command)) throw new Error("runtime_binary_not_absolute");
    const effectiveHome = value.launch.env.HOME ?? home;
    const key =
      value.adapter === "claude"
        ? "CLAUDE_CONFIG_DIR"
        : value.adapter === "codex"
          ? "CODEX_HOME"
          : "GEMINI_HOME";
    const configHome =
      value.launch.env[key] ?? (!value.launch.env.HOME ? inherited[key] : undefined);
    value.launch.env = {
      HOME: effectiveHome,
      TMPDIR: discoveryHome,
      PATH: (await paths()).join(path.delimiter),
      ...(configHome ? { [key]: configHome } : {}),
      ...Object.fromEntries(
        ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME"].flatMap((name) =>
          !value.launch.env.HOME && inherited[name] ? [[name, inherited[name]]] : [],
        ),
      ),
      ...value.launch.env,
    };
    return value;
  }
  async function probe(value: AgentDefinition) {
    const result = await run(value.launch.command, value.versionCommand, {
      cwd: options.directory,
      inherited: await environment(),
      timeoutMs: 5000,
    });
    const version = versionFromOutput(result.stdout);
    const home = Object.fromEntries(
      [
        "HOME",
        "CLAUDE_CONFIG_DIR",
        "CODEX_HOME",
        "GEMINI_HOME",
        "XDG_CONFIG_HOME",
        "XDG_DATA_HOME",
        "XDG_STATE_HOME",
      ].flatMap((key) => (value.launch.env[key] ? [[key, value.launch.env[key] as string]] : [])),
    );
    const auth =
      !result.failure && result.code === 0
        ? await checkLogin({
            adapter: value.adapter,
            command: value.launch.command,
            args:
              value.auth?.statusCommand ??
              (value.adapter === "claude"
                ? ["auth", "status"]
                : value.adapter === "codex"
                  ? ["login", "status"]
                  : []),
            cwd: options.directory,
            inherited: await environment(),
            apiKeyConfigured: !!(value.auth?.apiKeyEnv && value.launch.env[value.auth.apiKeyEnv]),
            runner: (command, args, input) => run(command, args, { ...input, env: home }),
          })
        : { state: "unknown" as const };
    const login = auth.state === "api_key_configured" ? "signed_in" : auth.state;
    return {
      installed: result.failure !== "not_found",
      broken: !!result.failure || result.code !== 0,
      login,
      ...(version ? { version } : {}),
    };
  }
  async function schema(value: AgentDefinition): Promise<unknown> {
    const base = path.join(options.directory, "private-runtime");
    mkdirSync(base, { recursive: true, mode: 0o700 });
    const directory = mkdtempSync(path.join(base, "codex-schema-"));
    try {
      const result = await run(
        value.launch.command,
        ["app-server", "generate-json-schema", "--experimental", "--out", directory],
        {
          cwd: options.directory,
          inherited: await environment(),
          timeoutMs: 15000,
          maxOutputBytes: 65536,
        },
      );
      if (result.failure || result.code !== 0) throw new Error("codex_schema_unavailable");
      const file = path.join(directory, "codex_app_server_protocol.schemas.json");
      return JSON.parse(readFileSync(file, "utf8"));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
  function adapters(redactor: Redactor): Map<string, AgentAdapter> {
    return new Map<string, AgentAdapter>([
      [
        "acp",
        new AcpAdapter({
          probe,
          connect: async (value, input) =>
            processes.connect(
              { ...value.launch, cwd: input.cwd, env: { ...value.launch.env, ...input.env } },
              redactor,
            ),
        }),
      ],
      [
        "claude",
        new ClaudeAdapter({
          probe,
          config: (content, manifestId) => files.config(content, manifestId),
          connect: async (_definition, _options, launch) => processes.connect(launch, redactor),
        }),
      ],
      [
        "codex",
        new CodexAdapter({
          privateRead: () => redactor.hideFrames(),
          probe,
          schema,
          connect: async (value, input) =>
            processes.connect(
              { ...value.launch, cwd: input.cwd, env: { ...value.launch.env, ...input.env } },
              redactor,
            ),
        }),
      ],
    ]);
  }
  return {
    definition,
    probe,
    adapters,
    async close() {
      await processes.close();
      await files.close();
    },
  };
}
