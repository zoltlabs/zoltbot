import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
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
import type { RunOptions } from "@zoltbot/detect";
import { afterEach, expect, it, vi } from "vitest";
import { PrivateContexts } from "../private-context.js";
import { EncryptedTaskVault } from "./encrypted-vault.js";
import { runnerLease } from "./fixture.js";
import { nativeCloudTasks } from "./native.js";
import { RunnerOutbox } from "./outbox.js";
import { taskVault } from "./vault.js";
import { ManagedWorkspaces } from "./workspaces.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.unstubAllEnvs();
});
async function fixture(provider: "claude" | "codex", apiKey = true) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "zoltbot-native-cloud-")));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, "source"),
    remote = path.join(root, "remote.git"),
    binary = path.join(root, provider),
    home = path.join(root, "home");
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
  const providerFile = path.resolve(`tools/fakes/src/${provider}-conformance-provider.ts`);
  await writeFile(
    binary,
    `#!/usr/bin/env node
const child = require("node:child_process").spawn(process.execPath, ["--import", ${JSON.stringify(import.meta.resolve("tsx"))}, ${JSON.stringify(providerFile)}, ...process.argv.slice(2)], {stdio:"inherit",env:{...process.env,TSX_DISABLE_CACHE:"1"}});
child.once("exit",code=>process.exit(code??1));
`,
  );
  await chmod(binary, 0o700);
  const vaultKey = randomBytes(32).toString("base64url"),
    providerKey = randomBytes(32).toString("base64url"),
    runnerToken = randomBytes(32).toString("base64url");
  vi.stubEnv("ZOLTBOT_RUNNER_TOKEN", runnerToken);
  vi.stubEnv("ZOLTBOT_RUNNER_VAULT_KEY", vaultKey);
  const vault = new EncryptedTaskVault(
    path.join(root, "vault"),
    { orgId: "org", taskId: "task" },
    vaultKey,
  );
  cleanup.push(async () => vault.close());
  const lease = runnerLease(),
    execution = lease.execution,
    builtin = (provider === "claude" ? claudeDefinitions : codexDefinitions)[0];
  if (!execution || !builtin) throw new Error("fixture_definition_missing");
  execution.definition = {
    ...structuredClone(builtin),
    launch: { command: "untrusted-cell-command", args: [], env: {} },
  };
  execution.profile.definitionId = builtin.id;
  execution.profile.instructions = "";
  const keys = [vaultKey, providerKey, runnerToken];
  const privateAnswer = randomBytes(32).toString("base64url");
  const guard = (value: unknown) => {
    if (keys.some((key) => JSON.stringify(value).includes(key))) throw new Error("private_value");
  };
  const outbox = new RunnerOutbox({
    directory: path.join(root, "outbox"),
    binding: { orgId: "org", taskId: "task", threadId: "thread", leaseId: "lease" },
    guard,
  });
  outbox.reconcile(0);
  cleanup.push(async () => outbox.close());
  const audits: string[] = [],
    statuses: string[] = [],
    probes: string[][] = [];
  let calls = 0;
  const works = new ManagedWorkspaces({
    directory: path.join(root, "managed"),
    localRepository: () => remote,
  });
  const factory = () =>
    nativeCloudTasks({
      orgId: "org",
      memberId: "member",
      directory: path.join(root, "runtime"),
      workspaces: works,
      guard,
      vault: async () => vault,
      ...(apiKey ? { providerKey: async () => providerKey } : {}),
      status: (code) => statuses.push(code),
      native: {
        home,
        inherited: {},
        paths: async () => [path.dirname(process.execPath), "/usr/bin", "/bin"],
        resolve: async () => binary,
        async run(_command: string, args: string[], input: RunOptions) {
          probes.push(args);
          if (args.includes("generate-json-schema")) {
            const target = args[args.indexOf("--out") + 1];
            if (!target || !path.resolve(target).startsWith(path.resolve(root) + path.sep))
              throw new Error("fixture_schema_scope");
            await writeFile(
              path.join(target, "codex_app_server_protocol.schemas.json"),
              await readFile("fixtures/codex/0.164.0/protocol-experimental.schema.json"),
            );
          }
          expect(JSON.stringify(input).includes(providerKey)).toBe(false);
          return {
            code: 0,
            stdout: args.includes("--version")
              ? provider === "claude"
                ? "Claude Code 2.1.299"
                : "codex-cli 0.164.0"
              : provider === "claude"
                ? JSON.stringify({ loggedIn: true })
                : "Logged in using ChatGPT",
            stderr: "",
          };
        },
      },
      tools: async ({ store, signal, assertPublic }) => ({
        definitions: [
          {
            name: "team_fixture_ping",
            description: "Synthetic scoped host proof.",
            inputSchema: { type: "object", properties: {}, additionalProperties: false },
          },
        ],
        tools: new Map([
          [
            "team_fixture_ping",
            async ({ actor }) => {
              expect(signal.aborted).toBe(false);
              expect(store.record("session", actor.sessionId)?.threadId).toBe("thread");
              const contexts = new PrivateContexts({
                store,
                vault: taskVault(vault, { orgId: "org", taskId: "task" }),
                publish() {},
              });
              await contexts.persist(actor.sessionId, new Set([privateAnswer]));
              await expect(assertPublic({ stdin: privateAnswer })).rejects.toThrow(
                "private_value_requires_secure_field",
              );
              await assertPublic({ command: "uname" });
              calls++;
              return { text: "scoped-native-cloud-ok" };
            },
          ],
        ]),
        authorize: () => true,
        checkLimits: () => true,
        audit: async (record) => {
          audits.push(record.result);
        },
      }),
    });
  let activeFactory = factory();
  cleanup.push(() => activeFactory.close());
  const controller = new AbortController();
  const start = async () => {
    const task = await activeFactory.task(lease, outbox, () => {}, controller.signal);
    cleanup.push(() => task.close());
    return task;
  };
  const frames = () => [...outbox.pending(0, 64)];
  const done = () =>
    frames().filter((frame) => frame.event.t === "turn.done" && frame.event.status === "completed")
      .length;
  const verifyFiles = async () => {
    const visit = async (directory: string) => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) await visit(file);
        else if (entry.isFile()) {
          const bytes = await readFile(file);
          for (const key of [...keys, privateAnswer])
            expect(bytes.includes(Buffer.from(key))).toBe(false);
        }
      }
    };
    await visit(root);
  };
  return {
    root,
    lease,
    execution,
    outbox,
    guard,
    controller,
    probes,
    statuses,
    audits,
    frames,
    done,
    start,
    verifyFiles,
    get calls() {
      return calls;
    },
    async restart() {
      await activeFactory.close();
      activeFactory = factory();
    },
  };
}

for (const provider of ["claude", "codex"] as const) {
  it(`runs a leased ${provider} task through production native hosts, serves a scoped tool, and resumes its original native session`, async () => {
    const f = await fixture(provider);
    let task = await f.start();
    await expect.poll(f.done, { timeout: 10000 }).toBe(1);
    expect(task.ready?.()).toBe(true);
    const ready = f.frames().find((frame) => frame.event.t === "session.ready");
    if (ready?.event.t !== "session.ready") throw new Error("fixture_native_ready_missing");
    const nativeId = ready.event.nativeId;
    await task.command(
      {
        taskId: "task",
        leaseId: "lease",
        commandId: "tool",
        command: {
          type: "send_turn",
          inputId: "tool-input",
          input: [{ type: "text", text: "host_tools" }],
          mode: "queue",
        },
      },
      f.controller.signal,
    );
    await expect.poll(f.done, { timeout: 10000 }).toBe(2);
    expect(f.calls).toBe(1);
    expect(f.audits).toEqual(["started", "succeeded"]);
    await f.verifyFiles();
    await task.close();
    await f.restart();
    task = await f.start();
    const resumed = f
      .frames()
      .filter((frame) => frame.event.t === "session.ready")
      .at(-1);
    expect(resumed?.event).toMatchObject({ t: "session.ready", nativeId });
    expect(f.done()).toBe(2);
    expect(f.statuses).toEqual([]);
    await f.verifyFiles();
    f.controller.abort();
    await task.close();
    expect(task.ready?.()).toBe(false);
  });

  it(`uses the Mac's native ${provider} login route without a hosted API key`, async () => {
    const f = await fixture(provider, false),
      task = await f.start();
    await expect.poll(f.done, { timeout: 10000 }).toBe(1);
    expect(task.ready?.()).toBe(true);
    expect(
      f.probes.some(
        (args) => args[0] === (provider === "claude" ? "auth" : "login") && args[1] === "status",
      ),
    ).toBe(true);
    await f.verifyFiles();
  });
}

it("refuses non-builtin providers before cloning or opening a native process", async () => {
  const f = await fixture("claude");
  f.execution.definition.id = "unsupported-provider";
  f.execution.profile.definitionId = "unsupported-provider";
  await expect(f.start()).rejects.toThrow("runner_task_unavailable");
  expect(f.probes).toEqual([]);
});
