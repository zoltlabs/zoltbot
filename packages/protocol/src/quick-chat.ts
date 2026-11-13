import { type Static, Type } from "@sinclair/typebox";
import { At, Id, OptionalText, object, Text, ToolKindSchema, values } from "./common.js";

// Quick Chat: general conversations outside any workspace or team.
// They live in host-side tables, not the event log, so delete removes their content.

/**
 * Who pays for a reply. Zoltbot is never a billing source. `tool_sign_in` is whatever account the
 * person signed the coding tool in with on that host: usually their plan, sometimes their key.
 */
export const QuickBillingSchema = values(["tool_sign_in", "user_api_key", "local"]);
export type QuickBilling = Static<typeof QuickBillingSchema>;
export const QuickConnectionKindSchema = values(["coding_tool", "api_key", "local"]);
export type QuickConnectionKind = Static<typeof QuickConnectionKindSchema>;
/** Coding tools Quick Chat can run on, by agent definition id. */
export const quickTools = ["antigravity", "claude", "codex"] as const;
export const QuickToolSchema = values(quickTools);
export type QuickTool = Static<typeof QuickToolSchema>;
export const QuickProviderSchema = values([
  "openai",
  "anthropic",
  "openai_compatible",
  ...quickTools,
]);
export type QuickProvider = Static<typeof QuickProviderSchema>;
export const QuickModelSchema = object({
  efforts: Type.Optional(Type.Array(Text)),
  id: Type.String({ minLength: 1, maxLength: 200 }),
  label: Type.String({ maxLength: 200 }),
  /** Discovered from the account, or typed by the person for an endpoint that cannot list. */
  source: values(["discovered", "configured"]),
});
export type QuickModel = Static<typeof QuickModelSchema>;
export const QuickHostSchema = object({ id: Id, name: Type.String({ maxLength: 200 }) });
/** What a client may see about a connection. Secrets never appear here. */
export const QuickConnectionSchema = object({
  id: Id,
  kind: QuickConnectionKindSchema,
  provider: QuickProviderSchema,
  label: Type.String({ minLength: 1, maxLength: 80 }),
  billing: QuickBillingSchema,
  host: QuickHostSchema,
  baseUrl: OptionalText,
  status: values(["ready", "needs_sign_in", "quota_exhausted", "unavailable"]),
  statusDetail: OptionalText,
  models: Type.Array(QuickModelSchema, { maxItems: 500 }),
  modelsCheckedAt: Type.Optional(At),
  /** A fast model from this connection's own list, suggested for Quick Chat. */
  recommendedModel: OptionalText,
  /** A display label for a signed in account, for example its email. */
  account: OptionalText,
  hasSecret: Type.Boolean(),
  createdAt: At,
  updatedAt: At,
});
export type QuickConnection = Static<typeof QuickConnectionSchema>;
export const QuickFallbackSchema = object({
  connectionId: Id,
  model: Id,
  /** When the person confirmed that conversation context goes to this destination and bill. */
  acknowledgedAt: At,
});
/**
 * How Quick Chat treats one of the person's MCP servers: `off` never loads it (and its tool
 * schemas cost nothing), `ask` loads it and asks before calls the tool does not mark as reads,
 * `allow` loads it and runs its calls without asking.
 */
export const QuickServerAccessSchema = values(["off", "ask", "allow"]);
export type QuickServerAccess = Static<typeof QuickServerAccessSchema>;
const ServerName = Type.String({ minLength: 1, maxLength: 100, pattern: "^[\\w.-]+$" });
export const QuickSettingsSchema = object({
  defaultConnectionId: Type.Optional(Id),
  defaultModel: Type.Optional(Id),
  /** An explicit stronger model for "Think deeper", per connection. */
  deeperModels: Type.Record(Id, Id),
  /** Off unless the person turns it on and acknowledges the destination. */
  fallback: Type.Optional(QuickFallbackSchema),
  /** Tools the person chose "Always allow" for, by native tool name. Reads never need this. */
  allowedTools: Type.Optional(Type.Array(Text, { maxItems: 200 })),
  /** Per MCP server, by name. A server without an entry is `ask`. */
  servers: Type.Optional(Type.Record(Type.String({ maxLength: 100 }), QuickServerAccessSchema)),
});
export type QuickSettings = Static<typeof QuickSettingsSchema>;
export const QuickContextSourceSchema = Type.Union([
  object({
    id: Id,
    kind: Type.Literal("file"),
    projectId: Id,
    path: Type.String({ minLength: 1, maxLength: 1024 }),
    label: Type.String({ maxLength: 300 }),
  }),
  object({
    id: Id,
    kind: Type.Literal("brief"),
    scope: object({ type: values(["project", "subproject"]), id: Id }),
    label: Type.String({ maxLength: 300 }),
  }),
  object({
    id: Id,
    kind: Type.Literal("workspace"),
    projectId: Id,
    label: Type.String({ maxLength: 300 }),
  }),
]);
export type QuickContextSource = Static<typeof QuickContextSourceSchema>;
/** One piece of context that went to the provider with a message. */
export const QuickContextRefSchema = object({
  sourceId: Id,
  label: Type.String({ maxLength: 300 }),
  path: OptionalText,
  /** Content hash, so a reused excerpt is not presented as freshly read. */
  revision: Id,
  chars: Type.Integer({ minimum: 0 }),
  reused: Type.Boolean(),
});
export type QuickContextRef = Static<typeof QuickContextRefSchema>;
export const QuickChatSchema = object({
  id: Id,
  title: Type.String({ minLength: 1, maxLength: 200 }),
  pinned: Type.Optional(Type.Boolean()),
  archived: Type.Optional(Type.Boolean()),
  unread: Type.Optional(Type.Boolean()),
  contextSources: Type.Array(QuickContextSourceSchema, { maxItems: 20 }),
  lastConnectionId: Type.Optional(Id),
  lastModel: Type.Optional(Id),
  handoffs: Type.Array(object({ threadId: Id, at: At }), { maxItems: 50 }),
  createdAt: At,
  updatedAt: At,
});
export type QuickChat = Static<typeof QuickChatSchema>;
export const QuickOutcomeSchema = values([
  "streaming",
  "complete",
  /** Cancelled or cut off: output and charges up to that point may exist. */
  "interrupted",
  /** The request may have reached the provider, but the result is unknown. Never replayed. */
  "uncertain",
  /** Refused before any output, for example quota or a missing sign-in. */
  "failed",
]);
export type QuickOutcome = Static<typeof QuickOutcomeSchema>;
export const QuickUsageSchema = object({
  inputTokens: Type.Optional(Type.Integer({ minimum: 0 })),
  outputTokens: Type.Optional(Type.Integer({ minimum: 0 })),
  reasoningTokens: Type.Optional(Type.Integer({ minimum: 0 })),
});
export type QuickUsage = Static<typeof QuickUsageSchema>;
/** A tool the coding tool used while answering, for example a service lookup or a file read. */
export const QuickToolCallSchema = object({
  id: Id,
  name: Text,
  kind: ToolKindSchema,
  title: OptionalText,
  status: values(["running", "ok", "error", "denied"]),
});
export type QuickToolCall = Static<typeof QuickToolCallSchema>;
/**
 * Something the coding tool asked before acting: permission for a tool that may change, send or
 * run something, or a question. The reply waits until the person answers or it expires.
 */
export const QuickRequestSchema = object({
  id: Id,
  kind: values(["approval", "question"]),
  title: Type.String({ maxLength: 500 }),
  detail: Type.Optional(Type.String({ maxLength: 2000 })),
  toolName: OptionalText,
  toolKind: Type.Optional(ToolKindSchema),
  /** Answers for a question. Approvals are answered allow, always or deny. */
  options: Type.Optional(Type.Array(object({ id: Id, label: Text }), { maxItems: 8 })),
  state: values(["pending", "allowed", "denied", "answered", "expired"]),
  /** True when Quick Chat allowed it without asking, for example a read-only lookup. */
  automatic: Type.Optional(Type.Boolean()),
});
export type QuickRequest = Static<typeof QuickRequestSchema>;
export const QuickMessageSchema = object({
  id: Id,
  chatId: Id,
  role: values(["user", "assistant"]),
  text: Type.String({ maxLength: 200_000 }),
  status: QuickOutcomeSchema,
  /** Attribution is kept per turn, so switching connections never rewrites history. */
  connectionId: Type.Optional(Id),
  connectionLabel: OptionalText,
  provider: Type.Optional(QuickProviderSchema),
  billing: Type.Optional(QuickBillingSchema),
  hostName: OptionalText,
  model: Type.Optional(Id),
  usage: Type.Optional(QuickUsageSchema),
  firstTextMs: Type.Optional(Type.Integer({ minimum: 0 })),
  totalMs: Type.Optional(Type.Integer({ minimum: 0 })),
  error: Type.Optional(object({ code: Id, message: Text })),
  context: Type.Array(QuickContextRefSchema, { maxItems: 50 }),
  /** Why an attached source contributed nothing, for example a detected secret. */
  contextNotes: Type.Optional(Type.Array(Type.String({ maxLength: 500 }), { maxItems: 20 })),
  tools: Type.Optional(Type.Array(QuickToolCallSchema, { maxItems: 100 })),
  requests: Type.Optional(Type.Array(QuickRequestSchema, { maxItems: 50 })),
  /** Set when an opt-in fallback answered instead of the selected connection. */
  fallbackFrom: Type.Optional(Id),
  createdAt: At,
});
export type QuickMessage = Static<typeof QuickMessageSchema>;
const ok = object({ ok: Type.Boolean() });
const Confirmed = Type.Literal(true);
export const quickChatMethods = {
  "quickChat.list": {
    params: object({ limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })) }),
    result: object({ items: Type.Array(QuickChatSchema) }),
  },
  "quickChat.get": {
    params: object({ id: Id }),
    result: object({ chat: QuickChatSchema, messages: Type.Array(QuickMessageSchema) }),
  },
  /** Creates the conversation on the first send. The command id makes a retry safe. */
  "quickChat.send": {
    params: object({
      chatId: Type.Optional(Id),
      text: Type.String({ minLength: 1, maxLength: 32_000 }),
      connectionId: Id,
      model: Id,
      contextSources: Type.Optional(Type.Array(QuickContextSourceSchema, { maxItems: 20 })),
    }),
    result: object({ chatId: Id, userMessageId: Id, replyId: Id }),
  },
  "quickChat.cancel": { params: object({ chatId: Id, replyId: Id }), result: ok },
  /** Answers a pending request on a streaming reply. `always` also saves the tool as allowed. */
  "quickChat.respond": {
    params: object({
      replyId: Id,
      requestId: Id,
      decision: values(["allow", "always", "deny"]),
      optionId: Type.Optional(Id),
    }),
    result: ok,
  },
  /** The MCP servers configured in this host's coding tools, by name, with Quick Chat's setting. */
  "quickChat.servers": {
    params: object({}),
    result: object({
      items: Type.Array(
        object({
          name: ServerName,
          tools: Type.Array(QuickToolSchema),
          access: QuickServerAccessSchema,
        }),
        { maxItems: 200 },
      ),
    }),
  },
  "quickChat.setServer": {
    params: object({ name: ServerName, access: QuickServerAccessSchema }),
    result: ok,
  },
  /** Removes a tool from the "Always allow" list, so it asks again. */
  "quickChat.forgetTool": { params: object({ name: Text }), result: ok },
  "quickChat.rename": {
    params: object({ id: Id, title: Type.String({ minLength: 1, maxLength: 200 }) }),
    result: QuickChatSchema,
  },
  "quickChat.update": {
    params: object({
      id: Id,
      pinned: Type.Optional(Type.Boolean()),
      archived: Type.Optional(Type.Boolean()),
      unread: Type.Optional(Type.Boolean()),
    }),
    result: QuickChatSchema,
  },
  "quickChat.delete": { params: object({ id: Id, confirmed: Confirmed }), result: ok },
  "quickChat.setContext": {
    params: object({
      id: Id,
      contextSources: Type.Array(QuickContextSourceSchema, { maxItems: 20 }),
    }),
    result: QuickChatSchema,
  },
  /** File names inside a workspace's folders, for choosing explicit context. Names only. */
  "quickChat.files": {
    params: object({ projectId: Id, query: Type.String({ maxLength: 256 }) }),
    result: object({
      items: Type.Array(object({ path: Text, label: Text })),
      truncated: Type.Boolean(),
    }),
  },
  "quickChat.usage": {
    params: object({ from: Type.Optional(At) }),
    result: object({
      items: Type.Array(
        object({
          connectionId: Id,
          billing: QuickBillingSchema,
          replies: Type.Integer({ minimum: 0 }),
          inputTokens: Type.Integer({ minimum: 0 }),
          outputTokens: Type.Integer({ minimum: 0 }),
          uncertain: Type.Integer({ minimum: 0 }),
        }),
      ),
    }),
  },
  "quickChat.handoffPreview": {
    params: object({ id: Id }),
    result: object({ brief: Text, contextLabels: Type.Array(Text) }),
  },
  /** Creates a normal workspace chat. It sends nothing: the person submits the brief there. */
  "quickChat.handoff": {
    params: object({
      id: Id,
      projectId: Id,
      subprojectId: Type.Optional(Id),
      profileId: Id,
      brief: Type.String({ minLength: 1, maxLength: 8000 }),
      confirmed: Confirmed,
    }),
    result: object({ threadId: Id, brief: Text }),
  },
  "quickConnection.list": {
    params: object({}),
    result: object({ items: Type.Array(QuickConnectionSchema), settings: QuickSettingsSchema }),
  },
  "quickConnection.saveApiKey": {
    params: object({
      id: Type.Optional(Id),
      provider: values(["openai", "anthropic"]),
      label: Type.String({ minLength: 1, maxLength: 80 }),
      /** Write only. Omit to keep the stored key. Never returned. */
      apiKey: Type.Optional(Type.String({ minLength: 8, maxLength: 512 })),
      confirmed: Confirmed,
    }),
    result: QuickConnectionSchema,
  },
  "quickConnection.saveLocal": {
    params: object({
      id: Type.Optional(Id),
      label: Type.String({ minLength: 1, maxLength: 80 }),
      baseUrl: Type.String({ minLength: 1, maxLength: 500 }),
      apiKey: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
      models: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 200 }))),
    }),
    result: QuickConnectionSchema,
  },
  "quickConnection.refreshModels": { params: object({ id: Id }), result: QuickConnectionSchema },
  "quickConnection.remove": { params: object({ id: Id, confirmed: Confirmed }), result: ok },
  /** Brings back a coding tool connection the person removed. */
  "quickConnection.addTool": {
    params: object({ tool: QuickToolSchema }),
    result: QuickConnectionSchema,
  },
  "quickConnection.setDefaults": {
    params: object({
      defaultConnectionId: Type.Optional(Id),
      defaultModel: Type.Optional(Id),
      deeperModel: Type.Optional(object({ connectionId: Id, model: Id })),
    }),
    result: QuickSettingsSchema,
  },
  /** Opt-in automatic fallback. Turning it on requires acknowledging destination and billing. */
  "quickConnection.setFallback": {
    params: Type.Union([
      object({ enabled: Type.Literal(false) }),
      object({
        enabled: Type.Literal(true),
        connectionId: Id,
        model: Id,
        acknowledged: Confirmed,
      }),
    ]),
    result: QuickSettingsSchema,
  },
};
/** Secrets and billing choices are made on the Mac, not from a paired phone. */
export const quickChatMacOnlyMethods = [
  "quickConnection.saveApiKey",
  "quickConnection.saveLocal",
  "quickConnection.remove",
  "quickConnection.addTool",
  "quickConnection.setFallback",
  "quickChat.setServer",
] as const;
/** Unsequenced events: Quick Chat state is not part of the event log. */
export const quickChatEvents = {
  "quickChat.changed": QuickChatSchema,
  "quickChat.removed": object({ id: Id }),
  "quickMessage.changed": QuickMessageSchema,
  "quickConnection.changed": object({ id: Id }),
};
