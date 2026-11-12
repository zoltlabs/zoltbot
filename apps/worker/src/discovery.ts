import path from "node:path";
import { claudeDefinitions } from "@zoltbot/adapters-claude/definitions";
import { codexDefinitions } from "@zoltbot/adapters-codex/definitions";
import { type CommandRunner, discoverBinaries } from "@zoltbot/detect";
import type { RunnerHello } from "@zoltbot/runner-protocol";

/** Version probes receive no task secrets and do not inspect provider login state. */
export async function workerCliMetadata(
  provider: "claude" | "codex",
  directory: string,
  options: { paths?: string[]; home?: string; run?: CommandRunner } = {},
): Promise<RunnerHello["clis"]> {
  const paths =
      options.paths ??
      (process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin")
        .split(path.delimiter)
        .filter(path.isAbsolute),
    clis: RunnerHello["clis"] = [];
  for (const definition of [...claudeDefinitions, ...codexDefinitions]) {
    const found = await discoverBinaries({
      binaryNames: definition.binaryNames,
      versionCommand: definition.versionCommand,
      testedVersions: definition.testedVersions,
      cwd: directory,
      path: paths,
      knownDirectories: [],
      inherited: { HOME: options.home ?? "/home/user", PATH: paths.join(path.delimiter) },
      ...(options.run ? { runner: options.run } : {}),
    });
    if (found.selected?.version)
      clis.push({ id: definition.adapter, version: found.selected.version });
  }
  if (!clis.some((cli) => cli.id === provider)) throw new Error("worker_cli_unavailable");
  return clis;
}
