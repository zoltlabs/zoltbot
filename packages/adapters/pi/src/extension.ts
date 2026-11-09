import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";

export interface GateEvent {
  toolName: string;
  toolCallId?: string;
  input: Record<string, unknown>;
}
export interface GateContext {
  hasUI: boolean;
  ui: {
    confirm(title: string, message: string, options?: { timeout: number }): Promise<boolean>;
    notify(message: string, type: "info"): void;
    select?:
      | ((
          title: string,
          options: string[],
          opts?: { signal: AbortSignal },
        ) => Promise<string | undefined>)
      | undefined;
    input?:
      | ((
          title: string,
          placeholder?: string,
          opts?: { signal: AbortSignal },
        ) => Promise<string | undefined>)
      | undefined;
  };
}
export interface QuestionToolDefinition {
  name: string;
  label: string;
  description: string;
  parameters: Record<string, unknown>;
  execute(
    id: string,
    params: unknown,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    context: GateContext,
  ): Promise<{
    content: { type: "text"; text: string }[];
    details: { status: "answered" | "cancelled" };
  }>;
}
export interface GateApi {
  registerTool(tool: QuestionToolDefinition): void;
  on(
    name: "tool_call",
    handler: (
      event: GateEvent,
      context: GateContext,
    ) => Promise<{ block: true; reason: string } | undefined>,
  ): void;
  registerMcpServer(
    name: string,
    config: { url: string; headers: Record<string, string>; exposure: "direct" },
  ): void;
  registerCommand(
    name: string,
    command: { description: string; handler(args: string, context: GateContext): Promise<void> },
  ): void;
  getAllTools(): { name: string }[];
}
interface Config {
  profile: string;
  cwd: string;
  hostMcp: { url: string; token: string };
  nonce: string;
}
const deny = (reason: string) => ({ block: true as const, reason: `ZOLTBOT_DENIED:${reason}` });
function inside(cwd: string, target: string) {
  let candidate = path.resolve(cwd, target);
  const suffix: string[] = [];
  while (!existsSync(candidate)) {
    const parent = path.dirname(candidate);
    if (parent === candidate) return false;
    suffix.unshift(path.basename(candidate));
    candidate = parent;
  }
  const actual = path.resolve(realpathSync(candidate), ...suffix);
  const relative = path.relative(realpathSync(cwd), actual);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}
export function registerQuestionTool(api: Pick<GateApi, "registerTool">) {
  api.registerTool({
    name: "zoltbot_ask_human",
    label: "Ask human",
    description:
      "Ask one blocking question when human input is needed. Provide options for a single choice, or omit options for typed input.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        question: { type: "string", minLength: 1, maxLength: 2000 },
        options: {
          type: "array",
          minItems: 1,
          maxItems: 8,
          items: { type: "string", minLength: 1, maxLength: 16000 },
        },
      },
      required: ["question"],
    },
    async execute(_id, raw, signal, _onUpdate, ctx) {
      const fail = () => {
        throw new Error("invalid_question_request");
      };
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fail();
      const params = raw as Record<string, unknown>;
      if (
        Object.keys(params).some((key) => !["question", "options"].includes(key)) ||
        typeof params.question !== "string" ||
        !params.question.trim() ||
        params.question.length > 2000
      )
        return fail();
      if (
        params.options !== undefined &&
        (!Array.isArray(params.options) ||
          !params.options.length ||
          params.options.length > 8 ||
          params.options.some(
            (option) => typeof option !== "string" || !option || option.length > 16000,
          ))
      )
        return fail();
      const options = params.options === undefined ? undefined : [...(params.options as string[])];
      let value: string | undefined;
      if (ctx.hasUI && !signal?.aborted)
        value = options
          ? await ctx.ui.select?.(params.question, options, signal ? { signal } : undefined)
          : await ctx.ui.input?.(params.question, "", signal ? { signal } : undefined);
      if (signal?.aborted || value === undefined || !value.trim())
        return {
          content: [{ type: "text", text: '{"status":"cancelled"}' }],
          details: { status: "cancelled" },
        };
      if (options && !options.includes(value)) throw new Error("invalid_question_answer");
      return {
        content: [{ type: "text", text: JSON.stringify({ status: "answered", answer: value }) }],
        details: { status: "answered" },
      };
    },
  });
}
export function registerGate(api: GateApi, config: Config) {
  if (
    !["read_only", "workspace_write", "workspace_write_net", "full_access"].includes(
      config.profile,
    ) ||
    !path.isAbsolute(config.cwd) ||
    !config.nonce ||
    !config.hostMcp?.token
  )
    throw new Error("invalid_gate_config");
  const url = new URL(config.hostMcp.url);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
    throw new Error("invalid_gate_config");
  registerQuestionTool(api);
  api.on("tool_call", async (event, ctx) => {
    try {
      if (config.profile === "full_access") return;
      if (event.toolName === "zoltbot_ask_human") return;
      if (event.toolName.startsWith("mcp__zoltbot__")) return;
      if (["read", "grep", "find", "ls"].includes(event.toolName)) return;
      if (config.profile === "read_only") return deny("Read only permission profile");
      if (["write", "edit"].includes(event.toolName)) {
        const target = event.input.path;
        return typeof target === "string" && inside(config.cwd, target)
          ? undefined
          : deny("Path outside workspace");
      }
      if (!ctx.hasUI) return deny("Approval host unavailable");
      const message = JSON.stringify({
        toolName: event.toolName,
        itemId: event.toolCallId,
        input: event.input,
        cwd: config.cwd,
      });
      if (message.length > 16000) return deny("Approval request too large");
      if ((await ctx.ui.confirm("Zoltbot approval", message, { timeout: 300000 })) !== true)
        return deny("Request declined");
    } catch {
      return deny("Approval host unavailable");
    }
  });
  api.registerMcpServer("zoltbot", {
    url: config.hostMcp.url,
    headers: { Authorization: `Bearer ${config.hostMcp.token}` },
    exposure: "direct",
  });
  api.registerCommand("zoltbot_ready", {
    description: "Verify the bundled Zoltbot gate",
    async handler(_args, ctx) {
      const deadline = Date.now() + 10000;
      while (!api.getAllTools().some((tool) => tool.name.startsWith("mcp__zoltbot__"))) {
        if (Date.now() >= deadline) throw new Error("host_tools_unavailable");
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      ctx.ui.notify(`zoltbot_ready:${config.nonce}`, "info");
    },
  });
}
export default function extension(api: GateApi) {
  const file = process.env.ZOLTBOT_PI_CONFIG;
  if (!file) throw new Error("gate_config_required");
  registerGate(api, JSON.parse(readFileSync(file, "utf8")) as Config);
}
