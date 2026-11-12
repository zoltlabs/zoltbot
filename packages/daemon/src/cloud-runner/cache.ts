import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import { queueHumanInput, resumeTask } from "@zoltbot/core";
import {
  type AgentDefinition,
  AgentDefinitionSchema,
  type DomainEvent,
  type EntityKind,
  entitySchemas,
  parse,
  QueuedInputBodySchema,
  type UserInput,
} from "@zoltbot/protocol";
import { type RunnerLease, RunnerLeaseSchema } from "@zoltbot/runner-protocol";
import { acquireOwnerLock, openStore, type Store } from "@zoltbot/store";
import { assertPublicDefinition } from "../definition-configuration.js";
import { recover } from "../recovery.js";
import { previousForThread } from "../runtime-configuration.js";
import { assertPortableCloudInput } from "./input.js";
import type { ManagedWorkspaceResult } from "./workspaces.js";

interface CacheOptions {
  directory: string;
  orgId: string;
  memberId: string;
  lease: RunnerLease;
  workspace: ManagedWorkspaceResult;
  /** A locally pinned definition, never the launch recipe received from the Cell. */
  definition: AgentDefinition;
  guard(value: unknown): void;
}
const marker = "cloud.runner.binding";

/** One replica per cloud task. There is no Local store argument or global projection. */
export class CloudTaskCache {
  private lease: RunnerLease;
  private closed = false;
  private constructor(
    private readonly options: CacheOptions,
    readonly store: Store,
    private readonly owner: ReturnType<typeof acquireOwnerLock>,
  ) {
    this.lease = structuredClone(options.lease);
  }
  static async open(source: CacheOptions) {
    const options = {
      ...source,
      lease: structuredClone(source.lease),
      definition: structuredClone(source.definition),
      workspace: structuredClone(source.workspace),
    };
    let owner: ReturnType<typeof acquireOwnerLock> | undefined;
    let store: Store | undefined;
    try {
      if (!path.isAbsolute(options.directory) || !path.isAbsolute(options.workspace.cwd))
        throw new Error("runner_cache_scope_conflict");
      const id = createHash("sha256")
        .update(JSON.stringify([options.orgId, options.lease.taskId]))
        .digest("hex");
      await mkdir(options.directory, { recursive: true, mode: 0o700 });
      const root = await lstat(options.directory);
      if (!root.isDirectory() || root.isSymbolicLink()) throw new Error("runner_cache_unavailable");
      const directory = path.join(await realpath(options.directory), id);
      await mkdir(directory, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
      });
      const info = await lstat(directory);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("runner_cache_unavailable");
      await chmod(directory, 0o700);
      for (const name of ["cache.db", "cache.db-wal", "cache.db-shm"]) {
        const file = await lstat(path.join(directory, name)).catch(
          (error: NodeJS.ErrnoException) => {
            if (error.code !== "ENOENT") throw error;
            return undefined;
          },
        );
        if (file && (!file.isFile() || file.isSymbolicLink()))
          throw new Error("runner_cache_unavailable");
      }
      owner = acquireOwnerLock(path.join(directory, "cache.lock"));
      store = await openStore(path.join(directory, "cache.db"));
      const cache = new CloudTaskCache(options, store, owner);
      cache.validate(options.lease);
      const saved = store.record("settings", marker)?.value;
      const binding = cache.binding();
      if (saved !== undefined && JSON.stringify(saved) !== JSON.stringify(binding))
        throw new Error("runner_cache_scope_conflict");
      if (saved === undefined && store.lastSeq() !== 0)
        throw new Error("runner_cache_scope_conflict");
      const before = store.snapshot(["task", "turn", "interaction", "item"]);
      const interrupted = before.turn?.some((turn) => turn.status === "running");
      const waiting =
        before.interaction?.some((interaction) => interaction.state === "pending") ||
        before.item?.some(
          (item) =>
            item.kind === "tool" &&
            (item.body as { status?: string; name?: string })?.status === "running" &&
            /(?:^|__)mac_exec$/.test(String((item.body as { name?: string })?.name)),
        );
      const queued = before.item?.some(
        (item) =>
          item.kind === "user" && (item.body as { queueState?: string })?.queueState === "queued",
      );
      const bootId = `runner-recovery:${randomUUID()}`,
        at = new Date().toISOString();
      recover(store, bootId, at);
      if (interrupted && !waiting && !queued) {
        const commandId = `${bootId}:continue`;
        store.dispatch(commandId, (state) =>
          resumeTask(state, options.lease.taskId, bootId, {
            commandId,
            at,
            actor: { kind: "system", id: "cloud-runner" },
          }),
        );
      }
      cache.update(options.lease);
      return cache;
    } catch (error) {
      store?.close();
      owner?.release();
      if (
        error instanceof Error &&
        [
          "runner_cache_scope_conflict",
          "runner_native_identity_changed",
          "runner_cache_missing",
        ].includes(error.message)
      )
        throw error;
      throw new Error("runner_cache_unavailable");
    }
  }
  private binding() {
    const execution = this.lease.execution;
    if (!execution) throw new Error("runner_cache_scope_conflict");
    return {
      version: 1,
      orgId: this.options.orgId,
      memberId: this.options.memberId,
      taskId: this.lease.taskId,
      leaseId: this.lease.leaseId,
      threadId: execution.thread.id,
      projectId: execution.project.id,
      profileId: execution.profile.id,
      definitionId: this.options.definition.id,
      provider: this.options.definition.adapter,
      repository: execution.project.cloud?.repository,
      defaultBranch: execution.project.cloud?.defaultBranch,
      location: execution.task.location,
      cwd: this.options.workspace.cwd,
      baseCommit: this.options.workspace.baseCommit,
    };
  }
  private validate(raw: RunnerLease) {
    const lease = parse(RunnerLeaseSchema, structuredClone(raw)),
      execution = lease.execution;
    const pinned = parse(AgentDefinitionSchema, this.options.definition);
    assertPublicDefinition(pinned);
    if (
      !execution ||
      !this.options.orgId ||
      lease.actor.userId !== this.options.memberId ||
      execution.task.createdBy.id !== this.options.memberId ||
      execution.task.id !== lease.taskId ||
      execution.thread.id !== execution.task.threadId ||
      execution.thread.taskId !== lease.taskId ||
      execution.project.id !== execution.task.projectId ||
      execution.thread.projectId !== execution.project.id ||
      !execution.project.cloud ||
      execution.profile.id !== execution.task.ownerAgentId ||
      execution.thread.agentId !== execution.profile.id ||
      execution.profile.definitionId !== pinned.id ||
      execution.definition.id !== pinned.id ||
      execution.definition.adapter !== pinned.adapter ||
      lease.taskId !== this.lease.taskId ||
      lease.leaseId !== this.lease.leaseId ||
      lease.launchManifest.threadId !== execution.thread.id ||
      lease.launchManifest.taskId !== lease.taskId ||
      lease.launchManifest.taskRevision !== execution.task.revision ||
      lease.launchManifest.profileId !== execution.profile.id ||
      lease.launchManifest.projectId !== execution.project.id
    )
      throw new Error("runner_cache_scope_conflict");
    const previous = this.lease;
    this.lease = lease;
    try {
      const saved = this.store.record("settings", marker)?.value;
      if (saved !== undefined && JSON.stringify(saved) !== JSON.stringify(this.binding()))
        throw new Error("runner_cache_scope_conflict");
    } finally {
      this.lease = previous;
    }
    const native = previousForThread(this.store.snapshot(), execution.thread.id);
    if (execution.previousNativeId && !native) throw new Error("runner_cache_missing");
    if (execution.previousNativeId && native && native.nativeId !== execution.previousNativeId)
      throw new Error("runner_native_identity_changed");
    this.options.guard(lease);
    this.options.guard(pinned);
    return lease;
  }
  update(raw: RunnerLease) {
    if (this.closed) throw new Error("runner_cache_closed");
    const lease = this.validate(raw),
      execution = lease.execution;
    if (!execution) throw new Error("runner_cache_scope_conflict");
    const current = this.store.record("task", lease.taskId);
    if (current && Number(current.revision) > execution.task.revision)
      throw new Error("runner_cache_scope_conflict");
    const commandId = `runner-cache:${randomUUID()}`,
      at = new Date().toISOString();
    const binding = this.binding();
    this.store.dispatch(commandId, (state) => {
      const events: DomainEvent[] = [];
      const append = (kind: EntityKind, value: Record<string, unknown>) => {
        parse(entitySchemas[kind], value);
        const id = String(value.id ?? value.key);
        events.push({
          eventId: `${commandId}:${events.length}`,
          aggregateType: kind,
          aggregateId: id,
          type: `${kind}.${state[kind]?.some((row) => String(row.id ?? row.key) === id) ? "updated" : "created"}`,
          occurredAt: at,
          payload: value,
        });
      };
      if (!state.settings?.some((row) => row.key === marker))
        append("settings", { key: marker, value: binding });
      append("agentDefinition", structuredClone(this.options.definition));
      append("agent", execution.profile);
      append("project", {
        ...execution.project,
        roots: [{ path: this.options.workspace.cwd, label: execution.project.name }],
        setupScript: "",
      });
      append("task", execution.task);
      append("thread", execution.thread);
      let seq = (state.item ?? []).reduce((highest, row) => Math.max(highest, Number(row.seq)), 0);
      const seen = new Set<string>();
      for (const item of execution.queuedItems) {
        const body = parse(QueuedInputBodySchema, item.body);
        assertPortableCloudInput(body.input);
        if (
          seen.has(item.id) ||
          item.kind !== "user" ||
          item.threadId !== execution.thread.id ||
          body.queueState !== "queued"
        )
          throw new Error("runner_cache_scope_conflict");
        seen.add(item.id);
        const existing = state.item?.find((row) => row.id === item.id);
        if (existing) {
          const old = parse(QueuedInputBodySchema, existing.body);
          if (
            existing.threadId !== item.threadId ||
            JSON.stringify(old.input) !== JSON.stringify(body.input) ||
            old.mode !== body.mode
          )
            throw new Error("runner_cache_scope_conflict");
          continue;
        }
        append("item", { ...item, seq: ++seq });
      }
      return { events, result: { ok: true } };
    });
    this.lease = lease;
  }
  queue(commandId: string, inputId: string, input: UserInput, mode: "queue" | "steer") {
    if (this.closed) throw new Error("runner_cache_closed");
    this.options.guard(input);
    assertPortableCloudInput(input);
    const execution = this.lease.execution;
    if (!execution) throw new Error("runner_cache_scope_conflict");
    const digest = createHash("sha256")
      .update(JSON.stringify([execution.thread.id, inputId, mode, input]))
      .digest("hex");
    const previous = this.store.receipt<{ kind: string; id: string; digest: string }>(commandId);
    if (
      previous &&
      (previous.result.kind !== "runner_input" ||
        previous.result.id !== inputId ||
        previous.result.digest !== digest)
    )
      throw new Error("runner_cache_scope_conflict");
    return this.store.dispatch(commandId, (state) => {
      const old = state.item?.find((row) => row.id === inputId);
      if (old) {
        const body = parse(QueuedInputBodySchema, old.body);
        if (
          old.threadId !== execution.thread.id ||
          JSON.stringify(body.input) !== JSON.stringify(input) ||
          body.mode !== mode
        )
          throw new Error("runner_cache_scope_conflict");
        return {
          events: [],
          result: { kind: "runner_input", id: inputId, disposition: "queued", digest },
        };
      }
      const output = queueHumanInput(
        state,
        { threadId: execution.thread.id, input, mode },
        inputId,
        {
          commandId,
          at: new Date().toISOString(),
          actor: { kind: "human", id: this.options.memberId },
        },
      );
      return {
        events: output.events,
        result: { kind: "runner_input", id: inputId, disposition: "queued", digest },
      };
    }).result;
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    try {
      this.store.close();
    } finally {
      this.owner.release();
    }
  }
}
