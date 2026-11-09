import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  watch,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { githubName, ImportReader } from "./import.js";

const roots: string[] = [];
function fixture() {
  mkdirSync(".cache/tests", { recursive: true });
  const root = mkdtempSync(path.resolve(".cache/tests/import-"));
  roots.push(root);
  const home = path.join(root, "home"),
    data = path.join(root, "data");
  mkdirSync(path.join(home, ".claude/projects/-workspace-example"), { recursive: true });
  mkdirSync(data);
  writeFileSync(
    path.join(home, ".claude/projects/-workspace-example/session.jsonl"),
    "private conversation must not be read",
  );
  writeFileSync(
    path.join(home, ".claude.json"),
    JSON.stringify({
      mcpServers: {
        example: {
          command: "example",
          args: ["--token", "private-arg"],
          env: { API_KEY: "private-key" },
          url: "https://user:password@example.com/mcp?token=private-url",
        },
      },
    }),
  );
  return { root, home, data };
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
it("requires consent, previews metadata only, masks secrets, and applies only selected preview IDs", async () => {
  const { home, data } = fixture();
  const reader = new ImportReader({ home, dataDir: data });
  await expect(reader.preview({ consent: false })).rejects.toThrow("import_consent_required");
  const events: string[] = [];
  function snapshot(directory: string): Record<string, unknown> {
    const rootInfo = statSync(directory);
    const result: Record<string, unknown> = {
      [directory]: { mtime: rootInfo.mtimeMs, size: rootInfo.size },
    };
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name),
        info = statSync(file);
      result[file] = {
        mtime: info.mtimeMs,
        size: info.size,
        ...(entry.isFile() ? { content: readFileSync(file, "base64") } : {}),
      };
      if (entry.isDirectory()) Object.assign(result, snapshot(file));
    }
    return result;
  }
  const before = snapshot(home);
  const watcher = watch(home, { recursive: true }, (_event, file) => events.push(String(file)));
  try {
    const preview = await reader.preview({ consent: true });
    expect(preview.counts).toEqual({ project: 1, session: 1, mcp: 1 });
    const json = JSON.stringify(preview);
    for (const secret of [
      "private conversation",
      "private-arg",
      "private-key",
      "private-url",
      "password",
    ])
      expect(json).not.toContain(secret);
    const session = preview.items.find((item) => item.kind === "session");
    expect(session).toBeDefined();
    await expect(reader.apply(preview.id, ["invented"], true)).rejects.toThrow(
      "unknown_import_item",
    );
    const applied = await reader.apply(preview.id, [session?.id ?? ""], true);
    expect(applied.items).toHaveLength(1);
    expect(applied.items[0]?.kind).toBe("session");
    const stored = readFileSync(path.join(data, "imports", `${preview.id}.json`), "utf8");
    for (const secret of [
      "private conversation",
      "private-arg",
      "private-key",
      "private-url",
      "password",
    ])
      expect(stored).not.toContain(secret);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(snapshot(home)).toEqual(before);
    for (const event of events)
      expect(
        Object.hasOwn(before, event === path.basename(home) ? home : path.resolve(home, event)),
        JSON.stringify({
          event,
          joined: path.relative(home, path.join(home, event)),
          resolved: path.relative(home, path.resolve(home, event)),
          known: Object.keys(before).map((file) => path.relative(home, file)),
        }),
      ).toBe(true);
  } finally {
    watcher.close();
  }
});
it("shallow repository scans skip build folders and do not follow symlinks", async () => {
  const { root, home, data } = fixture();
  const code = path.join(root, "code");
  mkdirSync(path.join(code, "visible/.git"), { recursive: true });
  mkdirSync(path.join(code, "node_modules/hidden/.git"), { recursive: true });
  const reader = new ImportReader({ home, dataDir: data });
  const preview = await reader.preview({ consent: true, codeFolders: [code] });
  expect(
    preview.items
      .filter((item) => item.kind === "project" && item.source === "git")
      .map((item) => item.path),
  ).toEqual([path.join(code, "visible")]);
});

it("does not inspect sources excluded from consent", async () => {
  const { home, data } = fixture();
  const reader = new ImportReader({ home, dataDir: data });
  const preview = await reader.preview({ consent: true, sources: ["cursor"] });
  expect(preview.items).toEqual([]);
  expect(preview.counts).toEqual({ project: 0, session: 0, mcp: 0 });
});
it("does not turn a lossy Claude directory encoding into an assumed project cwd", async () => {
  const { home, data } = fixture();
  const preview = await new ImportReader({ home, dataDir: data }).preview({
    consent: true,
    sources: ["claude"],
  });
  const project = preview.items.find((item) => item.kind === "project");
  expect(project?.nativePath).toBe(path.join(home, ".claude/projects/-workspace-example"));
  expect(project?.path).toBeUndefined();
});

it("does not persist a completed import ledger when the product transaction fails", async () => {
  const { home, data } = fixture();
  const reader = new ImportReader({
    home,
    dataDir: data,
    onApply: async () => {
      throw new Error("commit_failed");
    },
  });
  const preview = await reader.preview({ consent: true, sources: [] });
  await expect(reader.apply(preview.id, [], true)).rejects.toThrow("commit_failed");
  expect(existsSync(path.join(data, "imports", `${preview.id}.json`))).toBe(false);
});

it("links sessions to repositories without opening Claude transcripts", async () => {
  const { root, home, data } = fixture();
  const repo = path.join(root, "code/app.v2");
  mkdirSync(path.join(repo, ".git"), { recursive: true });
  mkdirSync(path.join(repo, "web"));
  writeFileSync(
    path.join(repo, ".git/config"),
    '[core]\n\tbare = false\n[remote "upstream"]\n\turl = git@github.com:other/fork.git\n[remote "origin"]\n\turl = https://token@github.com/acme/app.git\n',
  );
  const encoded = repo.replace(/[^A-Za-z0-9]/g, "-");
  mkdirSync(path.join(home, ".claude/projects", encoded));
  writeFileSync(path.join(home, ".claude/projects", encoded, "s.jsonl"), "x".repeat(9000));
  writeFileSync(
    path.join(home, ".claude.json"),
    JSON.stringify({ projects: { [repo]: {}, [path.join(root, "missing")]: {} } }),
  );
  const day = path.join(home, ".codex/sessions/2026/11/06");
  mkdirSync(day, { recursive: true });
  writeFileSync(
    path.join(day, "rollout-0b6e0a8e-5f1c-4f3e-9a0b-1c2d3e4f5a6b.jsonl"),
    `${JSON.stringify({ type: "session_meta", payload: { cwd: path.join(repo, "web") } })}\n{"private conversation":1}\n`,
  );
  const preview = await new ImportReader({ home, dataDir: data }).preview({ consent: true });
  const sessions = preview.items.filter((item) => item.kind === "session");
  const claude = sessions.find((item) => item.source === "claude" && item.name === "s");
  expect(claude).toMatchObject({ scopePath: repo, repoRoot: repo, remote: "acme/app" });
  expect(claude?.brief).toBeUndefined();
  const codex = sessions.find((item) => item.source === "codex");
  expect(codex).toMatchObject({
    scopePath: path.join(repo, "web"),
    repoRoot: repo,
    remote: "acme/app",
    brief: true,
  });
  const lossy = sessions.find((item) => item.name === "session");
  expect(lossy?.scopePath).toBeUndefined();
  expect(JSON.stringify(preview)).not.toContain("token");
  expect(JSON.stringify(preview)).not.toContain("private conversation");
});

it("reads only GitHub origin names from git config", () => {
  const config = (url: string) => `[remote "origin"]\n\turl = ${url}\n`;
  expect(githubName(config("git@github.com:acme/app.git"))).toBe("acme/app");
  expect(githubName(config("ssh://git@github.com/acme/app.js"))).toBe("acme/app.js");
  expect(githubName(config("https://user:secret@github.com/acme/app/"))).toBe("acme/app");
  expect(githubName(config("https://gitlab.com/acme/app.git"))).toBeUndefined();
  expect(githubName(config("https://github.com.evil.test/acme/app"))).toBeUndefined();
  expect(githubName('[remote "fork"]\n\turl = git@github.com:acme/app.git\n')).toBeUndefined();
});
