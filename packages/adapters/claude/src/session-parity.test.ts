import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import type { AgentSession, OpenOptions } from "@zoltbot/adapters-sdk";
import { type AgentEvent, AgentEventSchema, parse } from "@zoltbot/protocol";
import { expect, it } from "vitest";
import type { ClaudeHost } from "./host.js";
import { ClaudeAdapter } from "./index.js";

const definition = {
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
  defaults: { permissionProfile: "workspace_write" as const },
  staticCapabilities: {},
  nativeSessionRoots: [],
  experimental: false,
};
const owner = { kind: "human" as const, id: "user" };
async function harness(
  profile: OpenOptions["permissionProfile"],
  run: (
    session: AgentSession,
    trace: AgentEvent[],
    cwd: string,
    interaction: () => Promise<string>,
  ) => Promise<void>,
) {
  mkdirSync(".cache/tests", { recursive: true });
  const cwd = mkdtempSync(path.resolve(".cache/tests/claude-parity-"));
  const host: ClaudeHost = {
    async probe() {
      return { installed: true, broken: false, version: "2.1.299", login: "signed_in" };
    },
    async config(content) {
      const file = path.join(cwd, "mcp.json");
      writeFileSync(file, JSON.stringify(content), { mode: 0o600 });
      return { path: file, async dispose() {} };
    },
    async connect(_def, opts, launch) {
      const child = spawn(launch.command, launch.args, {
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
  const session = await new ClaudeAdapter(host).open(definition, {
    mode: "new",
    cwd,
    identity: { agentId: "profile", threadId: "thread" },
    permissionProfile: profile,
    hostMcp: { url: "http://127.0.0.1:1/mcp", token: "test-secret" },
  });
  const trace: AgentEvent[] = [];
  const reader = (async () => {
    for await (const event of session.events()) trace.push(event);
  })();
  let seen = 0;
  const interaction = async () => {
    await expect
      .poll(() => trace.filter((e) => e.t === "interaction.requested").length)
      .toBe(seen + 1);
    const event = trace.filter((e) => e.t === "interaction.requested")[seen++];
    if (event?.t !== "interaction.requested") throw new Error("missing_interaction");
    return event.interaction.id;
  };
  try {
    await run(session, trace, cwd, interaction);
    for (const event of trace) parse(AgentEventSchema, event);
  } finally {
    await session.close();
    await reader;
    rmSync(cwd, { recursive: true, force: true });
  }
}
const turns = (trace: AgentEvent[]) => trace.filter((e) => e.t === "turn.done").length;
const modes = (trace: AgentEvent[]) =>
  trace.flatMap((e) => (e.t === "mode.changed" ? [e.mode] : []));

it("reports modes per profile, at ready, on setMode, and after an accepted plan", async () => {
  await harness("workspace_write", async (session, trace, _cwd, interaction) => {
    expect(session.capabilities.modes).toEqual(["default", "acceptEdits", "plan"]);
    expect(session.capabilities).toMatchObject({
      elicitation: "form",
      compaction: { manual: true },
      rewind: true,
      backgroundTasks: true,
    });
    await expect
      .poll(() => trace.map((e) => e.t).slice(0, 2))
      .toEqual(["session.ready", "mode.changed"]);
    await expect(session.setMode("bypassPermissions")).rejects.toThrow("unsupported_mode");
    await session.setMode("plan");
    await session.send([{ type: "text", text: "plan" }], "queue");
    await session.respond(await interaction(), {
      action: "accept",
      choice: "allow_accept_edits",
      by: owner,
      at: new Date().toISOString(),
    });
    await expect.poll(() => turns(trace)).toBe(1);
    expect(modes(trace)).toEqual(["default", "plan", "acceptEdits"]);
    // The next init frame reports the native mode Claude now runs in; nothing changes.
    await session.send([{ type: "text", text: "normal" }], "queue");
    await expect.poll(() => turns(trace)).toBe(2);
    expect(modes(trace)).toEqual(["default", "plan", "acceptEdits"]);
  });
  await harness("full_access", async (session, trace) => {
    expect(session.capabilities.modes).toEqual([
      "default",
      "acceptEdits",
      "plan",
      "bypassPermissions",
      "auto",
    ]);
    await expect.poll(() => modes(trace)).toEqual(["bypassPermissions"]);
  });
});

it("forwards an allow_session grant to the session only and keeps plan feedback", async () => {
  await harness("workspace_write", async (session, trace, cwd, interaction) => {
    await session.send([{ type: "text", text: "suggestions" }], "queue");
    const id = await interaction();
    const request = trace.find((e) => e.t === "interaction.requested");
    expect(request?.t === "interaction.requested" && request.interaction.items[0]?.choices).toEqual(
      [
        { id: "allow_once" },
        { id: "allow_session", label: "Bash(npm test:*)" },
        { id: "reject_once" },
      ],
    );
    await session.respond(id, {
      action: "accept",
      choice: "allow_session",
      by: owner,
      at: new Date().toISOString(),
    });
    await expect.poll(() => turns(trace)).toBe(1);
    expect(JSON.parse(readFileSync(path.join(cwd, "permission-updates.json"), "utf8"))).toEqual([
      {
        type: "addRules",
        rules: [{ toolName: "Bash", ruleContent: "npm test:*" }],
        behavior: "allow",
        destination: "session",
      },
    ]);
    await session.send([{ type: "text", text: "plan" }], "queue");
    await session.respond(await interaction(), {
      action: "accept",
      choice: "allow_once",
      feedback: "Add a test.",
      by: owner,
      at: new Date().toISOString(),
    });
    await expect.poll(() => turns(trace)).toBe(2);
    expect(
      trace.some(
        (e) => e.t === "tool.done" && JSON.stringify(e.output).includes("## Reviewer notes"),
      ),
    ).toBe(true);
  });
});

it("compacts manually as one turn and refuses while busy", async () => {
  await harness("workspace_write", async (session, trace) => {
    await session.compact("keep the API notes");
    await expect.poll(() => turns(trace)).toBe(1);
    expect(
      trace.filter((e) => ["turn.started", "compaction", "turn.done"].includes(e.t)),
    ).toMatchObject([
      { t: "turn.started" },
      { t: "compaction", state: "started", trigger: "manual" },
      { t: "compaction", state: "done", trigger: "manual", tokensBefore: 20 },
      { t: "turn.done", status: "completed" },
    ]);
    await session.send([{ type: "text", text: "slow" }], "queue");
    await expect(session.compact()).rejects.toThrow("session_busy");
    await expect.poll(() => turns(trace)).toBe(2);
  });
});

it("reports background tasks between turns and stops them natively", async () => {
  await harness("workspace_write", async (session, trace) => {
    await session.send([{ type: "text", text: "background" }], "queue");
    await expect.poll(() => turns(trace)).toBe(1);
    // The agent notification arrives after the turn ended.
    await expect
      .poll(() =>
        trace.some(
          (e) =>
            e.t === "background.updated" && e.task.id === "agent-1" && e.task.state === "completed",
        ),
      )
      .toBe(true);
    const done = trace.findIndex((e) => e.t === "turn.done");
    expect(
      trace.findIndex((e) => e.t === "background.updated" && e.task.state === "completed"),
    ).toBeGreaterThan(done);
    expect(
      trace.find((e) => e.t === "background.updated" && e.task.id === "shell-1"),
    ).toMatchObject({
      task: {
        kind: "shell",
        description: "Watch",
        state: "running",
        outputPath: "/tmp/shell-1.output",
        toolItemId: "background-tool",
      },
    });
    await expect(session.stopBackground?.("agent-1")).rejects.toThrow(
      "background_task_not_running",
    );
    await session.stopBackground?.("shell-1");
    await expect
      .poll(
        () =>
          trace.filter(
            (e) =>
              e.t === "background.updated" && e.task.id === "shell-1" && e.task.state === "stopped",
          ).length,
      )
      .toBeGreaterThan(0);
  });
});

it("rewinds files to the checkpoint of a known turn", async () => {
  await harness("workspace_write", async (session, trace, cwd) => {
    const receipt = await session.send([{ type: "text", text: "normal" }], "queue");
    await expect.poll(() => turns(trace)).toBe(1);
    const turnId = (receipt.disposition === "started" && receipt.id) || "";
    await expect(session.rewindFiles?.("unknown", true)).rejects.toThrow("unsupported_rewind");
    expect(await session.rewindFiles?.(turnId, true)).toEqual({
      canRewind: true,
      files: ["safe.txt"],
      insertions: 2,
      deletions: 1,
    });
    expect(await session.rewindFiles?.(turnId, false)).toEqual({
      canRewind: true,
      files: ["safe.txt"],
      insertions: 2,
      deletions: 1,
    });
    expect(JSON.parse(readFileSync(path.join(cwd, "rewound.json"), "utf8"))).toHaveLength(1);
  });
});

it("answers elicitation forms and declines URL consent", async () => {
  await harness("workspace_write", async (session, trace, _cwd, interaction) => {
    await session.send([{ type: "text", text: "elicitation" }], "queue");
    const id = await interaction();
    await session.respond(id, {
      action: "accept",
      answers: { form: { value: { name: "Ada" } } },
      by: owner,
      at: new Date().toISOString(),
    });
    await expect.poll(() => turns(trace)).toBe(1);
    await session.send([{ type: "text", text: "elicitation_url" }], "queue");
    await session.respond(await interaction(), {
      action: "decline",
      by: owner,
      at: new Date().toISOString(),
    });
    await expect.poll(() => turns(trace)).toBe(2);
    const text = trace.flatMap((e) => (e.t === "message.done" ? [e.text] : [])).join("\n");
    expect(text).toContain('{"action":"accept","content":{"name":"Ada"}}');
    expect(text).toContain('{"action":"decline"}');
  });
});

it("reports a granted mode only after Claude confirms it", async () => {
  await harness("workspace_write", async (session, trace, cwd, interaction) => {
    await expect.poll(() => modes(trace)).toEqual(["default"]);
    writeFileSync(path.join(cwd, "refuse-modes.json"), JSON.stringify(["acceptEdits"]));
    await session.send([{ type: "text", text: "plan" }], "queue");
    await session.respond(await interaction(), {
      action: "accept",
      choice: "allow_accept_edits",
      by: owner,
      at: new Date().toISOString(),
    });
    await expect.poll(() => turns(trace)).toBe(1);
    expect(modes(trace)).toEqual(["default"]);
    expect(session.capabilities.safeModes).toEqual(["default", "plan", "acceptEdits"]);
  });
});

it("keeps bypass available after a full access session relaunches in another mode", async () => {
  await harness("full_access", async (session, trace) => {
    await session.setMode("default");
    await session.setModel("other-model");
    await session.setMode("bypassPermissions");
    expect(modes(trace)).toEqual(["bypassPermissions", "default", "bypassPermissions"]);
  });
});

it("switches models live but refuses relaunching changes while background tasks run", async () => {
  await harness("workspace_write", async (session, trace, cwd) => {
    await session.send([{ type: "text", text: "background" }], "queue");
    await expect.poll(() => turns(trace)).toBe(1);
    // The model and effort reach the running process, so its background tasks keep running.
    await session.setModel("other-model", "high");
    expect(JSON.parse(readFileSync(path.join(cwd, "live-model.json"), "utf8"))).toEqual({
      model: "other-model",
      effortLevel: "high",
    });
    await expect(session.rename("renamed")).rejects.toThrow("session_busy");
    await session.stopBackground?.("shell-1");
    await expect
      .poll(() =>
        trace.some(
          (e) =>
            e.t === "background.updated" && e.task.id === "agent-1" && e.task.state !== "running",
        ),
      )
      .toBe(true);
    await session.setModel("other-model");
  });
});

it("holds input and compaction until a rewind finishes", async () => {
  await harness("workspace_write", async (session, trace, cwd) => {
    const receipt = await session.send([{ type: "text", text: "normal" }], "queue");
    await expect.poll(() => turns(trace)).toBe(1);
    const turnId = (receipt.disposition === "started" && receipt.id) || "";
    const rewinding = session.rewindFiles?.(turnId, false);
    await expect(session.compact()).rejects.toThrow("session_busy");
    await expect(session.rewindFiles?.(turnId, true)).rejects.toThrow("session_busy");
    expect(await session.send([{ type: "text", text: "normal" }], "queue")).toEqual({
      disposition: "queued",
    });
    expect(await rewinding).toMatchObject({ canRewind: true });
    expect(JSON.parse(readFileSync(path.join(cwd, "rewound.json"), "utf8"))).toHaveLength(1);
    // The held input starts once the rewind is over.
    await expect.poll(() => turns(trace)).toBe(2);
  });
});
