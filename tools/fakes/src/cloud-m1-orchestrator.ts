import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  type SandboxCreate,
  SandboxCreateSchema,
  SandboxOperationSchema,
} from "@zoltbot/cloud-contracts";
import { parse } from "@zoltbot/protocol";
import type { ExecProcess, ExecutionTarget, SandboxRef } from "@zoltbot/sandbox";
import {
  type OperationJournal,
  type OperationRecord,
  SandboxOrchestrator,
} from "@zoltbot/sandbox/orchestrate";
import { verifyServiceToken } from "../../../packages/cell/src/service.js";
import type { createCloudM1Account, FakeAccountRequest } from "./cloud-m1-account.js";
import type { createCloudM1Workers } from "./cloud-m1-workers.js";

class Journal implements OperationJournal {
  private readonly rows = new Map<string, OperationRecord>();
  async reserve(initial: OperationRecord) {
    if (!this.rows.has(initial.key)) this.rows.set(initial.key, structuredClone(initial));
    return structuredClone(this.rows.get(initial.key) as OperationRecord);
  }
  async compare(key: string, version: number, next: OperationRecord) {
    if (this.rows.get(key)?.version !== version) return undefined;
    this.rows.set(key, structuredClone(next));
    return structuredClone(next);
  }
}
interface Job {
  input: SandboxCreate;
  ref: SandboxRef;
  process?: ExecProcess;
  statuses: string[];
  createdAt: string;
  state: "running" | "sleeping" | "destroyed";
  intervals: Array<{ start: number; end?: number }>;
}
const key = (scope: { orgId: string; taskId: string }) =>
  JSON.stringify([scope.orgId, scope.taskId]);
const configuration = (input: SandboxCreate) =>
  createHash("sha256").update(JSON.stringify(input)).digest("hex");

/** Fake Global orchestration uses the real public effect journal and target, never a provider API. */
export function createSandboxHarness(options: {
  issuer: string;
  serviceKey: string;
  cellOrigin: string;
  cloudOrigin: string;
  target: ExecutionTarget;
  account: Pick<Awaited<ReturnType<typeof createCloudM1Account>>, "secretsForTask">;
  workers: Pick<Awaited<ReturnType<typeof createCloudM1Workers>>, "provision" | "revoke">;
  command: readonly string[];
  environment: Record<string, string>;
  now?: () => number;
  limitSeconds?: number;
}) {
  const target = options.target,
    jobs = new Map<string, Job>(),
    now = options.now ?? Date.now;
  const effects = new SandboxOrchestrator({ target, journal: new Journal() });
  const materials = new Map<string, Record<string, string>>();
  const limitSeconds = options.limitSeconds ?? 360000;
  const wire = (job: Job) => ({
    orgId: job.input.orgId,
    userId: job.input.userId,
    taskId: job.input.taskId,
    sandboxId: job.ref.id,
    target: "e2b",
    state: job.state,
    sleepKeepsProcesses: target.capabilities.sleepKeepsProcesses,
    createdAt: job.createdAt,
    updatedAt: new Date().toISOString(),
  });
  const meter = (orgId: string) => {
    const date = new Date(now()),
      start = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1),
      end = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
    const tasks = [...jobs.values()]
      .filter((job) => job.input.orgId === orgId)
      .map((job) => ({
        taskId: job.input.taskId,
        sandboxSeconds: job.intervals.reduce(
          (sum, interval) =>
            sum +
            Math.max(0, Math.min(interval.end ?? now(), end) - Math.max(interval.start, start)) /
              1000,
          0,
        ),
      }));
    return {
      periodStart: new Date(start).toISOString(),
      periodEnd: new Date(end).toISOString(),
      sandboxSeconds: tasks.reduce((sum, task) => sum + task.sandboxSeconds, 0),
      limitSeconds,
      tasks,
    };
  };
  const launch = async (job: Job) => {
    if (job.process) return;
    const process = await target.exec(job.ref, [...options.command], {
      env: { ...options.environment, ZOLTBOT_WORKER_HOME: job.ref.workdir },
    });
    job.process = process;
    void (async () => {
      let pending = "";
      for await (const chunk of process) {
        if (chunk.stream !== "stdout") {
          for (const code of [
            "ERR_MODULE_NOT_FOUND",
            "MODULE_NOT_FOUND",
            "TypeError",
            "SyntaxError",
            "EACCES",
            "fixture_git_network_refused",
          ])
            if (chunk.data.includes(code) && job.statuses.length < 128)
              job.statuses.push(`fixture_stderr_${code.toLowerCase()}`);
          continue;
        }
        pending += chunk.data;
        if (pending.length > 65536) {
          pending = "";
          continue;
        }
        const lines = pending.split("\n");
        pending = lines.pop() ?? "";
        for (const line of lines) {
          try {
            const value = JSON.parse(line);
            if (
              value.type === "worker.status" &&
              typeof value.code === "string" &&
              /^[a-z_]{1,100}$/.test(value.code) &&
              job.statuses.length < 128
            )
              job.statuses.push(value.code);
          } catch {}
        }
      }
    })().catch(() => {});
    void process.exit
      .then((result) => {
        if (job.process === process) delete job.process;
        if (job.statuses.length < 128) job.statuses.push(`worker_exit_${result.code ?? "signal"}`);
      })
      .catch(() => {
        if (job.process === process) delete job.process;
        if (job.statuses.length < 128) job.statuses.push("worker_exit_unavailable");
      });
  };
  const operate = async (job: Job, kind: "wake" | "sleep" | "destroy", operationId: string) => {
    const result = await effects.run({
      id: operationId,
      scope: { orgId: job.input.orgId, userId: job.input.userId, taskId: job.input.taskId },
      kind,
      configurationId: configuration(job.input),
      ref: job.ref,
    });
    if (result.state !== "done") throw new Error("fixture_operation_pending");
    const next = kind === "sleep" ? "sleeping" : kind === "destroy" ? "destroyed" : "running";
    if (job.state !== next) {
      const last = job.intervals.at(-1);
      if (last && last.end === undefined) last.end = now();
      if (next === "running") job.intervals.push({ start: now() });
    }
    job.state = next;
    if (kind === "destroy") {
      options.workers.revoke(job.input.orgId, job.input.taskId);
      materials.delete(key(job.input));
    }
    if (kind === "wake") await launch(job);
    return wire(job);
  };
  return Object.freeze({
    async handle(request: FakeAccountRequest) {
      if (
        ![
          "/api/cloud/sandboxes",
          "/api/cloud/sandboxes/wake",
          "/api/cloud/sandboxes/sleep",
          "/api/cloud/usage",
        ].includes(request.path)
      )
        return undefined;
      try {
        const input = request.body as Record<string, unknown>;
        if (!input || typeof input.orgId !== "string") throw new Error();
        const bearer = /^Bearer ([A-Za-z0-9_.-]+)$/.exec(request.authorization ?? "")?.[1] ?? "";
        await verifyServiceToken(
          bearer,
          options.serviceKey,
          options.issuer,
          "orchestrator",
          input.orgId,
        );
        if (request.path === "/api/cloud/usage" && request.method === "POST")
          return { status: 200, body: meter(input.orgId) };
        if (!request.operationId) throw new Error();
        if (request.path === "/api/cloud/sandboxes" && request.method === "POST") {
          const value = parse(SandboxCreateSchema, input),
            existing = jobs.get(key(value));
          if (existing) {
            if (configuration(value) !== configuration(existing.input)) throw new Error();
            return { status: 200, body: wire(existing) };
          }
          if (meter(value.orgId).sandboxSeconds >= limitSeconds)
            return { status: 409, body: { error: "limit_reached" } };
          const result = await effects.run(
            {
              id: request.operationId,
              scope: { orgId: value.orgId, userId: value.userId, taskId: value.taskId },
              kind: "create",
              configurationId: configuration(value),
            },
            async () => {
              let env = materials.get(key(value));
              if (!env) {
                const injected = options.account.secretsForTask(
                    { orgId: value.orgId, userId: value.userId, taskId: value.taskId },
                    value.provider,
                  ),
                  runnerId = randomUUID(),
                  grant = await options.workers.provision({
                    orgId: value.orgId,
                    userId: value.userId,
                    taskId: value.taskId,
                    runnerId,
                  });
                env = {
                  ZOLTBOT_ORG_ID: value.orgId,
                  ZOLTBOT_TASK_ID: value.taskId,
                  ZOLTBOT_MEMBER_ID: value.userId,
                  ZOLTBOT_RUNNER_ID: runnerId,
                  ZOLTBOT_PROVIDER: value.provider,
                  ZOLTBOT_CELL_URL: options.cellOrigin,
                  ZOLTBOT_CLOUD_ORIGIN: options.cloudOrigin,
                  ZOLTBOT_SLEEP_KEEPS_PROCESSES: String(target.capabilities.sleepKeepsProcesses),
                  ZOLTBOT_RUNNER_TOKEN: grant.token,
                  ZOLTBOT_WORKER_REFRESH: grant.refresh,
                  ZOLTBOT_PRIVATE_CONTEXT_KEY: randomBytes(32).toString("base64url"),
                  GITHUB_TOKEN: injected.githubToken,
                  [value.provider === "claude" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY"]:
                    injected.providerKey,
                };
                materials.set(key(value), env);
              }
              return { template: "zoltbot-base", env };
            },
          );
          const ref = result.refs[0];
          if (result.state !== "done" || !ref) throw new Error();
          const job: Job = {
            input: structuredClone(value),
            ref,
            statuses: [],
            createdAt: new Date().toISOString(),
            state: "running",
            intervals: [{ start: now() }],
          };
          jobs.set(key(value), job);
          await launch(job);
          return { status: 200, body: wire(job) };
        }
        const value = parse(SandboxOperationSchema, input),
          job = jobs.get(key(value));
        if (!job || job.ref.id !== value.sandboxId) throw new Error();
        const kind =
          request.method === "DELETE" && request.path === "/api/cloud/sandboxes"
            ? "destroy"
            : request.method === "POST" && request.path.endsWith("/wake")
              ? "wake"
              : request.method === "POST" && request.path.endsWith("/sleep")
                ? "sleep"
                : undefined;
        if (!kind) throw new Error();
        return { status: 200, body: await operate(job, kind, request.operationId) };
      } catch {
        return { status: 503, body: { error: "fixture_operation_refused" } };
      }
    },
    summaries: () =>
      [...jobs.values()].map((job) => ({
        taskId: job.input.taskId,
        orgId: job.input.orgId,
        sandboxId: job.ref.id,
        state: job.state,
        statuses: [...job.statuses],
      })),
    async crash(orgId: string, taskId: string) {
      const job = jobs.get(key({ orgId, taskId }));
      if (!job?.process) throw new Error("fixture_worker_missing");
      const process = job.process;
      await process.kill();
      await process.exit;
    },
    async restart(orgId: string, taskId: string) {
      const job = jobs.get(key({ orgId, taskId }));
      if (!job) throw new Error("fixture_worker_missing");
      await launch(job);
    },
    async deleteOrg(orgId: string) {
      for (const job of jobs.values())
        if (job.input.orgId === orgId && job.state !== "destroyed")
          await operate(job, "destroy", `delete:${job.input.taskId}`);
    },
  });
}
