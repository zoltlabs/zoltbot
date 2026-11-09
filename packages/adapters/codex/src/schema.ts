import { Ajv, type ValidateFunction } from "ajv";
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("provider_protocol_error");
  return value as Record<string, unknown>;
}
const serverResults: Record<string, string> = {
  "item/commandExecution/requestApproval": "CommandExecutionRequestApprovalResponse",
  "item/fileChange/requestApproval": "FileChangeRequestApprovalResponse",
  "item/permissions/requestApproval": "PermissionsRequestApprovalResponse",
  "item/tool/requestUserInput": "ToolRequestUserInputResponse",
  "mcpServer/elicitation/request": "McpServerElicitationRequestResponse",
  "item/tool/call": "DynamicToolCallResponse",
};
const results: Record<string, string> = {
  initialize: "InitializeResponse",
  "account/read": "GetAccountResponse",
  "thread/start": "ThreadStartResponse",
  "thread/resume": "ThreadResumeResponse",
  "thread/fork": "ThreadForkResponse",
  "thread/list": "ThreadListResponse",
  "turn/start": "TurnStartResponse",
  "turn/steer": "TurnSteerResponse",
  "turn/interrupt": "TurnInterruptResponse",
  "thread/name/set": "ThreadSetNameResponse",
  "thread/compact/start": "ThreadCompactStartResponse",
  "config/read": "ConfigReadResponse",
  "model/list": "ModelListResponse",
};
export class CodexSchemas {
  private readonly ajv = new Ajv({ strict: false, validateFormats: false });
  private readonly cache = new Map<string, ValidateFunction>();
  private readonly definitions: Record<string, unknown>;
  private readonly v2: Record<string, unknown>;
  private readonly notifications: Set<string>;
  private readonly requests: Set<string>;
  readonly sourceKinds: string[];
  constructor(bundle: unknown) {
    this.definitions = object(object(bundle).definitions);
    this.v2 = object(this.definitions.v2);
    this.notifications = this.methods("ServerNotification");
    this.requests = this.methods("ServerRequest");
    const kinds = object(this.v2.ThreadSourceKind).enum;
    this.sourceKinds = Array.isArray(kinds)
      ? kinds.filter((k): k is string => typeof k === "string")
      : [];
  }
  private methods(name: string) {
    const variants = object(this.definitions[name]).oneOf;
    if (!Array.isArray(variants)) throw new Error("invalid_provider_schema");
    return new Set(
      variants.flatMap((value) => {
        const method = object(object(object(value).properties).method).enum;
        return Array.isArray(method)
          ? method.filter((m): m is string => typeof m === "string")
          : [];
      }),
    );
  }
  private check(name: string, value: unknown) {
    let validate = this.cache.get(name);
    if (!validate) {
      if (!(name in this.v2) && !(name in this.definitions))
        throw new Error("unsupported_provider_schema");
      validate = this.ajv.compile({
        definitions: this.definitions,
        $ref: `#/definitions/${name in this.v2 ? `v2/${name}` : name}`,
      });
      this.cache.set(name, validate);
    }
    if (!validate(value)) throw new Error("provider_protocol_error");
  }
  request(value: unknown) {
    this.check("ClientRequest", value);
  }
  clientNotification(value: unknown) {
    this.check("ClientNotification", value);
  }
  notification(value: unknown) {
    const message = object(value);
    if (typeof message.method !== "string" || !this.notifications.has(message.method)) return false;
    this.check("ServerNotification", value);
    return true;
  }
  serverRequest(value: unknown) {
    const message = object(value);
    if (typeof message.method !== "string" || !this.requests.has(message.method)) return false;
    this.check("ServerRequest", value);
    return true;
  }
  result(method: string, value: unknown) {
    const name = results[method];
    if (!name) throw new Error("unsupported_result_schema");
    this.check(name, value);
  }
  serverResult(method: string, value: unknown) {
    const name = serverResults[method];
    if (!name) throw new Error("unsupported_server_request");
    this.check(name, value);
  }
}
