import { execFileSync } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { claudeDefinitions } from "@zoltbot/adapters-claude/definitions";
import { codexDefinitions } from "@zoltbot/adapters-codex/definitions";
import { parse } from "@zoltbot/protocol";
import { parseRunnerMessage, type RunnerEvent, RunnerEventSchema } from "@zoltbot/runner-protocol";
import { expect, it } from "vitest";
import { type WebSocket, WebSocketServer } from "ws";
import { runnerLease } from "../../../packages/daemon/src/cloud-runner/fixture.js";
import { readWorkerEnvironment } from "./environment.js";
import { startWorker, type WorkerOptions } from "./index.js";
import { workerEnvironmentFixture } from "./test-fixture.js";

for (const provider of ["claude", "codex"] as const) {
  for (const mode of ["private_tool", "mac_bridge"] as const) {
    it(`runs sandbox ${provider} ${mode} through setup, tools, reconnect replay and native resume`, async () => {
      const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "zoltbot-worker-native-"))),
        source = path.join(root, "source"),
        remote = path.join(root, "remote.git"),
        home = path.join(root, "home"),
        binary = path.join(root, provider);
      await mkdir(source);
      await mkdir(home);
      const git = (cwd: string, args: string[]) =>
        execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
      git(source, ["init", "-b", "main"]);
      await writeFile(path.join(source, "README.md"), "Synthetic repository\n");
      git(source, ["add", "."]);
      git(source, [
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "-m",
        "Seed",
      ]);
      git(root, ["clone", "--bare", source, remote]);
      const fixture = workerEnvironmentFixture(),
        keys = Object.entries(fixture.env)
          .filter(([name]) =>
            [
              "ZOLTBOT_RUNNER_TOKEN",
              "ZOLTBOT_WORKER_REFRESH",
              "ZOLTBOT_PRIVATE_CONTEXT_KEY",
              "GITHUB_TOKEN",
              "ANTHROPIC_API_KEY",
            ].includes(name),
          )
          .map(([, value]) => value);
      const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
      await new Promise<void>((resolve, reject) => {
        server.once("listening", resolve);
        server.once("error", reject);
      }).catch(async (error) => {
        await rm(root, { recursive: true, force: true });
        throw error;
      });
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("fixture_cell_missing");
      const env = {
        ...fixture.env,
        ZOLTBOT_PROVIDER: provider,
        OPENAI_API_KEY: fixture.env.ANTHROPIC_API_KEY,
        ZOLTBOT_CELL_URL: `http://127.0.0.1:${address.port}`,
      };
      const providerFile = path.resolve(`tools/fakes/src/${provider}-conformance-provider.ts`);
      await writeFile(
        binary,
        `#!/usr/bin/env node
const child=require("node:child_process").spawn(process.execPath,["--import",${JSON.stringify(import.meta.resolve("tsx"))},${JSON.stringify(providerFile)},...process.argv.slice(2)],{stdio:"inherit",env:{...process.env,TSX_DISABLE_CACHE:"1"}});child.once("exit",code=>process.exit(code??1));\n`,
      );
      await chmod(binary, 0o700);
      const lease = runnerLease(),
        execution = lease.execution,
        builtin = (provider === "claude" ? claudeDefinitions : codexDefinitions)[0];
      if (!execution || !builtin) throw new Error("fixture_execution_missing");
      lease.actor.deviceId = fixture.claims.device;
      execution.task.location = "sandbox";
      execution.definition = structuredClone(builtin);
      execution.profile.definitionId = builtin.id;
      execution.profile.instructions = "";
      execution.project.cloud = {
        repository: "example/repository",
        defaultBranch: "main",
        setupScript: "printf ran >> setup-count",
      };
      const frames = new Map<number, RunnerEvent>(),
        hellos: Record<string, unknown>[] = [],
        statuses: string[] = [],
        versions: string[][] = [];
      let connected: WebSocket | undefined,
        drop = false,
        authenticated = true,
        calls = 0,
        accounts = 0;
      const send = (socket: WebSocket, method: string, params: unknown, id = method) =>
        socket.send(JSON.stringify(parseRunnerMessage({ jsonrpc: "2.0", id, method, params })));
      const sendTool = (id: string) => {
        if (!connected) throw new Error("fixture_cell_disconnected");
        send(
          connected,
          "runner.command",
          {
            taskId: "task",
            leaseId: "lease",
            commandId: id,
            command: {
              type: "send_turn",
              inputId: `input:${id}`,
              input: [
                { type: "text", text: mode === "mac_bridge" ? "mac_exec" : "host_tools_echo" },
              ],
              mode: "queue",
            },
          },
          id,
        );
      };
      server.on("connection", (socket, request) => {
        connected = socket;
        authenticated &&= request.headers.authorization === `Bearer ${env.ZOLTBOT_RUNNER_TOKEN}`;
        socket.on("message", (data) => {
          const message = JSON.parse(data.toString());
          if (message.method === "runner.hello") {
            hellos.push(message.params);
            socket.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { ok: true } }));
            send(socket, "runner.ack", {
              taskId: "task",
              runnerSeq: Math.max(0, ...frames.keys()),
            });
            send(socket, "runner.lease", lease);
          }
          if (message.method === "runner.event") {
            const frame = parse(RunnerEventSchema, message.params),
              previous = frames.get(frame.runnerSeq);
            if (previous) expect(frame).toEqual(previous);
            else frames.set(frame.runnerSeq, frame);
            if (
              !drop &&
              frame.event.t === "message.done" &&
              frame.event.text.includes("[redacted]")
            ) {
              drop = true;
              socket.close();
              return;
            }
            send(socket, "runner.ack", {
              taskId: "task",
              runnerSeq: frame.runnerSeq,
            });
          }
          if (message.method === "mac.status.request") {
            expect(
              [...frames.values()].some(
                (frame) =>
                  frame.event.t === "turn.started" && frame.event.turnId === message.params.turnId,
              ),
            ).toBe(true);
            socket.send(
              JSON.stringify({
                jsonrpc: "2.0",
                id: message.id,
                result: {
                  available: true,
                  targetDeviceId: "mac",
                  mac: "Test Mac",
                  osVersion: "15.0",
                  cwd: "/home/user/work",
                },
              }),
            );
          }
          if (message.method === "mac.exec.request") {
            calls++;
            socket.send(
              JSON.stringify({
                jsonrpc: "2.0",
                id: message.id,
                result: {
                  state: "complete",
                  requestId: message.params.requestId,
                  result: {
                    requestId: message.params.requestId,
                    taskId: "task",
                    stdout: "synthetic-Mac-output [redacted]",
                    stderr: "",
                    exitCode: 0,
                    truncated: false,
                    durationMs: 1,
                    mac: "Test Mac",
                  },
                },
              }),
            );
          }
        });
      });
      const options: Omit<WorkerOptions, "environment"> = {
        directory: path.join(root, "worker"),
        workDirectory: path.join(root, "work"),
        allowLoopback: true,
        localRepository: () => remote,
        clis: [{ id: provider, version: builtin.testedVersions }],
        versions: { worker: "fixture" },
        status: (code) => statuses.push(code),
        fetch: async () => {
          accounts++;
          throw new Error("fixture_account_unexpected");
        },
        native: {
          home,
          inherited: {},
          paths: async () => [path.dirname(process.execPath), "/usr/bin", "/bin"],
          resolve: async () => binary,
          async run(_command, args) {
            versions.push(args);
            if (args.includes("generate-json-schema")) {
              const target = args[args.indexOf("--out") + 1];
              if (!target || !path.resolve(target).startsWith(root + path.sep))
                throw new Error("fixture_schema_scope");
              await writeFile(
                path.join(target, "codex_app_server_protocol.schemas.json"),
                await readFile("fixtures/codex/0.164.0/protocol-experimental.schema.json"),
              );
            }
            return {
              code: 0,
              stdout: args.includes("--version")
                ? provider === "claude"
                  ? "Claude Code 2.1.299"
                  : "codex-cli 0.164.0"
                : "",
              stderr: "",
            };
          },
        },
        tools: async () => ({
          definitions: [
            {
              name: "team_fixture_ping",
              description: "Synthetic task tool.",
              inputSchema: { type: "object", properties: {}, additionalProperties: false },
            },
          ],
          tools: new Map([
            [
              "team_fixture_ping",
              async () => {
                calls++;
                return { text: env.GITHUB_TOKEN };
              },
            ],
          ]),
          authorize: () => true,
          checkLimits: () => true,
          audit: async () => {},
        }),
      };
      if (mode === "mac_bridge") delete options.tools;
      let worker: Awaited<ReturnType<typeof startWorker>> | undefined;
      const done = () =>
        [...frames.values()].filter(
          (frame) => frame.event.t === "turn.done" && frame.event.status === "completed",
        ).length;
      try {
        worker = await startWorker({
          ...options,
          environment: readWorkerEnvironment(env, { allowLoopback: true }),
        });
        await expect.poll(done, { timeout: 15000 }).toBe(1);
        const nativeId = [...frames.values()].find(
          (frame) => frame.event.t === "session.ready",
        )?.event;
        if (nativeId?.t !== "session.ready") throw new Error("fixture_ready_missing");
        sendTool("first-tool");
        await expect.poll(done, { timeout: 15000 }).toBe(2);
        await expect.poll(() => hellos.length, { timeout: 5000 }).toBe(2);
        expect(drop).toBe(true);
        expect(calls).toBe(1);
        expect(
          [...frames.values()].filter((frame) => frame.event.t === "session.ready"),
        ).toHaveLength(1);
        expect(hellos[0]).toMatchObject({
          kind: "sandbox",
          runnerId: fixture.claims.device,
          sleepKeepsProcesses: false,
        });
        await worker.close();
        worker = await startWorker({
          ...options,
          environment: readWorkerEnvironment(env, { allowLoopback: true }),
        });
        await expect
          .poll(
            () => [...frames.values()].filter((frame) => frame.event.t === "session.ready").length,
            { timeout: 15000 },
          )
          .toBe(2);
        const nativeIds = [...frames.values()].flatMap((frame) =>
          frame.event.t === "session.ready" ? [frame.event.nativeId] : [],
        );
        expect(nativeIds).toEqual([nativeId.nativeId, nativeId.nativeId]);
        sendTool("second-tool");
        await expect.poll(done, { timeout: 15000 }).toBe(3);
        expect(calls).toBe(2);
        expect(accounts).toBe(0);
        expect(authenticated).toBe(true);
        expect(await readFile(path.join(root, "work/repository/setup-count"), "utf8")).toBe("ran");
        expect(statuses).not.toContain("runtime_event_failed");
        expect(versions.some((args) => args.includes("auth") || args.includes("login"))).toBe(
          false,
        );
        await worker.close();
        worker = undefined;
        const scan = async (folder: string): Promise<void> => {
          for (const entry of await readdir(folder, { withFileTypes: true })) {
            const file = path.join(folder, entry.name);
            if (entry.isDirectory()) await scan(file);
            else if (entry.isFile()) {
              const bytes = await readFile(file);
              expect(keys.some((key) => bytes.includes(Buffer.from(key)))).toBe(false);
            }
          }
        };
        await scan(root);
        expect(keys.some((key) => JSON.stringify([...frames.values()]).includes(key))).toBe(false);
      } finally {
        await worker?.close();
        for (const socket of server.clients) socket.terminate();
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
        await rm(root, { recursive: true, force: true });
      }
    }, 45000);
  }
}
