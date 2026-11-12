import { bearer, CellTokenVerifier } from "./auth.js";
import { verifyServiceToken } from "./service.js";

export { OrgCell } from "./org-cell.js";

const verifiers = new Map<string, CellTokenVerifier>();
export default {
  async fetch(request: Request, env: Cloudflare.Env): Promise<Response> {
    const url = new URL(request.url);
    const match = /^\/v1\/orgs\/([A-Za-z0-9_-]{1,200})(?:\/(connect|rpc))?$/.exec(url.pathname);
    if (!match?.[1]) return new Response(null, { status: 404 });
    const orgId = match[1];
    const action = match[2];
    if (
      (action === "connect" && request.method !== "GET") ||
      (action === "rpc" && request.method !== "POST") ||
      (!action && request.method !== "DELETE")
    )
      return new Response(null, { status: 404 });
    try {
      const token = bearer(request);
      const headers = new Headers(request.headers);
      headers.delete("x-zolt-claims");
      headers.delete("x-zolt-service");
      if (!action) {
        await verifyServiceToken(
          token,
          env.ORCHESTRATOR_SIGNING_KEY,
          env.CELL_JWT_ISSUER,
          "cell-service",
          orgId,
        );
        headers.set("x-zolt-service", "delete");
      } else {
        const key = JSON.stringify([env.CELL_JWKS_URL, env.CELL_JWT_ISSUER]);
        let verifier = verifiers.get(key);
        if (!verifier) {
          verifier = new CellTokenVerifier({
            jwksUrl: env.CELL_JWKS_URL,
            issuer: env.CELL_JWT_ISSUER,
          });
          verifiers.set(key, verifier);
        }
        const claims = await verifier.verify(token, orgId);
        headers.set("x-zolt-claims", JSON.stringify(claims));
      }
      headers.delete("Authorization");
      return env.ORG_CELLS.get(env.ORG_CELLS.idFromName(orgId)).fetch(
        new Request(request, { headers }),
      );
    } catch {
      return new Response(null, { status: 401 });
    }
  },
} satisfies ExportedHandler<Cloudflare.Env>;
