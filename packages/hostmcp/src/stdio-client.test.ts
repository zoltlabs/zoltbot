import { expect, it } from "vitest";
import { RichToolResult, ToolDispatcher } from "./dispatcher.js";
import { SessionTokens } from "./session-tokens.js";
import { connectStdio } from "./stdio-client.js";

it("keeps a standalone MCP connection alive across calls and closes only its child", async () => {
  const script = `
    import { Server } from ${JSON.stringify(import.meta.resolve("@modelcontextprotocol/sdk/server/index.js"))};
    import { StdioServerTransport } from ${JSON.stringify(import.meta.resolve("@modelcontextprotocol/sdk/server/stdio.js"))};
    import { CallToolRequestSchema, ListToolsRequestSchema } from ${JSON.stringify(import.meta.resolve("@modelcontextprotocol/sdk/types.js"))};
    const server = new Server({name:'synthetic-driver',version:'1'}, {capabilities:{tools:{}}});
    let count = 0;
    server.setRequestHandler(ListToolsRequestSchema, async () => ({tools:[{name:'read',inputSchema:{type:'object'}}]}));
    server.setRequestHandler(CallToolRequestSchema, async () => ({content:[{type:'text',text:String(++count)}]}));
    await server.connect(new StdioServerTransport());
  `;
  const client = await connectStdio(process.execPath, ["--input-type=module", "-e", script], {});
  try {
    expect((await client.listTools()).tools[0]?.name).toBe("read");
    expect((await client.callTool({ name: "read" })).content).toEqual([
      { type: "text", text: "1" },
    ]);
    expect((await client.callTool({ name: "read" })).content).toEqual([
      { type: "text", text: "2" },
    ]);
  } finally {
    await client.close();
  }
});

it("forwards bounded images and structured state through the audited dispatcher", async () => {
  const tokens = new SessionTokens();
  const token = tokens.issue({ agentId: "a", threadId: "t", sessionId: "s" });
  const content = [{ type: "image" as const, data: "cG5n", mimeType: "image/png" }];
  const dispatcher = new ToolDispatcher(tokens, {
    tools: new Map([
      [
        "native_app",
        async () =>
          new RichToolResult({ content, structuredContent: { snapshot_id: "s1" }, isError: true }),
      ],
    ]),
    authorize: () => true,
    checkLimits: () => true,
    audit: async () => {},
  });
  expect(
    await dispatcher.call(`Bearer ${token}`, { id: "1", name: "native_app", arguments: {} }),
  ).toEqual({ content, structuredContent: { snapshot_id: "s1" }, isError: true });
  tokens.revoke("s");
  expect(
    (await dispatcher.call(`Bearer ${token}`, { id: "2", name: "native_app", arguments: {} }))
      .isError,
  ).toBe(true);
});
