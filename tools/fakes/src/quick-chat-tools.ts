import type { AgentSession } from "@zoltbot/adapters-sdk";
import type { AgentDefinition, AgentEvent, Capabilities } from "@zoltbot/protocol";
import type { QuickToolRuntime } from "../../../packages/daemon/src/quick-chat/tools.js";

// A deterministic stand-in for the person's installed coding tools. Behavior is chosen by the
// message text, so tests never start a real tool or use anyone's plan.
//
//   contains "limit"    the tool reports a usage limit before answering
//   contains "lookup"   the tool reads with a service tool (Quick Chat allows it without asking)
//   contains "tool"     the tool asks to send an email first and waits for the answer
//   contains "slow"     streams a delta every 100 ms for 5 s (for cancellation)
//   otherwise           replies "Echo: <message>" in two deltas with usage

export const fakeToolModels: Record<string, { id: string; name: string }[]> = {
  antigravity: [
    { id: "gemini-3.8-pro", name: "Gemini 3.8 Pro" },
    { id: "gemini-3-flash", name: "Gemini 3 Flash" },
    { id: "gemini-3.8-flash", name: "Gemini 3.8 Flash" },
  ],
  claude: [
    { id: "default", name: "Default (recommended)" },
    { id: "sonnet", name: "Sonnet 5.5" },
    { id: "haiku", name: "Haiku 5.5" },
  ],
  codex: [
    { id: "gpt-6.1-sol", name: "GPT-6.1-Sol" },
    { id: "gpt-5.6-terra", name: "GPT-5.6-Terra" },
    { id: "gpt-6.1-terra", name: "GPT-6.1 Terra" },
  ],
};
export interface FakeToolLog {
  opens: {
    tool: string;
    conversationId: string;
    model?: string;
    instructions: string;
    tools: boolean;
    off?: string[];
  }[];
  sends: { tool: string; conversationId: string; text: string }[];
  declined: string[];
  allowed: { id: string; automatic: boolean }[];
  closed: number;
}
export function fakeToolRuntime(options: { signedOut?: string[] } = {}) {
  const log: FakeToolLog = { opens: [], sends: [], declined: [], allowed: [], closed: 0 };
  const runtime: QuickToolRuntime = {
    async open(definition: AgentDefinition, input) {
      if (options.signedOut?.includes(definition.id)) throw new Error("auth_required");
      log.opens.push({ tool: definition.id, ...input });
      const queue: AgentEvent[] = [];
      let wake: (() => void) | undefined;
      let closed = false;
      let interrupted = false;
      const push = (event: AgentEvent) => {
        queue.push(event);
        wake?.();
      };
      let turn = 0;
      const answers = new Map<string, (allowed: boolean) => void>();
      const ask = (turnId: string, toolName: string, toolKind: "read" | "other") =>
        new Promise<boolean>((resolve) => {
          const id = `ask-${turnId}`;
          answers.set(id, resolve);
          push({
            t: "interaction.requested",
            interaction: {
              id,
              agentId: "quick-chat",
              threadId: input.conversationId,
              type: "approval",
              title: toolKind === "read" ? "Read search data" : "Send an email",
              context: { toolName, toolKind },
              items: [
                {
                  id: "a",
                  prompt: "Allow?",
                  choices: [{ id: "allow_once" }, { id: "reject_once" }],
                },
              ],
              chain: [],
              urgency: "blocking",
            },
          });
        });
      const session: AgentSession = {
        capabilities: {
          models: { selectable: true, list: fakeToolModels[definition.id] ?? [] },
        } as unknown as Capabilities,
        nativeId: `native-${input.conversationId}`,
        async *events() {
          while (!closed) {
            const next = queue.shift();
            if (next) yield next;
            else await new Promise<void>((done) => (wake = done));
          }
        },
        async send(value) {
          const text = value.map((part) => ("text" in part ? part.text : "")).join("");
          log.sends.push({ tool: definition.id, conversationId: input.conversationId, text });
          const turnId = `turn-${++turn}`;
          const question = text.split("---\n\n").at(-1)?.split("</context>\n\n").at(-1) ?? text;
          void (async () => {
            await Promise.resolve();
            if (text.includes("limit")) {
              push({ t: "status", state: "rate_limited", detail: "Usage limit" });
              push({ t: "turn.done", turnId, status: "failed" });
              return;
            }
            push({ t: "turn.started", turnId });
            let suffix = "";
            if (text.includes("lookup")) {
              push({
                t: "tool.started",
                turnId,
                itemId: "call-1",
                name: "mcp__seoskill__seo_report",
                kind: "other",
                input: {},
                title: "Search Console report",
              });
              await ask(turnId, "mcp__seoskill__seo_report", "read");
              push({ t: "tool.done", itemId: "call-1", status: "ok" });
            } else if (text.includes("tool")) {
              suffix = (await ask(turnId, "mcp__gmail__send_message", "other"))
                ? " (sent)"
                : " (not sent)";
            }
            if (text.includes("slow")) {
              for (let i = 0; i < 50 && !interrupted; i++) {
                push({ t: "text.delta", turnId, itemId: "m", text: `${i} ` });
                await new Promise((done) => setTimeout(done, 100));
              }
              push({ t: "turn.done", turnId, status: interrupted ? "interrupted" : "completed" });
              return;
            }
            const reply = `Echo: ${question}${suffix}`;
            push({ t: "text.delta", turnId, itemId: "m", text: reply.slice(0, 6) });
            push({ t: "text.delta", turnId, itemId: "m", text: reply.slice(6) });
            push({ t: "usage.updated", turnId, usage: { inputTokens: 20, outputTokens: 6 } });
            push({ t: "turn.done", turnId, status: "completed" });
          })();
          return { disposition: "started" };
        },
        async interrupt() {
          interrupted = true;
        },
        async respond(id, answer) {
          if (answer.action === "accept")
            log.allowed.push({ id, automatic: answer.automatic === true });
          else log.declined.push(id);
          answers.get(id)?.(answer.action === "accept");
          answers.delete(id);
        },
        async setModel() {},
        async setMode() {},
        async compact() {},
        async rename() {},
        async contextUsage() {
          return undefined;
        },
        async close() {
          if (closed) return;
          closed = true;
          log.closed++;
          wake?.();
        },
      };
      return session;
    },
    async close() {},
  };
  return { runtime, log };
}
/** Agent definitions for the three tools, as the store holds them after detection. */
export const fakeToolDefinitions = ["antigravity", "claude", "codex"].map((id) => ({
  id,
  displayName: id,
  adapter: id === "antigravity" ? "acp" : id,
  binaryNames: [],
  versionCommand: [],
  launch: { command: "fake", args: [], env: {} },
  testedVersions: "fixture",
  defaults: { permissionProfile: "read_only" },
  staticCapabilities: {},
  nativeSessionRoots: [],
  experimental: false,
}));
