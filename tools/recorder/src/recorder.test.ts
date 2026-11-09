import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { expect, it } from "vitest";
import { record } from "./index.js";

it("records replayable versioned frames without secrets or personal paths", async () => {
  mkdirSync(".cache/tests", { recursive: true });
  const root = mkdtempSync(path.resolve(".cache/tests/recorder-"));
  const file = path.join(root, "capture.jsonl");
  const capture = record({
    command: process.execPath,
    args: [
      "-e",
      'process.stdin.on("data",()=>{process.stdout.write(JSON.stringify({token:"unknown-private",text:"seeded-secret",cwd:process.cwd()})+"\\n")});',
    ],
    cwd: root,
    version: "test-1",
    output: file,
    secrets: ["seeded-secret"],
  });
  try {
    capture.send({ message: "synthetic input" });
    for (let i = 0; i < 100 && !readFileSync(file, "utf8").includes("stdout"); i++) await delay(10);
    const text = readFileSync(file, "utf8");
    expect(text).toContain("stdout");
    expect(text).toContain("test-1");
    expect(text).not.toContain("seeded-secret");
    expect(text).not.toContain("unknown-private");
    expect(text).not.toContain("/Users/");
    expect(
      text
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    ).toHaveLength(3);
  } finally {
    await capture.close();
    rmSync(root, { recursive: true, force: true });
  }
});
