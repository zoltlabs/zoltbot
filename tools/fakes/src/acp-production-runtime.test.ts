import { mkdirSync } from "node:fs";
import path from "node:path";
import { startDaemon } from "@zoltbot/daemon";
import { InteractionSchema, parse } from "@zoltbot/protocol";
import { expect, it } from "vitest";
import { productionRuntime } from "../../../packages/daemon/src/production-runtime.js";
import { providerHosts } from "../../../packages/daemon/src/provider-hosts.js";
import { DaemonClient } from "../../../packages/ui/src/connection.js";
import { verifyArtifactHostRoundTrip } from "./artifact-host-assertions.js";
import { runtimeFixture } from "./runtime-fixture.js";

for (const flavor of ["cursor", "antigravity", "opencode", "copilot"])
  it(`runs ${flavor} through production ACP hosts, durable approval and daemon restart`, async () => {
    const f = await runtimeFixture();
    const dataDir = path.join(f.root, "daemon");
    mkdirSync(dataDir);
    const start = () =>
      startDaemon({
        dataDir,
        runtime: (context) =>
          productionRuntime(context, dataDir, {
            hosts: providerHosts({
              directory: dataDir,
              home: dataDir,
              inherited: {},
              paths: async () => (process.env.PATH ?? "").split(path.delimiter),
              run: async () => ({ code: 0, stdout: "1.4.12", stderr: "" }),
            }),
          }),
      });
    let daemon = await start();
    let client = new DaemonClient(async () => ({ url: daemon.url, token: daemon.token }));
    let counter = 0;
    const call = (method: string, params: Record<string, unknown>) =>
      client.call(method, params, `acp-production:${++counter}`);
    const completed = () =>
      daemon.store.snapshot(["turn"]).turn?.filter((row) => row.status === "completed").length ?? 0;
    try {
      daemon.dispatch(
        {
          type: "create",
          kind: "project",
          value: {
            id: "zolt",
            name: "Zolt",
            goal: "Test",
            instructions: "",
            constraints: "",
            roots: [],
            hierarchyDepth: 3,
            tags: [],
            requireCodeReview: false,
            skipFinalGateWhenReviewed: false,
            archived: false,
            createdAt: new Date().toISOString(),
          },
        },
        "project",
      );
      for (const kind of ["agentDefinition", "agent", "thread"] as const) {
        for (const original of f.store.snapshot()[kind] ?? []) {
          const value = structuredClone(original);
          if (kind === "agentDefinition")
            Object.assign(value, {
              adapter: "acp",
              flavor,
              versionCommand: ["--version"],
              auth: { loginCommand: flavor === "cursor" ? ["login"] : [] },
              launch: {
                command: process.execPath,
                args: [
                  "--import",
                  "tsx",
                  path.resolve("tools/fakes/src/acp-conformance-provider.ts"),
                ],
                env: { TSX_DISABLE_CACHE: "1", ACP_TEST_UNIQUE_IDS: "1", ACP_TEST_FLAVOR: flavor },
              },
            });
          if (kind === "thread")
            Object.assign(value, {
              kind: "manager",
              projectId: "zolt",
              node: { type: "project", id: "zolt" },
            });
          if (kind === "agent") Object.assign(value, { permissionProfile: "workspace_write" });
          daemon.dispatch({ type: "create", kind, value }, `seed:${kind}`);
        }
      }
      await client.start();
      const login = (await call("provider.loginInfo", { profileId: "profile" })) as {
        command: string;
      };
      expect(login.command).not.toContain("CODEX_HOME");
      await call("session.connect", { threadId: "thread" });
      expect(completed()).toBe(0);
      const session = daemon.store
        .snapshot(["session"])
        .session?.find((row) => row.threadId === "thread");
      expect(session?.nativeId).toBeTypeOf("string");
      await call("turn.send", {
        threadId: "thread",
        mode: "queue",
        input: [{ type: "text", text: "approval" }],
      });
      await expect
        .poll(() =>
          daemon.store
            .snapshot(["interaction"])
            .interaction?.some((row) => row.state === "pending"),
        )
        .toBe(true);
      const request = parse(
        InteractionSchema,
        daemon.store.snapshot(["interaction"]).interaction?.find((row) => row.state === "pending"),
      );
      await call("interaction.answer", {
        id: request.id,
        version: request.version,
        answer: {
          action: "accept",
          choice: "allow_once",
          by: { kind: "human", id: "owner" },
          at: new Date().toISOString(),
        },
      });
      await expect.poll(completed).toBe(1);
      client.stop();
      await daemon.close();
      daemon = await start();
      client = new DaemonClient(async () => ({ url: daemon.url, token: daemon.token }));
      await client.start();
      await call("session.connect", { threadId: "thread", previousSessionId: session?.id });
      expect(
        daemon.store.snapshot(["session"]).session?.find((row) => row.state === "ready")?.nativeId,
      ).toBe(session?.nativeId);
      await call("turn.send", {
        threadId: "thread",
        mode: "queue",
        input: [{ type: "text", text: "tools" }],
      });
      await expect.poll(completed).toBe(2);
      expect(
        daemon.store
          .snapshot(["item"])
          .item?.some((row) => JSON.stringify(row.body).includes("safe.txt")),
      ).toBe(true);
      await call("turn.send", {
        threadId: "thread",
        mode: "queue",
        input: [{ type: "text", text: "form" }],
      });
      await expect
        .poll(() =>
          daemon.store
            .snapshot(["interaction"])
            .interaction?.some((row) => row.type === "form" && row.state === "pending"),
        )
        .toBe(true);
      const form = parse(
        InteractionSchema,
        daemon.store
          .snapshot(["interaction"])
          .interaction?.find((row) => row.type === "form" && row.state === "pending"),
      );
      await call("interaction.answer", {
        id: form.id,
        version: form.version,
        answer: {
          action: "accept",
          answers: { form: { value: { name: "Verified" } } },
          by: { kind: "human", id: "owner" },
          at: new Date().toISOString(),
        },
      });
      await expect.poll(completed).toBe(3);
      await call("turn.send", {
        threadId: "thread",
        mode: "queue",
        input: [{ type: "text", text: "delegate" }],
      });
      await expect
        .poll(
          () =>
            daemon.store
              .snapshot(["audit"])
              .audit?.some(
                (row) => row.action === "host.team_delegate" && row.result === "succeeded",
              ),
          { timeout: 7000 },
        )
        .toBe(true);
      await expect
        .poll(
          () =>
            daemon.store
              .snapshot(["turn"])
              .turn?.some((row) => row.origin === "agent" && row.status === "completed"),
          { timeout: 7000 },
        )
        .toBe(true);
      await verifyArtifactHostRoundTrip(call, daemon.store);
    } finally {
      client.stop();
      await daemon.close();
      f.close();
    }
  }, 25000);

it("persists an actionable fail-closed reason when an ACP provider has no read-only mode", async () => {
  const f = await runtimeFixture();
  const dataDir = path.join(f.root, "capability-error");
  mkdirSync(dataDir);
  const daemon = await startDaemon({
    dataDir,
    runtime: (context) =>
      productionRuntime(context, dataDir, {
        hosts: providerHosts({
          directory: dataDir,
          home: dataDir,
          inherited: {},
          paths: async () => (process.env.PATH ?? "").split(path.delimiter),
          run: async () => ({ code: 0, stdout: "1.4.12", stderr: "" }),
        }),
      }),
  });
  const client = new DaemonClient(async () => ({ url: daemon.url, token: daemon.token }));
  try {
    for (const kind of ["agentDefinition", "agent", "thread"] as const)
      for (const original of f.store.snapshot()[kind] ?? []) {
        const value = structuredClone(original);
        if (kind === "agentDefinition")
          Object.assign(value, {
            adapter: "acp",
            flavor: "antigravity",
            versionCommand: ["--version"],
            launch: {
              command: process.execPath,
              args: [
                "--import",
                "tsx",
                path.resolve("tools/fakes/src/acp-conformance-provider.ts"),
              ],
              env: { TSX_DISABLE_CACHE: "1" },
            },
          });
        daemon.dispatch({ type: "create", kind, value }, `seed-error:${kind}`);
      }
    await client.start();
    await expect(
      client.call("session.connect", { threadId: "thread" }, "connect-error"),
    ).rejects.toThrow("read_only_mode_unavailable");
    expect(
      daemon.store.snapshot(["session"]).session?.find((row) => row.threadId === "thread"),
    ).toMatchObject({ state: "failed", endReason: "read_only_mode_unavailable" });
  } finally {
    client.stop();
    await daemon.close();
    f.close();
  }
});
