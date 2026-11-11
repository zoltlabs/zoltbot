import { expect, it } from "vitest";
import { ToolDispatcher } from "./dispatcher.js";
import { SessionTokens } from "./session-tokens.js";

const identity = { agentId: "profile-a", threadId: "thread-a", sessionId: "session-a" };
const request = { id: "call-a", name: "team_test", arguments: { target: "profile-b" } };
function fixture() {
  const tokens = new SessionTokens();
  const token = tokens.issue(identity);
  tokens.setTurn(identity.sessionId, "turn-a");
  const trace: string[] = [];
  let granted = true;
  let limited = false;
  let failAudit = false;
  let output: unknown = { ok: true };
  const dispatcher = new ToolDispatcher(tokens, {
    authorize: (actor, name, args) => {
      expect(actor.agentId).toBe(identity.agentId);
      expect(name).toBe(request.name);
      expect(args).toEqual(request.arguments);
      trace.push("grant");
      return granted;
    },
    checkLimits: () => {
      trace.push("limits");
      return !limited;
    },
    audit: async (record) => {
      trace.push(`audit:${record.result}`);
      expect(JSON.stringify(record)).not.toContain(token);
      expect(record).not.toHaveProperty("arguments");
      if (failAudit) throw new Error("synthetic-private-error");
    },
    tools: new Map([
      [
        request.name,
        async (call) => {
          trace.push("execute");
          expect(call.actor).toEqual({ ...identity, turnId: "turn-a" });
          expect(call.idempotencyKey).toBe(JSON.stringify(["session-a", "turn-a", "call-a"]));
          return output;
        },
      ],
    ]),
  });
  return {
    tokens,
    token,
    trace,
    dispatcher,
    grant: (value: boolean) => {
      granted = value;
    },
    limit: () => {
      limited = true;
    },
    failAudit: () => {
      failAudit = true;
    },
    output: (value: unknown) => {
      output = value;
    },
  };
}

it("checks authority, grants, limits, and durable audit before invoking a bounded tool", async () => {
  const f = fixture();
  const result = await f.dispatcher.call(`Bearer ${f.token}`, request);
  expect(result).toEqual({ content: [{ type: "text", text: '{"ok":true}' }] });
  expect(f.trace).toEqual([
    "grant",
    "limits",
    "audit:started",
    "grant",
    "execute",
    "grant",
    "audit:succeeded",
    "grant",
  ]);
});

it("refuses unauthorized, denied, limited, or unauditable operations before execution", async () => {
  for (const mode of ["token", "grant", "limit", "audit"] as const) {
    const f = fixture();
    if (mode === "token") f.tokens.revoke(identity.sessionId);
    if (mode === "grant") f.grant(false);
    if (mode === "limit") f.limit();
    if (mode === "audit") f.failAudit();
    const result = await f.dispatcher.call(`Bearer ${f.token}`, request);
    expect(result.isError).toBe(true);
    expect(f.trace).not.toContain("execute");
    expect(JSON.stringify(result)).not.toContain("synthetic-private-error");
  }
});

it("does not expose oversized tool output or unknown failures", async () => {
  const f = fixture();
  f.output({ text: "private-output".repeat(4000) });
  const result = await f.dispatcher.call(`Bearer ${f.token}`, request);
  expect(result.isError).toBe(true);
  expect(result.content[0]?.text).toBe('{"error":"result_too_large"}');
  expect(JSON.stringify(result)).not.toContain("private-output");
});

it("rechecks revocation after awaiting the pre-execution audit", async () => {
  const tokens = new SessionTokens();
  const token = tokens.issue(identity);
  let executions = 0;
  const dispatcher = new ToolDispatcher(tokens, {
    tools: new Map([
      [
        "team_test",
        async () => {
          executions++;
          return {};
        },
      ],
    ]),
    authorize: () => true,
    checkLimits: () => true,
    audit: async () => {
      tokens.revoke(identity.sessionId);
    },
  });
  expect((await dispatcher.call(`Bearer ${token}`, request)).isError).toBe(true);
  expect(executions).toBe(0);
});

it("rejects grant revocation while audit is pending and hides handler failures", async () => {
  const tokens = new SessionTokens();
  const token = tokens.issue(identity);
  let granted = true;
  let executions = 0;
  const records: string[] = [];
  const dispatcher = new ToolDispatcher(tokens, {
    tools: new Map([
      [
        request.name,
        async () => {
          executions++;
          throw new Error("synthetic-private-handler-error");
        },
      ],
    ]),
    authorize: () => granted,
    checkLimits: () => true,
    audit: async (record) => {
      records.push(record.result);
      if (record.result === "started") granted = false;
    },
  });
  expect((await dispatcher.call(`Bearer ${token}`, request)).content[0]?.text).toBe(
    '{"error":"grant_required"}',
  );
  expect(executions).toBe(0);
  expect(records).toEqual(["started", "denied"]);
  const failing = new ToolDispatcher(tokens, {
    tools: new Map([
      [
        request.name,
        async () => {
          throw new Error("synthetic-private-handler-error");
        },
      ],
    ]),
    authorize: () => true,
    checkLimits: () => true,
    audit: async () => {},
  });
  expect((await failing.call(`Bearer ${token}`, request)).content[0]?.text).toBe(
    '{"error":"tool_failed"}',
  );
});

it("bounds arguments and fixes call identity and arguments before asynchronous audit", async () => {
  const f = fixture();
  const oversized = { ...request, arguments: { text: "x".repeat(65537) } };
  expect((await f.dispatcher.call(`Bearer ${f.token}`, oversized)).isError).toBe(true);
  expect(f.trace).toEqual([]);
  const tokens = new SessionTokens();
  const token = tokens.issue(identity);
  const mutable = { ...request, arguments: { ...request.arguments } };
  let invocation: unknown;
  const dispatcher = new ToolDispatcher(tokens, {
    tools: new Map([
      [
        request.name,
        async (call) => {
          invocation = call;
          return {};
        },
      ],
    ]),
    authorize: () => true,
    checkLimits: () => true,
    audit: async (record) => {
      if (record.result === "started") {
        mutable.name = "unregistered";
        mutable.id = "changed-call";
        mutable.arguments.target = "changed-target";
      }
    },
  });
  expect((await dispatcher.call(`Bearer ${token}`, mutable)).isError).toBeUndefined();
  expect(invocation).toEqual({
    actor: identity,
    arguments: request.arguments,
    idempotencyKey: JSON.stringify([identity.sessionId, null, request.id]),
  });
});

it("withholds an awaited result if its session or grant was revoked while the handler ran", async () => {
  for (const mode of ["token", "grant"] as const) {
    const tokens = new SessionTokens(),
      token = tokens.issue(identity);
    let granted = true;
    const dispatcher = new ToolDispatcher(tokens, {
      tools: new Map([
        [
          "team_test",
          async () => {
            if (mode === "token") tokens.revoke(identity.sessionId);
            else granted = false;
            return { text: "protected-result" };
          },
        ],
      ]),
      authorize: () => granted,
      checkLimits: () => true,
      audit: async () => {},
    });
    const result = await dispatcher.call(`Bearer ${token}`, request);
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain("protected-result");
  }
});

it("surfaces safe schema and snake_case domain errors while hiding arbitrary or path-bearing failures", async () => {
  const tokens = new SessionTokens();
  const token = tokens.issue(identity);
  let thrown = new Error("planned_task_exists: use dispatch to start task vip-fix");
  const dispatcher = new ToolDispatcher(tokens, {
    tools: new Map([
      [
        request.name,
        async () => {
          throw thrown;
        },
      ],
    ]),
    authorize: () => true,
    checkLimits: () => true,
    audit: async () => {},
  });
  const schemaInvalid = await dispatcher.call(`Bearer ${token}`, request, () => ({
    valid: false,
    errorMessage: "data must have required property 'why'",
  }));
  expect(JSON.parse(schemaInvalid.content[0]?.text ?? "{}")).toEqual({
    error: "invalid_tool_arguments",
    detail: "data must have required property 'why'",
  });

  const domainInvalid = await dispatcher.call(`Bearer ${token}`, request);
  expect(JSON.parse(domainInvalid.content[0]?.text ?? "{}")).toEqual({
    error: "planned_task_exists",
    detail: "use dispatch to start task vip-fix",
  });

  thrown = new Error("Invalid payload: /revision: Expected required property");
  const typeboxInvalid = await dispatcher.call(`Bearer ${token}`, request);
  expect(JSON.parse(typeboxInvalid.content[0]?.text ?? "{}")).toEqual({
    error: "invalid_tool_arguments",
    detail: "/revision: Expected required property",
  });

  thrown = new Error("internal_leak: /var/folders/secret/file.ts");
  const pathBearing = await dispatcher.call(`Bearer ${token}`, request);
  expect(JSON.parse(pathBearing.content[0]?.text ?? "{}")).toEqual({
    error: "tool_failed",
  });
});
