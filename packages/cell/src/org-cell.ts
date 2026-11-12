import { DurableObject } from "cloudflare:workers";
import { type CellTokenClaims, CellTokenClaimsSchema } from "@zoltbot/cloud-contracts";
import { type MacOutputChunk, parse } from "@zoltbot/protocol";
import { migrateDriver, Store } from "@zoltbot/store/portable";
import { interactionAlarms, rebuildAlarm } from "./alarm-work.js";
import { CellAnswers } from "./answers.js";
import { boundedJson } from "./auth.js";
import { CloudRpc, safeError } from "./cloud-rpc.js";
import { CellCommands } from "./commands.js";
import { CellLeases } from "./leases.js";
import { CellMacBridge } from "./mac-bridge.js";
import { CellRunners } from "./runners.js";
import { CellSandboxes } from "./sandboxes.js";
import { seedCell } from "./seed.js";
import { CellService } from "./service.js";
import { attachment, CellSockets } from "./sockets.js";
import { CellSqlDriver } from "./sql-driver.js";

export class OrgCell extends DurableObject<Cloudflare.Env> {
  private store: Store | undefined;
  private service: CellService | undefined;
  private deleted = false;
  private mac: CellMacBridge | undefined;
  private async open(claims: CellTokenClaims): Promise<Store> {
    if (this.deleted) throw new Error("unauthorized");
    this.service ??= new CellService(
      {
        origin: this.env.ORCHESTRATOR_URL,
        signingKey: this.env.ORCHESTRATOR_SIGNING_KEY,
        issuer: this.env.CELL_JWT_ISSUER,
      },
      claims.org,
    );
    await this.service.authorize(claims);
    if (this.deleted) throw new Error("unauthorized");
    if (!this.store)
      await this.ctx.blockConcurrencyWhile(async () => {
        if (this.deleted) throw new Error("unauthorized");
        if (this.store) return;
        const driver = new CellSqlDriver(this.ctx.storage);
        migrateDriver(driver);
        driver.exec(
          "CREATE TABLE IF NOT EXISTS cell_identity(id INTEGER PRIMARY KEY CHECK(id=1),org_id TEXT NOT NULL,user_id TEXT NOT NULL)",
        );
        const identity = driver
          .prepare("SELECT org_id,user_id FROM cell_identity WHERE id=1")
          .get() as { org_id: string; user_id: string } | undefined;
        if (identity && (identity.org_id !== claims.org || identity.user_id !== claims.sub))
          throw new Error("unauthorized");
        if (!identity)
          driver.prepare("INSERT INTO cell_identity VALUES(1,?,?)").run(claims.org, claims.sub);
        const store = new Store(driver);
        seedCell(store);
        this.store = store;
      });
    const identity = this.store?.database
      .prepare("SELECT org_id,user_id FROM cell_identity WHERE id=1")
      .get() as { org_id: string; user_id: string } | undefined;
    if (!this.store || identity?.org_id !== claims.org || identity.user_id !== claims.sub)
      throw new Error("unauthorized");
    return this.store;
  }
  override async fetch(request: Request): Promise<Response> {
    if (request.method === "DELETE" && request.headers.get("x-zolt-service") === "delete") {
      this.deleted = true;
      this.mac?.close();
      this.mac = undefined;
      this.service?.invalidate();
      this.store?.database.close();
      await this.ctx.storage.deleteAlarm();
      await this.ctx.storage.deleteAll();
      for (const socket of this.ctx.getWebSockets()) socket.close(1008, "deleted");
      this.store = undefined;
      return Response.json({ deleted: true });
    }
    try {
      const claims = parse(
        CellTokenClaimsSchema,
        JSON.parse(request.headers.get("x-zolt-claims") ?? "null"),
      );
      const store = await this.open(claims);
      if (new URL(request.url).pathname.endsWith("/connect")) {
        const permissions = await this.service?.authorize(claims);
        if (this.deleted) throw new Error("unauthorized");
        const response = new CellSockets(this.ctx).connect(request, claims, store, permissions);
        if (response.status === 101) await this.schedule();
        return response;
      }
      const input = await boundedJson(request);
      try {
        if (!this.service) throw new Error("service_unavailable");
        const response = await new CloudRpc(
          store,
          claims,
          this.service,
          new CellAnswers(store, this.ctx),
        ).call(input);
        if (this.deleted) throw new Error("unauthorized");
        await this.broadcast(store);
        await this.schedule(1);
        return Response.json(response);
      } catch (error) {
        const id = input && typeof input === "object" && "id" in input ? input.id : null;
        return Response.json({
          jsonrpc: "2.0",
          id,
          error: { code: -32000, message: safeError(error) },
        });
      }
    } catch {
      return new Response(null, { status: 401 });
    }
  }
  private async schedule(delay = 15000) {
    if (this.deleted) return;
    const next = Date.now() + delay;
    const alarm = await this.ctx.storage.getAlarm();
    if (this.deleted) return;
    if (alarm === null || alarm > next) await this.ctx.storage.setAlarm(next);
  }
  private sandboxes(store: Store, answers: CellAnswers) {
    if (this.deleted || !this.service) throw new Error("unauthorized");
    const commands = new CellCommands(store);
    const identity = store.database
      .prepare("SELECT org_id,user_id FROM cell_identity WHERE id=1")
      .get() as { org_id: string; user_id: string };
    return new CellSandboxes(
      store,
      this.service,
      identity.org_id,
      identity.user_id,
      () => Date.now(),
      () => !this.deleted,
      (taskId) => answers.pending(taskId) || commands.pending(taskId),
    );
  }
  private async broadcast(store: Store) {
    if (this.deleted) return;
    const sockets = new CellSockets(this.ctx);
    for (const runner of this.ctx.getWebSockets("runner")) {
      if (this.deleted) return;
      try {
        await this.authorizeSocket(runner);
        await new CellRunners(this.ctx, store, this.bridge(store)).offer(runner);
        this.bridge(store).deliver(runner);
      } catch (error) {
        if (error instanceof Error && error.message === "unauthorized")
          runner.close(1008, "unauthorized");
        await this.schedule();
      }
    }
    for (const socket of this.ctx.getWebSockets("client")) {
      if (this.deleted) return;
      try {
        const data = attachment(socket);
        if (data.claims.exp <= Math.floor(Date.now() / 1000)) {
          socket.close(1008, "unauthorized");
          continue;
        }
        if (sockets.replay(socket, store)) await this.schedule(1);
      } catch {
        socket.close(1013, "reconnect");
      }
    }
  }
  override async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer) {
    let responseId: string | number | null = null;
    try {
      const data = attachment(socket);
      const maximum = data.claims.kind === "client" ? 65536 : 2097152;
      if (
        typeof message !== "string" ||
        message.length > maximum ||
        new TextEncoder().encode(message).byteLength > maximum
      )
        throw new Error("forbidden");
      const store = await this.open(data.claims);
      if (!this.service) throw new Error("unauthorized");
      await this.authorizeSocket(socket);
      const input: unknown = JSON.parse(message);
      if (
        input &&
        typeof input === "object" &&
        "id" in input &&
        (typeof input.id === "string" || typeof input.id === "number")
      )
        responseId = input.id;
      const response =
        data.claims.kind === "client"
          ? await new CloudRpc(
              store,
              data.claims,
              this.service,
              new CellAnswers(store, this.ctx),
            ).call(input)
          : await new CellRunners(this.ctx, store, this.bridge(store)).message(socket, input);
      if (
        data.claims.kind === "client" &&
        input &&
        typeof input === "object" &&
        "method" in input &&
        ["events.subscribe", "events.unsubscribe"].includes(String(input.method))
      ) {
        const subscription = attachment(socket);
        subscription.subscribed = input.method === "events.subscribe";
        if (subscription.subscribed) {
          const params = "params" in input ? (input.params as { fromSeq?: number }) : {};
          const from = params.fromSeq ?? store.lastSeq();
          subscription.lastSeq = Math.min(from, store.lastSeq());
          if (response && "result" in response && (response.result as { resync?: boolean }).resync)
            subscription.lastSeq = store.lastSeq();
        }
        socket.serializeAttachment(subscription);
      }
      if (this.deleted || socket.readyState !== WebSocket.OPEN) return;
      if (response) socket.send(JSON.stringify(response));
      await this.broadcast(store);
      await this.schedule();
    } catch (error) {
      if (socket.readyState !== WebSocket.OPEN) return;
      if (error instanceof Error && error.message === "unauthorized") {
        socket.close(1008, "unauthorized");
        return;
      }
      socket.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: responseId,
          error: { code: -32000, message: safeError(error) },
        }),
      );
    }
  }
  override async webSocketClose(socket: WebSocket, code: number) {
    const valid =
      [1000, 1001, 1002, 1003, 1007, 1008, 1009, 1010, 1011, 1012, 1013, 1014].includes(code) ||
      (code >= 3000 && code <= 4999);
    socket.close(valid ? code : 1000);
  }
  override async webSocketError(socket: WebSocket) {
    socket.close(1011, "reconnect");
  }
  private async authorizeSocket(socket: WebSocket, fresh = false) {
    if (this.deleted || !this.service) throw new Error("unauthorized");
    const data = attachment(socket);
    const permissions = await this.service.authorize(data.claims, Date.now(), fresh);
    if (this.deleted || socket.readyState !== WebSocket.OPEN) throw new Error("unauthorized");
    if (data.claims.kind === "mac_runner") {
      if (!permissions) throw new Error("unauthorized");
      const current = attachment(socket);
      current.permissions = permissions;
      socket.serializeAttachment(current);
    }
  }
  private bridge(store: Store) {
    if (this.deleted) throw new Error("unauthorized");
    if (!this.mac) {
      const identity = store.database
        .prepare("SELECT org_id,user_id FROM cell_identity WHERE id=1")
        .get() as { org_id: string; user_id: string } | undefined;
      if (!identity) throw new Error("unauthorized");
      this.mac = new CellMacBridge(
        store,
        this.ctx,
        { orgId: identity.org_id, userId: identity.user_id },
        (socket) => this.authorizeSocket(socket),
        () => !this.deleted,
        (chunk) => this.publishMacChunk(chunk),
      );
    }
    return this.mac;
  }
  private async publishMacChunk(chunk: MacOutputChunk) {
    for (const socket of this.ctx.getWebSockets("client")) {
      if (this.deleted) return;
      try {
        await this.authorizeSocket(socket);
        if (!attachment(socket).subscribed || this.deleted) continue;
        socket.send(JSON.stringify({ jsonrpc: "2.0", method: "mac.exec.chunk", params: chunk }));
      } catch {
        socket.close(1008, "unauthorized");
      }
    }
  }
  private async alarmStore(): Promise<Store | undefined> {
    if (this.deleted) return;
    const driver = new CellSqlDriver(this.ctx.storage);
    if (
      !driver
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='cell_identity'")
        .get()
    )
      return;
    const identity = driver.prepare("SELECT org_id,user_id FROM cell_identity WHERE id=1").get() as
      | { org_id: string; user_id: string }
      | undefined;
    if (!identity) return;
    this.service ??= new CellService(
      {
        origin: this.env.ORCHESTRATOR_URL,
        signingKey: this.env.ORCHESTRATOR_SIGNING_KEY,
        issuer: this.env.CELL_JWT_ISSUER,
      },
      identity.org_id,
    );
    const access = (await this.service.request("access", "POST", {
      orgId: identity.org_id,
      userId: identity.user_id,
      kind: "cell",
    })) as { active?: boolean };
    if (!access.active || this.deleted) throw new Error("unauthorized");
    this.store ??= new Store(driver);
    return this.store;
  }
  override async alarm() {
    if (this.deleted) return;
    try {
      const store = await this.alarmStore();
      if (!store) return;
      if (await rebuildAlarm(store, this.ctx.storage)) {
        if (!store.rebuildProgress()) await this.schedule();
        return;
      }
      const pending = interactionAlarms(store);
      for (const socket of this.ctx.getWebSockets()) {
        try {
          const data = attachment(socket);
          await this.authorizeSocket(socket, true);
          if (data.claims.kind === "client" && new CellSockets(this.ctx).replay(socket, store))
            await this.schedule(1);
        } catch {
          socket.close(1008, "unauthorized");
        }
      }
      if (this.deleted) return;
      const answers = new CellAnswers(store, this.ctx);
      const answerAlarm = answers.alarm();
      const sandboxes = this.sandboxes(store, answers);
      const commands = new CellCommands(store);
      const next = await sandboxes.tick(async (taskId) => {
        if (this.deleted) throw new Error("unauthorized");
        const task = store.record("task", taskId);
        const turn = store.database
          .prepare(
            "SELECT id FROM turns WHERE thread_id=? AND status='running' ORDER BY started_at DESC LIMIT 1",
          )
          .get(String(task?.threadId)) as { id: string } | undefined;
        sandboxes.checkpoint(taskId, () => {
          commands.enqueue(taskId, `checkpoint:${taskId}:r${task?.revision}`, {
            type: "interrupt",
            ...(turn ? { turnId: turn.id } : {}),
          });
        });
      });
      if (this.deleted) return;
      const retry = await new CellLeases(store).checkPresence(
        (taskId, operationId) => sandboxes.wake(taskId, operationId),
        Date.now(),
        (taskId) => sandboxes.get(taskId)?.state === "sleeping",
      );
      if (this.deleted) return;
      await this.broadcast(store);
      if (next !== undefined) await this.schedule(Math.max(1, next - Date.now()));
      if (answerAlarm !== undefined) await this.schedule(Math.max(1, answerAlarm - Date.now()));
      if (retry || pending || this.ctx.getWebSockets().length) await this.schedule();
    } catch {
      for (const socket of this.ctx.getWebSockets()) socket.close(1008, "unauthorized");
      await this.schedule();
    }
  }
}
