import { DurableObject } from "cloudflare:workers";
import { type CellTokenClaims, CellTokenClaimsSchema } from "@zoltbot/cloud-contracts";
import { parse } from "@zoltbot/protocol";
import { migrateDriver, Store } from "@zoltbot/store/portable";
import { CellService } from "./service.js";
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
        this.store = new Store(driver);
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
      await this.open(claims);
      return Response.json({ error: "method_unavailable" }, { status: 501 });
    } catch {
      return new Response(null, { status: 401 });
    }
  }
}
