import { readFileSync } from "node:fs";
import { Ajv } from "ajv";
import { describe, expect, it } from "vitest";

const bundle = JSON.parse(readFileSync("fixtures/codex/0.164.0/protocol.schema.json", "utf8"));
const ajv = new Ajv({ strict: false, validateFormats: false });
const validate = (name: string, value: unknown) =>
  ajv.compile({
    definitions: bundle.definitions,
    $ref: `#/definitions/${bundle.definitions.v2[name] ? `v2/${name}` : name}`,
  })(value);
describe("Codex 0.164.0 generated schema evidence", () => {
  it("distinguishes thread sandbox mode spelling from turn sandbox policy spelling", () => {
    expect(
      validate("ThreadStartParams", {
        cwd: "/work/repo",
        sandbox: "read-only",
        approvalPolicy: "on-request",
      }),
    ).toBe(true);
    expect(
      validate("ThreadStartParams", {
        cwd: "/work/repo",
        sandbox: "readOnly",
        approvalPolicy: "onRequest",
      }),
    ).toBe(false);
  });
  it("validates command and permission approval bodies without conflating them", () => {
    expect(validate("CommandExecutionRequestApprovalResponse", { decision: "accept" })).toBe(true);
    expect(
      validate("CommandExecutionRequestApprovalResponse", {
        decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: ["git", "status"] } },
      }),
    ).toBe(true);
    expect(validate("PermissionsRequestApprovalResponse", { permissions: {}, scope: "turn" })).toBe(
      true,
    );
    expect(validate("PermissionsRequestApprovalResponse", { decision: "accept" })).toBe(false);
  });
  it("keys user answers by question id and uses arrays of strings", () => {
    expect(
      validate("ToolRequestUserInputResponse", {
        answers: { q1: { answers: ["one", "two"] }, q2: { answers: ["free text"] } },
      }),
    ).toBe(true);
    expect(validate("ToolRequestUserInputResponse", { answers: { q1: "one" } })).toBe(false);
  });
  it("uses result in the successful RPC response envelope", () => {
    expect(validate("JSONRPCResponse", { id: 1, result: { decision: "accept" } })).toBe(true);
    expect(validate("JSONRPCResponse", { id: 1, decision: "accept" })).toBe(false);
  });
  it("separates experimental dynamic tools from stable thread configuration", () => {
    const experimental = JSON.parse(
      readFileSync("fixtures/codex/0.164.0/protocol-experimental.schema.json", "utf8"),
    );
    expect(bundle.definitions.v2.ThreadStartParams.properties.dynamicTools).toBeUndefined();
    expect(experimental.definitions.v2.ThreadStartParams.properties.dynamicTools).toBeDefined();
  });
  it("validates captured client requests and keeps machine identity redacted", () => {
    const records = readFileSync("fixtures/codex/0.164.0/initialize-no-auth.jsonl", "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    for (const record of records) {
      if (record.direction === "stdin" && "id" in record.message)
        expect(validate("ClientRequest", record.message)).toBe(true);
      if (record.message.method === "remoteControl/status/changed") {
        expect(record.message.params.serverName).toBe("[REDACTED]");
        expect(record.message.params.installationId).toBe("[REDACTED]");
      }
    }
  });
  it("records authenticated per thread HTTP tool discovery without a model turn", () => {
    const records = readFileSync("fixtures/codex/0.164.0/thread-mcp-no-auth.jsonl", "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(records.some((r) => r.message.method === "turn/start")).toBe(false);
    const status = records.find((r) => r.direction === "stdout" && r.message.id === 3);
    expect(status.message.result.data[0].authStatus).toBe("bearerToken");
    expect(status.message.result.data[0].tools.spike_ping).toBeDefined();
    const http = JSON.parse(readFileSync("fixtures/codex/0.164.0/mcp-http-no-auth.json", "utf8"));
    expect(
      http.some(
        (r: { method: string; authorized: boolean }) => r.method === "tools/list" && r.authorized,
      ),
    ).toBe(true);
    expect(http.every((r: { authorized: boolean }) => r.authorized)).toBe(true);
  });
});
