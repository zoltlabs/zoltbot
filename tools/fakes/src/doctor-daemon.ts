import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { startDaemon } from "@zoltbot/daemon";
import type { AgentDefinition } from "@zoltbot/protocol";
import { DetectionService } from "../../../packages/detect/src/index.js";
import { ReferenceSession } from "./reference-adapter.js";

const dataDir = process.env.ZOLTBOT_DATA_DIR;
if (!dataDir) throw new Error("fixture_data_dir_required");
const sourceHome = path.join(dataDir, "source-home");
const history = path.join(sourceHome, ".claude/projects/-fixture");
mkdirSync(history, { recursive: true });
writeFileSync(
  path.join(history, "33333333-3333-4333-8333-333333333333.jsonl"),
  "synthetic-private-conversation-body",
);
writeFileSync(
  path.join(sourceHome, ".claude.json"),
  JSON.stringify({
    mcpServers: {
      shared: {
        command: "example",
        args: ["--token", "synthetic-private-import-argument"],
        env: { API_KEY: "synthetic-private-import-key" },
      },
    },
  }),
);
const codeFolder = path.join(sourceHome, "code");
mkdirSync(codeFolder, { recursive: true });
execFileSync("git", ["init", "--quiet", "--template=", path.join(codeFolder, "project")], {
  cwd: dataDir,
  env: {
    PATH: process.env.PATH,
    HOME: dataDir,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: path.join(dataDir, "unused-git-config"),
  },
  stdio: "ignore",
});
const paths = [path.join(dataDir, "bin-broken"), path.join(dataDir, "bin-working")];
for (const directory of paths) mkdirSync(directory, { recursive: true });
const witness = JSON.stringify(path.join(dataDir, "native-checks.jsonl"));
for (const [index, directory] of paths.entries())
  writeFileSync(
    path.join(directory, "sample"),
    `#!${process.execPath}\nconst fs = process.getBuiltinModule("node:fs");\nfs.appendFileSync(${witness}, JSON.stringify(process.argv.slice(2)) + "\\n");\n${index === 0 ? 'process.stderr.write("synthetic-private-broken-detail"); process.exit(1);' : 'if (process.argv[2] === "--version") console.log("sample 1.0.0"); else console.log(JSON.stringify({ loggedIn: true }));'}\n`,
    { mode: 0o700 },
  );
const definition: AgentDefinition = {
  id: "sample",
  displayName: "Fixture coding tool",
  adapter: "claude",
  binaryNames: ["sample"],
  versionCommand: ["--version"],
  launch: { command: "sample", args: [], env: {} },
  auth: { statusCommand: ["auth", "status"] },
  testedVersions: "1.0.0",
  defaults: { permissionProfile: "workspace_write" },
  staticCapabilities: {
    resume: true,
    fork: false,
    steer: "queue_only",
    usage: { tokens: true, cost: false, context: false, cache: false },
  },
  nativeSessionRoots: [],
  experimental: false,
};
const daemon = await startDaemon({
  dataDir,
  runtimeHost: {
    async prepare(input, redactor) {
      return {
        cwd: dataDir,
        estimate: (text) => text.length,
        async open(request) {
          return new ReferenceSession(
            {
              identity: { agentId: input.profile.id, threadId: input.thread.id },
              cwd: dataDir,
              mode: request.mode,
              ...(request.nativeId ? { nativeId: request.nativeId } : {}),
              permissionProfile: input.profile.permissionProfile,
              hostMcp: { url: "http://127.0.0.1:1", token: "fixture-only" },
            },
            undefined,
            15000,
            redactor,
          ).open();
        },
      };
    },
  },
  ...(process.env.ZOLTBOT_UI_ORIGIN
    ? { origins: ["zoltbot://desktop", process.env.ZOLTBOT_UI_ORIGIN] }
    : {}),
  setup: (context) => {
    const service = new DetectionService({
      dataDir,
      home: sourceHome,
      paths,
      knownPaths: [],
      builtins: [definition],
      onApply: context.applyImport,
    });
    // Keep this explicit-scan scenario isolated from the shell's background update poll.
    service.updates = async () => [];
    const report = service.report.bind(service);
    service.report = async () => {
      if (existsSync(path.join(dataDir, "fail-report")))
        throw new Error("synthetic_report_unavailable");
      return report();
    };
    return service;
  },
});
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.once(signal, () => {
    void daemon.close().then(() => {
      process.exitCode = 0;
    });
  });
