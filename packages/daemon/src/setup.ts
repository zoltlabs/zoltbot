import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { acpDefinitions } from "@zoltbot/adapters-acp/definitions";
import { claudeDefinitions } from "@zoltbot/adapters-claude/definitions";
import { codexDefinitions } from "@zoltbot/adapters-codex/definitions";
import { piDefaultDefinition, piDefinitions } from "@zoltbot/adapters-pi/definitions";
import { DetectionService, macProbeSandbox, runCommand, versionFromOutput } from "@zoltbot/detect";
import type { ImportReceipt } from "@zoltbot/protocol";
export const builtinDefinitions = [
  ...claudeDefinitions,
  ...codexDefinitions,
  ...acpDefinitions,
  piDefaultDefinition,
  ...piDefinitions,
];
export function createSetup(options: {
  dataDir: string;
  home?: string;
  preference?: () => unknown;
  runtime?: (definitionId: string) => unknown;
  overrides?: () => Record<string, string>;
  updateChecks?: () => boolean;
  onApply?: (receipt: ImportReceipt) => Promise<void>;
}) {
  const service: DetectionService = new DetectionService({
    ...options,
    home: options.home ?? homedir(),
    builtins: builtinDefinitions,
    sandbox: {
      async initialize(argv): Promise<unknown> {
        const runtime = await realpath(process.execPath);
        return macProbeSandbox({
          dataDir: options.dataDir,
          paths: await service.paths(),
          runtimeReadRoots: [path.dirname(path.dirname(runtime))],
        }).initialize(argv);
      },
    },
    globalChecks: async () => {
      const paths = await service.paths();
      const checks: unknown[] = [{ kind: "global", id: "daemon", state: "healthy" }];
      for (const command of ["git", "gh"]) {
        const result = await runCommand(command, ["--version"], {
          cwd: options.dataDir,
          inherited: { HOME: options.dataDir, PATH: paths.join(path.delimiter) },
          timeoutMs: 5000,
        });
        const version = versionFromOutput(result.stdout);
        checks.push({
          kind: "global",
          id: command,
          state: result.failure || result.code !== 0 ? "unavailable" : "available",
          ...(version ? { version } : {}),
        });
      }
      return checks;
    },
  });
  return service;
}
