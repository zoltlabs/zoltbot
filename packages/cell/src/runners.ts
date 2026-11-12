import type { CellTokenClaims } from "@zoltbot/cloud-contracts";
import { startTask } from "@zoltbot/core";
import {
  AgentDefinitionSchema,
  ItemSchema,
  ProfileSchema,
  ProjectSchema,
  parse,
  TaskSchema,
  ThreadSchema,
} from "@zoltbot/protocol";
import {
  parseRunnerMessage,
  RunnerDrainSchema,
  type RunnerExecution,
  RunnerHeartbeatSchema,
  type RunnerHello,
  RunnerHelloSchema,
  type RunnerLease,
} from "@zoltbot/runner-protocol";
import type { Store } from "@zoltbot/store/portable";
import { CellAnswers } from "./answers.js";
import { CellCommands } from "./commands.js";
import { CellLeases } from "./leases.js";
import { runnerEvent } from "./runner-events.js";
import { attachment } from "./sockets.js";

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, value]) => [key, canonical(value)]),
    );
  return value;
}
async function digest(value: unknown) {
  return [
    ...new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(JSON.stringify(canonical(value))),
      ),
    ),
  ]
    .map((n) => n.toString(16).padStart(2, "0"))
    .join("");
}
/** All native execution stays on the dialing runner; this class owns its durable assignment. */
export class CellRunners {
  private readonly leases: CellLeases;
  constructor(
    private readonly ctx: DurableObjectState,
    private readonly store: Store,
  ) {
    this.leases = new CellLeases(store);
    store.database.exec(
      "CREATE TABLE IF NOT EXISTS cell_manifests(task_id TEXT NOT NULL,revision INTEGER NOT NULL,body TEXT NOT NULL,PRIMARY KEY(task_id,revision)); CREATE TABLE IF NOT EXISTS cell_lease_offers(task_id TEXT PRIMARY KEY,runner_id TEXT NOT NULL,last_input_id TEXT)",
    );
  }
  private async lease(taskId: string, claims: CellTokenClaims): Promise<RunnerLease> {
    let task = parse(TaskSchema, this.store.record("task", taskId));
    if (task.state === "queued") {
      const commandId = `lease:${task.id}:r${task.revision}`;
      this.store.dispatch(
        commandId,
        (state) => {
          this.leases.assign(taskId, claims.device, claims);
          const latest = this.store.database
            .prepare(
              "SELECT id,seq,kind FROM item_records WHERE thread_id=? ORDER BY seq DESC LIMIT 1",
            )
            .get(String(task.threadId)) as { id: string; seq: number; kind: string } | undefined;
          if (latest) state.item = [{ ...latest, threadId: task.threadId, body: {} }];
          return startTask(state, task.id, task.revision, {
            commandId,
            at: new Date().toISOString(),
            actor: { kind: "system", id: "cell" },
          });
        },
        { scope: { taskId }, kinds: ["task", "thread", "session", "turn"] },
      );
      task = parse(TaskSchema, this.store.record("task", taskId));
    }
    const assigned = this.leases.get(taskId);
    if (!assigned || assigned.runnerId !== claims.device) throw new Error("forbidden");
    this.leases.require(taskId, assigned.leaseId, claims.device, claims);
    if (["completed", "cancelled", "failed"].includes(task.state))
      throw new Error("task_not_running");
    const project = parse(ProjectSchema, this.store.record("project", String(task.projectId)));
    if (!project.cloud) throw new Error("forbidden");
    const thread = parse(ThreadSchema, this.store.record("thread", String(task.threadId)));
    const profile = parse(ProfileSchema, this.store.record("agent", String(task.ownerAgentId)));
    const definition = parse(
      AgentDefinitionSchema,
      this.store.record("agentDefinition", profile.definitionId),
    );
    const saved = this.store.database
      .prepare("SELECT body FROM cell_manifests WHERE task_id=? AND revision=?")
      .get(task.id, task.revision) as { body: string } | undefined;
    const configuration = saved
      ? (JSON.parse(saved.body) as {
          project: typeof project;
          profile: typeof profile;
          definition: typeof definition;
          brief: string;
          acceptance: string;
        })
      : { project, profile, definition, brief: task.brief, acceptance: task.acceptance };
    if (!saved)
      this.store.database
        .prepare("INSERT INTO cell_manifests VALUES(?,?,?)")
        .run(task.id, task.revision, JSON.stringify(configuration));
    const hash = await digest(configuration);
    const fresh = parse(TaskSchema, this.store.record("task", task.id));
    if (["completed", "cancelled", "failed"].includes(fresh.state))
      throw new Error("task_not_running");
    const queued = (
      this.store.database
        .prepare(
          "SELECT id FROM items WHERE thread_id=? AND kind='user' AND json_extract(body,'$.queueState')='queued' ORDER BY seq LIMIT 8",
        )
        .all(thread.id) as { id: string }[]
    ).map((row) => parse(ItemSchema, this.store.record("item", row.id)));
    const sessions = this.store.read({ taskId }, ["session"]).session ?? [];
    const native = sessions
      .filter((row) => row.threadId === thread.id && typeof row.nativeId === "string")
      .sort(
        (a, b) =>
          Number(b.generation ?? 0) - Number(a.generation ?? 0) ||
          String(b.startedAt).localeCompare(String(a.startedAt)),
      )[0]?.nativeId;
    const execution: RunnerExecution = {
      project: configuration.project,
      profile: configuration.profile,
      definition: configuration.definition,
      task: { ...fresh, brief: configuration.brief, acceptance: configuration.acceptance },
      thread,
      queuedItems: queued,
      ...(typeof native === "string" ? { previousNativeId: native } : {}),
    };
    return {
      taskId: task.id,
      leaseId: assigned.leaseId,
      brief: configuration.brief,
      actor: { userId: claims.sub, deviceId: claims.device, surface: "runner" },
      workspaceInstructions: configuration.project.instructions,
      execution,
      launchManifest: {
        version: 1,
        id: `manifest:${task.id}:r${task.revision}`,
        executionId: `${task.id}:r${task.revision}`,
        threadId: thread.id,
        taskId: task.id,
        taskRevision: task.revision,
        projectId: project.id,
        profileId: profile.id,
        configurationHash: hash,
        cwd: ".",
        connections: [],
        skills: [],
        budget: { limit: 1500, fixed: 0, connections: 0, skills: 0, knowledge: 0 },
      },
    };
  }
  private async deliver(
    socket: WebSocket,
    hello: RunnerHello,
    claims: CellTokenClaims,
    includeExisting = true,
  ) {
    const existing = this.leases
      .all()
      .filter((lease) => lease.runnerId === hello.runnerId)
      .map((lease) => lease.taskId);
    const queued =
      claims.kind === "sandbox_runner" && claims.task
        ? [claims.task]
        : hello.acceptTasks
          ? (
              this.store.database
                .prepare(
                  "SELECT id FROM tasks WHERE state='queued' AND execution_location='mac' ORDER BY created_at,id LIMIT 100",
                )
                .all() as { id: string }[]
            ).map((row) => row.id)
          : [];
    for (const taskId of new Set([...existing, ...queued])) {
      const task = parse(TaskSchema, this.store.record("task", taskId));
      if (!["queued", "running", "review", "blocked"].includes(task.state)) continue;
      const currentLease = this.leases.get(taskId);
      if (currentLease && currentLease.runnerId !== hello.runnerId) continue;
      if (!includeExisting && task.state !== "queued") {
        const inputs = this.store.database
          .prepare(
            "SELECT id FROM items WHERE thread_id=? AND kind='user' AND json_extract(body,'$.queueState')='queued' ORDER BY seq LIMIT 8",
          )
          .all(String(task.threadId)) as { id: string }[];
        const offered = this.store.database
          .prepare("SELECT last_input_id FROM cell_lease_offers WHERE task_id=? AND runner_id=?")
          .get(taskId, hello.runnerId) as { last_input_id: string | null } | undefined;
        if (!inputs.length || offered?.last_input_id === inputs.at(-1)?.id) continue;
      }
      const profile = this.store.record("agent", String(task.ownerAgentId));
      if (!hello.clis.some((cli) => cli.id === profile?.definitionId)) continue;
      let lease: RunnerLease;
      try {
        lease = await this.lease(taskId, claims);
      } catch (error) {
        if (error instanceof Error && error.message === "task_not_running") continue;
        throw error;
      }
      socket.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: `ack:${lease.taskId}:${this.leases.get(taskId)?.lastSeq ?? 0}`,
          method: "runner.ack",
          params: { taskId: lease.taskId, runnerSeq: this.leases.get(taskId)?.lastSeq ?? 0 },
        }),
      );
      socket.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: `lease:${lease.leaseId}:r${task.revision}`,
          method: "runner.lease",
          params: lease,
        }),
      );
      this.store.database
        .prepare(
          "INSERT INTO cell_lease_offers(task_id,runner_id,last_input_id) VALUES(?,?,?) ON CONFLICT(task_id) DO UPDATE SET runner_id=excluded.runner_id,last_input_id=excluded.last_input_id",
        )
        .run(taskId, hello.runnerId, lease.execution?.queuedItems.at(-1)?.id ?? null);
    }
  }
  async offer(socket: WebSocket) {
    const data = attachment(socket);
    if (!data.runnerId || data.claims.kind === "client" || socket.readyState !== WebSocket.OPEN)
      return;
    await this.deliver(
      socket,
      {
        runnerId: data.runnerId,
        kind: data.claims.kind === "mac_runner" ? "mac" : "sandbox",
        protocolVersion: 1,
        versions: {},
        clis: (data.clis ?? []).map((id) => ({ id, version: "" })),
        sleepKeepsProcesses: false,
        acceptTasks: data.acceptTasks ?? false,
      },
      data.claims,
      false,
    );
    new CellCommands(this.store).deliver(socket);
    new CellAnswers(this.store, this.ctx).deliver(socket);
  }
  async message(socket: WebSocket, input: unknown) {
    const data = attachment(socket);
    const claims = data.claims;
    if (claims.kind === "client") throw new Error("forbidden");
    const request = parseRunnerMessage(input);
    if (!("method" in request)) {
      if (!data.runnerId || data.runnerId !== claims.device) throw new Error("forbidden");
      if (new CellAnswers(this.store, this.ctx).receive(claims, data.runnerId, request))
        return undefined;
      new CellCommands(this.store).result(claims, data.runnerId, request);
      return undefined;
    }
    if (request.method === "runner.hello") {
      const hello = parse(RunnerHelloSchema, request.params);
      if (
        hello.runnerId !== claims.device ||
        hello.kind !== (claims.kind === "mac_runner" ? "mac" : "sandbox")
      )
        throw new Error("forbidden");
      data.runnerId = hello.runnerId;
      data.clis = hello.clis.map((cli) => cli.id).filter((id) => ["claude", "codex"].includes(id));
      data.acceptTasks = hello.kind === "sandbox" || hello.acceptTasks === true;
      socket.serializeAttachment(data);
      for (const other of this.ctx.getWebSockets("runner"))
        if (
          attachment(other).connectionId !== data.connectionId &&
          attachment(other).runnerId === hello.runnerId
        )
          other.close(1012, "reconnect");
      await this.deliver(socket, hello, claims);
      new CellCommands(this.store).deliver(socket, true);
      new CellAnswers(this.store, this.ctx).deliver(socket, true);
      return { jsonrpc: "2.0", id: request.id, result: { ok: true, heartbeatMs: 15000 } };
    }
    if (!data.runnerId || data.runnerId !== claims.device) throw new Error("forbidden");
    if (request.method === "runner.heartbeat") {
      const heartbeat = parse(RunnerHeartbeatSchema, request.params);
      if (heartbeat.runnerId !== data.runnerId) throw new Error("forbidden");
      this.leases.heartbeat(data.runnerId, heartbeat.leaseIds, claims);
      return { jsonrpc: "2.0", id: request.id, result: { ok: true } };
    }
    if (request.method === "runner.event") {
      const ack = runnerEvent(this.store, claims, data.runnerId, request.params);
      socket.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: `ack:${ack.taskId}:${ack.runnerSeq}`,
          method: "runner.ack",
          params: ack,
        }),
      );
      return { jsonrpc: "2.0", id: request.id, result: ack };
    }
    if (request.method === "runner.drain") {
      const drain = parse(RunnerDrainSchema, request.params);
      if (drain.runnerId !== data.runnerId) throw new Error("forbidden");
      data.acceptTasks = false;
      socket.serializeAttachment(data);
      return { jsonrpc: "2.0", id: request.id, result: { ok: true } };
    }
    throw new Error("method_unavailable");
  }
}
