import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { CodexSchemas } from "./schema.js";

const bundle = JSON.parse(readFileSync("fixtures/codex/0.164.0/protocol.schema.json", "utf8"));
it("validates outgoing requests against the pinned generated catalog", () => {
  const schemas = new CodexSchemas(bundle);
  expect(() =>
    schemas.request({
      id: 1,
      method: "thread/start",
      params: { cwd: "/work/repo", sandbox: "read-only", approvalPolicy: "on-request" },
    }),
  ).not.toThrow();
  expect(() =>
    schemas.request({ id: 1, method: "thread/start", params: { sandbox: "readOnly" } }),
  ).toThrow("provider_protocol_error");
});
it("distinguishes unknown notifications from malformed known payloads", () => {
  const schemas = new CodexSchemas(bundle);
  expect(schemas.notification({ method: "future/method", params: {} })).toBe(false);
  expect(() =>
    schemas.notification({ method: "item/agentMessage/delta", params: { delta: 2 } }),
  ).toThrow("provider_protocol_error");
  expect(
    schemas.notification({
      method: "item/agentMessage/delta",
      params: { threadId: "th", turnId: "t", itemId: "i", delta: "ok" },
    }),
  ).toBe(true);
});
it("validates result bodies without confusing permission grants with command decisions", () => {
  const schemas = new CodexSchemas(bundle);
  expect(() =>
    schemas.serverResult("item/commandExecution/requestApproval", { decision: "accept" }),
  ).not.toThrow();
  expect(() =>
    schemas.serverResult("item/permissions/requestApproval", { decision: "accept" }),
  ).toThrow("provider_protocol_error");
  expect(() =>
    schemas.serverResult("item/permissions/requestApproval", { permissions: {}, scope: "turn" }),
  ).not.toThrow();
});
