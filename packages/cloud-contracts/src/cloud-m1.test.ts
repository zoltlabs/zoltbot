import { parse } from "@zoltbot/protocol";
import { expect, it } from "vitest";
import { CellJwkSchema, CellTokenClaimsSchema, SandboxCreateSchema } from "./cloud-m1.js";

it("keeps client and runner claims org-bound and refuses an orchestrator audience", () => {
  const claim = {
    iss: "https://example.invalid",
    aud: "cell",
    sub: "user",
    org: "org",
    device: "device",
    surface: "desktop",
    kind: "client",
    iat: 1,
    exp: 601,
    jti: "request",
  };
  expect(() => parse(CellTokenClaimsSchema, claim)).not.toThrow();
  expect(() => parse(CellTokenClaimsSchema, { ...claim, org: undefined })).toThrow();
  expect(() => parse(CellTokenClaimsSchema, { ...claim, aud: "orchestrator" })).toThrow();
});
it("publishes only public ES256 key material", () => {
  const publicKey = {
    kty: "EC",
    crv: "P-256",
    use: "sig",
    alg: "ES256",
    kid: "key",
    x: "x".repeat(43),
    y: "y".repeat(43),
  };
  expect(() => parse(CellJwkSchema, publicKey)).not.toThrow();
  expect(() => parse(CellJwkSchema, { ...publicKey, d: "private" })).toThrow();
});
it("keeps secret values outside cell-to-orchestrator create calls", () => {
  const request = {
    orgId: "org",
    userId: "user",
    projectId: "project",
    taskId: "task",
    repository: "owner/repo",
    defaultBranch: "main",
    setupScript: "",
    provider: "claude",
  };
  expect(() => parse(SandboxCreateSchema, request)).not.toThrow();
  expect(() =>
    parse(SandboxCreateSchema, { ...request, apiKey: "synthetic-forbidden-value" }),
  ).toThrow();
});
