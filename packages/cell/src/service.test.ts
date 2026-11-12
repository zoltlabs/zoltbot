import type { CellTokenClaims } from "@zoltbot/cloud-contracts";
import { expect, it, vi } from "vitest";
import { base64url } from "./auth.js";
import { CellService, serviceToken, verifyServiceToken } from "./service.js";

const issuer = "https://accounts.example.invalid";
const now = 1800000000000;
function secret() {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}
it("forwards the durable effect ID and reduces an orchestrator quota response to a safe code", async () => {
  const fetcher = vi.fn(async (_url, init) => {
    expect(new Headers(init?.headers).get("Idempotency-Key")).toBe("create:task:1");
    return Response.json({ error: "limit_reached" }, { status: 409 });
  });
  const service = new CellService(
    { origin: "https://accounts.example.invalid/api/cloud", signingKey: secret(), issuer },
    "org",
    fetcher,
  );
  await expect(
    service.request("sandboxes", "POST", {}, { operationId: "create:task:1", timeoutMs: 30000 }),
  ).rejects.toThrow("limit_reached");
});
it("separates the cell service token from client and orchestrator audiences", async () => {
  const key = secret();
  const token = await serviceToken(key, issuer, "cell-service", "org", now);
  await verifyServiceToken(token, key, issuer, "cell-service", "org", now);
  for (const [aud, org, at, signingKey] of [
    ["orchestrator", "org", now, key],
    ["cell-service", "other", now, key],
    ["cell-service", "org", now + 120000, key],
    ["cell-service", "org", now, secret()],
  ] as const)
    await expect(verifyServiceToken(token, signingKey, issuer, aud, org, at)).rejects.toThrow(
      "unauthorized",
    );
});
it("checks revocation within thirty seconds, sends the session and fails closed", async () => {
  const key = secret();
  let active = true;
  const fetcher = vi.fn(async (_url, init) => {
    const headers = new Headers(init?.headers);
    await verifyServiceToken(
      (headers.get("Authorization") ?? "").slice(7),
      key,
      issuer,
      "orchestrator",
      "org",
    );
    expect(JSON.parse(String(init?.body)).sessionId).toBe("session");
    return Response.json({ active });
  });
  const service = new CellService(
    { origin: "https://accounts.example.invalid/api/cloud", signingKey: key, issuer },
    "org",
    fetcher,
  );
  const claims: CellTokenClaims = {
    iss: issuer,
    aud: "cell",
    sub: "user",
    org: "org",
    device: "device",
    session: "session",
    surface: "desktop",
    kind: "client",
    iat: now / 1000,
    exp: now / 1000 + 600,
    jti: "token-id",
  };
  await service.authorize(claims, now);
  active = false;
  await expect(service.authorize(claims, now + 1000, true)).rejects.toThrow("unauthorized");
  await expect(service.authorize(claims, now + 2000)).rejects.toThrow("unauthorized");
  active = true;
  await service.authorize(claims, now + 3000);
  active = false;
  await service.authorize(claims, now + 32999);
  expect(fetcher).toHaveBeenCalledTimes(4);
  await expect(service.authorize(claims, now + 33000)).rejects.toThrow("unauthorized");
  expect(fetcher).toHaveBeenCalledTimes(5);
  active = true;
  await service.authorize(claims, now + 34000);
  service.invalidate();
  fetcher.mockRejectedValueOnce(new Error("service_unavailable"));
  await expect(service.authorize(claims, now + 35000)).rejects.toThrow("service_unavailable");
});
