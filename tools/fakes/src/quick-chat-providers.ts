import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

// Deterministic stand-ins for the Quick Chat provider APIs: OpenAI Responses and Anthropic
// Messages with the person's own key, and an OpenAI compatible local server.
// Behavior is chosen by model id, so tests never depend on a real account or a paid call.
//
//   fake-fast      replies "Echo: <last user text>" in three deltas and completes with usage
//   fake-quota     refuses with a usage-limit error (HTTP 429)
//   fake-midquota  streams one delta, then response.failed with the usage-limit code
//   fake-slow      streams a delta every 100 ms for 5 s (for cancellation)
//   fake-cut       streams a delta and closes without a completion event

export interface FakeRequest {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}
export interface FakeProviders {
  url: string;
  requests: FakeRequest[];
  close(): Promise<void>;
}
const models = ["fake-fast", "fake-quota", "fake-midquota", "fake-slow", "fake-cut"];
const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));
function lastUserText(body: Record<string, unknown>): string {
  const input = (body.input ?? body.messages) as Record<string, unknown>[] | undefined;
  const user = [...(input ?? [])].reverse().find((row) => row.role === "user");
  const content = user?.content;
  const text =
    typeof content === "string"
      ? content
      : ((content as { text?: string }[] | undefined) ?? [])
          .map((part) => part.text ?? "")
          .join("");
  // Echo the question, not the attached context, so history stays readable in tests.
  return text.split("</context>\n\n").at(-1) ?? text;
}
export async function startFakeProviders(): Promise<FakeProviders> {
  const requests: FakeRequest[] = [];
  let url = "";
  const sse = (response: ServerResponse) =>
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
  const event = (response: ServerResponse, value: unknown, name?: string) =>
    response.write(`${name ? `event: ${name}\n` : ""}data: ${JSON.stringify(value)}\n\n`);
  async function responses(body: Record<string, unknown>, response: ServerResponse) {
    const model = String(body.model);
    if (!models.includes(model)) {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(
        JSON.stringify({ error: { code: "model_not_found", message: "No such model." } }),
      );
      return;
    }
    if (model === "fake-quota") {
      response.writeHead(429, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          error: {
            code: "insufficient_quota",
            message: "Usage limit reached.",
          },
        }),
      );
      return;
    }
    sse(response);
    const text = `Echo: ${lastUserText(body)}`;
    if (model === "fake-midquota") {
      event(response, { type: "response.output_text.delta", delta: "Partial" });
      event(response, {
        type: "response.failed",
        response: {
          error: { code: "insufficient_quota", message: "Limit." },
        },
      });
      response.end();
      return;
    }
    if (model === "fake-cut") {
      event(response, { type: "response.output_text.delta", delta: "Cut" });
      response.end();
      return;
    }
    if (model === "fake-slow") {
      for (let i = 0; i < 50 && !response.destroyed; i++) {
        event(response, { type: "response.output_text.delta", delta: `${i} ` });
        await wait(100);
      }
    } else
      for (const part of [text.slice(0, 5), text.slice(5, 10), text.slice(10)])
        event(response, { type: "response.output_text.delta", delta: part });
    event(response, {
      type: "response.completed",
      response: {
        usage: {
          input_tokens: 12,
          output_tokens: 7,
          output_tokens_details: { reasoning_tokens: 0 },
        },
      },
    });
    response.end();
  }
  async function handle(request: IncomingMessage, response: ServerResponse, body: string) {
    const path = new URL(request.url ?? "/", url).pathname;
    const json = () => JSON.parse(body || "{}") as Record<string, unknown>;
    const reply = (status: number, value: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(value));
    };
    const bearer = String(request.headers.authorization ?? "");
    if (path === "/v1/models" && request.headers["x-api-key"])
      return reply(200, { data: models.map((id) => ({ id, display_name: `Fake ${id}` })) });
    if (path === "/v1/models" && bearer === "Bearer sk-user-synthetic")
      return reply(200, { data: models.map((id) => ({ id })) });
    if (path === "/v1/models" && !bearer) return reply(200, { data: models.map((id) => ({ id })) });
    if (path === "/v1/models")
      return reply(401, { error: { code: "invalid_api_key", message: "Bad key." } });
    if (path === "/v1/responses") {
      if (bearer !== "Bearer sk-user-synthetic")
        return reply(401, { error: { code: "invalid_api_key", message: "Bad key." } });
      return responses(json(), response);
    }
    if (path === "/v1/messages") {
      if (request.headers["x-api-key"] !== "sk-ant-synthetic")
        return reply(401, { error: { type: "authentication_error", message: "Bad key." } });
      const value = json();
      sse(response);
      const text = `Echo: ${lastUserText(value)}`;
      event(
        response,
        { type: "message_start", message: { usage: { input_tokens: 9 } } },
        "message_start",
      );
      event(
        response,
        { type: "content_block_delta", delta: { type: "text_delta", text } },
        "content_block_delta",
      );
      event(response, { type: "message_delta", usage: { output_tokens: 4 } }, "message_delta");
      event(response, { type: "message_stop" }, "message_stop");
      response.end();
      return;
    }
    if (path === "/v1/chat/completions") {
      const value = json();
      sse(response);
      const text = `Echo: ${lastUserText(value)}`;
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
      response.write(
        `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 3 } })}\n\n`,
      );
      response.write("data: [DONE]\n\n");
      response.end();
      return;
    }
    reply(404, { error: { code: "not_found" } });
  }
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      requests.push({
        method: request.method ?? "GET",
        path: new URL(request.url ?? "/", url).pathname,
        headers: request.headers,
        body,
      });
      void handle(request, response, body).catch(() => {
        if (!response.headersSent) response.writeHead(500);
        response.end();
      });
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fake_listen_failed");
  url = `http://127.0.0.1:${address.port}`;
  return {
    url,
    requests,
    close: () =>
      new Promise<void>((done) => {
        server.closeAllConnections();
        server.close(() => done());
      }),
  };
}
