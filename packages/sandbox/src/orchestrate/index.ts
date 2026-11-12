import { createHash } from "node:crypto";
import type { ExecutionTarget, SandboxRef, SandboxSpec, SandboxState } from "../interface.js";

export interface SandboxScope {
  orgId: string;
  userId: string;
  taskId: string;
}
export interface OperationRequest {
  id: string;
  scope: SandboxScope;
  kind: "create" | "wake" | "sleep" | "destroy";
  /** Non-secret identity of frozen template/setup/startup material, never its plaintext. */
  configurationId: string;
  ref?: SandboxRef;
}
export interface OperationRecord {
  key: string;
  fingerprint: string;
  request: OperationRequest;
  target: string;
  version: number;
  state: "new" | "attempted" | "bound" | "done" | "ambiguous";
  refs: SandboxRef[];
  retryAt: number;
  providerState?: SandboxState;
}
/** Implement each method as one short transaction. No transaction may span provider I/O. */
export interface OperationJournal {
  /** Insert if absent; otherwise return the existing record without replacing it. */
  reserve(initial: OperationRecord): Promise<OperationRecord>;
  /** Compare version and key atomically; write next with version incremented by one. */
  compare(
    key: string,
    version: number,
    next: OperationRecord,
  ): Promise<OperationRecord | undefined>;
}
export type OperationResult =
  | { state: "pending"; refs: SandboxRef[] }
  | { state: "done"; refs: SandboxRef[]; providerState: SandboxState }
  | { state: "ambiguous"; refs: SandboxRef[] };
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const validId = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 200 && !/[\0\r\n]/.test(value);

/** Provider effects only. Accounts, quotas, material custody, worker startup and deletion policy are caller-owned. */
export class SandboxOrchestrator {
  constructor(
    private readonly options: {
      target: ExecutionTarget;
      journal: OperationJournal;
      now?(): number;
    },
  ) {}
  private now() {
    return this.options.now?.() ?? Date.now();
  }
  private ref(ref: SandboxRef) {
    if (
      !ref ||
      ref.target !== this.options.target.id ||
      !validId(ref.id) ||
      typeof ref.workdir !== "string" ||
      !ref.workdir.startsWith("/") ||
      ref.workdir.length > 4096 ||
      /[\0\r\n]/.test(ref.workdir)
    )
      throw new Error("sandbox_operation_invalid");
    return { target: ref.target, id: ref.id, workdir: ref.workdir };
  }
  private result(record: OperationRecord): OperationResult {
    if (record.state === "ambiguous")
      return { state: "ambiguous", refs: structuredClone(record.refs) };
    if (record.state === "done" && record.providerState)
      return {
        state: "done",
        refs: structuredClone(record.refs),
        providerState: record.providerState,
      };
    return { state: "pending", refs: structuredClone(record.refs) };
  }
  private async save(record: OperationRecord, patch: Partial<OperationRecord>) {
    const next = { ...structuredClone(record), ...patch, version: record.version + 1 };
    try {
      return await this.options.journal.compare(record.key, record.version, next);
    } catch {
      throw new Error("sandbox_journal_unavailable");
    }
  }
  private async reserve(record: OperationRecord) {
    try {
      return await this.options.journal.reserve(record);
    } catch {
      throw new Error("sandbox_journal_unavailable");
    }
  }
  private async bound(initial: OperationRecord, refs: SandboxRef[]) {
    let record = initial;
    for (let attempt = 0; attempt < 4; attempt++) {
      const combined = [
        ...new Map([...record.refs, ...refs].map((ref) => [ref.id, this.ref(ref)])).values(),
      ];
      if (combined.length > 256) throw new Error("sandbox_operation_invalid");
      const saved = await this.save(record, {
        refs: combined,
        state: combined.length > 1 ? "ambiguous" : "bound",
        retryAt: 0,
      });
      if (saved) return saved;
      record = await this.reserve(initial);
      if (record.fingerprint !== initial.fingerprint) throw new Error("sandbox_operation_conflict");
    }
    throw new Error("sandbox_journal_unavailable");
  }
  async run(
    raw: OperationRequest,
    prepare?: () => Promise<Omit<SandboxSpec, "labels">>,
  ): Promise<OperationResult> {
    if (
      !raw ||
      typeof raw !== "object" ||
      Array.isArray(raw) ||
      Object.keys(raw).some(
        (key) => !["id", "scope", "kind", "configurationId", "ref"].includes(key),
      ) ||
      !raw.scope ||
      typeof raw.scope !== "object" ||
      Array.isArray(raw.scope) ||
      Object.keys(raw.scope).some((key) => !["orgId", "userId", "taskId"].includes(key)) ||
      (raw.ref && Object.keys(raw.ref).some((key) => !["target", "id", "workdir"].includes(key)))
    )
      throw new Error("sandbox_operation_invalid");
    const request: OperationRequest = {
        id: raw.id,
        kind: raw.kind,
        configurationId: raw.configurationId,
        scope: { orgId: raw.scope.orgId, userId: raw.scope.userId, taskId: raw.scope.taskId },
        ...(raw.ref ? { ref: this.ref(raw.ref) } : {}),
      },
      target = this.options.target;
    if (
      !validId(request.id) ||
      !validId(request.configurationId) ||
      ![request.scope?.orgId, request.scope?.userId, request.scope?.taskId].every(validId) ||
      !["create", "wake", "sleep", "destroy"].includes(request.kind) ||
      (request.kind === "create" ? !!request.ref || !prepare : !request.ref)
    )
      throw new Error("sandbox_operation_invalid");
    if (request.ref) this.ref(request.ref);
    const key = digest([
      request.scope.orgId,
      request.scope.userId,
      request.scope.taskId,
      request.id,
    ]);
    const fingerprint = digest([
      target.id,
      request.scope.orgId,
      request.scope.userId,
      request.scope.taskId,
      request.id,
      request.kind,
      request.configurationId,
      request.ref ?? null,
    ]);
    const initial: OperationRecord = {
      key,
      fingerprint,
      request,
      target: target.id,
      version: 0,
      state: "new",
      refs: request.ref ? [this.ref(request.ref)] : [],
      retryAt: 0,
    };
    let record = await this.reserve(initial);
    if (record.key !== key || record.fingerprint !== fingerprint || record.target !== target.id)
      throw new Error("sandbox_operation_conflict");
    if (record.state === "done" || record.state === "ambiguous") return this.result(record);
    const labels = {
      "zoltbot.org": digest(request.scope.orgId),
      "zoltbot.member": digest(request.scope.userId),
      "zoltbot.task": digest(request.scope.taskId),
      "zoltbot.operation": key,
    };
    if (request.kind === "create") {
      if (record.state === "new") {
        if (record.retryAt > this.now()) return this.result(record);
        const claimed = await this.save(record, {
          state: "attempted",
          retryAt: this.now() + 30000,
        });
        if (!claimed) return this.result(await this.reserve(initial));
        record = claimed;
        let spec: Omit<SandboxSpec, "labels">;
        try {
          spec = (await prepare?.()) ?? {};
        } catch {
          const reset = await this.save(record, { state: "new", retryAt: this.now() + 15000 });
          return this.result(reset ?? record);
        }
        try {
          const ref = this.ref(await target.create({ ...spec, labels }));
          record = await this.bound(record, [ref]);
        } catch {
          // The create may have committed remotely. Never issue another create under this operation.
          return this.result(record);
        }
      } else if (record.state === "attempted") {
        let refs: SandboxRef[];
        try {
          refs = (await target.find(labels)).map((ref) => this.ref(ref));
        } catch {
          return this.result(record);
        }
        if (!refs.length) return this.result(record);
        record = await this.bound(record, refs);
      }
      if (record.state === "ambiguous") return this.result(record);
      const ref = record.refs[0];
      if (!ref) return this.result(record);
      try {
        const state = (await target.status(ref)).state;
        const saved = await this.save(record, { state: "done", providerState: state });
        return this.result(saved ?? (await this.reserve(initial)));
      } catch {
        return this.result(record);
      }
    }
    const ref = record.refs[0];
    if (!ref) throw new Error("sandbox_operation_invalid");
    const desired: SandboxState =
      request.kind === "wake" ? "running" : request.kind === "sleep" ? "sleeping" : "destroyed";
    let state: SandboxState;
    try {
      state = (await target.status(ref)).state;
    } catch {
      return this.result(record);
    }
    if (state !== desired) {
      if (record.state === "attempted" && record.retryAt > this.now()) return this.result(record);
      const claimed = await this.save(record, { state: "attempted", retryAt: this.now() + 30000 });
      if (!claimed) return this.result(await this.reserve(initial));
      record = claimed;
      try {
        await target[request.kind](ref);
        state = (await target.status(ref)).state;
      } catch {
        return this.result(record);
      }
    }
    if (state !== desired) return this.result(record);
    const saved = await this.save(record, { state: "done", providerState: state });
    return this.result(saved ?? (await this.reserve(initial)));
  }
}
