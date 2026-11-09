import { randomUUID } from "node:crypto";
import type { AgentSession } from "@zoltbot/adapters-sdk";
import type {
  AgentDefinition,
  InteractionAnswer,
  InteractionDraft,
  QuickModel,
  QuickRequest,
  QuickTool,
  QuickToolCall,
  QuickUsage,
} from "@zoltbot/protocol";
import type { QuickHostContext } from "./host-tools.js";
import {
  type InferenceAdapter,
  InferenceError,
  type InferenceRequest,
  type InferenceTurn,
  type QuickDecision,
  type QuickToolHooks,
} from "./providers.js";

// Quick Chat on the coding tools the person already installed and signed in to on this host
// (Codex, Claude Code, Antigravity). Their own sign-in pays; Zoltbot holds no credential.
// With tools on, the tool may use the person's own MCP servers and Quick Chat's workspace reads.
// Read-only requests are allowed; anything else waits for the person, never for Zoltbot.

/** Opens a native session for one conversation. Production: tool-runtime.ts. */
export interface QuickToolRuntime {
  open(
    definition: AgentDefinition,
    options: {
      conversationId: string;
      model?: string;
      instructions: string;
      tools: boolean;
      /** With tools: the person's MCP servers to leave out. */
      off?: string[];
    },
  ): Promise<AgentSession>;
  /** Gives the runtime the host state its workspace tools read. */
  attach?(host: QuickHostContext): void;
  close(): Promise<void>;
}
/** Kinds that only look things up, so Quick Chat allows them without asking. */
const readKinds = new Set(["read", "search", "think"]);
/** Quick Chat's own workspace tools are read-only, whatever name the tool gives them. */
const ownRead = /(^|__)quick_(workspaces|search|read)$/;
const noTools = "Do not use tools, read files, browse, or run commands.";
const withTools = [
  "You may use your tools and the person's connected services to look things up.",
  "quick_workspaces, quick_search and quick_read read the person's Zoltbot workspaces.",
  "Prefer looking up live data over guessing. The person is asked before anything that changes,",
  "sends, posts, buys, deletes or runs commands; if they decline, say what you would have done.",
].join(" ");
/** Turns a native request into what the person sees, or undefined when it is allowed as-is. */
export function quickRequest(
  interaction: InteractionDraft,
  allowed: (name: string) => boolean,
): QuickRequest | undefined {
  const context = interaction.context;
  const name = context?.toolName ?? "";
  if (
    interaction.type === "approval" &&
    ((context?.toolKind && readKinds.has(context.toolKind)) || ownRead.test(name) || allowed(name))
  )
    return undefined;
  const item = interaction.items[0];
  const question = interaction.type === "question" && Boolean(item?.options?.length);
  const detail = context?.command ?? context?.paths?.join("\n") ?? context?.markdown;
  return {
    id: interaction.id,
    kind: question ? "question" : "approval",
    title: (interaction.title || item?.prompt || name || "Allow this action?").slice(0, 500),
    ...(detail ? { detail: detail.slice(0, 2000) } : {}),
    ...(name ? { toolName: name } : {}),
    ...(context?.toolKind ? { toolKind: context.toolKind } : {}),
    ...(question && item?.options
      ? { options: item.options.map((option) => ({ id: option.id, label: option.label })) }
      : {}),
    state: "pending",
  };
}
/** The native answer for a decision. Only the first question of a request is answered. */
function nativeAnswer(interaction: InteractionDraft, decision: QuickDecision): InteractionAnswer {
  const by = { kind: "human" as const, id: "quick-chat" };
  const at = new Date().toISOString();
  if (decision.decision === "deny") return { action: "decline" as const, by, at };
  const item = interaction.items[0];
  if (interaction.type === "question" && item && decision.optionId)
    return {
      action: "accept" as const,
      answers: { [item.id]: { options: [decision.optionId] } },
      by,
      at,
    };
  if (interaction.type === "form" && item)
    return { action: "accept" as const, answers: { [item.id]: { value: {} } }, by, at };
  const choices = item?.choices?.map((choice) => choice.id) ?? [];
  return {
    action: "accept" as const,
    ...(choices.includes("allow_once") ? { choice: "allow_once" } : {}),
    by,
    at,
  };
}
export const toolLabels: Record<QuickTool, string> = {
  antigravity: "Antigravity",
  claude: "Claude Code",
  codex: "Codex",
};
const preferred: Record<QuickTool, RegExp> = {
  antigravity: /flash/i,
  claude: /^sonnet$/i,
  codex: /terra/i,
};
const version = (id: string) =>
  (id.match(/\d+(?:\.\d+)*/)?.[0] ?? "0").split(".").map(Number) as number[];
const newer = (a: string, b: string) => {
  const [x, y] = [version(a), version(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++)
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (y[i] ?? 0) - (x[i] ?? 0);
  return 0;
};
/** The newest fast model each tool lists: Gemini Flash, Sonnet, or GPT Terra. */
export function toolRecommendation(tool: QuickTool, models: readonly QuickModel[]) {
  return models
    .map((model) => model.id)
    .filter((id) => preferred[tool].test(id))
    .sort(newer)[0];
}
const toolCodes: [RegExp, string, string][] = [
  [/auth|login|sign/i, "sign_in_required", "Sign in to this coding tool on the Mac, then retry."],
  [/binary_not_found|not_found|ENOENT/i, "unreachable", "This coding tool is not installed."],
];
function openFailure(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const [, code, text] = toolCodes.find(([pattern]) => pattern.test(message)) ?? [
    undefined,
    "unreachable",
    "The coding tool did not start.",
  ];
  return new InferenceError(code, "refused", text);
}
const transcript = (turns: InferenceTurn[]) =>
  `Earlier in this conversation:\n\n${turns
    .map((turn) => `${turn.role === "user" ? "User" : "Assistant"}: ${turn.text}`)
    .join("\n\n")}\n\n---\n\n`;

interface Turn {
  onText(delta: string): void;
  text: boolean;
  produced: string;
  started: boolean;
  limited: boolean;
  signIn: boolean;
  usage?: QuickUsage;
  tools?: QuickToolHooks | undefined;
  calls: Map<string, QuickToolCall>;
  done(status: "completed" | "failed" | "interrupted", error?: string): void;
}
interface Warm {
  key: string;
  conversationId: string;
  session: AgentSession;
  /** The last reply this session gave, so a follow-up only sends the new message. */
  last?: { question: string; reply: string };
  turn?: Turn | undefined;
  usedAt: number;
}

export function toolInference(options: {
  runtime: QuickToolRuntime;
  definition(tool: QuickTool): AgentDefinition | undefined;
  idleMs?: number;
}) {
  const warm = new Map<string, Warm>();
  const idleMs = options.idleMs ?? 10 * 60_000;
  const retire = (entry: Warm) => {
    if (warm.get(entry.key) === entry) warm.delete(entry.key);
    void entry.session.close().catch(() => {});
  };
  const sweep = setInterval(() => {
    for (const entry of warm.values())
      if (!entry.turn && Date.now() - entry.usedAt > idleMs) retire(entry);
  }, 60_000);
  sweep.unref();
  const definition = (tool: QuickTool) => {
    const value = options.definition(tool);
    if (!value)
      throw new InferenceError("unreachable", "refused", "This coding tool is not set up.");
    return value;
  };
  const instructions = (base: string, tools: boolean) =>
    `${base}\nAnswer directly in this conversation. ${tools ? withTools : noTools}`;
  /** Allows reads, asks the person about the rest, and declines everything when tools are off. */
  const answer = async (
    entry: Warm,
    interaction: InteractionDraft,
    tools: QuickToolHooks | undefined,
  ) => {
    const request = tools ? quickRequest(interaction, tools.allowed) : undefined;
    const decision: QuickDecision = !tools
      ? { decision: "deny" }
      : request
        ? await tools.ask(request).catch(() => ({ decision: "deny" as const }))
        : { decision: "allow" };
    try {
      await entry.session.respond(interaction.id, {
        ...nativeAnswer(interaction, decision),
        ...(!request ? { automatic: true } : {}),
      });
    } catch {
      // A form whose schema needs fields cannot be accepted empty; decline it instead.
      await entry.session
        .respond(interaction.id, nativeAnswer(interaction, { decision: "deny" }))
        .catch(() => {});
    }
  };
  /** Reads events for the life of the session and routes them to the current turn. */
  const pump = async (entry: Warm) => {
    try {
      for await (const event of entry.session.events()) {
        const turn = entry.turn;
        if (event.t === "interaction.requested") {
          void answer(entry, event.interaction, turn?.tools);
          continue;
        }
        if (!turn) continue;
        if (event.t === "tool.started" || event.t === "tool.done") {
          const prior = turn.calls.get(event.itemId);
          const call: QuickToolCall | undefined =
            event.t === "tool.started"
              ? {
                  id: event.itemId,
                  name: event.name.slice(0, 200),
                  kind: event.kind,
                  ...(event.title ? { title: event.title.slice(0, 300) } : {}),
                  status: "running",
                }
              : prior && { ...prior, status: event.status };
          if (call && turn.calls.size < 100) {
            turn.calls.set(call.id, call);
            turn.tools?.onCall(call);
          }
          continue;
        }
        if (event.t === "turn.started") turn.started = true;
        else if (event.t === "text.delta") {
          turn.text = true;
          turn.produced += event.text;
          turn.onText(event.text);
        } else if (event.t === "message.done" && event.phase === "final" && !turn.text) {
          turn.text = Boolean(event.text);
          turn.produced += event.text;
          turn.onText(event.text);
        } else if (event.t === "usage.updated")
          turn.usage = {
            ...(event.usage.inputTokens !== undefined
              ? { inputTokens: event.usage.inputTokens }
              : {}),
            ...(event.usage.outputTokens !== undefined
              ? { outputTokens: event.usage.outputTokens }
              : {}),
            ...(event.usage.reasoningTokens !== undefined
              ? { reasoningTokens: event.usage.reasoningTokens }
              : {}),
          };
        else if (event.t === "status") {
          if (event.state === "rate_limited") turn.limited = true;
          if (event.state === "auth_required") turn.signIn = true;
        } else if (event.t === "turn.done") turn.done(event.status, event.error?.message);
      }
    } catch {}
    entry.turn?.done("failed", "The coding tool stopped.");
    retire(entry);
  };
  const acquire = async (tool: QuickTool, request: InferenceRequest) => {
    const conversationId = request.conversationId ?? randomUUID();
    const tools = Boolean(request.tools);
    const off = [...(request.tools?.off() ?? [])].sort();
    // A server setting change opens a new session, since a session's tools are fixed at launch.
    const key = `${tool}:${conversationId}:${request.model}:${tools ? `tools:${off.join(",")}` : "plain"}`;
    const existing = warm.get(key);
    const previous = request.turns.at(-2);
    const question = request.turns.at(-3);
    if (
      existing &&
      !existing.turn &&
      existing.last &&
      previous?.role === "assistant" &&
      previous.text === existing.last.reply &&
      question?.text === existing.last.question
    )
      return { entry: existing, input: request.turns.at(-1)?.text ?? "" };
    if (existing) retire(existing);
    // One live session per conversation: a model change starts a new one.
    for (const entry of warm.values())
      if (entry.conversationId === conversationId && !entry.turn) retire(entry);
    let session: AgentSession;
    try {
      session = await options.runtime.open(definition(tool), {
        conversationId,
        model: request.model,
        instructions: instructions(request.instructions, tools),
        tools,
        ...(off.length ? { off } : {}),
      });
    } catch (error) {
      throw error instanceof InferenceError ? error : openFailure(error);
    }
    const entry: Warm = { key, conversationId, session, usedAt: Date.now() };
    warm.set(key, entry);
    void pump(entry);
    const earlier = request.turns.slice(0, -1);
    return {
      entry,
      input: `${earlier.length ? transcript(earlier) : ""}${request.turns.at(-1)?.text ?? ""}`,
    };
  };
  const adapter = (tool: QuickTool): InferenceAdapter => ({
    async listModels() {
      let session: AgentSession | undefined;
      try {
        session = await options.runtime.open(definition(tool), {
          conversationId: `models-${randomUUID()}`,
          instructions: "",
          tools: false,
        });
        return (session.capabilities.models.list ?? []).map((model) => ({
          id: model.id,
          label: model.name,
          efforts: session?.capabilities.effort ?? [],
          source: "discovered" as const,
        }));
      } catch (error) {
        throw error instanceof InferenceError ? error : openFailure(error);
      } finally {
        await session?.close().catch(() => {});
      }
    },
    async stream(request) {
      const { entry, input } = await acquire(tool, request);
      let finish!: (status: "completed" | "failed" | "interrupted", error?: string) => void;
      const settled = new Promise<{ status: string; error?: string | undefined }>((resolve) => {
        finish = (status, error) => resolve({ status, error });
      });
      const turn: Turn = {
        onText: request.onText,
        text: false,
        produced: "",
        started: false,
        limited: false,
        signIn: false,
        tools: request.tools,
        calls: new Map(),
        done: (status, error) => {
          if (entry.turn === turn) entry.turn = undefined;
          finish(status, error);
        },
      };
      entry.turn = turn;
      const abort = () => void entry.session.interrupt().catch(() => turn.done("interrupted"));
      request.signal.addEventListener("abort", abort, { once: true });
      try {
        try {
          await entry.session.send([{ type: "text", text: input }], "queue");
        } catch (error) {
          entry.turn = undefined;
          retire(entry);
          throw openFailure(error);
        }
        const { status, error } = await settled;
        entry.usedAt = Date.now();
        const admitted = turn.started || turn.text;
        if (status === "completed" && turn.text && !request.signal.aborted) {
          entry.last = { question: request.turns.at(-1)?.text ?? "", reply: turn.produced };
          return turn.usage ? { usage: turn.usage } : {};
        }
        retire(entry);
        if (request.signal.aborted || status === "interrupted")
          throw new InferenceError("cancelled", "ambiguous", "Stopped.");
        if (turn.limited)
          throw new InferenceError(
            "quota_exhausted",
            turn.text ? "ambiguous" : "refused",
            "This coding tool's usage limit was reached.",
          );
        if (turn.signIn)
          throw new InferenceError(
            "sign_in_required",
            "refused",
            "Sign in to this coding tool on the Mac.",
          );
        throw new InferenceError(
          status === "completed" ? "empty_reply" : "provider_error",
          admitted ? "ambiguous" : "refused",
          error ?? "The coding tool did not answer.",
        );
      } finally {
        request.signal.removeEventListener("abort", abort);
        if (request.conversationId?.startsWith("router-")) retire(entry);
      }
    },
  });
  return {
    adapter,
    async close() {
      clearInterval(sweep);
      await Promise.all([...warm.values()].map((entry) => entry.session.close().catch(() => {})));
      warm.clear();
      await options.runtime.close();
    },
  };
}
