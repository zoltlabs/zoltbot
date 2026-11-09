import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import type { OpenOptions } from "@zoltbot/adapters-sdk";
import type { AgentDefinition, AgentEvent } from "@zoltbot/protocol";
import { expect, it } from "vitest";
import type { PiHost } from "./host.js";
import { PiAdapter } from "./index.js";

const definition: AgentDefinition = {
  id: "pi-test",
  displayName: "Pi test",
  adapter: "pi",
  binaryNames: [],
  versionCommand: [],
  launch: {
    command: process.execPath,
    args: ["--import", "tsx", path.resolve("tools/fakes/src/pi-conformance-provider.ts")],
    env: {},
  },
  testedVersions: "1.4.0",
  defaults: { permissionProfile: "read_only" },
  staticCapabilities: {},
  nativeSessionRoots: [],
  experimental: false,
};
function setup() {
  mkdirSync(".cache/tests", { recursive: true });
  const cwd = mkdtempSync(path.resolve(".cache/tests/pi-session-"));
  let starts = 0;
  const host: PiHost = {
    async probe() {
      return { installed: true, broken: false, version: "1.4.0", login: "signed_in" };
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
    async extension(source, sha256) {
      const file = path.join(cwd, "gate.ts");
      writeFileSync(file, source, { mode: 0o600 });
      if (createHash("sha256").update(source).digest("hex") !== sha256)
        throw new Error("extension_hash_mismatch");
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
          ...launch.env,
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
it("opens and streams a native turn through the native protocol fake", async () => {
  const test = setup();
  const adapter = new PiAdapter(test.host);
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
async function errorOf(open: Promise<{ close(): Promise<void> }>) {
  try {
    const session = await open;
    await session.close();
    return "opened";
  } catch (error) {
    return error instanceof Error ? error.message : "unknown";
  }
}
it("rejects a modified gate before launching any process", async () => {
  const test = setup();
  test.host.extension = async () => {
    const file = path.join(test.cwd, "modified-gate.ts");
    writeFileSync(file, "export default () => {}", { mode: 0o600 });
    return {
      path: file,
      async dispose() {
        rmSync(file, { force: true });
      },
    };
  };
  try {
    expect(await errorOf(new PiAdapter(test.host).open(definition, test.options))).toBe(
      "extension_hash_mismatch",
    );
    expect(test.starts()).toBe(0);
  } finally {
    rmSync(test.cwd, { recursive: true, force: true });
  }
});
it("keeps exclusive writers across definition aliases and later closes", async () => {
  const test = setup();
  const adapter = new PiAdapter(test.host);
  const options: OpenOptions = { ...test.options, mode: "resume", nativeId: "native" };
  const first = await adapter.open(definition, options);
  try {
    expect(await errorOf(adapter.open({ ...definition, id: "alias" }, options))).toBe(
      "native_session_in_use",
    );
    await first.close();
    const second = await adapter.open(definition, options);
    try {
      await first.close();
      expect(await errorOf(adapter.open(definition, options))).toBe("native_session_in_use");
    } finally {
      await second.close();
    }
  } finally {
    await first.close();
    rmSync(test.cwd, { recursive: true, force: true });
  }
});
it("limits model discovery and selection to the profile provider", async () => {
  const test = setup();
  const session = await new PiAdapter(test.host).open(
    { ...definition, flavor: "test" },
    test.options,
  );
  try {
    expect(session.capabilities.models.list).toEqual([{ id: "test:model", name: "Model" }]);
    await expect(session.setModel("other:model")).rejects.toThrow("unsupported_model");
  } finally {
    await session.close();
    rmSync(test.cwd, { recursive: true, force: true });
  }
});
