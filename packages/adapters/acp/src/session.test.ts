import { spawn } from "node:child_process";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import type { OpenOptions } from "@zoltbot/adapters-sdk";
import type { AgentDefinition, AgentEvent } from "@zoltbot/protocol";
import { describe, expect, it } from "vitest";
import { readyChild } from "../../../../tools/fakes/src/ready-child.js";
import { FlavorRegistry, genericFlavor } from "./flavor.js";
import { AcpAdapter } from "./index.js";
import type { AcpHost } from "./transport.js";

const definition: AgentDefinition = {
  id: "test",
  displayName: "Test ACP",
  adapter: "acp",
  binaryNames: [],
  versionCommand: [],
  launch: {
    command: process.execPath,
    args: [
      "--import",
      "tsx",
      path.resolve("tools/fakes/src/fake-acp.ts"),
      path.resolve("tools/fakes/scenarios/acp-normal.yaml"),
    ],
    env: {},
  },
  testedVersions: "fake",
  defaults: { permissionProfile: "read_only" },
  staticCapabilities: {},
  nativeSessionRoots: [],
  experimental: false,
};
const options: OpenOptions = {
  mode: "new",
  cwd: process.cwd(),
  permissionProfile: "read_only",
  identity: { agentId: "test-agent", threadId: "test-thread" },
  hostMcp: { url: "http://127.0.0.1:1/mcp", token: "test-secret" },
  appendInstructions: "Follow repository rules.",
};
const host: AcpHost = {
  async probe() {
    return { installed: true, broken: false, login: "unknown" };
  },
  async connect(def, opts) {
    const child = spawn(def.launch.command, def.launch.args, {
      cwd: opts.cwd,
      env: {
        PATH: process.env.PATH,
        TSX_DISABLE_CACHE: "1",
        TMPDIR: path.resolve(".cache/tmp"),
        ...(opts.env ?? {}),
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
    await readyChild(child);
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
async function until(trace: AgentEvent[], predicate: (e: AgentEvent) => boolean) {
  await expect.poll(() => trace.some(predicate), { timeout: 3000 }).toBe(true);
}
describe("ACP session with real stdio wire fake", () => {
  it("initializes v1, creates a session with host MCP, streams and completes", async () => {
    const adapter = new AcpAdapter(host);
    const session = await adapter.open(definition, options);
    const trace: AgentEvent[] = [];
    const reader = (async () => {
      for await (const event of session.events()) trace.push(event);
    })();
    try {
      expect(session.nativeId).toBe("fake-session");
      expect(session.capabilities.resume).toBe(true);
      expect(session.capabilities.steer).toBe("queue_only");
      expect(await session.send([{ type: "text", text: "normal" }], "queue")).toMatchObject({
        disposition: "started",
      });
      await until(trace, (e) => e.t === "turn.done");
      expect(trace.find((e) => e.t === "message.done")).toMatchObject({ text: "ok" });
      expect(trace.find((e) => e.t === "session.ready")).toBeDefined();
    } finally {
      await session.close();
      await reader;
    }
  });
  it("does not claim unsupported fork and rejects before launching", async () => {
    await expect(
      new AcpAdapter(host).open(definition, { ...options, mode: "fork", nativeId: "old" }),
    ).rejects.toThrow("unsupported_fork");
  });
  it("keeps opaque permission choices and sends the selected provider id", async () => {
    const def = structuredClone(definition);
    def.launch.args[3] = path.resolve("tools/fakes/scenarios/acp-approval.yaml");
    const session = await new AcpAdapter(host).open(def, options);
    const trace: AgentEvent[] = [];
    const reader = (async () => {
      for await (const event of session.events()) trace.push(event);
    })();
    try {
      await session.send([{ type: "text", text: "approval" }], "queue");
      await until(trace, (e) => e.t === "interaction.requested");
      const requested = trace.find((e) => e.t === "interaction.requested");
      if (requested?.t !== "interaction.requested") throw new Error("missing interaction");
      expect(requested.interaction.agentId).toBe("test-agent");
      expect(requested.interaction.threadId).toBe("test-thread");
      await session.respond(requested.interaction.id, {
        action: "accept",
        choice: "opaque-allow",
        by: { kind: "human", id: "test" },
        at: "2026-10-27T12:00:00Z",
      });
      await until(trace, (e) => e.t === "tool.done" && e.output === "accepted");
      expect(trace.filter((e) => e.t === "interaction.cleared")).toHaveLength(1);
      await expect(
        session.respond(requested.interaction.id, {
          action: "cancel",
          by: { kind: "human", id: "test" },
          at: "2026-10-27T12:00:00Z",
        }),
      ).rejects.toThrow("interaction_not_pending");
    } finally {
      await session.close();
      await reader;
    }
  });
  it("queues a second prompt and injects instructions only once", async () => {
    const def = structuredClone(definition);
    def.launch.args[3] = path.resolve("tools/fakes/scenarios/acp-queue.yaml");
    const session = await new AcpAdapter(host).open(def, options);
    const trace: AgentEvent[] = [];
    const reader = (async () => {
      for await (const event of session.events()) trace.push(event);
    })();
    try {
      await session.send([{ type: "text", text: "first" }], "queue");
      expect(await session.send([{ type: "text", text: "second" }], "steer")).toEqual({
        disposition: "queued",
      });
      await expect.poll(() => trace.filter((e) => e.t === "turn.done").length).toBe(2);
      expect(trace.find((e) => e.t === "message.done")).toMatchObject({ text: "second" });
    } finally {
      await session.close();
      await reader;
    }
  });
  it("cancels the active prompt and accepts a later prompt", async () => {
    const def = structuredClone(definition);
    def.launch.args[3] = path.resolve("tools/fakes/scenarios/acp-cancel.yaml");
    const session = await new AcpAdapter(host).open(def, options);
    const trace: AgentEvent[] = [];
    const reader = (async () => {
      for await (const event of session.events()) trace.push(event);
    })();
    try {
      await session.send([{ type: "text", text: "slow" }], "queue");
      await until(trace, (e) => e.t === "text.delta");
      await session.interrupt();
      await until(trace, (e) => e.t === "turn.done" && e.status === "interrupted");
      await session.send([{ type: "text", text: "normal" }], "queue");
      await until(trace, (e) => e.t === "turn.done" && e.status === "completed");
    } finally {
      await session.close();
      await reader;
    }
  });
  it("routes an advertised elicitation form and validates the response", async () => {
    const def = structuredClone(definition);
    def.launch.args[3] = path.resolve("tools/fakes/scenarios/acp-form.yaml");
    const session = await new AcpAdapter(host).open(def, options);
    const trace: AgentEvent[] = [];
    const reader = (async () => {
      for await (const event of session.events()) trace.push(event);
    })();
    try {
      await session.send([{ type: "text", text: "form" }], "queue");
      await until(trace, (e) => e.t === "interaction.requested");
      const requested = trace.find((e) => e.t === "interaction.requested");
      if (requested?.t !== "interaction.requested") throw new Error("missing form");
      expect(requested.interaction.type).toBe("form");
      expect(requested.interaction.agentId).toBe("test-agent");
      expect(requested.interaction.threadId).toBe("test-thread");
      await session.respond(requested.interaction.id, {
        action: "accept",
        answers: { form: { value: { name: "chosen" } } },
        by: { kind: "human", id: "test" },
        at: "2026-10-27T00:00:00Z",
      });
      await until(trace, (e) => e.t === "text.delta" && e.text === "accepted");
    } finally {
      await session.close();
      await reader;
    }
  });
  it("ends a stalled prompt with a visible error and rejects later input", async () => {
    const def = structuredClone(definition);
    def.launch.args[3] = path.resolve("tools/fakes/scenarios/acp-hang.yaml");
    const session = await new AcpAdapter(host, undefined, 500).open(def, options);
    const trace: AgentEvent[] = [];
    const reader = (async () => {
      for await (const event of session.events()) trace.push(event);
    })();
    try {
      await session.send([{ type: "text", text: "hang" }], "queue");
      await until(trace, (e) => e.t === "status" && e.detail === "request_timeout");
      await until(trace, (e) => e.t === "turn.done" && e.status === "failed");
      await expect(session.send([{ type: "text", text: "late" }], "queue")).rejects.toThrow(
        "session_closed",
      );
    } finally {
      await session.close();
      await reader;
    }
  });
  it("applies advertised model and effort ids at open and switches an advertised mode", async () => {
    const def = structuredClone(definition);
    def.launch.args[3] = path.resolve("tools/fakes/scenarios/acp-config.yaml");
    const session = await new AcpAdapter(host).open(def, {
      ...options,
      model: "large",
      effort: "high",
    });
    const reader = (async () => {
      for await (const event of session.events()) {
        expect(event.t).toBeDefined();
      }
    })();
    try {
      expect(session.capabilities.models.selectable).toBe(true);
      expect(session.capabilities.effort).toEqual(["low", "high"]);
      await session.setMode("plan");
      await expect(session.setMode("invented")).rejects.toThrow("unsupported_mode");
      await expect(session.setModel("invented")).rejects.toThrow("unsupported_model_selection");
    } finally {
      await session.close();
      await reader;
    }
  });
  it("sends manual compaction only after the provider advertises the command", async () => {
    const def = structuredClone(definition);
    def.launch.args[3] = path.resolve("tools/fakes/scenarios/acp-compaction.yaml");
    const session = await new AcpAdapter(host).open(def, options);
    const trace: AgentEvent[] = [];
    const reader = (async () => {
      for await (const event of session.events()) trace.push(event);
    })();
    try {
      await expect(session.compact()).rejects.toThrow("unsupported_manual_compaction");
      await session.send([{ type: "text", text: "normal" }], "queue");
      await until(trace, (e) => e.t === "turn.done");
      await session.compact("keep decisions");
      await until(trace, (e) => e.t === "compaction" && e.state === "done");
      expect(trace.filter((e) => e.t === "compaction").every((e) => e.trigger === "manual")).toBe(
        true,
      );
    } finally {
      await session.close();
      await reader;
    }
  });
  it("maps flavor extension interactions without changes to the generic client", async () => {
    const def = structuredClone(definition);
    def.launch.args[3] = path.resolve("tools/fakes/scenarios/acp-extension.yaml");
    def.flavor = "test-extension";
    const flavors = new FlavorRegistry();
    flavors.register({
      ...genericFlavor,
      id: "test-extension",
      interactionCapabilities: { questions: "native", planReview: "none" },
      mapExtensionRequest(method) {
        return method === "_example/question"
          ? {
              id: "placeholder",
              agentId: "placeholder",
              threadId: "placeholder",
              type: "question",
              items: [{ id: "q", prompt: "Choose", allowOther: true }],
              chain: [],
              urgency: "blocking",
            }
          : undefined;
      },
      mapExtensionAnswer(_method, _params, answer) {
        return { answer: answer?.answers?.q?.other };
      },
    });
    const session = await new AcpAdapter(host, flavors).open(def, options);
    const trace: AgentEvent[] = [];
    const reader = (async () => {
      for await (const event of session.events()) trace.push(event);
    })();
    try {
      expect(session.capabilities.questions).toBe("native");
      await session.send([{ type: "text", text: "question" }], "queue");
      await until(trace, (e) => e.t === "interaction.requested");
      const requested = trace.find((e) => e.t === "interaction.requested");
      if (requested?.t !== "interaction.requested")
        throw new Error("missing extension interaction");
      expect(requested.interaction.threadId).toBe("test-thread");
      await session.respond(requested.interaction.id, {
        action: "accept",
        answers: { q: { other: "chosen" } },
        by: { kind: "human", id: "test" },
        at: "2026-10-27T00:00:00Z",
      });
      await until(trace, (e) => e.t === "text.delta" && e.text === "accepted");
    } finally {
      await session.close();
      await reader;
    }
  });
  it("reloads the same native session when a flavor requires cancel then resume", async () => {
    const def = structuredClone(definition);
    def.launch.args[3] = path.resolve("tools/fakes/scenarios/acp-cancel-resume.yaml");
    def.flavor = "test-resume";
    const flavors = new FlavorRegistry();
    flavors.register({ ...genericFlavor, id: "test-resume", cancelBehavior: "cancel_then_resume" });
    const session = await new AcpAdapter(host, flavors).open(def, options);
    const trace: AgentEvent[] = [];
    const reader = (async () => {
      for await (const event of session.events()) trace.push(event);
    })();
    try {
      await session.send([{ type: "text", text: "slow" }], "queue");
      await until(trace, (e) => e.t === "text.delta");
      await session.interrupt();
      expect(session.nativeId).toBe("fake-session");
      await session.send([{ type: "text", text: "normal" }], "queue");
      await until(trace, (e) => e.t === "turn.done" && e.status === "completed");
    } finally {
      await session.close();
      await reader;
    }
  });
});
it("reserves a native resume before asynchronous initialization and rejects a second writer", async () => {
  const adapter = new AcpAdapter(host);
  const first = await adapter.open(definition, options);
  try {
    let error = "";
    try {
      const nativeId = first.nativeId;
      if (!nativeId) throw new Error("missing_native_id");
      const second = await adapter.open(definition, { ...options, mode: "resume", nativeId });
      await second.close();
    } catch (value) {
      error = value instanceof Error ? value.message : "unknown";
    }
    expect(error).toBe("native_session_in_use");
  } finally {
    await first.close();
  }
});
it("selects the advertised read only config mode before session readiness and prevents widening", async () => {
  const def = structuredClone(definition);
  def.flavor = "opencode";
  def.launch.args[3] = path.resolve("tools/fakes/scenarios/acp-mode-config.yaml");
  const session = await new AcpAdapter(host).open(def, options);
  const trace: AgentEvent[] = [];
  const reader = (async () => {
    for await (const event of session.events()) trace.push(event);
  })();
  try {
    expect(session.capabilities.modes).toEqual(["build", "plan"]);
    await expect(session.setMode("build")).rejects.toThrow("permission_profile_ceiling");
    await session.send([{ type: "text", text: "normal" }], "queue");
    await until(trace, (e) => e.t === "turn.done");
  } finally {
    await session.close();
    await reader;
  }
});
it("denies execution under a read only profile without issuing a human approval", async () => {
  const def = structuredClone(definition);
  def.launch.args[3] = path.resolve("tools/fakes/scenarios/acp-read-only-deny.yaml");
  const session = await new AcpAdapter(host).open(def, options);
  const trace: AgentEvent[] = [];
  const reader = (async () => {
    for await (const event of session.events()) trace.push(event);
  })();
  try {
    await session.send([{ type: "text", text: "normal" }], "queue");
    await until(trace, (e) => e.t === "tool.done");
    expect(trace.some((e) => e.t === "interaction.requested")).toBe(false);
    expect(trace.find((e) => e.t === "tool.done")).toMatchObject({ status: "denied" });
  } finally {
    await session.close();
    await reader;
  }
});
it("keeps Cursor questions pending when an unsupported free text answer is rejected", async () => {
  const def = structuredClone(definition);
  def.flavor = "cursor";
  def.launch.args[3] = path.resolve("tools/fakes/scenarios/acp-cursor-question.yaml");
  const session = await new AcpAdapter(host).open(def, {
    ...options,
    permissionProfile: "workspace_write",
  });
  const trace: AgentEvent[] = [];
  const reader = (async () => {
    for await (const event of session.events()) trace.push(event);
  })();
  try {
    await session.send([{ type: "text", text: "question" }], "queue");
    await until(trace, (e) => e.t === "interaction.requested");
    const event = trace.find((e) => e.t === "interaction.requested");
    if (event?.t !== "interaction.requested") throw new Error("missing_question");
    const answer = {
      action: "accept" as const,
      by: { kind: "human" as const, id: "user" },
      at: "2026-10-27T00:00:00Z",
    };
    await expect(
      session.respond(event.interaction.id, {
        ...answer,
        answers: { choice: { other: "unsupported" } },
      }),
    ).rejects.toThrow("invalid_question_answer");
    expect(trace.filter((e) => e.t === "interaction.cleared")).toHaveLength(0);
    await session.respond(event.interaction.id, {
      ...answer,
      answers: { choice: { options: ["native-option"] } },
    });
    await until(trace, (e) => e.t === "tool.done");
    expect(trace.filter((e) => e.t === "interaction.cleared")).toHaveLength(1);
  } finally {
    await session.close();
    await reader;
  }
});

for (const firstPromptPending of [false, true])
  it(`injects resume instructions only with positive evidence of a never-prompted session (${firstPromptPending})`, async () => {
    const def = structuredClone(definition);
    def.launch.args[3] = path.resolve(
      `tools/fakes/scenarios/acp-resume-${firstPromptPending ? "empty" : "existing"}.yaml`,
    );
    const session = await new AcpAdapter(host).open(def, {
      ...options,
      mode: "resume",
      nativeId: "fake-session",
      firstPromptPending,
    });
    const trace: AgentEvent[] = [];
    const reader = (async () => {
      for await (const event of session.events()) trace.push(event);
    })();
    try {
      await session.send([{ type: "text", text: "hello" }], "queue");
      await until(trace, (event) => event.t === "turn.done");
      expect(trace.find((event) => event.t === "turn.done")).toMatchObject({ status: "completed" });
    } finally {
      await session.close();
      await reader;
    }
  });
