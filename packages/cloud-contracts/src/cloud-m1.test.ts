import { parse } from "@zoltbot/protocol";
import { expect, it } from "vitest";
import {
  CellJwkSchema,
  CellTokenClaimsSchema,
  CloudRunnerGrantInputSchema,
  CloudRunnerGrantResultSchema,
  SandboxCreateSchema,
} from "./cloud-m1.js";

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

it("requires explicit runner capabilities without accepting client-supplied authority", () => {
  const input = { deviceId: "device", canRunTasks: false, canMacExec: true };
  expect(parse(CloudRunnerGrantInputSchema, input)).toEqual(input);
  for (const value of [
    { deviceId: "device" },
    { ...input, canRunTasks: "true" },
    { ...input, orgId: "other" },
    { ...input, sessionId: "chosen" },
    { ...input, expiresAt: "2099-01-01T00:00:00Z" },
  ])
    expect(() => parse(CloudRunnerGrantInputSchema, value)).toThrow();
  const grant = { ...input, id: "grant", sessionId: "session", expiresAt: "2026-11-11T00:00:00Z" };
  expect(parse(CloudRunnerGrantResultSchema, { grant })).toEqual({ grant });
  expect(parse(CloudRunnerGrantResultSchema, { grant: null })).toEqual({ grant: null });
  expect(() =>
    parse(CloudRunnerGrantResultSchema, { grant: { ...grant, accessToken: "forbidden" } }),
  ).toThrow();
});
