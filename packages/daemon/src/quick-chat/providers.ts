import type { QuickModel, QuickRequest, QuickToolCall, QuickUsage } from "@zoltbot/protocol";

// Quick Chat inference adapters for the person's own API keys and local endpoints. Each one is a
// plain streaming HTTP client against a documented API, billed to them (never Zoltbot).

export type FetchLike = typeof fetch;
export interface InferenceTurn {
  role: "user" | "assistant";
  text: string;
}
export interface InferenceRequest {
  model: string;
  instructions: string;
  turns: InferenceTurn[];
  /** Lets a stateful runtime keep one session per conversation. */
  conversationId?: string;
  signal: AbortSignal;
  onText(delta: string): void;
  /**
   * Present when this reply may use tools (coding tools only). Absent, the tool is told not to
   * and every permission request is declined.
   */
  tools?: QuickToolHooks;
}
export interface QuickDecision {
  decision: "allow" | "always" | "deny";
  optionId?: string;
}
export interface QuickToolHooks {
  /** A tool started or finished. Called again with the same id as its status changes. */
  onCall(call: QuickToolCall): void;
  /** Asks the person. Resolves when they answer, or with deny when the reply ends first. */
  ask(request: QuickRequest): Promise<QuickDecision>;
  /** Tools the person chose "Always allow" for, or whose server they set to allow. */
  allowed(name: string): boolean;
  /** The person's MCP servers to leave out of the session. */
  off(): string[];
}
export interface InferenceResult {
  usage?: QuickUsage;
}
/**
 * `refused`: the provider declined before doing work, so nothing was charged and another
 * connection may be offered. `ambiguous`: the request may have been admitted; never replay it.
 */
export class InferenceError extends Error {
  constructor(
    readonly code: string,
    readonly admission: "refused" | "ambiguous",
    message: string,
  ) {
    super(message);
  }
}
export interface InferenceAdapter {
  listModels(signal?: AbortSignal): Promise<QuickModel[]>;
  stream(request: InferenceRequest): Promise<InferenceResult>;
}
const connectFailures = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH"]);
/** A request that never reached the provider is refused; anything else may have been admitted. */
function transportError(error: unknown, signal?: AbortSignal): InferenceError {
  if (signal?.aborted) return new InferenceError("cancelled", "ambiguous", "Cancelled.");
  const cause = (error as { cause?: { code?: string } })?.cause?.code;
  return cause && connectFailures.has(cause)
    ? new InferenceError("unreachable", "refused", "The model endpoint could not be reached.")
    : new InferenceError("network_error", "ambiguous", "The connection to the model was lost.");
}
async function send(fetcher: FetchLike, url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetcher(url, { ...init, redirect: "error" });
  } catch (error) {
    throw transportError(error, init.signal ?? undefined);
  }
}
async function errorBody(response: Response): Promise<{ code?: string; message?: string }> {
  try {
    const text = (await response.text()).slice(0, 4000);
    const json = JSON.parse(text) as Record<string, unknown>;
    const error = (json.error ?? json) as Record<string, unknown>;
    return {
      ...(typeof error.code === "string" ? { code: error.code } : {}),
      ...(typeof error.type === "string" && typeof error.code !== "string"
        ? { code: error.type }
        : {}),
      ...(typeof error.message === "string"
        ? { message: error.message.slice(0, 300) }
        : typeof json.detail === "string"
          ? { message: json.detail.slice(0, 300) }
          : {}),
    };
  } catch {
    return {};
  }
}
const quotaCodes = new Set(["insufficient_quota", "rate_limit_exceeded", "rate_limit_error"]);
/** Maps an HTTP refusal (no stream was opened, so no work was billed) to a stable code. */
async function refusal(response: Response): Promise<InferenceError> {
  const body = await errorBody(response);
  const code =
    body.code && quotaCodes.has(body.code)
      ? "quota_exhausted"
      : response.status === 401
        ? "sign_in_required"
        : response.status === 429
          ? "quota_exhausted"
          : response.status === 404
            ? "model_unavailable"
            : (body.code ?? `http_${response.status}`);
  const messages: Record<string, string> = {
    quota_exhausted: "This connection has reached a usage limit.",
    sign_in_required: "This connection needs you to sign in again.",
    model_unavailable: "This model is not available on this connection.",
  };
  return new InferenceError(
    code,
    "refused",
    messages[code] ?? body.message ?? `The provider refused the request (${response.status}).`,
  );
}
/** Server-sent events as (event, data) pairs. Stops when the body ends. */
export async function* serverEvents(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<{ event?: string; data: string }> {
  const decoder = new TextDecoder();
  let buffer = "",
    event: string | undefined,
    data: string[] = [];
  const reader = body.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      let index = buffer.indexOf("\n");
      while (index >= 0) {
        const line = buffer.slice(0, index).replace(/\r$/, "");
        buffer = buffer.slice(index + 1);
        if (line === "") {
          if (data.length) yield { ...(event ? { event } : {}), data: data.join("\n") };
          event = undefined;
          data = [];
        } else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
        else if (line.startsWith("event:")) event = line.slice(6).trim();
        index = buffer.indexOf("\n");
      }
      if (buffer.length > 4_000_000) throw new Error("stream_line_too_long");
      if (done) break;
    }
    if (data.length) yield { ...(event ? { event } : {}), data: data.join("\n") };
  } finally {
    reader.releaseLock();
  }
}
function json(data: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(data);
    return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}
const count = (value: unknown) =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
function usage(input: unknown, output: unknown, reasoning?: unknown): QuickUsage | undefined {
  const result: QuickUsage = {};
  const i = count(input),
    o = count(output),
    r = count(reasoning);
  if (i !== undefined) result.inputTokens = i;
  if (o !== undefined) result.outputTokens = o;
  if (r !== undefined) result.reasoningTokens = r;
  return Object.keys(result).length ? result : undefined;
}
/** Consumes a stream. A stream that ends without the provider's completion is ambiguous. */
async function consume(
  response: Response,
  signal: AbortSignal,
  handle: (frame: { event?: string; data: string }) => "done" | undefined,
): Promise<void> {
  if (!response.body) throw new InferenceError("empty_stream", "ambiguous", "No response stream.");
  try {
    for await (const frame of serverEvents(response.body)) if (handle(frame) === "done") return;
  } catch (error) {
    if (error instanceof InferenceError) throw error;
    throw transportError(error, signal);
  }
  throw new InferenceError(
    signal.aborted ? "cancelled" : "stream_ended",
    "ambiguous",
    "The reply ended before the provider confirmed it was complete.",
  );
}
/** OpenAI Responses API with the person's own key: `store: false`, full history in `input`. */
export function openAIResponses(options: {
  baseUrl: string;
  token: () => Promise<string>;
  fetch?: FetchLike;
}): InferenceAdapter {
  const fetcher = options.fetch ?? fetch;
  const base = options.baseUrl.replace(/\/+$/, "");
  return {
    async listModels(signal) {
      const response = await send(fetcher, `${base}/models`, {
        headers: { authorization: `Bearer ${await options.token()}` },
        ...(signal ? { signal } : {}),
      });
      if (!response.ok) throw await refusal(response);
      const body = (await response.json()) as Record<string, unknown>;
      return ((body.data as Record<string, unknown>[] | undefined) ?? [])
        .filter((row) => typeof row.id === "string")
        .map((row) => ({
          id: String(row.id),
          label: String(row.id),
          source: "discovered" as const,
        }))
        .sort((a, b) => a.id.localeCompare(b.id));
    },
    async stream(request) {
      const response = await send(fetcher, `${base}/responses`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${await options.token()}`,
          "content-type": "application/json",
          accept: "text/event-stream",
        },
        body: JSON.stringify({
          model: request.model,
          instructions: request.instructions,
          input: request.turns.map((turn) => ({
            role: turn.role,
            content: [
              { type: turn.role === "user" ? "input_text" : "output_text", text: turn.text },
            ],
          })),
          store: false,
          stream: true,
        }),
        signal: request.signal,
      });
      if (!response.ok) throw await refusal(response);
      let produced = false,
        result: InferenceResult = {};
      await consume(response, request.signal, (frame) => {
        const value = json(frame.data);
        const type = String(value?.type ?? frame.event ?? "");
        if (type === "response.output_text.delta" && typeof value?.delta === "string") {
          produced = true;
          request.onText(value.delta);
        } else if (type === "response.completed") {
          const reply = value?.response as Record<string, unknown> | undefined;
          const reported = reply?.usage as Record<string, unknown> | undefined;
          const details = reported?.output_tokens_details as Record<string, unknown> | undefined;
          const sample = usage(
            reported?.input_tokens,
            reported?.output_tokens,
            details?.reasoning_tokens,
          );
          result = sample ? { usage: sample } : {};
          return "done";
        } else if (type === "response.failed" || type === "error") {
          const reply = value?.response as Record<string, unknown> | undefined;
          const error = (reply?.error ?? value?.error ?? value) as Record<string, unknown>;
          const code = String(error?.code ?? "provider_failed");
          const quota = quotaCodes.has(code);
          throw new InferenceError(
            quota ? "quota_exhausted" : code,
            quota && !produced ? "refused" : "ambiguous",
            quota
              ? "This connection has reached a usage limit."
              : typeof error?.message === "string"
                ? error.message.slice(0, 300)
                : "The provider stopped the reply.",
          );
        } else if (type === "response.incomplete")
          throw new InferenceError(
            "incomplete",
            "ambiguous",
            "The provider ended the reply early.",
          );
        return undefined;
      });
      return result;
    },
  };
}
/** Anthropic Messages API with the person's own Anthropic API key. */
export function anthropicMessages(options: {
  baseUrl: string;
  apiKey: () => Promise<string>;
  fetch?: FetchLike;
}): InferenceAdapter {
  const fetcher = options.fetch ?? fetch;
  const base = options.baseUrl.replace(/\/+$/, "");
  const headers = async () => ({
    "x-api-key": await options.apiKey(),
    "anthropic-version": "2023-06-01",
  });
  return {
    async listModels(signal) {
      const response = await send(fetcher, `${base}/v1/models?limit=100`, {
        headers: await headers(),
        ...(signal ? { signal } : {}),
      });
      if (!response.ok) throw await refusal(response);
      const body = (await response.json()) as { data?: Record<string, unknown>[] };
      return (body.data ?? [])
        .filter((row) => typeof row.id === "string")
        .map((row) => ({
          id: String(row.id),
          label: typeof row.display_name === "string" ? row.display_name : String(row.id),
          source: "discovered" as const,
        }));
    },
    async stream(request) {
      const response = await send(fetcher, `${base}/v1/messages`, {
        method: "POST",
        headers: { ...(await headers()), "content-type": "application/json" },
        body: JSON.stringify({
          model: request.model,
          max_tokens: 4096,
          system: request.instructions,
          messages: request.turns.map((turn) => ({ role: turn.role, content: turn.text })),
          stream: true,
        }),
        signal: request.signal,
      });
      if (!response.ok) throw await refusal(response);
      let input: number | undefined, output: number | undefined;
      await consume(response, request.signal, (frame) => {
        const value = json(frame.data);
        const type = String(value?.type ?? frame.event ?? "");
        if (type === "message_start") {
          const message = value?.message as { usage?: Record<string, unknown> } | undefined;
          input = count(message?.usage?.input_tokens);
        } else if (type === "content_block_delta") {
          const delta = value?.delta as Record<string, unknown> | undefined;
          if (delta?.type === "text_delta" && typeof delta.text === "string") {
            request.onText(delta.text);
          }
        } else if (type === "message_delta") {
          output = count((value?.usage as Record<string, unknown> | undefined)?.output_tokens);
        } else if (type === "message_stop") return "done";
        else if (type === "error") {
          const error = value?.error as Record<string, unknown> | undefined;
          const code = String(error?.type ?? "provider_failed");
          throw new InferenceError(
            code === "rate_limit_error" ? "quota_exhausted" : code,
            "ambiguous",
            typeof error?.message === "string"
              ? error.message.slice(0, 300)
              : "The provider stopped the reply.",
          );
        }
        return undefined;
      });
      const sample = usage(input, output);
      return sample ? { usage: sample } : {};
    },
  };
}
/** An OpenAI compatible endpoint, for example a local model server. A key is optional. */
export function openAICompatible(options: {
  baseUrl: string;
  apiKey?: () => Promise<string | undefined>;
  fetch?: FetchLike;
}): InferenceAdapter {
  const fetcher = options.fetch ?? fetch;
  const base = options.baseUrl.replace(/\/+$/, "");
  const headers = async (): Promise<Record<string, string>> => {
    const key = await options.apiKey?.();
    return key ? { authorization: `Bearer ${key}` } : {};
  };
  return {
    async listModels(signal) {
      const response = await send(fetcher, `${base}/models`, {
        headers: await headers(),
        ...(signal ? { signal } : {}),
      });
      if (!response.ok) throw await refusal(response);
      const body = (await response.json()) as { data?: Record<string, unknown>[] };
      return (body.data ?? [])
        .filter((row) => typeof row.id === "string")
        .map((row) => ({
          id: String(row.id),
          label: String(row.id),
          source: "discovered" as const,
        }));
    },
    async stream(request) {
      const response = await send(fetcher, `${base}/chat/completions`, {
        method: "POST",
        headers: { ...(await headers()), "content-type": "application/json" },
        body: JSON.stringify({
          model: request.model,
          messages: [
            { role: "system", content: request.instructions },
            ...request.turns.map((turn) => ({ role: turn.role, content: turn.text })),
          ],
          stream: true,
          stream_options: { include_usage: true },
        }),
        signal: request.signal,
      });
      if (!response.ok) throw await refusal(response);
      let result: InferenceResult = {};
      await consume(response, request.signal, (frame) => {
        if (frame.data.trim() === "[DONE]") return "done";
        const value = json(frame.data);
        if (value?.error) {
          const error = value.error as Record<string, unknown>;
          throw new InferenceError(
            String(error.code ?? "provider_failed"),
            "ambiguous",
            typeof error.message === "string"
              ? error.message.slice(0, 300)
              : "The model stopped the reply.",
          );
        }
        const choice = (value?.choices as Record<string, unknown>[] | undefined)?.[0];
        const delta = choice?.delta as Record<string, unknown> | undefined;
        if (typeof delta?.content === "string" && delta.content) {
          request.onText(delta.content);
        }
        const reported = value?.usage as Record<string, unknown> | undefined;
        const sample = usage(reported?.prompt_tokens, reported?.completion_tokens);
        if (sample) result = { usage: sample };
        return undefined;
      });
      return result;
    },
  };
}
