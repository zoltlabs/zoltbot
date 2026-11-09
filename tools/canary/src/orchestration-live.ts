import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { startDaemon } from "../../../packages/daemon/src/api.js";
import { productionRuntime } from "../../../packages/daemon/src/production-runtime.js";
import { quickToolRuntime } from "../../../packages/daemon/src/quick-chat/tool-runtime.js";
import {
  AgentDefinitionSchema,
  parse,
  protocolVersion,
} from "../../../packages/protocol/src/index.js";

// Opt-in only: real connected-plan turns, synthetic code, no native UI or external publication.
mkdirSync(path.resolve(".cache"), { recursive: true });
const resume = process.env.ZOLTBOT_CANARY_RESUME;
const root = resume ? path.resolve(resume) : mkdtempSync(path.resolve(".cache/live-pipeline-"));
const repo = path.join(root, "repo"),
  dataDir = path.join(root, "daemon");
if (!resume) {
  mkdirSync(path.join(repo, "test"), { recursive: true });
  writeFileSync(
    path.join(repo, "package.json"),
    JSON.stringify({ type: "module", scripts: { test: "node --test" } }),
  );
  writeFileSync(
    path.join(repo, "ports.mjs"),
    `export function parsePort(value) {\n const port = Number.parseInt(value, 10);\n if (!Number.isInteger(port) || port < 1 || port > 65535) throw new RangeError('Invalid port');\n return port;\n}\n`,
  );
  writeFileSync(
    path.join(repo, "test/ports.test.mjs"),
    `import {test} from 'node:test';\nimport assert from 'node:assert/strict';\nimport {parsePort} from '../ports.mjs';\ntest('existing port behavior',()=>{ assert.equal(parsePort('80'),80); assert.throws(()=>parsePort('0')); });\n`,
  );
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
  git("init", "-b", "main");
  git("config", "user.name", "Zoltbot Canary");
  git("config", "user.email", "canary@example.invalid");
  const emptyHooks = path.join(repo, ".git", "empty-hooks");
  mkdirSync(emptyHooks);
  git("config", "core.hooksPath", emptyHooks);
  git("add", ".");
  git("commit", "-m", "Seed isolated port utility");
}
const daemon = await startDaemon({
  dataDir,
  runtime: (context) => productionRuntime(context, dataDir),
  quickChat: { tools: quickToolRuntime(dataDir) },
});
const at = new Date().toISOString();
for (const tool of ["codex", "claude"]) {
  if (daemon.store.record("agent", tool)) continue;
  const definition = parse(
    AgentDefinitionSchema,
    JSON.parse(readFileSync(`packages/adapters/${tool}/definitions/${tool}.json`, "utf8")),
  );
  daemon.dispatch(
    { type: "create", kind: "agentDefinition", value: definition },
    `definition:${tool}`,
  );
  daemon.dispatch(
    {
      type: "create",
      kind: "agent",
      value: {
        id: tool,
        name: tool,
        avatar: "C",
        kind: "profile",
        definitionId: tool,
        permissionProfile: "workspace_write",
        instructions:
          "Work only on this synthetic canary. Keep responses short. Do not browse, install packages, delegate, publish, or change Git configuration. Follow the current phase and its outcome-marker contract.",
        hidden: false,
        archived: false,
      },
    },
    `profile:${tool}`,
  );
}
if (!daemon.store.record("project", "canary"))
  daemon.dispatch(
    {
      type: "create",
      kind: "project",
      value: {
        id: "canary",
        name: "Live pipeline canary",
        goal: "",
        instructions: "",
        constraints: "",
        roots: [{ path: repo, label: "Synthetic repo" }],
        hierarchyDepth: 3,
        tags: [],
        requireCodeReview: false,
        skipFinalGateWhenReviewed: false,
        archived: false,
        createdAt: at,
      },
    },
    "project",
  );
if (!daemon.store.record("thread", "origin"))
  daemon.dispatch(
    {
      type: "create",
      kind: "thread",
      value: {
        id: "origin",
        agentId: "codex",
        projectId: "canary",
        node: { type: "project", id: "canary" },
        kind: "main",
        title: "Live pipeline",
        titleSource: "human",
        pinned: false,
        archived: false,
        createdAt: at,
        lastActivityAt: at,
      },
    },
    "thread",
  );
const socket = new WebSocket(daemon.url);
await new Promise<void>((resolve) =>
  socket.addEventListener("open", () => resolve(), { once: true }),
);
let sequence = 0;
const waiters = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
socket.addEventListener("message", (message) => {
  const value = JSON.parse(String(message.data));
  const pending = waiters.get(value.id);
  if (!pending) return;
  waiters.delete(value.id);
  if (value.error) pending.reject(Error(value.error.message));
  else pending.resolve(value.result);
});
const call = (method: string, params: unknown, commandId?: string): Promise<unknown> =>
  new Promise((resolve, reject) => {
    const id = ++sequence;
    waiters.set(id, { resolve, reject });
    socket.send(
      JSON.stringify({ jsonrpc: "2.0", id, method, params, ...(commandId ? { commandId } : {}) }),
    );
  });
let testRetries = 0;
let repairRequested =
    !!resume &&
    (
      daemon.store.snapshot().orchestration?.[0]?.phases as
        | { role: string; attempt: number }[]
        | undefined
    )?.some((phase) => phase.role === "implement" && phase.attempt > 1) === true,
  last = "";
const trace: unknown[] = [];
try {
  await call("hello", { token: daemon.token, protocolVersion });
  console.log(JSON.stringify({ root, state: "starting" }));
  if (!resume)
    await call(
      "turn.send",
      {
        threadId: "origin",
        mode: "queue",
        input: [
          {
            type: "text",
            text: `Run exactly four phases: plan using gpt-6.1-terra, implement using gpt-6.1-terra, security review using sonnet, and tests using gpt-6.1-terra. Task: add exported formatOrigin(host, port) to ports.mjs returning http://host:port using parsePort. Host must be a nonempty simple ASCII hostname with letters, digits, dots and hyphens only. Add tests, using node --test, no dependencies. First implementation: add ONLY formatOrigin and its happy-path/host tests, using string ports in those tests; leave existing parsePort unchanged. Security review: audit both exports, explicitly probe parsePort('80oops') and parsePort('80.5'), and require strict decimal integer port strings in range 1..65535, rejecting non-string inputs, whitespace and newline suffixes. Review is read-only: report findings and do not try to repair files in the review phase. Block if either malformed value is accepted. If review finds this existing bug, repair is authorized to fix parsePort and add regression tests. Tests phase: verify both new feature and malformed-port regressions. Keep all changes in the same workspace. Do not commit, install dependencies, or publish.`,
          },
        ],
      },
      "live-build",
    );
  const deadline = Date.now() + 15 * 60_000;
  while (Date.now() < deadline) {
    const state = daemon.store.snapshot();
    const run = state.orchestration?.[0];
    if (run) {
      const phases = run.phases as {
        role: string;
        status: string;
        taskId?: string;
        summary?: string;
        execution: unknown;
      }[];
      const status = JSON.stringify({
        state: run.state,
        phases: phases.map((p) => ({ role: p.role, status: p.status, summary: p.summary })),
      });
      if (status !== last) {
        console.log(status);
        trace.push(JSON.parse(status));
        last = status;
      }
      if (
        run.state === "blocked" &&
        phases.some(
          (phase) =>
            phase.role === "tests" &&
            phase.status === "blocked" &&
            phase.summary?.startsWith("No successful test command"),
        )
      ) {
        if (++testRetries > 1) throw Error("test_evidence_retry_limit");
        await call(
          "orchestration.retry",
          { id: run.id, revision: run.revision },
          `retry-tests:${run.revision}`,
        );
      } else if (run.state === "blocked") {
        if (
          repairRequested ||
          !phases.some(
            (p) => p.role === "review" && p.status === "blocked" && p.summary?.includes("port"),
          )
        )
          throw Error(`unexpected_pipeline_block: ${status}`);
        repairRequested = true;
        await call(
          "orchestration.repair",
          { id: run.id, revision: run.revision },
          `live-repair:${run.revision}`,
        );
      }
      if (run.state === "completed") {
        if (!repairRequested) throw Error("review_loop_not_exercised");
        const workspace = state.workspace?.find((w) => w.id === run.workspaceId);
        if (!workspace) throw Error("workspace_missing");
        const cwd = String(workspace.path);
        const tests = execFileSync(process.execPath, ["--test"], { cwd, encoding: "utf8" });
        const invalidPorts = ["80oops", "80.5", "80\n", "80 ", " 80", "0", "65536", 80, null];
        const adversarial = execFileSync(
          process.execPath,
          [
            "--input-type=module",
            "-e",
            `import{parsePort,formatOrigin}from './ports.mjs';import assert from 'node:assert/strict';for(const p of ${JSON.stringify(invalidPorts)})assert.throws(()=>parsePort(p));assert.throws(()=>parsePort(undefined));assert.equal(formatOrigin('localhost','8080'),'http://localhost:8080');console.log('independent adversarial checks passed')`,
          ],
          { cwd, encoding: "utf8" },
        );
        const tasks = state.task?.filter((t) => t.workflowRunId === run.id) ?? [];
        const paths = new Set(tasks.map((t) => t.workspaceId));
        if (paths.size !== 1) throw Error("handoff_workspace_changed");
        for (const task of tasks) {
          const session = state.session?.find((s) => s.threadId === task.threadId);
          const execution = task.phaseExecution as { definitionId: string; model: string };
          if (
            !session ||
            session.cwd !== cwd ||
            session.provider !== execution.definitionId ||
            session.model !== execution.model
          )
            throw Error("actual_execution_does_not_match_assignment");
          if (String(task.brief).length > 16000) throw Error("handoff_limit_exceeded");
        }
        const plan = tasks.find((task) => task.stageId === "0");
        const implementation = tasks.find((task) => task.stageId === "1");
        if (!plan || !implementation || !String(implementation.brief).includes(String(plan.id)))
          throw Error("plan_handoff_missing");
        const repair = tasks.find(
          (task) => task.stageId === "1" && String(task.id).endsWith(":a2"),
        );
        if (
          !repair ||
          !String(repair.brief).includes("CURRENT ATTEMPT: repair") ||
          !String(repair.brief).includes("80oops")
        )
          throw Error("review_findings_not_handed_to_repair");
        if (execFileSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" }).trim())
          throw Error("source_repository_was_modified");
        const nativeChecks = (state.item ?? [])
          .filter(
            (item) => item.threadId === `${phases.at(-1)?.taskId}:thread` && item.kind === "tool",
          )
          .map((item) => ({ seq: item.seq, ...(item.body as { check?: string; status?: string }) }))
          .filter((item) => item.check === "tests")
          .map((item) => ({ seq: item.seq, check: item.check, status: item.status }));
        if (!nativeChecks.some((check) => check.status === "ok"))
          throw Error("native_test_evidence_missing");
        const diff = execFileSync("git", ["diff", "HEAD"], { cwd, encoding: "utf8" });
        writeFileSync(
          path.join(root, "evidence.json"),
          JSON.stringify(
            {
              run,
              nativeChecks,
              tasks,
              trace,
              tests,
              adversarial,
              diff,
              sessions: state.session?.map((s) => ({
                threadId: s.threadId,
                provider: s.provider,
                model: s.model,
                cwd: s.cwd,
              })),
            },
            null,
            2,
          ),
        );
        console.log(
          JSON.stringify({
            state: "verified",
            root,
            cwd,
            repairRequested,
            tasks: tasks.length,
            tests,
            adversarial,
          }),
        );
        break;
      }
    }
    const pending = state.interaction?.filter((i) => i.state === "pending") ?? [];
    if (pending.length)
      throw Error(
        `interaction_requires_inspection: ${JSON.stringify(pending.map((i) => ({ id: i.id, title: i.title, context: i.context, version: i.version })))}`,
      );
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  if (daemon.store.snapshot().orchestration?.[0]?.state !== "completed")
    throw Error("pipeline_deadline");
} finally {
  writeFileSync(path.join(root, "snapshot.json"), JSON.stringify(daemon.store.snapshot(), null, 2));
  socket.close();
  await daemon.close();
}
