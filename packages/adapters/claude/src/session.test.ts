import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import type { OpenOptions } from "@zoltbot/adapters-sdk";
import type { AgentDefinition, AgentEvent } from "@zoltbot/protocol";
import { expect, it } from "vitest";
import type { ClaudeHost } from "./host.js";
import { ClaudeAdapter } from "./index.js";

const definition: AgentDefinition = {
  id: "claude-test",
  displayName: "Claude test",
  adapter: "claude",
  binaryNames: [],
  versionCommand: [],
  launch: {
    command: process.execPath,
    args: ["--import", "tsx", path.resolve("tools/fakes/src/claude-conformance-provider.ts")],
    env: {},
  },
  testedVersions: "2.1.299",
  defaults: { permissionProfile: "read_only" },
  staticCapabilities: {},
  nativeSessionRoots: [],
  experimental: false,
};
function setup() {
  mkdirSync(".cache/tests", { recursive: true });
  const cwd = mkdtempSync(path.resolve(".cache/tests/claude-session-"));
  let starts = 0;
  const host: ClaudeHost = {
    async probe() {
      return { installed: true, broken: false, version: "2.1.299", login: "signed_in" };
    },
    async config(content) {
      const file = path.join(cwd, `mcp-${starts}.json`);
      writeFileSync(file, JSON.stringify(content), { mode: 0o600 });
      return {
        path: file,
        async dispose() {
          rmSync(file, { force: true });
        },
      };
    },
    async connect(_def, opts, launch) {
      starts++;
      const child = spawn(launch.command, launch.args, {
        cwd: opts.cwd,
        env: {
          PATH: process.env.PATH,
          TSX_DISABLE_CACHE: "1",
          HOME: cwd,
          TMPDIR: cwd,
          ...(launch.env?.ZOLTBOT_HOST_MCP_TOKEN
            ? { ZOLTBOT_HOST_MCP_TOKEN: launch.env.ZOLTBOT_HOST_MCP_TOKEN }
            : {}),
        },
        stdio: ["pipe", "pipe", "ignore"],
      });
      const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
      return {
        input: Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>,
        output: Writable.toWeb(child.stdin) as unknown as WritableStream<Uint8Array>,
        closed,
        async close() {
          child.kill("SIGTERM");
          await closed;
        },
      };
    },
  };
  const options: OpenOptions = {
    mode: "new",
    cwd,
    identity: { agentId: "profile", threadId: "thread" },
    permissionProfile: "read_only",
    hostMcp: { url: "http://127.0.0.1:1/mcp", token: "test-secret" },
  };
  return { cwd, host, options, starts: () => starts };
}
async function openError(operation: Promise<{ close(): Promise<void> }>) {
  try {
    const session = await operation;
    await session.close();
    return "opened";
  } catch (error) {
    return error instanceof Error ? error.message : "unknown_error";
  }
}
it("opens and streams a native turn through the native protocol fake", async () => {
  const test = setup();
  const adapter = new ClaudeAdapter(test.host);
  const session = await adapter.open(definition, test.options);
  const trace: AgentEvent[] = [];
  const reader = (async () => {
    for await (const event of session.events()) trace.push(event);
  })();
  try {
    await session.send([{ type: "text", text: "normal" }], "queue");
    await expect.poll(() => trace.some((e) => e.t === "turn.done")).toBe(true);
    expect(trace.find((e) => e.t === "message.done")).toMatchObject({ text: "ok", phase: "final" });
    expect(trace.filter((e) => e.t === "turn.started")).toHaveLength(1);
  } finally {
    await session.close();
    await reader;
    rmSync(test.cwd, { recursive: true, force: true });
  }
});

it("writes only an environment placeholder for its host credential and passes the credential to the native child", async () => {
  const test = setup(),
    token = randomBytes(32).toString("base64url");
  const connect = test.host.connect;
  let received = false;
  test.host.connect = async (definition, options, launch) => {
    received = launch.env?.ZOLTBOT_HOST_MCP_TOKEN === token;
    return connect(definition, options, launch);
  };
  const session = await new ClaudeAdapter(test.host).open(definition, {
    ...test.options,
    hostMcp: { ...test.options.hostMcp, token, tokenEnv: "ZOLTBOT_HOST_MCP_TOKEN" },
    env: { ZOLTBOT_HOST_MCP_TOKEN: token },
  });
  try {
    const content = readFileSync(path.join(test.cwd, "mcp-0.json"), "utf8");
    expect(JSON.parse(content).mcpServers.zoltbot.headers.Authorization).toBe(
      `Bearer \${ZOLTBOT_HOST_MCP_TOKEN}`,
    );
    expect(content.includes(token)).toBe(false);
    expect(received).toBe(true);
    expect(
      JSON.parse(readFileSync(path.join(test.cwd, "environment-keys.json"), "utf8"))
        .ZOLTBOT_HOST_MCP_TOKEN,
    ).toBe("present");
  } finally {
    await session.close();
    rmSync(test.cwd, { recursive: true, force: true });
  }
});

it("steers into the running turn and queues plain sends behind it", async () => {
  const test = setup();
  const session = await new ClaudeAdapter(test.host).open(definition, test.options);
  const trace: AgentEvent[] = [];
  const reader = (async () => {
    for await (const event of session.events()) trace.push(event);
  })();
  try {
    const first = await session.send([{ type: "text", text: "slow" }], "queue");
    expect(await session.send([{ type: "text", text: "normal" }], "queue")).toMatchObject({
      disposition: "queued",
    });
    // The steered segment's aborted result does not end the turn; the steered reply lands in it.
    expect(await session.send([{ type: "text", text: "steered" }], "steer")).toEqual({
      disposition: "started",
      id: first.id,
    });
    await expect
      .poll(() =>
        trace.filter((e) => e.t === "turn.done").map((e) => e.t === "turn.done" && e.status),
      )
      .toEqual(["completed", "completed"]);
    expect(
      trace.some((e) => e.t === "text.delta" && e.text === "steered" && e.turnId === first.id),
    ).toBe(true);
    expect(trace.filter((e) => e.t === "turn.started")).toHaveLength(2);
  } finally {
    await session.close();
    await reader;
    rmSync(test.cwd, { recursive: true, force: true });
  }
});
it("interrupts once and continues with the next explicit send", async () => {
  const test = setup();
  const session = await new ClaudeAdapter(test.host).open(definition, test.options);
  const trace: AgentEvent[] = [];
  const reader = (async () => {
    for await (const event of session.events()) trace.push(event);
  })();
  try {
    await session.send([{ type: "text", text: "slow" }], "queue");
    expect(await session.send([{ type: "text", text: "normal" }], "queue")).toMatchObject({
      disposition: "queued",
    });
    await session.interrupt();
    await expect.poll(() => trace.filter((e) => e.t === "turn.done").length).toBe(1);
    expect(trace.find((e) => e.t === "turn.done")).toMatchObject({ status: "interrupted" });
    await session.send([{ type: "text", text: "normal" }], "queue");
    await expect.poll(() => trace.filter((e) => e.t === "turn.done").length).toBe(2);
    expect(trace.filter((e) => e.t === "turn.started")).toHaveLength(2);
  } finally {
    await session.close();
    await reader;
    rmSync(test.cwd, { recursive: true, force: true });
  }
});
it("uses profile identity for native approvals and rejects duplicate answers", async () => {
  const test = setup();
  const session = await new ClaudeAdapter(test.host).open(definition, test.options);
  const trace: AgentEvent[] = [];
  const reader = (async () => {
    for await (const event of session.events()) trace.push(event);
  })();
  try {
    await session.send([{ type: "text", text: "approval" }], "queue");
    await expect.poll(() => trace.some((e) => e.t === "interaction.requested")).toBe(true);
    const event = trace.find((e) => e.t === "interaction.requested");
    if (event?.t !== "interaction.requested") throw new Error("missing_interaction");
    expect(event.interaction).toMatchObject({ agentId: "profile", threadId: "thread" });
    const answer = {
      action: "accept" as const,
      choice: "allow_once",
      by: { kind: "human" as const, id: "user" },
      at: new Date().toISOString(),
    };
    await session.respond(event.interaction.id, answer);
    await expect(session.respond(event.interaction.id, answer)).rejects.toThrow(
      "interaction_not_pending",
    );
    await expect.poll(() => trace.some((e) => e.t === "turn.done")).toBe(true);
  } finally {
    await session.close();
    await reader;
    rmSync(test.cwd, { recursive: true, force: true });
  }
});

it.each([
  ["plan_file", "# Plan\nFrom file."],
  ["plan_stripped", "# Plan\nFrom call."],
])("reviews the plan when ExitPlanMode permission arrives without plan text (%s)", async (scenario, markdown) => {
  const test = setup();
  const session = await new ClaudeAdapter(test.host).open(definition, test.options);
  const trace: AgentEvent[] = [];
  const reader = (async () => {
    for await (const event of session.events()) trace.push(event);
  })();
  try {
    await session.send([{ type: "text", text: scenario }], "queue");
    await expect.poll(() => trace.some((e) => e.t === "interaction.requested")).toBe(true);
    const event = trace.find((e) => e.t === "interaction.requested");
    if (event?.t !== "interaction.requested") throw new Error("missing_interaction");
    expect(event.interaction).toMatchObject({
      type: "plan",
      context: { markdown },
    });
    await session.respond(event.interaction.id, {
      action: "accept",
      choice: "allow_once",
      by: { kind: "human", id: "user" },
      at: new Date().toISOString(),
    });
    await expect.poll(() => trace.some((e) => e.t === "turn.done")).toBe(true);
  } finally {
    await session.close();
    await reader;
    rmSync(test.cwd, { recursive: true, force: true });
  }
});
it("resumes an idle process with the same native id and returns summary context only", async () => {
  const test = setup();
  let refreshes = 0;
  const authorizations: string[] = [];
  const config = test.host.config;
  test.host.config = async (content, manifestId) => {
    const value = content as { mcpServers: { fixture: { headers: { Authorization: string } } } };
    authorizations.push(value.mcpServers.fixture.headers.Authorization);
    return config(content, manifestId);
  };
  test.options.refreshConnections = async () => [
    {
      name: "fixture",
      kind: "https",
      url: "https://example.com/mcp",
      headers: { Authorization: `Bearer rotated-${++refreshes}` },
    },
  ];
  const session = await new ClaudeAdapter(test.host, 1500, 30).open(definition, test.options);
  const trace: AgentEvent[] = [];
  const reader = (async () => {
    for await (const event of session.events()) trace.push(event);
  })();
  try {
    await session.send([{ type: "text", text: "normal" }], "queue");
    await expect.poll(() => trace.some((e) => e.t === "turn.done")).toBe(true);
    await expect
      .poll(
        async () => {
          await session.contextUsage();
          return test.starts();
        },
        { interval: 60 },
      )
      .toBeGreaterThan(1);
    expect(await session.contextUsage()).toEqual({ used: 20, size: 100 });
    expect(authorizations.length).toBeGreaterThan(1);
    expect(authorizations[0]).not.toBe(authorizations[1]);
    await session.send([{ type: "text", text: "normal" }], "queue");
    await expect.poll(() => trace.filter((e) => e.t === "turn.done").length).toBe(2);
    expect(trace.filter((e) => e.t === "session.ready")).toHaveLength(1);
    expect(trace.some((e) => e.t === "capabilities.updated")).toBe(true);
    await expect(session.setMode("bypassPermissions")).rejects.toThrow("unsupported_mode");
  } finally {
    await session.close();
    await reader;
    rmSync(test.cwd, { recursive: true, force: true });
  }
});
it("reserves resume ownership before asynchronous startup and releases it after close", async () => {
  const test = setup();
  const adapter = new ClaudeAdapter(test.host);
  const opts: OpenOptions = { ...test.options, mode: "resume", nativeId: "native-id" };
  const first = await adapter.open(definition, opts);
  try {
    expect(await openError(adapter.open(definition, opts))).toBe("native_session_in_use");
    expect(await openError(adapter.open({ ...definition, id: "other-profile" }, opts))).toBe(
      "native_session_in_use",
    );
    await first.close();
    const second = await adapter.open(definition, opts);
    try {
      await first.close();
      expect(await openError(adapter.open(definition, opts))).toBe("native_session_in_use");
    } finally {
      await second.close();
    }
  } finally {
    await first.close();
    rmSync(test.cwd, { recursive: true, force: true });
  }
});

it("opens against replayed real startup controls and discards detailed context fields", async () => {
  const test = setup();
  const records = readFileSync("fixtures/claude/2.1.299/initialize-mcp-no-auth.jsonl", "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  let controller: ReadableStreamDefaultController<Uint8Array>;
  let finish = () => {};
  const closed = new Promise<void>((resolve) => {
    finish = resolve;
  });
  test.host.connect = async () => ({
    input: new ReadableStream<Uint8Array>({
      start(value) {
        controller = value;
      },
    }),
    output: new WritableStream<Uint8Array>({
      write(bytes) {
        const request = JSON.parse(new TextDecoder().decode(bytes));
        const original = records.find(
          (r) => r.direction === "stdin" && r.message.request.subtype === request.request.subtype,
        );
        if (!original) throw new Error("unrecorded_control");
        const captured = records.find(
          (r) =>
            r.direction === "stdout" &&
            r.message.response.request_id === original.message.request_id,
        );
        const reply = structuredClone(captured.message);
        reply.response.request_id = request.request_id;
        controller.enqueue(new TextEncoder().encode(`${JSON.stringify(reply)}\n`));
      },
    }),
    closed,
    async close() {
      finish();
    },
  });
  const session = await new ClaudeAdapter(test.host).open(definition, {
    ...test.options,
    permissionProfile: "workspace_write",
  });
  try {
    const context = await session.contextUsage();
    expect(Object.keys(context ?? {})).toEqual(["used", "size"]);
    expect(context?.used).toBeGreaterThan(0);
    expect(context?.size).toBeGreaterThan(context?.used ?? 0);
  } finally {
    await session.close();
    rmSync(test.cwd, { recursive: true, force: true });
  }
});

it("loads managed skills through namespaced native plugin catalogs on open and resume", async () => {
  const test = setup(),
    pluginPath = path.join(test.cwd, "plugin"),
    namespace = "zoltbot-fixture";
  mkdirSync(path.join(pluginPath, ".claude-plugin"), { recursive: true });
  mkdirSync(path.join(pluginPath, "skills/release-notes"), { recursive: true });
  writeFileSync(
    path.join(pluginPath, ".claude-plugin/plugin.json"),
    JSON.stringify({ name: namespace }),
  );
  writeFileSync(
    path.join(pluginPath, "skills/release-notes/SKILL.md"),
    "---\nname: release-notes\ndescription: Test\n---\nNotes",
  );
  const managedSkills = [
    {
      name: "release-notes",
      namespace,
      pluginPath,
      path: path.join(pluginPath, "skills/release-notes"),
    },
  ];
  const adapter = new ClaudeAdapter(test.host);
  let session = await adapter.open(definition, { ...test.options, managedSkills });
  try {
    expect(session.capabilities.slashCommands).toEqual(
      expect.arrayContaining([
        { name: "zoltbot-fixture:release-notes", description: "Managed native fixture skill" },
      ]),
    );
    const nativeId = session.nativeId;
    await session.close();
    session = await adapter.open(definition, {
      ...test.options,
      mode: "resume",
      nativeId: nativeId ?? "",
      managedSkills,
    });
    expect(session.nativeId).toBe(nativeId);
    expect(
      session.capabilities.slashCommands?.some((c) => c.name === "zoltbot-fixture:release-notes"),
    ).toBe(true);
  } finally {
    await session.close();
    rmSync(test.cwd, { recursive: true, force: true });
  }
});
it("refuses a managed skill missing from the provider native catalog", async () => {
  const test = setup();
  try {
    await expect(
      new ClaudeAdapter(test.host).open(definition, {
        ...test.options,
        managedSkills: [
          { name: "missing", namespace: "not-reported", pluginPath: test.cwd, path: test.cwd },
        ],
      }),
    ).rejects.toThrow();
  } finally {
    rmSync(test.cwd, { recursive: true, force: true });
  }
});
