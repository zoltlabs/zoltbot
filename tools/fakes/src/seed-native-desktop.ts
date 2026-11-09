import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { startDaemon } from "@zoltbot/daemon";
import { build } from "esbuild";

const directory = process.argv[2];
if (!directory || !path.isAbsolute(directory)) throw new Error("fixture_directory_required");
mkdirSync(directory, { recursive: true, mode: 0o700 });
const daemon = await startDaemon({ dataDir: directory });
const at = "2026-10-29T12:00:00Z";
try {
  daemon.dispatch(
    {
      type: "create",
      kind: "project",
      value: {
        id: "zolt",
        name: "Zolt",
        goal: "Build useful features",
        instructions: "Keep the work bounded and verify changes.",
        constraints: "",
        roots: [],
        hierarchyDepth: 3,
        tags: [],
        requireCodeReview: false,
        skipFinalGateWhenReviewed: false,
        archived: false,
        createdAt: at,
      },
    },
    "project",
  );
  const acp = process.argv[3] === "--acp";
  const providers = acp ? ["cursor", "antigravity", "opencode", "copilot"] : ["claude", "codex"];
  const names: Record<string, string> = {
    claude: "Claude",
    codex: "Codex",
    cursor: "Cursor",
    antigravity: "Antigravity",
    opencode: "OpenCode",
    copilot: "GitHub Copilot",
  };
  for (const provider of providers) {
    const binary = path.join(directory, `${provider}-synthetic.mjs`);
    const entry = path.resolve(`tools/fakes/src/${acp ? "acp" : provider}-conformance-provider.ts`);
    const compiled = path.join(directory, `${provider}-runtime.mjs`);
    await build({
      entryPoints: [entry],
      outfile: compiled,
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node24",
      define: { "import.meta.url": JSON.stringify(pathToFileURL(entry).href) },
      banner: {
        js: "import {createRequire} from 'node:module'; const require=createRequire(import.meta.url);",
      },
    });
    const source = `#!${process.execPath}
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
if (args.includes('--version')) { process.stdout.write(${JSON.stringify(acp ? "1.4.12\n" : provider === "claude" ? "2.1.299\n" : "codex-cli 0.164.0\n")}); }
else if (args.includes('generate-json-schema')) { writeFileSync(path.join(args[args.indexOf('--out')+1], 'codex_app_server_protocol.schemas.json'), readFileSync(${JSON.stringify(path.resolve("fixtures/codex/0.164.0/protocol-experimental.schema.json"))})); }
else { const child = spawn(${JSON.stringify(process.execPath)}, [${JSON.stringify(compiled)}, ...args], { stdio: 'inherit', env: process.env }); child.on('exit', code => { process.exitCode = code ?? 1; }); }
`;
    writeFileSync(binary, source, { mode: 0o700 });
    daemon.dispatch(
      {
        type: "create",
        kind: "agentDefinition",
        value: {
          id: provider,
          displayName: names[provider],
          adapter: acp ? "acp" : provider,
          ...(acp
            ? { flavor: provider, auth: { loginCommand: provider === "cursor" ? ["login"] : [] } }
            : {}),
          binaryNames: [],
          versionCommand: ["--version"],
          launch: {
            command: binary,
            args: [],
            env: {
              ACP_TEST_UNIQUE_IDS: "1",
              ACP_TEST_FLAVOR: provider,
              HOME: path.join(directory, "provider-home"),
              ...(acp
                ? {}
                : {
                    CLAUDE_CONFIG_DIR: path.join(directory, "providers/claude"),
                    CODEX_HOME: path.join(directory, "providers/codex"),
                  }),
            },
          },
          testedVersions: provider === "claude" ? "2.1.299" : "0.164.0",
          defaults: { permissionProfile: "read_only" },
          staticCapabilities: {},
          nativeSessionRoots: [],
          experimental: false,
        },
      },
      `definition:${provider}`,
    );
    daemon.dispatch(
      {
        type: "create",
        kind: "agent",
        value: {
          id: `${provider}-profile`,
          name: names[provider],
          avatar: "A",
          kind: "profile",
          definitionId: provider,
          permissionProfile: acp ? "workspace_write" : "read_only",
          instructions: "Stay within this direction.",
          hidden: false,
          archived: false,
        },
      },
      `profile:${provider}`,
    );
    daemon.dispatch(
      {
        type: "create",
        kind: "thread",
        value: {
          id: `${provider}-manager`,
          agentId: `${provider}-profile`,
          projectId: "zolt",
          node: { type: "project", id: "zolt" },
          kind: provider === providers[0] ? "manager" : "side",
          title: `${names[provider]} workflow`,
          titleSource: "human",
          pinned: false,
          archived: false,
          createdAt: at,
          lastActivityAt: at,
        },
      },
      `thread:${provider}`,
    );
  }
} finally {
  await daemon.close();
}
