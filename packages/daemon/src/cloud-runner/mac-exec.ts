import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import path from "node:path";
import type { CloudDevice } from "@zoltbot/cloud-contracts";
import {
  type ApprovalPayload,
  approvalStdinHash,
  fromB64,
  linkId,
  verifyApproval,
} from "@zoltbot/link";
import { macPrefixMatches, parse } from "@zoltbot/protocol";
import {
  type MacExecRequest,
  MacExecRequestSchema,
  type MacExecResult,
  MacExecResultSchema,
  type MacStatusRequest,
  MacStatusRequestSchema,
  type MacStatusResult,
  MacStatusResultSchema,
} from "@zoltbot/runner-protocol";
import { MacExecJournal } from "./mac-exec-journal.js";

export interface MacExecution {
  requestId: string;
  taskId: string;
  command: string;
  cwd: string;
  stdin: string;
  timeoutSeconds: number;
}
export interface MacExecutionOptions {
  directory: string;
  orgId: string;
  userId: string;
  deviceId: string;
  mac: string;
  /** Product version supplied by the Mac host; never a Cell-supplied label or Darwin kernel version. */
  osVersion?: string;
  mode(): "off" | "ask" | "allow_listed";
  /** Read through the Mac's own account session, never through the Cell. */
  deviceKeys(signal: AbortSignal): Promise<readonly CloudDevice[]>;
  /** Resolve the active task's folder from this Mac's own project links/scratch policy. */
  task(
    taskId: string,
    turnId: string,
    signal: AbortSignal,
  ): Promise<{ active: boolean; folder: string }>;
  /** The process host must stop its owned process group when aborted. */
  execute(input: MacExecution, signal: AbortSignal): Promise<MacExecResult>;
  now?(): number;
}
const errors = new Set([
  "mac_unavailable",
  "mac_approval_required",
  "mac_approval_refused",
  "mac_request_conflict",
  "mac_approval_replayed",
  "mac_execution_uncertain",
  "mac_exec_unavailable",
]);

/** Independent approval enforcement; a Cell request never establishes execution authority. */
export class MacExecutionHost {
  private readonly journal: MacExecJournal;
  private readonly lifetime = new AbortController();
  private readonly pins = new Map<string, string>();
  private readonly active = new Map<string, Promise<MacExecResult>>();
  private closing: Promise<void> | undefined;
  constructor(private readonly options: MacExecutionOptions) {
    this.journal = MacExecJournal.open(options.directory);
  }
  async status(raw: MacStatusRequest, signal: AbortSignal): Promise<MacStatusResult> {
    const deadline = new AbortController();
    const combined = AbortSignal.any([signal, deadline.signal, this.lifetime.signal]);
    const timer = setTimeout(() => deadline.abort(), 1500);
    try {
      if (combined.aborted) return { available: false, reason: "unavailable" };
      const request = parse(MacStatusRequestSchema, structuredClone(raw));
      if (
        request.userId !== this.options.userId ||
        (request.targetDeviceId && request.targetDeviceId !== this.options.deviceId)
      )
        return { available: false, reason: "unavailable" };
      if (this.options.mode() === "off") return { available: false, reason: "off" };
      if (!this.options.osVersion) return { available: false, reason: "unavailable" };
      const folder = this.folder(request.taskId, request.turnId, request.cwd, combined);
      let abort = () => {};
      const stopped = new Promise<never>((_resolve, reject) => {
        abort = () => reject(new Error("mac_unavailable"));
        combined.addEventListener("abort", abort, { once: true });
        if (combined.aborted) abort();
      });
      let cwd: string;
      try {
        cwd = await Promise.race([folder, stopped]);
      } finally {
        combined.removeEventListener("abort", abort);
      }
      if (combined.aborted || this.options.mode() === "off")
        return { available: false, reason: "unavailable" };
      return parse(MacStatusResultSchema, {
        available: true,
        targetDeviceId: this.options.deviceId,
        mac: this.options.mac,
        osVersion: this.options.osVersion,
        allowListedCommands: this.options.mode() === "allow_listed",
        cwd,
      });
    } catch {
      return { available: false, reason: "unavailable" };
    } finally {
      clearTimeout(timer);
    }
  }
  private async folder(
    taskId: string,
    turnId: string,
    requested: string | undefined,
    signal: AbortSignal,
  ) {
    const task = await this.options.task(taskId, turnId, signal);
    if (signal.aborted || !task.active || !path.isAbsolute(task.folder))
      throw new Error("mac_unavailable");
    const base = await realpath(task.folder),
      cwd = await realpath(path.resolve(base, requested ?? "."));
    const relative = path.relative(base, cwd);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
      throw new Error("mac_approval_refused");
    return cwd;
  }
  async request(raw: MacExecRequest, signal: AbortSignal): Promise<MacExecResult> {
    const combined = AbortSignal.any([signal, this.lifetime.signal]);
    try {
      if (combined.aborted || !["ask", "allow_listed"].includes(this.options.mode()))
        throw new Error("mac_unavailable");
      const request = parse(MacExecRequestSchema, structuredClone(raw));
      if (
        request.userId !== this.options.userId ||
        request.targetDeviceId !== this.options.deviceId
      )
        throw new Error("mac_approval_refused");
      const approval = request.approval;
      if (!approval) throw new Error("mac_approval_required");
      const prefix = approval.payload.scope === "prefix";
      if (
        prefix &&
        (this.options.mode() !== "allow_listed" ||
          !macPrefixMatches(approval.payload.command, request.command) ||
          !!request.stdin ||
          approval.payload.stdinHash !== approvalStdinHash())
      )
        throw new Error("mac_approval_required");
      const keys = await this.options.deviceKeys(combined);
      const registered = keys.filter(
        (key) =>
          key.userId === this.options.userId &&
          key.deviceId === approval.payload.signerDeviceId &&
          !key.revokedAt,
      );
      if (registered.length !== 1) throw new Error("mac_approval_refused");
      const device = registered[0];
      if (
        !device ||
        linkId(fromB64(device.publicKey)) !== device.deviceId ||
        (this.pins.has(device.deviceId) && this.pins.get(device.deviceId) !== device.publicKey)
      )
        throw new Error("mac_approval_refused");
      this.pins.set(device.deviceId, device.publicKey);
      const cwd = await this.folder(request.taskId, request.turnId, request.cwd, combined);
      const expected: ApprovalPayload = {
        ...approval.payload,
        orgId: this.options.orgId,
        userId: this.options.userId,
        requestId: prefix ? approval.payload.requestId : request.requestId,
        taskId: request.taskId,
        turnId: prefix ? approval.payload.turnId : request.turnId,
        targetDeviceId: this.options.deviceId,
        scope: prefix ? "prefix" : "command",
        command: prefix ? approval.payload.command : request.command,
        cwd,
        stdinHash: approvalStdinHash(request.stdin ?? ""),
        timeoutSeconds: request.timeoutSeconds ?? 600,
      };
      const now = this.options.now?.() ?? Date.now();
      const expired = approval.payload.expiresAt <= now;
      if (
        combined.aborted ||
        !["ask", "allow_listed"].includes(this.options.mode()) ||
        (prefix && this.options.mode() !== "allow_listed") ||
        !verifyApproval(
          device.publicKey,
          approval,
          expected,
          expired ? approval.payload.expiresAt - 1 : now,
        )
      )
        throw new Error("mac_approval_refused");
      const binding = createHash("sha256")
        .update(
          JSON.stringify([
            expected.orgId,
            expected.userId,
            request.requestId,
            expected.taskId,
            request.turnId,
            expected.targetDeviceId,
            expected.scope,
            request.command,
            expected.cwd,
            expected.stdinHash,
            expected.timeoutSeconds,
          ]),
        )
        .digest("hex");
      const scope = {
        orgId: this.options.orgId,
        userId: this.options.userId,
        taskId: request.taskId,
        requestId: request.requestId,
      };
      const key = JSON.stringify(scope),
        ruleBinding = createHash("sha256")
          .update(
            JSON.stringify(
              Object.entries(approval.payload).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
            ),
          )
          .digest("hex"),
        claimed = prefix
          ? expired
            ? this.journal.existingPrefix(scope, binding, approval.signature, ruleBinding)
            : this.journal.beginPrefix(
                scope,
                binding,
                approval.signature,
                ruleBinding,
                request.requestId === approval.payload.requestId &&
                  request.turnId === approval.payload.turnId,
              )
          : expired
            ? this.journal.existing(scope, binding, approval.signature)
            : this.journal.begin(scope, binding, approval.signature);
      if (!claimed) throw new Error("mac_approval_refused");
      if (claimed.state === "completed") return claimed.result;
      const running = this.active.get(key);
      if (claimed.state === "executing" && running) return await running;
      if (claimed.state !== "new") throw new Error("mac_execution_uncertain");
      const work = (async () => {
        if (combined.aborted) throw new Error("mac_execution_uncertain");
        const result = parse(
          MacExecResultSchema,
          await this.options.execute(
            {
              requestId: request.requestId,
              taskId: request.taskId,
              command: request.command,
              cwd,
              stdin: request.stdin ?? "",
              timeoutSeconds: expected.timeoutSeconds,
            },
            combined,
          ),
        );
        if (result.mac !== this.options.mac) throw new Error("mac_exec_unavailable");
        if (
          Buffer.byteLength(result.stdout) > 262144 ||
          Buffer.byteLength(result.stderr) > 65536 ||
          (result.stdoutBytes !== undefined &&
            result.stdoutBytes < Buffer.byteLength(result.stdout)) ||
          (result.stderrBytes !== undefined &&
            result.stderrBytes < Buffer.byteLength(result.stderr))
        )
          throw new Error("mac_exec_unavailable");
        this.journal.complete(scope, binding, result);
        return result;
      })();
      this.active.set(key, work);
      try {
        return await work;
      } finally {
        this.active.delete(key);
      }
    } catch (error) {
      throw new Error(
        error instanceof Error && errors.has(error.message)
          ? error.message
          : "mac_exec_unavailable",
      );
    }
  }
  close() {
    this.closing ??= (async () => {
      this.lifetime.abort();
      await Promise.allSettled([...this.active.values()]);
      this.pins.clear();
      this.journal.close();
    })();
    return this.closing;
  }
}
