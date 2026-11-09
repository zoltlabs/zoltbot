import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { ImportReader } from "./import.js";

const roots: string[] = [];
function fixture() {
  mkdirSync(".cache/tests", { recursive: true });
  const root = mkdtempSync(path.resolve(".cache/tests/provider-import-"));
  roots.push(root);
  const home = path.join(root, "home"),
    data = path.join(root, "data");
  mkdirSync(home);
  mkdirSync(data);
  return { root, home, data };
}
function file(root: string, relative: string, value: string) {
  const target = path.join(root, relative);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, value);
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
it("reads documented Gemini, OpenCode, and Cline MCP metadata without resolving secrets", async () => {
  const { home, data } = fixture();
  file(
    home,
    ".gemini/settings.json",
    JSON.stringify({
      mcpServers: {
        gemini: {
          httpUrl: "https://example.com/mcp?token=private-url",
          headers: { Authorization: "private-header" },
        },
      },
    }),
  );
  file(
    home,
    ".config/opencode/opencode.jsonc",
    '{ // native JSONC\n "mcp": {"local": {"type":"local", "command":["node","private-argument"], "environment":{"API_KEY":"private-env"},},},}',
  );
  file(
    home,
    ".cline/data/settings/cline_mcp_settings.json",
    JSON.stringify({
      mcpServers: { cline: { command: "node", args: ["private-cline-argument"] } },
    }),
  );
  file(home, ".cline/data/settings/providers.json", "private-provider-credential");
  const preview = await new ImportReader({ home, dataDir: data }).preview({
    consent: true,
    sources: ["gemini", "opencode", "cline"],
  });
  expect(preview.counts).toEqual({ project: 0, session: 0, mcp: 3 });
  expect(preview.items.find((item) => item.source === "opencode")?.configuration).toMatchObject({
    command: "node",
    argumentCount: 1,
    env: { API_KEY: "[confirmation required]" },
  });
  expect(preview.items.find((item) => item.source === "gemini")?.configuration?.url).toContain(
    "example.com",
  );
  expect(JSON.stringify(preview)).not.toContain("private-");
});
it("reads selected project configs independently of whether repositories are being imported", async () => {
  const { root, home, data } = fixture();
  const repo = path.join(root, "code/repository");
  mkdirSync(path.join(repo, ".git"), { recursive: true });
  file(repo, ".gemini/settings.json", '{"mcpServers":{"project":{"command":"example"}}}');
  file(
    repo,
    "opencode.json",
    '{"mcp":{"servers":{"remote":{"type":"remote","url":"https://example.com/mcp"}}}}',
  );
  const preview = await new ImportReader({ home, dataDir: data }).preview({
    consent: true,
    sources: ["gemini", "opencode"],
    codeFolders: [path.dirname(repo)],
  });
  expect(preview.counts).toEqual({ project: 0, session: 0, mcp: 2 });
});
it("rejects malformed JSONC instead of importing its partial recovery result", async () => {
  const { home, data } = fixture();
  file(
    home,
    ".config/opencode/opencode.jsonc",
    '{"mcp":{"broken":{"command":["node"]}} trailing-invalid',
  );
  const preview = await new ImportReader({ home, dataDir: data }).preview({
    consent: true,
    sources: ["opencode"],
  });
  expect(preview.items).toEqual([]);
  expect(preview.errors).toEqual([{ source: "opencode", code: "invalid_mcp_metadata" }]);
});
it("uses only Codex index metadata to name existing session files and keeps the last update", async () => {
  const { home, data } = fixture();
  const id = "00000000-0000-4000-8000-000000000001";
  file(
    home,
    `.codex/sessions/2026/10/27/rollout-2026-10-27T12-00-00-${id}.jsonl`,
    "private-conversation-body",
  );
  file(
    home,
    ".codex/session_index.jsonl",
    [
      JSON.stringify({ id, thread_name: "Old name", updated_at: "2026-10-27T10:00:00Z" }),
      "malformed-private-row",
      JSON.stringify({ id, thread_name: "Current name", updated_at: "2026-10-27T11:00:00Z" }),
    ].join("\n"),
  );
  const preview = await new ImportReader({ home, dataDir: data }).preview({
    consent: true,
    sources: ["codex"],
  });
  expect(preview.items).toMatchObject([{ kind: "session", nativeId: id, name: "Current name" }]);
  expect(preview.errors).toEqual([{ source: "codex", code: "invalid_session_index" }]);
  expect(JSON.stringify(preview)).not.toContain("private-");
});
it("does not treat a prefixed Claude child transcript filename as a resumable session ID", async () => {
  const { home, data } = fixture();
  const id = "00000000-0000-4000-8000-000000000002";
  file(home, `.claude/projects/-workspace/${id}.jsonl`, "private-body");
  file(home, `.claude/projects/-workspace/agent-${id}.jsonl`, "private-child-body");
  const preview = await new ImportReader({ home, dataDir: data }).preview({
    consent: true,
    sources: ["claude"],
  });
  expect(preview.items.find((item) => item.name === id)?.nativeId).toBe(id);
  expect(preview.items.find((item) => item.name === `agent-${id}`)?.nativeId).toBeUndefined();
});
it("uses independently existing config project paths and scoped Claude MCP metadata", async () => {
  const { root, home, data } = fixture();
  const folder = path.join(root, "folder"),
    repo = path.join(root, "repository");
  mkdirSync(folder);
  mkdirSync(path.join(repo, ".git"), { recursive: true });
  file(
    home,
    ".claude.json",
    JSON.stringify({
      projects: {
        [folder]: { mcpServers: { project: { command: "example" } } },
        [path.join(root, "missing")]: {},
      },
    }),
  );
  file(home, ".codex/config.toml", `[projects.${JSON.stringify(repo)}]\ntrust_level = "trusted"\n`);
  const preview = await new ImportReader({ home, dataDir: data }).preview({
    consent: true,
    sources: ["claude", "codex"],
  });
  expect(
    preview.items
      .filter((item) => item.kind === "project")
      .map((item) => item.path)
      .sort(),
  ).toEqual([folder, repo].sort());
  expect(
    preview.items.find((item) => item.kind === "project" && item.path === folder)?.repoRoot,
  ).toBeUndefined();
  expect(
    preview.items.find((item) => item.kind === "project" && item.path === repo)?.repoRoot,
  ).toBe(repo);
  expect(preview.items.find((item) => item.kind === "mcp")?.scopePath).toBe(folder);
});
