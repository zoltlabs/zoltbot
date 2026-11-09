import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { startDaemon } from "@zoltbot/daemon";
import { InteractionSchema, parse } from "@zoltbot/protocol";
import { expect, it } from "vitest";
import { productionRuntime } from "../../../packages/daemon/src/production-runtime.js";
import { providerHosts } from "../../../packages/daemon/src/provider-hosts.js";
import { DaemonClient } from "../../../packages/ui/src/connection.js";
import { verifyArtifactHostRoundTrip } from "./artifact-host-assertions.js";
import { runtimeFixture } from "./runtime-fixture.js";

for (const provider of ["claude", "codex"] as const)
  it(`runs ${provider} through production hosts, daemon RPC, human interactions and restart resume`, async () => {
    const f = await runtimeFixture(),
      dataDir = path.join(f.root, "daemon");
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
              run: async (_command, args) => {
                if (args.includes("generate-json-schema")) {
                  const directory = args[args.indexOf("--out") + 1];
                  if (!directory) throw new Error("missing_schema_output");
                  writeFileSync(
                    path.join(directory, "codex_app_server_protocol.schemas.json"),
                    readFileSync("fixtures/codex/0.164.0/protocol-experimental.schema.json"),
                  );
                }
                return {
                  code: 0,
                  stdout: provider === "claude" ? "2.1.299" : "codex-cli 0.164.0",
                  stderr: "",
                };
              },
            }),
            waitMs: 5000,
          }),
      });
    let daemon = await start();
    let client = new DaemonClient(async () => ({ url: daemon.url, token: daemon.token }));
    let counter = 0;
    const call = (method: string, params: Record<string, unknown>) =>
      client.call(method, params, `production:${++counter}`);
    try {
      daemon.dispatch(
        {
          type: "create",
          kind: "project",
          value: {
            id: "zolt",
            name: "Zolt",
            goal: "Health",
            instructions: "Test the change",
            constraints: "",
            roots: [],
            hierarchyDepth: 3,
            tags: [],
            requireCodeReview: false,
            skipFinalGateWhenReviewed: false,
            archived: false,
            createdAt: "2026-10-29T12:00:00Z",
          },
        },
        "project",
      );
      for (const kind of ["agentDefinition", "agent", "thread"] as const) {
        for (const original of f.store.snapshot()[kind] ?? []) {
          const value = structuredClone(original);
          if (kind === "agentDefinition")
            Object.assign(value, {
              adapter: provider,
              versionCommand: ["--version"],
              launch: {
                command: process.execPath,
                args: [
                  "--import",
                  "tsx",
                  path.resolve(`tools/fakes/src/${provider}-conformance-provider.ts`),
                ],
                env: { TSX_DISABLE_CACHE: "1" },
              },
            });
          if (kind === "thread")
            Object.assign(value, {
              kind: "manager",
              projectId: "zolt",
              node: { type: "project", id: "zolt" },
            });
          if (kind === "agent") value.instructions = "Production inherited context fixture";
          daemon.dispatch({ type: "create", kind, value }, `seed:${kind}`);
        }
      }
      await client.start();
      await call("session.connect", { threadId: "thread" });
      expect(daemon.store.snapshot(["turn"]).turn ?? []).toHaveLength(0);
      const session = daemon.store
        .snapshot(["session"])
        .session?.find((row) => row.threadId === "thread");
      expect(session?.cwd).toContain(path.join(dataDir, "workspaces"));
      const nativeId = session?.nativeId;
      expect(nativeId).toBeTypeOf("string");
      for (const prompt of ["question", "approval"]) {
        const completed =
          daemon.store
            .snapshot(["turn"])
            .turn?.filter((row) => row.status === "completed" && row.threadId === "thread")
            .length ?? 0;
        await call("turn.send", {
          threadId: "thread",
          mode: "queue",
          input: [{ type: "text", text: prompt }],
        });
        await expect
          .poll(
            () =>
              daemon.store
                .snapshot(["interaction"])
                .interaction?.some((row) => row.state === "pending"),
            { timeout: 5000 },
          )
          .toBe(true);
        const request = parse(
          InteractionSchema,
          daemon.store
            .snapshot(["interaction"])
            .interaction?.find((row) => row.state === "pending"),
        );
        const answers = Object.fromEntries(
          request.items.map((item) => [
            item.id,
            item.options?.length
              ? { options: [item.options[0]?.id] }
              : { other: "A fixture answer" },
          ]),
        );
        await call("interaction.answer", {
          id: request.id,
          version: request.version,
          answer: {
            action: "accept",
            ...(prompt === "approval" ? { choice: "allow_once" } : { answers }),
            by: { kind: "human", id: "owner" },
            at: new Date().toISOString(),
          },
        });
        await expect
          .poll(
            () =>
              daemon.store
                .snapshot(["turn"])
                .turn?.filter((row) => row.status === "completed" && row.threadId === "thread")
                .length,
            { timeout: 5000 },
          )
          .toBe(completed + 1);
      }
      const count = daemon.store
        .snapshot(["item"])
        .item?.filter((row) => row.kind === "user").length;
      client.stop();
      await daemon.close();
      daemon = await start();
      client = new DaemonClient(async () => ({ url: daemon.url, token: daemon.token }));
      await client.start();
      await call("session.connect", { threadId: "thread", previousSessionId: session?.id });
      const resumed = daemon.store
        .snapshot(["session"])
        .session?.filter((row) => row.state === "ready");
      expect(resumed).toHaveLength(1);
      expect(resumed?.[0]).toMatchObject({ nativeId, cwd: session?.cwd });
      expect(
        daemon.store.snapshot(["item"]).item?.filter((row) => row.kind === "user"),
      ).toHaveLength(count ?? 0);
      await call("turn.send", {
        threadId: "thread",
        mode: "queue",
        input: [{ type: "text", text: "continue" }],
      });
      await expect
        .poll(
          () =>
            daemon.store
              .snapshot(["turn"])
              .turn?.filter((row) => row.status === "completed" && row.threadId === "thread")
              .length,
          { timeout: 5000 },
        )
        .toBe(3);
      expect(
        daemon.store
          .snapshot(["settings"])
          .settings?.some((row) => String(row.key).startsWith("runtime.configuration.")),
      ).toBe(true);
      await call("turn.send", {
        threadId: "thread",
        mode: "queue",
        input: [{ type: "text", text: "delegate" }],
      });
      await expect
        .poll(
          () =>
            daemon.store
              .snapshot(["turn"])
              .turn?.filter((row) => row.status === "completed" && row.threadId === "thread")
              .length,
          { timeout: 7000 },
        )
        .toBe(4);
      const child = daemon.store
        .snapshot(["thread"])
        .thread?.find((row) => String(row.id).startsWith("child-"));
      expect(
        daemon.store
          .snapshot(["item"])
          .item?.filter((row) => row.threadId === child?.id && row.kind === "user"),
      ).toHaveLength(1);
      expect(child).toMatchObject({ kind: "side", node: { type: "project", id: "zolt" } });
      expect(
        daemon.store.snapshot(["turn"]).turn?.find((row) => row.threadId === child?.id),
      ).toMatchObject({ status: "completed", origin: "agent" });
      expect(
        daemon.store
          .snapshot(["audit"])
          .audit?.some((row) => row.action === "host.team_delegate" && row.result === "succeeded"),
      ).toBe(true);
      const completedIn = () =>
        daemon.store
          .snapshot(["turn"])
          .turn?.filter((row) => row.status === "completed" && row.threadId === "thread").length;
      await call("turn.send", {
        threadId: "thread",
        mode: "queue",
        input: [{ type: "text", text: "workspace_area" }],
      });
      await expect.poll(completedIn, { timeout: 7000 }).toBe(5);
      expect(
        daemon.store.snapshot(["subproject"]).subproject?.find((row) => row.name === "Growth"),
      ).toMatchObject({ projectId: "zolt", depth: 1 });
      await call("turn.send", {
        threadId: "thread",
        mode: "queue",
        input: [{ type: "text", text: "workspace_project" }],
      });
      await expect.poll(completedIn, { timeout: 7000 }).toBe(6);
      const approval = parse(
        InteractionSchema,
        daemon.store
          .snapshot(["interaction"])
          .interaction?.find((row) => row.nativeRef === "host:workspace"),
      );
      expect(approval).toMatchObject({ state: "pending", type: "approval" });
      expect(daemon.store.snapshot(["project"]).project).toHaveLength(1);
      await call("interaction.answer", {
        id: approval.id,
        version: approval.version,
        answer: {
          action: "accept",
          choice: "allow_once",
          by: { kind: "human", id: "owner" },
          at: new Date().toISOString(),
        },
      });
      expect(
        daemon.store.snapshot(["project"]).project?.find((row) => row.name === "Coach"),
      ).toBeDefined();
      await expect.poll(completedIn, { timeout: 7000 }).toBe(7);
      expect(
        daemon.store
          .snapshot(["item"])
          .item?.some(
            (row) =>
              row.threadId === "thread" &&
              row.kind === "user" &&
              JSON.stringify(row.body).includes("[Zoltbot] Approved: created project"),
          ),
      ).toBe(true);
      await verifyArtifactHostRoundTrip(call, daemon.store);
    } finally {
      client.stop();
      await daemon.close();
      f.close();
    }
  }, 25000);
