import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { createDockerTarget } from "./index.js";

it("checks labels and state without connecting to a Docker engine or waking containers", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "docker-lookup-"));
  try {
    const binary = path.join(root, "docker");
    await writeFile(
      binary,
      `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "ps") {
  if (!args.includes("label=task=task") || !args.includes("label=ai.zoltbot.sandbox=fixture")) process.exit(9);
  process.stdout.write("mine\\nforeign\\nsleeping\\nstopped\\ngone\\n");
} else if (args[0] === "inspect") {
  const name = args.at(-1);
  if (name === "gone") { process.stderr.write("No such container"); process.exit(1); }
  const labels = {"ai.zoltbot.sandbox":"fixture",task:name === "foreign" ? "other" : "task"};
  process.stdout.write(JSON.stringify(labels)+"|"+(name === "sleeping" ? "paused" : name === "stopped" ? "exited" : "running"));
} else process.exit(9);
`,
      { mode: 0o700 },
    );
    const target = createDockerTarget({ binary, label: "fixture" });
    expect(await target.find({ task: "task" })).toEqual([
      { target: target.id, id: "mine", workdir: "/home/user" },
      { target: target.id, id: "sleeping", workdir: "/home/user" },
    ]);
    await expect(target.find({})).rejects.toMatchObject({ code: "invalid" });
    await expect(
      target.create({ labels: { "ai.zoltbot.sandbox": "other" } }),
    ).rejects.toMatchObject({ code: "invalid" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
