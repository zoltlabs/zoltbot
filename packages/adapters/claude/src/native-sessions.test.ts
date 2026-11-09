import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { claudeDefinitions } from "./definitions.js";
import { ClaudeAdapter } from "./index.js";
import { listClaudeSessions } from "./native-sessions.js";

it("lists only native session filenames without reading history or inventing cwd", async () => {
  mkdirSync(".cache/tests", { recursive: true });
  const root = mkdtempSync(path.resolve(".cache/tests/claude-index-"));
  try {
    const project = path.join(root, "projects/-work-ambiguous-name");
    mkdirSync(project, { recursive: true });
    const id = "12345678-1234-1234-1234-123456789abc";
    writeFileSync(path.join(project, `${id}.jsonl`), "private synthetic history", { mode: 0 });
    writeFileSync(path.join(project, `agent-${id}.jsonl`), "child history");
    writeFileSync(path.join(project, "unverified.jsonl"), "not a native id");
    const outside = path.join(root, "outside");
    mkdirSync(outside);
    writeFileSync(path.join(outside, `${id}.jsonl`), "outside history");
    symlinkSync(outside, path.join(root, "projects/linked-project"));
    symlinkSync(
      path.join(outside, `${id}.jsonl`),
      path.join(project, "abcdefab-1234-1234-1234-123456789abc.jsonl"),
    );
    const rows = await listClaudeSessions(root, "2026-10-27T12:00:00.000Z");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      provider: "claude",
      nativeId: id,
      adopted: false,
      missing: false,
      lastSeenAt: "2026-10-27T12:00:00.000Z",
    });
    expect(rows[0]?.cwd).toBeUndefined();
    expect(rows[0]?.title).toBeUndefined();
    expect(JSON.stringify(rows)).not.toContain("history");
    const adapter = new ClaudeAdapter({
      probe: async () => {
        throw new Error("must not launch");
      },
      config: async () => {
        throw new Error("must not configure");
      },
      connect: async () => {
        throw new Error("must not connect");
      },
    });
    const base = claudeDefinitions[0];
    if (!base) throw new Error("missing_definition");
    const definition = { ...base, launch: { ...base.launch, env: { CLAUDE_CONFIG_DIR: root } } };
    expect((await adapter.listNativeSessions(definition, {})).map((row) => row.nativeId)).toEqual([
      id,
    ]);
    await expect(
      adapter.listNativeSessions(definition, { cwd: "/work/ambiguous/name" }),
    ).rejects.toThrow("native_cwd_filter_unverified");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
it("rejects a symlinked root and does not turn an unreadable listing into an empty result", async () => {
  mkdirSync(".cache/tests", { recursive: true });
  const root = mkdtempSync(path.resolve(".cache/tests/claude-index-root-"));
  try {
    mkdirSync(path.join(root, "actual"));
    symlinkSync(path.join(root, "actual"), path.join(root, "linked"));
    await expect(listClaudeSessions(path.join(root, "linked"))).rejects.toThrow(
      "unsafe_native_session_root",
    );
    writeFileSync(path.join(root, "projects"), "not a directory");
    await expect(listClaudeSessions(root)).rejects.toThrow();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
