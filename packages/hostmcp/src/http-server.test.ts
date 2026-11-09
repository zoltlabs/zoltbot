import { request as httpRequest } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { expect, it } from "vitest";
import { ToolDispatcher } from "./dispatcher.js";
import { startHostMcp } from "./http-server.js";
import { SessionTokens } from "./session-tokens.js";

async function fixture() {
  const tokens = new SessionTokens();
  const a = tokens.issue({ agentId: "profile-a", threadId: "thread-a", sessionId: "session-a" });
  const b = tokens.issue({ agentId: "profile-b", threadId: "thread-b", sessionId: "session-b" });
  let calls = 0;
  const audits: string[] = [];
  const dispatcher = new ToolDispatcher(tokens, {
    tools: new Map([
      [
        "team_echo",
        async (call) => {
          calls++;
          return { actor: call.actor, arguments: call.arguments };
        },
      ],
    ]),
    authorize: () => true,
    checkLimits: () => true,
    audit: async (record) => {
      audits.push(record.result);
    },
  });
  const host = await startHostMcp({
    tokens,
    dispatcher,
    tools: [
      {
        name: "team_echo",
        description: "Synthetic scoped echo.",
        inputSchema: {
          type: "object",
          properties: { value: { type: "string", maxLength: 100 } },
          required: ["value"],
          additionalProperties: false,
        },
      },
    ],
  });
  const clients: Client[] = [];
  const connect = async (token: string) => {
    const client = new Client({ name: "zoltbot-test", version: "1" });
    clients.push(client);
    await client.connect(
      new StreamableHTTPClientTransport(new URL(host.url), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      }),
    );
    return client;
  };
  return {
    host,
    tokens,
    a,
    b,
    connect,
    calls: () => calls,
    audits,
    close: async () => {
      await Promise.all(clients.map((client) => client.close()));
      await host.close();
    },
  };
}

it("serves a real MCP client handshake, fixed tool list, and independent scoped calls", async () => {
  const f = await fixture();
  try {
    const a = await f.connect(f.a);
    const b = await f.connect(f.b);
    expect((await a.listTools()).tools.map((tool) => tool.name)).toEqual(["team_echo"]);
    f.tokens.setTurn("session-a", "turn-a");
    const resultA = await a.callTool({ name: "team_echo", arguments: { value: "hello" } });
    const resultB = await b.callTool({ name: "team_echo", arguments: { value: "world" } });
    expect(JSON.stringify(resultA)).toContain("thread-a");
    expect(JSON.stringify(resultA)).not.toContain("thread-b");
    expect(JSON.stringify(resultA)).toContain("turn-a");
    expect(JSON.stringify(resultB)).toContain("thread-b");
    expect(f.calls()).toBe(2);
    f.tokens.revoke("session-a");
    await expect(a.listTools()).rejects.toThrow();
    expect((await b.listTools()).tools).toHaveLength(1);
  } finally {
    await f.close();
  }
});

it("rejects invalid tool input before dispatch without echoing submitted private values", async () => {
  const f = await fixture();
  try {
    const client = await f.connect(f.a);
    const result = await client.callTool({
      name: "team_echo",
      arguments: {
        value: "synthetic-private-input",
        actor: { agentId: "injected" },
      },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain("synthetic-private-input");
    expect(f.calls()).toBe(0);
    expect(f.audits).toEqual(["denied"]);
  } finally {
    await f.close();
  }
});

it("authenticates every method, rejects foreign origins and hosts, and bounds HTTP bodies", async () => {
  const f = await fixture();
  try {
    expect((await fetch(f.host.url)).status).toBe(401);
    const headers = { Authorization: `Bearer ${f.a}` };
    expect((await fetch(f.host.url, { headers })).status).toBe(405);
    expect(
      (await fetch(f.host.url, { headers: { ...headers, Origin: "https://foreign.example" } }))
        .status,
    ).toBe(403);
    expect(
      await new Promise<number>((resolve, reject) => {
        const call = httpRequest(
          f.host.url,
          { headers: { ...headers, Host: "foreign.example" } },
          (response) => {
            response.resume();
            response.once("end", () => resolve(response.statusCode ?? 0));
          },
        );
        call.once("error", reject);
        call.end();
      }),
    ).toBe(403);
    const result = await fetch(f.host.url, {
      method: "POST",
      headers: {
        ...headers,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ text: "x".repeat(65537) }),
    });
    expect(result.status).toBe(413);
    expect(f.calls()).toBe(0);
    await f.host.close();
    await f.host.close();
    expect(f.tokens.authenticate(`Bearer ${f.b}`)).toBeUndefined();
  } finally {
    await f.close();
  }
});

it("negotiates a supported older protocol and rejects unsupported versions and invalid UTF-8", async () => {
  const f = await fixture();
  try {
    const headers = {
      Authorization: `Bearer ${f.a}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };
    const initialization = await fetch(f.host.url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "older-test", version: "1" },
        },
      }),
    });
    expect(initialization.status).toBe(200);
    expect((await initialization.json()).result.protocolVersion).toBe("2025-03-26");
    const unsupported = await fetch(f.host.url, {
      method: "POST",
      headers: {
        ...headers,
        "MCP-Protocol-Version": "unsupported",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" }),
    });
    expect(unsupported.status).toBe(400);
    const encoder = new TextEncoder();
    const invalid = new Uint8Array([
      ...encoder.encode('{"jsonrpc":"2.0","id":3,"method":"ping","params":{"x":"'),
      255,
      ...encoder.encode('"}}'),
    ]);
    const malformed = await fetch(f.host.url, { method: "POST", headers, body: invalid.buffer });
    expect(malformed.status).toBe(400);
    expect(f.calls()).toBe(0);
  } finally {
    await f.close();
  }
});

it("freezes the optional browser catalog per authenticated execution without changing legacy host tools", async () => {
  const tokens = new SessionTokens();
  const legacy = tokens.issue({ agentId: "a", threadId: "old", sessionId: "old" });
  const browser = tokens.issue({ agentId: "a", threadId: "new", sessionId: "new" });
  const base = { name: "team_echo", inputSchema: { type: "object" as const, properties: {} } };
  const evidence = {
    name: "team_browser_evidence",
    inputSchema: { type: "object" as const, properties: {} },
  };
  const dispatcher = new ToolDispatcher(tokens, {
    tools: new Map(),
    authorize: () => false,
    checkLimits: () => true,
    audit: async () => {},
  });
  const host = await startHostMcp({
    tokens,
    dispatcher,
    tools: [base, evidence],
    toolsForActor: (actor) => (actor.sessionId === "new" ? [base, evidence] : [base]),
  });
  const clients: Client[] = [];
  try {
    for (const [token, names] of [
      [legacy, ["team_echo"]],
      [browser, ["team_echo", "team_browser_evidence"]],
    ] as const) {
      const client = new Client({ name: "catalog-test", version: "1" });
      clients.push(client);
      await client.connect(
        new StreamableHTTPClientTransport(new URL(host.url), {
          requestInit: { headers: { Authorization: `Bearer ${token}` } },
        }),
      );
      expect((await client.listTools()).tools.map((t) => t.name)).toEqual(names);
    }
  } finally {
    await Promise.all(clients.map((c) => c.close()));
    await host.close();
  }
});
