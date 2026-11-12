import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { workerCliMetadata } from "./discovery.js";

it("advertises discovered CLI versions using probes with no task secrets or login calls", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "zoltbot-worker-discovery-")),
    bin = path.join(root, "bin"),
    commands: string[][] = [];
  await mkdir(bin);
  for (const name of ["claude", "codex"]) await writeFile(path.join(bin, name), "synthetic");
  try {
    const clis = await workerCliMetadata("claude", root, {
      paths: [bin],
      home: root,
      async run(command, args, options) {
        commands.push(args);
        expect(options.inherited).toEqual({ HOME: root, PATH: bin });
        return {
          code: 0,
          stdout: path.basename(command) === "claude" ? "Claude Code 2.1.299" : "codex-cli 0.164.0",
          stderr: "",
        };
      },
    });
    expect(clis).toEqual([
      { id: "claude", version: "2.1.299" },
      { id: "codex", version: "0.164.0" },
    ]);
    expect(commands).toEqual([["--version"], ["--version"]]);
    await expect(workerCliMetadata("claude", root, { paths: [], home: root })).rejects.toThrow(
      "worker_cli_unavailable",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
