import type { SessionTokens, ToolActor } from "./session-tokens.js";

export interface ToolRequest {
  id: string;
  name: string;
  arguments: unknown;
}
export interface ToolInvocation {
  actor: ToolActor;
  arguments: unknown;
  /** Handlers must use a durable command receipt for mutations. */
  idempotencyKey: string;
}
export interface ToolResult {
  content: (
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string; text?: never }
  )[];
  isError?: true;
  structuredContent?: Record<string, unknown>;
}
/** Only trusted host handlers can opt into bounded multimodal results. */
export class RichToolResult {
  constructor(readonly result: ToolResult) {}
}
type AuditResult = "started" | "denied" | "rate_limited" | "succeeded" | "failed";
export interface ToolAudit {
  actor: ToolActor;
  callId: string;
  name: string;
  result: AuditResult;
}
interface Options {
  tools: ReadonlyMap<string, (call: ToolInvocation) => Promise<unknown>>;
  /** Resolve targets from stored state and read current grants. Never trust supplied actor fields. */
  authorize(actor: ToolActor, name: string, args: unknown): boolean;
  /** Reserve the call's limit allowance before audit and execution. */
  checkLimits(actor: ToolActor, name: string): boolean;
  audit(record: ToolAudit): Promise<void>;
}
const failure = (code: string, detail?: string): ToolResult => ({
  content: [
    { type: "text", text: JSON.stringify(detail ? { error: code, detail } : { error: code }) },
  ],
  isError: true,
});
const sanitizeSchemaDetail = (raw: string) =>
  raw
    .replace(/[^A-Za-z0-9_./,;:'"() -]/g, "")
    .trim()
    .slice(0, 220) || undefined;
const domainErrorPattern =
  /^([a-z][a-z0-9]*(?:_[a-z0-9]+)+)(?:: ([A-Za-z0-9_.,;:'"() -]{1,220}))?$/;
function classifyHandlerError(error: unknown): { code: string; detail?: string } {
  if (!(error instanceof Error)) return { code: "tool_failed" };
  if (error.message.startsWith("Invalid payload: ")) {
    const detail = sanitizeSchemaDetail(error.message.slice("Invalid payload: ".length));
    return detail ? { code: "invalid_tool_arguments", detail } : { code: "invalid_tool_arguments" };
  }
  const match = domainErrorPattern.exec(error.message);
  if (match?.[1]) {
    return match[2] ? { code: match[1], detail: match[2] } : { code: match[1] };
  }
  return { code: "tool_failed" };
}
const sameActor = (a: ToolActor, b: ToolActor | undefined) =>
  b &&
  a.agentId === b.agentId &&
  a.threadId === b.threadId &&
  a.sessionId === b.sessionId &&
  a.turnId === b.turnId;

/** Transport-independent tool boundary. Audit contains identities and outcomes, never arguments. */
export class ToolDispatcher {
  private readonly tools: Options["tools"];
  constructor(
    private readonly tokens: SessionTokens,
    private readonly options: Options,
  ) {
    this.tools = new Map(options.tools);
  }

  async call(
    authorization: string | undefined,
    request: ToolRequest,
    validate?: (args: unknown) => boolean | { valid: boolean; errorMessage?: string | undefined },
  ): Promise<ToolResult> {
    const { id, name } = request;
    const actor = this.tokens.authenticate(authorization);
    if (!actor) return failure("unauthorized");
    if (!id || id.length > 256 || !name || name.length > 256)
      return failure("invalid_tool_request");
    const execute = this.tools.get(name);
    if (!execute) return failure("unknown_tool");
    let args: unknown;
    try {
      const encoded = JSON.stringify(request.arguments);
      if (encoded === undefined || Buffer.byteLength(encoded) > 65536)
        return failure("invalid_tool_arguments");
      args = JSON.parse(encoded);
    } catch {
      return failure("invalid_tool_arguments");
    }
    const audit = (result: AuditResult) =>
      this.options.audit({
        actor: { ...actor },
        callId: id,
        name: name,
        result,
      });
    try {
      const validation = validate ? validate(args) : true;
      const valid = typeof validation === "boolean" ? validation : validation.valid;
      if (!valid) {
        await audit("denied");
        const detail =
          typeof validation === "object" && validation.errorMessage
            ? sanitizeSchemaDetail(validation.errorMessage)
            : undefined;
        return failure("invalid_tool_arguments", detail);
      }
      if (!this.options.authorize({ ...actor }, name, args)) {
        await audit("denied");
        return failure("grant_required");
      }
      if (!this.options.checkLimits({ ...actor }, name)) {
        await audit("rate_limited");
        return failure("rate_limited");
      }
      await audit("started");
      if (!sameActor(actor, this.tokens.authenticate(authorization))) {
        await audit("failed");
        return failure("session_authority_changed");
      }
      if (!this.options.authorize({ ...actor }, name, args)) {
        await audit("denied");
        return failure("grant_required");
      }
    } catch {
      return failure("authorization_audit_failed");
    }
    let text: string | undefined;
    let rich: ToolResult | undefined;
    try {
      const value = await execute({
        actor: { ...actor },
        arguments: args,
        idempotencyKey: JSON.stringify([actor.sessionId, actor.turnId ?? null, id]),
      });
      if (value instanceof RichToolResult) rich = value.result;
      text = JSON.stringify(rich ?? value);
    } catch (error) {
      try {
        await audit("failed");
      } catch {}
      if (!sameActor(actor, this.tokens.authenticate(authorization)))
        return failure("session_authority_changed");
      if (!this.options.authorize({ ...actor }, name, args)) return failure("grant_required");
      const classified = classifyHandlerError(error);
      return failure(classified.code, classified.detail);
    }
    try {
      if (!sameActor(actor, this.tokens.authenticate(authorization))) {
        await audit("failed");
        return failure("session_authority_changed");
      }
      if (!this.options.authorize({ ...actor }, name, args)) {
        await audit("denied");
        return failure("grant_required");
      }
      if (text === undefined || text.length > (rich ? 8 * 1024 * 1024 : 4000)) {
        await audit("failed");
        return failure("result_too_large");
      }
      await audit(rich?.isError ? "failed" : "succeeded");
    } catch {
      return failure("result_audit_failed");
    }
    if (!sameActor(actor, this.tokens.authenticate(authorization)))
      return failure("session_authority_changed");
    if (!this.options.authorize({ ...actor }, name, args)) return failure("grant_required");
    return rich ?? { content: [{ type: "text", text }] };
  }
}
