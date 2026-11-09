import { readFileSync } from "node:fs";
import path from "node:path";
import { AcpAdapter } from "@zoltbot/adapters-acp";
import { ClaudeAdapter } from "@zoltbot/adapters-claude";
import { CodexAdapter } from "@zoltbot/adapters-codex";
import type { AgentAdapter, OpenOptions } from "@zoltbot/adapters-sdk";
import { handle } from "@zoltbot/core";
import { NativeProcesses, RuntimeFiles, SessionManager } from "@zoltbot/daemon";
import { SessionTokens, startHostMcp, ToolDispatcher } from "@zoltbot/hostmcp";
import type { AgentDefinition } from "@zoltbot/protocol";
import { expect, it } from "vitest";
import type { Redactor } from "../../../packages/daemon/src/logging.js";
import { NativeRuntimeHost } from "../../../packages/daemon/src/native-runtime.js";
import { at, runtimeFixture } from "./runtime-fixture.js";

for (const provider of ["claude", "codex", "acp"] as const)
  it(`assembles ${provider} through the runtime manager, real native transport and scoped HTTP host`, async () => {
    const f = await runtimeFixture();
    const processes = new NativeProcesses(path.join(f.root, "logs")),
      files = new RuntimeFiles(path.join(f.root, "private-runtime"));
    const tokens = new SessionTokens(),
      audits: string[] = [];
    let calls = 0,
      issued: string | undefined;
    const dispatcher = new ToolDispatcher(tokens, {
      tools: new Map([
        [
          "team_fixture_ping",
          async ({ actor }) => {
            expect(actor).toMatchObject({ agentId: "profile", threadId: "thread" });
            expect(actor.turnId).toBeTypeOf("string");
            expect(
              f.store
                .snapshot(["turn"])
                .turn?.some((row) => row.id === actor.turnId && row.status === "running"),
            ).toBe(true);
            calls++;
            return { text: "scoped-host-ok" };
          },
        ],
      ]),
      authorize: (actor) =>
        actor.agentId === "profile" &&
        actor.threadId === "thread" &&
        f.store
          .snapshot(["session"])
          .session?.some(
            (row) => row.id === actor.sessionId && ["ready", "running"].includes(String(row.state)),
          ) === true,
      checkLimits: () => true,
      audit: async (record) => {
        audits.push(record.result);
      },
    });
    const mcp = await startHostMcp({
      tokens,
      dispatcher,
      tools: [
        {
          name: "team_fixture_ping",
          description: "Synthetic scoped transport proof.",
          inputSchema: { type: "object", properties: {}, additionalProperties: false },
        },
      ],
    });
    const probe = async () => ({
      installed: true,
      broken: false,
      login: "unknown" as const,
      version: "fixture",
    });
    const connect = (
      redactor: Redactor,
      launch: { command: string; args: string[]; cwd: string; env: Record<string, string> },
    ) => processes.connect(launch, redactor);
    const registry = new Map<string, (redactor: Redactor) => AgentAdapter>([
      [
        "claude",
        (redactor) =>
          new ClaudeAdapter(
            {
              probe,
              config: (content) => files.config(content),
              async connect(_def, _options, launch) {
                return connect(redactor, launch);
              },
            },
            5000,
          ),
      ],
      [
        "codex",
        (redactor) =>
          new CodexAdapter(
            {
              probe,
              async schema() {
                return JSON.parse(
                  readFileSync("fixtures/codex/0.164.0/protocol-experimental.schema.json", "utf8"),
                );
              },
              async connect(definition, options) {
                return connect(redactor, {
                  ...definition.launch,
                  cwd: options.cwd,
                  env: { ...definition.launch.env, ...options.env },
                });
              },
            },
            5000,
          ),
      ],
      [
        "acp",
        (redactor) =>
          new AcpAdapter(
            {
              probe,
              async connect(definition: AgentDefinition, options: OpenOptions) {
                return connect(redactor, {
                  ...definition.launch,
                  cwd: options.cwd,
                  env: { ...definition.launch.env, ...options.env },
                });
              },
            },
            undefined,
            5000,
          ),
      ],
    ]);
    f.store.dispatch("close-seed", (state) =>
      handle(
        state,
        { type: "transition", kind: "session", id: "session", to: "closed" },
        { commandId: "close-seed", at, actor: { kind: "system", id: "runtime" } },
      ),
    );
    f.store.dispatch("native-definition", (state) =>
      handle(
        state,
        {
          type: "update",
          kind: "agentDefinition",
          id: "fake",
          changes: {
            adapter: provider,
            launch: {
              command: process.execPath,
              args: [
                "--import",
                "tsx",
                path.resolve(`tools/fakes/src/${provider}-conformance-provider.ts`),
              ],
              env: { HOME: f.root, TMPDIR: f.root, TSX_DISABLE_CACHE: "1" },
            },
          },
        },
        { commandId: "native-definition", at, actor: { kind: "human", id: "owner" } },
      ),
    );
    const runtime = new NativeRuntimeHost({
      adapters: registry,
      workspace: async () => ({ cwd: f.root }),
      estimate: (text) => text.length,
      toolTokens: 8,
      async bind(identity) {
        issued = tokens.issue(identity);
        return {
          url: mcp.url,
          token: issued,
          setTurn: (turnId) => tokens.setTurn(identity.sessionId, turnId),
          async close() {
            tokens.revoke(identity.sessionId);
          },
        };
      },
    });
    const manager = new SessionManager({ store: f.store, host: runtime, publish() {} });
    try {
      const worker = await manager.ensure("thread");
      f.queue("native-host-call", "host_tools");
      await worker.wake();
      await expect
        .poll(() => f.store.snapshot(["turn"]).turn?.some((row) => row.status === "completed"), {
          timeout: 5000,
        })
        .toBe(true);
      expect(calls).toBe(1);
      expect(audits).toEqual(["started", "succeeded"]);
      expect(tokens.authenticate(`Bearer ${issued}`)).not.toHaveProperty("turnId");
      expect(JSON.stringify(f.store.snapshot())).not.toContain(issued);
      await manager.close();
      expect(tokens.authenticate(`Bearer ${issued}`)).toBeUndefined();
      expect(
        f.store.snapshot(["session"]).session?.filter((row) => row.state === "closed"),
      ).toHaveLength(2);
    } finally {
      await manager.close();
      await processes.close();
      await files.close();
      await mcp.close();
      f.close();
    }
  });

it("closes an opened child and revokes its tools when the selected directory was replaced during open", async () => {
  const { mkdirSync, renameSync } = await import("node:fs");
  const { ReferenceAdapter, ReferenceSession } = await import("./reference-adapter.js");
  const f = await runtimeFixture();
  const workspace = path.join(f.root, "workspace");
  mkdirSync(workspace);
  f.store.dispatch("close-seed", (state) =>
    handle(
      state,
      { type: "transition", kind: "session", id: "session", to: "closed" },
      { commandId: "close-seed", at, actor: { kind: "system", id: "runtime" } },
    ),
  );
  f.queue("pending", "must remain queued");
  let closed = 0,
    revoked = 0;
  const runtime = new NativeRuntimeHost({
    adapters: new Map([
      [
        "reference",
        () =>
          ({
            ...new ReferenceAdapter(),
            id: "reference",
            manifest: () => new ReferenceAdapter().manifest(),
            probe: async (definition: AgentDefinition) => new ReferenceAdapter().probe(definition),
            listNativeSessions: async (definition: AgentDefinition, filter: { cwd?: string }) =>
              new ReferenceAdapter().listNativeSessions(definition, filter),
            async open(_definition: AgentDefinition, options: OpenOptions) {
              const session = await new ReferenceSession(options).open();
              const close = session.close.bind(session);
              session.close = async () => {
                closed++;
                await close();
              };
              renameSync(workspace, `${workspace}-old`);
              mkdirSync(workspace);
              return session;
            },
          }) as AgentAdapter,
      ],
    ]),
    workspace: async () => ({ cwd: workspace }),
    estimate: (text) => text.length,
    toolTokens: 0,
    async bind() {
      return {
        url: "http://127.0.0.1:1/mcp",
        token: "synthetic-only",
        setTurn() {},
        async close() {
          revoked++;
        },
      };
    },
  });
  const manager = new SessionManager({ store: f.store, host: runtime, publish() {} });
  try {
    await expect(manager.ensure("thread")).rejects.toThrow(/^runtime_workspace_changed$/);
    expect(closed).toBe(1);
    expect(revoked).toBe(1);
    const state = f.store.snapshot();
    expect(state.turn ?? []).toHaveLength(0);
    expect(state.item?.find((row) => row.id === "pending")?.body).toMatchObject({
      queueState: "queued",
    });
    expect(state.session?.filter((row) => row.state === "failed")).toHaveLength(1);
  } finally {
    await manager.close();
    f.close();
  }
});
