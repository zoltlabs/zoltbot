import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import type { ToolDispatcher } from "./dispatcher.js";
import type { SessionTokens, ToolActor } from "./session-tokens.js";

interface Options {
  tokens: SessionTokens;
  dispatcher: ToolDispatcher;
  tools: readonly Tool[];
  toolsForActor?(actor: ToolActor): readonly Tool[];
}
class BodyFailure extends Error {
  constructor(readonly status: number) {
    super("invalid_host_request");
  }
}
async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of request.iterator({ destroyOnReturn: false })) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > 65536) throw new BodyFailure(413);
      chunks.push(bytes);
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
  } catch (error) {
    request.resume();
    throw error instanceof BodyFailure ? error : new BodyFailure(400);
  }
}
function reject(response: ServerResponse, status: number) {
  response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  response.end(
    JSON.stringify({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32600, message: "Host request rejected" },
    }),
  );
}

/** Loopback Streamable HTTP. Application session authority is independent of MCP transport state. */
export async function startHostMcp(options: Options) {
  const tools = structuredClone([...options.tools]);
  if (new Set(tools.map((tool) => tool.name)).size !== tools.length)
    throw new Error("duplicate_host_tool");
  const validator = new AjvJsonSchemaValidator();
  const validations = new Map(
    tools.map((tool) => [
      tool.name,
      validator.getValidator(
        tool.inputSchema as Parameters<AjvJsonSchemaValidator["getValidator"]>[0],
      ),
    ]),
  );
  const active = new Set<Server>();
  let expectedHost = "";
  let closed: Promise<void> | undefined;
  const server = createServer({ maxHeaderSize: 8192 }, (request, response) => {
    void handle(request, response).catch(() => {
      if (!response.headersSent) reject(response, 500);
      else response.destroy();
    });
  });
  server.headersTimeout = 10000;
  server.requestTimeout = 10000;
  async function handle(request: IncomingMessage, response: ServerResponse) {
    if (request.url !== "/mcp") {
      reject(response, 404);
      return;
    }
    if (request.headers.host !== expectedHost || request.headers.origin !== undefined) {
      reject(response, 403);
      return;
    }
    const authorization = request.headers.authorization;
    if (!options.tokens.authenticate(authorization)) {
      reject(response, 401);
      return;
    }
    if (request.method !== "POST") {
      response.setHeader("Allow", "POST");
      reject(response, 405);
      return;
    }
    let body: unknown;
    try {
      body = await readBody(request);
    } catch (error) {
      reject(response, error instanceof BodyFailure ? error.status : 400);
      return;
    }
    if (!options.tokens.authenticate(authorization)) {
      reject(response, 401);
      return;
    }
    const protocol = new Server(
      { name: "zoltbot", version: "0.1.0" },
      { capabilities: { tools: {} } },
    );
    const transport = new StreamableHTTPServerTransport({
      enableJsonResponse: true,
    });
    active.add(protocol);
    let cleanup: Promise<void> | undefined;
    const close = () => (cleanup ??= protocol.close().finally(() => active.delete(protocol)));
    response.once("close", () => {
      void close().catch(() => {});
    });
    protocol.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: structuredClone([
        ...(options.toolsForActor?.(options.tokens.authenticate(authorization) as ToolActor) ??
          tools),
      ]),
    }));
    protocol.setRequestHandler(CallToolRequestSchema, async (call, extra) => {
      const validate = validations.get(call.params.name);
      const result = await options.dispatcher.call(
        authorization,
        {
          id: String(extra.requestId),
          name: call.params.name,
          arguments: call.params.arguments ?? {},
        },
        (args) => validate?.(args).valid === true,
      );
      return { ...result };
    });
    try {
      await protocol.connect(transport);
      response.setHeader("Cache-Control", "no-store");
      await transport.handleRequest(request, response, body);
    } catch {
      await close();
      if (!response.headersSent) reject(response, 500);
      else response.destroy();
    }
  }
  await new Promise<void>((resolve, fail) => {
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", fail);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("host_address_unavailable");
  expectedHost = `127.0.0.1:${address.port}`;
  return {
    url: `http://${expectedHost}/mcp`,
    close(): Promise<void> {
      closed ??= (async () => {
        options.tokens.close();
        const stopped = new Promise<void>((resolve, fail) =>
          server.close((error) => (error ? fail(error) : resolve())),
        );
        server.closeAllConnections();
        await Promise.all([...active].map((protocol) => protocol.close()));
        await stopped;
      })();
      return closed;
    },
  };
}
