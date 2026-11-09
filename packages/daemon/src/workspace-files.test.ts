import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { listThreadFiles, workspaceFiles } from "./workspace-files.js";

it("finds bounded file names only inside the native workspace and skips symlinks and generated trees", async () => {
  mkdirSync(".cache/tests", { recursive: true });
  const root = mkdtempSync(path.resolve(".cache/tests/mentions-"));
  const cwd = path.join(root, "workspace");
  try {
    for (const directory of ["src", ".git", "node_modules", ".cache"])
      mkdirSync(path.join(cwd, directory), { recursive: true });
    mkdirSync(path.join(root, "outside"));
    writeFileSync(path.join(cwd, "src", "hello.ts"), "Synthetic source");
    writeFileSync(path.join(cwd, "src", "other.ts"), "Synthetic source");
    for (const directory of [".git", "node_modules", ".cache"])
      writeFileSync(path.join(cwd, directory, "hello-private.ts"), "Synthetic excluded fixture");
    writeFileSync(path.join(root, "outside", "hello-outside.ts"), "Synthetic outside fixture");
    symlinkSync(path.join(root, "outside"), path.join(cwd, "linked"));
    symlinkSync(path.join(root, "outside", "hello-outside.ts"), path.join(cwd, "hello-link.ts"));
    const result = await workspaceFiles(cwd, "hello", 20);
    expect(result).toEqual({
      items: [{ path: path.join(cwd, "src", "hello.ts"), label: "src/hello.ts" }],
      truncated: false,
    });
    const limited = await workspaceFiles(cwd, "", 1);
    expect(limited.items).toHaveLength(1);
    expect(limited.truncated).toBe(true);
    expect(JSON.stringify(limited)).not.toContain("Synthetic source");
    await expect(workspaceFiles(cwd, "x".repeat(257), 20)).rejects.toThrow("invalid_file_query");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("requires an unarchived thread and a known native working directory", async () => {
  await expect(listThreadFiles({}, "thread", "", 20)).rejects.toThrow("runtime_thread_unavailable");
  await expect(
    listThreadFiles({ thread: [{ id: "thread", archived: false }] }, "thread", "", 20),
  ).rejects.toThrow("workspace_not_ready");
  await expect(
    listThreadFiles(
      {
        thread: [{ id: "thread", archived: true }],
        session: [{ threadId: "thread", cwd: "/must-not-read" }],
      },
      "thread",
      "",
      20,
    ),
  ).rejects.toThrow("runtime_thread_unavailable");
});
