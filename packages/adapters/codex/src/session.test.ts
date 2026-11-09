import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import type { OpenOptions } from "@zoltbot/adapters-sdk";
import type { AgentDefinition, AgentEvent } from "@zoltbot/protocol";
import { expect, it } from "vitest";
import type { CodexHost } from "./host.js";
import { CodexAdapter } from "./index.js";

const definition: AgentDefinition = {
  id: "codex-test",
  displayName: "Codex test",
  adapter: "codex",
  binaryNames: [],
  versionCommand: [],
  launch: {
    command: process.execPath,
    args: ["--import", "tsx", path.resolve("tools/fakes/src/codex-conformance-provider.ts")],
    env: {},
  },
  testedVersions: "0.164.0",
  defaults: { permissionProfile: "read_only" },
  staticCapabilities: {},
  nativeSessionRoots: [],
  experimental: false,
};
function setup() {
  mkdirSync(".cache/tests", { recursive: true });
  const cwd = mkdtempSync(path.resolve(".cache/tests/codex-session-"));
  let starts = 0;
  let privateReads = 0;
  const host: CodexHost = {
    privateRead() {
      privateReads++;
    },
    async probe() {
      return { installed: true, broken: false, version: "0.164.0", login: "signed_in" };
    },
    async schema() {
      return JSON.parse(
        readFileSync("fixtures/codex/0.164.0/protocol-experimental.schema.json", "utf8"),
      );
    },
    async connect(def, opts) {
      expect(def.launch.args.filter((arg) => arg === "app-server")).toHaveLength(1);
      expect(def.launch.args.slice(0, 2)).toEqual(["--import", "tsx"]);
      starts++;
      const child = spawn(def.launch.command, def.launch.args, {
        cwd: opts.cwd,
        env: { PATH: process.env.PATH, TSX_DISABLE_CACHE: "1", HOME: cwd, TMPDIR: cwd },
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
  return { cwd, host, options, starts: () => starts, privateReads: () => privateReads };
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
it("opens and streams a native turn through the schema validated fake", async () => {
  const test = setup();
  const adapter = new CodexAdapter(test.host);
  const session = await adapter.open(definition, test.options);
  expect(test.privateReads()).toBe(1);
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
it("shares one process across threads and keeps another thread usable after closing one", async () => {
  const test = setup();
  const adapter = new CodexAdapter(test.host);
  const first = await adapter.open(definition, test.options);
  const second = await adapter.open(definition, {
    ...test.options,
    identity: { agentId: "second", threadId: "second-thread" },
  });
  const trace: AgentEvent[] = [];
  const reader = (async () => {
    for await (const event of second.events()) trace.push(event);
  })();
  try {
    expect(test.starts()).toBe(1);
    expect(first.nativeId).not.toBe(second.nativeId);
    await first.close();
    await second.send([{ type: "text", text: "normal" }], "queue");
    await expect.poll(() => trace.some((e) => e.t === "turn.done")).toBe(true);
  } finally {
    await first.close();
    await second.close();
    await reader;
    rmSync(test.cwd, { recursive: true, force: true });
  }
});

it("forks an owned native thread but rejects a second writer on resume", async () => {
  const test = setup();
  const adapter = new CodexAdapter(test.host);
  const first = await adapter.open(definition, test.options);
  let fork: Awaited<ReturnType<CodexAdapter["open"]>> | undefined;
  try {
    await expect(
      openError(
        adapter.open(definition, { ...test.options, mode: "resume", nativeId: first.nativeId }),
      ),
    ).resolves.toBe("native_session_in_use");
    expect(
      await openError(
        adapter.open(
          { ...definition, id: "other-profile" },
          {
            ...test.options,
            mode: "resume",
            nativeId: first.nativeId,
          },
        ),
      ),
    ).toBe("native_session_in_use");
    fork = await adapter.open(definition, {
      ...test.options,
      mode: "fork",
      nativeId: first.nativeId,
      identity: { agentId: "fork", threadId: "fork-thread" },
    });
    expect(fork.nativeId).not.toBe(first.nativeId);
    expect(test.starts()).toBe(1);
  } finally {
    await fork?.close();
    await first.close();
    rmSync(test.cwd, { recursive: true, force: true });
  }
});

it("lists native sessions with explicit sources and current ownership", async () => {
  const test = setup();
  const adapter = new CodexAdapter(test.host);
  const session = await adapter.open(definition, test.options);
  try {
    const sessions = await adapter.listNativeSessions(definition, { cwd: test.cwd });
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      nativeId: session.nativeId,
      cwd: test.cwd,
      adopted: true,
      threadId: "thread",
      source: "vscode",
    });
    expect(test.starts()).toBe(1);
  } finally {
    await session.close();
    rmSync(test.cwd, { recursive: true, force: true });
  }
});

it("requires authentication before creating a thread when the native account is signed out", async () => {
  const test = setup();
  const def = structuredClone(definition);
  def.launch.args = [
    "--import",
    "tsx",
    path.resolve("tools/fakes/src/fake-codex.ts"),
    path.resolve("tools/fakes/scenarios/codex-signed-out.yaml"),
  ];
  try {
    await expect(openError(new CodexAdapter(test.host).open(def, test.options))).resolves.toBe(
      "auth_required",
    );
  } finally {
    rmSync(test.cwd, { recursive: true, force: true });
  }
});

it("does not accept a later provider completion after the session has failed", async () => {
  const test = setup();
  const session = await new CodexAdapter(test.host).open(definition, test.options);
  const trace: AgentEvent[] = [];
  const reader = (async () => {
    for await (const event of session.events()) trace.push(event);
  })();
  try {
    await session.send([{ type: "text", text: "slow" }], "queue");
    await session.fail("process_died");
    const started = trace.find((e) => e.t === "turn.started");
    if (started?.t !== "turn.started") throw new Error("missing turn");
    await session.receive("turn/completed", {
      threadId: session.nativeId,
      turn: { id: started.turnId, status: "completed", items: [] },
    });
    expect(trace.filter((e) => e.t === "turn.done")).toHaveLength(1);
    expect(trace.find((e) => e.t === "turn.done")).toMatchObject({ status: "failed" });
  } finally {
    await session.close();
    await reader;
    rmSync(test.cwd, { recursive: true, force: true });
  }
});

it("rejects a broken binary before connecting", async () => {
  const test = setup();
  test.host.probe = async () => ({ installed: true, broken: true, login: "unknown" });
  try {
    await expect(
      openError(new CodexAdapter(test.host).open(definition, test.options)),
    ).resolves.toBe("binary_broken");
    expect(test.starts()).toBe(0);
  } finally {
    rmSync(test.cwd, { recursive: true, force: true });
  }
});

it("does not poison the connection cache after a failed preflight", async () => {
  const test = setup();
  const original = test.host.schema;
  let failed = false;
  test.host.schema = async (def) => {
    if (!failed) {
      failed = true;
      throw new Error("temporary_schema_failure");
    }
    return original(def);
  };
  const adapter = new CodexAdapter(test.host);
  let session: Awaited<ReturnType<CodexAdapter["open"]>> | undefined;
  try {
    await expect(openError(adapter.open(definition, test.options))).resolves.toBe(
      "temporary_schema_failure",
    );
    session = await adapter.open(definition, test.options);
    expect(session.nativeId).toBeDefined();
  } finally {
    await session?.close();
    rmSync(test.cwd, { recursive: true, force: true });
  }
});

it("reserves concurrent native resumes before issuing the second thread mutation", async () => {
  const test = setup();
  const adapter = new CodexAdapter(test.host);
  const initial = await adapter.open(definition, test.options);
  const nativeId = initial.nativeId;
  await initial.close();
  const results = await Promise.allSettled([
    adapter.open(definition, { ...test.options, mode: "resume", nativeId }),
    adapter.open(definition, { ...test.options, mode: "resume", nativeId }),
  ]);
  try {
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected");
    expect(rejected?.status === "rejected" ? rejected.reason.message : "missing").toBe(
      "native_session_in_use",
    );
  } finally {
    for (const result of results) if (result.status === "fulfilled") await result.value.close();
    rmSync(test.cwd, { recursive: true, force: true });
  }
});

it("releases the native writer after physical failure without releasing a later owner's lease", async () => {
  const test = setup();
  const adapter = new CodexAdapter(test.host);
  const initial = await adapter.open(definition, test.options);
  let resumed: Awaited<ReturnType<CodexAdapter["open"]>> | undefined;
  try {
    await initial.fail("process_died");
    resumed = await adapter.open(definition, {
      ...test.options,
      mode: "resume",
      nativeId: initial.nativeId,
    });
    await initial.close();
    expect(
      await openError(
        adapter.open(definition, { ...test.options, mode: "resume", nativeId: initial.nativeId }),
      ),
    ).toBe("native_session_in_use");
    expect(resumed.nativeId).toBe(initial.nativeId);
  } finally {
    await initial.close();
    await resumed?.close();
    rmSync(test.cwd, { recursive: true, force: true });
  }
});

it("rejects a newly installed unverified version before native fork dispatch", async () => {
  const test = setup();
  const adapter = new CodexAdapter(test.host);
  try {
    expect(
      await openError(
        adapter.open(definition, {
          ...test.options,
          mode: "fork",
          fork: { sourceNativeId: "parent", sourceCwd: test.cwd, boundary: { kind: "latest" } },
        }),
      ),
    ).toBe("native_fork_unverified");
    expect(test.privateReads()).toBe(0);
  } finally {
    rmSync(test.cwd, { recursive: true, force: true });
  }
});
