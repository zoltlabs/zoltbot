import { DurableObject } from "cloudflare:workers";
import { type CellTokenClaims, CellTokenClaimsSchema } from "@zoltbot/cloud-contracts";
import { parse } from "@zoltbot/protocol";
import { migrateDriver, Store } from "@zoltbot/store/portable";
import { interactionAlarms, rebuildAlarm } from "./alarm-work.js";
import { boundedJson } from "./auth.js";
import { CloudRpc, safeError } from "./cloud-rpc.js";
import { seedCell } from "./seed.js";
import { CellService } from "./service.js";
import { attachment, CellSockets } from "./sockets.js";
import { CellSqlDriver } from "./sql-driver.js";

export class OrgCell extends DurableObject<Cloudflare.Env> {
  private store: Store | undefined;
  private service: CellService | undefined;
  private deleted = false;
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
      this.service?.invalidate();
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
        const response = new CellSockets(this.ctx).connect(request, claims, store);
        if (response.status === 101) await this.schedule();
        return response;
      }
      const input = await boundedJson(request);
      try {
        if (!this.service) throw new Error("service_unavailable");
        const response = await new CloudRpc(store, claims, this.service).call(input);
        await this.broadcast(store);
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
    const next = Date.now() + delay;
    const alarm = await this.ctx.storage.getAlarm();
    if (alarm === null || alarm > next) await this.ctx.storage.setAlarm(next);
  }
  private async broadcast(store: Store) {
    const sockets = new CellSockets(this.ctx);
    for (const socket of this.ctx.getWebSockets("client")) {
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
    try {
      if (
        typeof message !== "string" ||
        message.length > 65536 ||
        new TextEncoder().encode(message).byteLength > 65536
      )
        throw new Error("forbidden");
      const data = attachment(socket);
      const store = await this.open(data.claims);
      if (!this.service) throw new Error("unauthorized");
      const input: unknown = JSON.parse(message);
      const response = await new CloudRpc(store, data.claims, this.service).call(input);
      if (input && typeof input === "object" && "method" in input) {
        if (input.method === "events.unsubscribe") data.subscribed = false;
        if (input.method === "events.subscribe") {
          const params = "params" in input ? (input.params as { fromSeq?: number }) : {};
          data.lastSeq = params.fromSeq ?? 0;
          data.subscribed = true;
        }
        socket.serializeAttachment(data);
      }
      socket.send(JSON.stringify(response));
      await this.broadcast(store);
      await this.schedule();
    } catch (error) {
      if (error instanceof Error && error.message === "unauthorized") {
        socket.close(1008, "unauthorized");
        return;
      }
      const input =
        typeof message === "string" && message.length <= 65536
          ? (() => {
              try {
                return JSON.parse(message);
              } catch {
                return null;
              }
            })()
          : null;
      socket.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: input?.id ?? null,
          error: { code: -32000, message: safeError(error) },
        }),
      );
    }
  }
  override async webSocketClose(socket: WebSocket, code: number) {
    socket.close(code);
  }
  override async webSocketError(socket: WebSocket) {
    socket.close(1011, "reconnect");
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
          await this.service?.authorize(data.claims, Date.now(), true);
          if (data.claims.kind === "client" && new CellSockets(this.ctx).replay(socket, store))
            await this.schedule(1);
        } catch {
          socket.close(1008, "unauthorized");
        }
      }
      if (pending || this.ctx.getWebSockets().length) await this.schedule();
    } catch {
      for (const socket of this.ctx.getWebSockets()) socket.close(1008, "unauthorized");
      await this.schedule();
    }
  }
}
