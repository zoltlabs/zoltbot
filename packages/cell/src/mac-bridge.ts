import { parse, TaskSchema } from "@zoltbot/protocol";
import {
  type MacExecProgress,
  type MacExecRequest,
  MacExecRequestSchema,
  type MacStatusRequest,
  MacStatusRequestSchema,
  type MacStatusResult,
  MacStatusResultSchema,
} from "@zoltbot/runner-protocol";
import type { Store } from "@zoltbot/store/portable";
import { CellMacRecords } from "./mac-records.js";
import { attachment } from "./sockets.js";

interface Pending {
  deviceId: string;
  connectionId: string;
  resolve(value: MacStatusResult): void;
}
/** Pending status is transient; command authority and results live in CellMacRecords. */
export class CellMacBridge {
  private readonly records: CellMacRecords;
  private readonly pending = new Map<string, Pending>();
  constructor(
    private readonly store: Store,
    private readonly ctx: Pick<DurableObjectState, "getWebSockets">,
    private readonly owner: { orgId: string; userId: string },
    private readonly authorize: (socket: WebSocket) => Promise<void>,
    private readonly alive = () => true,
  ) {
    this.records = new CellMacRecords(store, owner);
  }
  private currentMac(socket: WebSocket) {
    if (!this.alive() || socket.readyState !== WebSocket.OPEN) return false;
    const data = attachment(socket),
      claims = data.claims;
    const current = this.store.database
      .prepare("SELECT connection_id FROM cell_runner_connections WHERE runner_id=?")
      .get(claims.device) as { connection_id: string } | undefined;
    return (
      claims.kind === "mac_runner" &&
      claims.org === this.owner.orgId &&
      claims.sub === this.owner.userId &&
      claims.exp > Math.floor(Date.now() / 1000) &&
      data.permissions?.canMacExec === true &&
      data.runnerId === claims.device &&
      current?.connection_id === data.connectionId
    );
  }
  private source(socket: WebSocket, taskId: string) {
    if (!this.alive()) throw new Error("forbidden");
    const data = attachment(socket),
      source = { claims: data.claims, connectionId: data.connectionId };
    this.records.authorizeSource(source, taskId);
    return source;
  }
  async status(socket: WebSocket, raw: MacStatusRequest): Promise<MacStatusResult> {
    const request = parse(MacStatusRequestSchema, structuredClone(raw));
    const source = this.source(socket, request.taskId);
    const task = parse(TaskSchema, this.store.record("task", request.taskId));
    const turn = this.store.record("turn", request.turnId);
    if (
      request.userId !== source.claims.sub ||
      task.createdBy.id !== source.claims.sub ||
      !["running", "blocked", "queued"].includes(task.state) ||
      turn?.threadId !== task.threadId
    )
      throw new Error("forbidden");
    const candidates = this.ctx.getWebSockets("runner").filter((candidate) => {
      try {
        return (
          this.currentMac(candidate) &&
          (!request.targetDeviceId ||
            attachment(candidate).claims.device === request.targetDeviceId)
        );
      } catch {
        return false;
      }
    });
    if (!candidates.length) return { available: false, reason: "offline" };
    if (candidates.length !== 1) return { available: false, reason: "choose_mac" };
    if (this.pending.size >= 8) return { available: false, reason: "unavailable" };
    const mac = candidates[0];
    if (!mac) return { available: false, reason: "offline" };
    const data = attachment(mac),
      id = `mac-status:${crypto.randomUUID()}`;
    let finished = false;
    return new Promise<MacStatusResult>((resolve) => {
      const timer = setTimeout(() => settle({ available: false, reason: "offline" }), 1800);
      const settle = (value: MacStatusResult) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        this.pending.delete(id);
        resolve(value);
      };
      this.pending.set(id, {
        deviceId: data.claims.device,
        connectionId: data.connectionId,
        resolve: settle,
      });
      void (async () => {
        try {
          await this.authorize(mac);
          if (finished) return;
          this.source(socket, request.taskId);
          if (!this.currentMac(mac)) throw new Error("forbidden");
          mac.send(
            JSON.stringify({
              jsonrpc: "2.0",
              id,
              method: "mac.status.request",
              params: { ...request, targetDeviceId: data.claims.device },
            }),
          );
        } catch {
          settle({ available: false, reason: "offline" });
        }
      })();
    });
  }
  async exec(socket: WebSocket, raw: MacExecRequest): Promise<MacExecProgress> {
    const request = parse(MacExecRequestSchema, structuredClone(raw));
    const source = this.source(socket, request.taskId);
    if (request.approval || !request.cwd?.startsWith("/")) throw new Error("forbidden");
    const prior = await this.records.poll(source, request);
    if (prior) return prior;
    const status = await this.status(socket, {
      requestId: request.requestId,
      taskId: request.taskId,
      turnId: request.turnId,
      userId: request.userId,
      targetDeviceId: request.targetDeviceId,
      cwd: request.cwd,
    });
    if (!status.available)
      return { state: "denied", requestId: request.requestId, reason: "offline" };
    return this.records.request(this.source(socket, request.taskId), request, {
      deviceId: status.targetDeviceId,
      mac: status.mac,
      cwd: status.cwd,
    });
  }
  deliver(socket: WebSocket, force = false) {
    if (!this.currentMac(socket)) return;
    const data = attachment(socket);
    for (const row of this.records.outgoing(data.claims, data.connectionId, force)) {
      socket.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: `mac-exec:${row.id}`,
          method: "mac.exec.request",
          params: row.request,
        }),
      );
      this.records.sent(row.id, data.claims, data.connectionId);
    }
  }
  receive(socket: WebSocket, response: { id: string | number; result?: unknown; error?: unknown }) {
    if (typeof response.id !== "string" || !/^mac-(?:status|exec):/.test(response.id)) return false;
    if (!this.currentMac(socket)) throw new Error("forbidden");
    const data = attachment(socket);
    if (response.id.startsWith("mac-status:")) {
      const pending = this.pending.get(response.id);
      if (!pending) return true;
      if (pending.deviceId !== data.claims.device || pending.connectionId !== data.connectionId)
        throw new Error("forbidden");
      const result = response.error
        ? { available: false as const, reason: "unavailable" as const }
        : parse(MacStatusResultSchema, response.result);
      if (result.available && result.targetDeviceId !== data.claims.device)
        throw new Error("forbidden");
      pending.resolve(result);
      return true;
    }
    return this.records.receive(data.claims, data.connectionId, response);
  }
  close() {
    for (const pending of this.pending.values())
      pending.resolve({ available: false, reason: "offline" });
    this.pending.clear();
  }
}
