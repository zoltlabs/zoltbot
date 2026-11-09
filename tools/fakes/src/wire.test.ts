import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stringify } from "yaml";

const roots: string[] = [];
function dir() {
  mkdirSync(".cache/tests", { recursive: true });
  const root = mkdtempSync(path.resolve(".cache/tests/wire-"));
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const input: Record<string, unknown[]> = {
  claude: [{ type: "user", message: { role: "user", content: [{ type: "text", text: "hello" }] } }],
  codex: [
    { id: 1, method: "initialize", params: { clientInfo: { name: "zoltbot", version: "test" } } },
    { method: "initialized" },
    { id: 2, method: "thread/start", params: { cwd: "/work/repo" } },
    {
      id: 3,
      method: "turn/start",
      params: { threadId: "fake-thread", input: [{ type: "text", text: "hello" }] },
    },
  ],
  acp: [
    { id: 1, method: "initialize", params: { protocolVersion: 1 } },
    { id: 2, method: "session/new", params: { cwd: "/work/repo", mcpServers: [] } },
    {
      id: 3,
      method: "session/prompt",
      params: { sessionId: "fake-session", prompt: [{ type: "text", text: "hello" }] },
    },
  ],
  pi: [{ id: "1", type: "prompt", message: "hello" }],
};
function run(provider: string, scenario: string, lines: unknown[] = input[provider] ?? []) {
  const root = dir();
  return spawnSync(
    process.execPath,
    ["--import", "tsx", `tools/fakes/src/fake-${provider}.ts`, scenario],
    {
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? "", HOME: root, TMPDIR: root, TSX_DISABLE_CACHE: "1" },
      input: `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`,
      encoding: "utf8",
      timeout: 1000,
    },
  );
}
describe("scripted fake wire protocols", () => {
  for (const provider of Object.keys(input))
    it(`${provider} emits its wire shape`, () => {
      const result = run(provider, `tools/fakes/scenarios/${provider}-normal.yaml`);
      expect(result.status, result.stderr).toBe(0);
      const frames = result.stdout
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l));
      expect(frames.length).toBeGreaterThan(1);
      if (provider === "codex")
        expect(frames).toContainEqual(expect.objectContaining({ method: "turn/completed" }));
      if (provider === "claude")
        expect(frames).toContainEqual(expect.objectContaining({ type: "result" }));
      if (provider === "acp")
        expect(frames).toContainEqual(
          expect.objectContaining({ result: { stopReason: "end_turn" } }),
        );
      if (provider === "pi") expect(frames.at(-1)).toEqual({ type: "agent_settled" });
    });
  it("rejects a missing Codex handshake", () => {
    const root = dir(),
      scenario = path.join(root, "bad.yaml");
    writeFileSync(
      scenario,
      stringify({
        name: "bad",
        provider: "codex",
        steps: [{ on_input: { match: { method: "thread/start" } } }],
      }),
    );
    expect(run("codex", scenario, [{ id: 1, method: "thread/start" }]).status).not.toBe(0);
  });
  it("rejects a malformed control response instead of finishing silently", () => {
    const root = dir(),
      scenario = path.join(root, "approval.yaml");
    writeFileSync(
      scenario,
      stringify({
        name: "approval",
        provider: "claude",
        steps: [
          {
            emit: {
              type: "control_request",
              request_id: "r1",
              request: { subtype: "can_use_tool", tool_name: "Read" },
            },
          },
          {
            on_input: {
              match: {
                type: "control_response",
                response: { request_id: "r1", subtype: "success" },
              },
            },
          },
        ],
      }),
    );
    expect(
      run("claude", scenario, [{ type: "control_response", response: { request_id: "wrong" } }])
        .status,
    ).not.toBe(0);
  });
  it.each([
    "slow",
    "crash",
    "hang",
    "malformed",
    "unknown",
  ] as const)("supports %s fault mode", (mode) => {
    const root = dir(),
      scenario = path.join(root, "mode.yaml");
    writeFileSync(
      scenario,
      stringify({
        name: "fault",
        provider: "claude",
        mode,
        crashAfter: 1,
        steps: [{ emit: { type: "system", subtype: "init" } }],
      }),
    );
    const result = run("claude", scenario, []);
    if (mode === "hang")
      expect((result.error as NodeJS.ErrnoException | undefined)?.code).toBe("ETIMEDOUT");
    else if (mode === "crash") expect(result.status).toBe(1);
    else {
      expect(result.status).toBe(0);
      if (mode === "malformed") expect(result.stdout).toContain("{malformed-json");
      if (mode === "unknown") expect(result.stdout).toContain("future/unknown");
    }
  });
  it("keeps protocol fixtures synthetic", () => {
    for (const provider of Object.keys(input))
      expect(readFileSync(`tools/fakes/scenarios/${provider}-normal.yaml`, "utf8")).not.toMatch(
        /\/Users\/|Bearer\s+[A-Za-z0-9]+|sk-[A-Za-z0-9]{10}/,
      );
  });
});
