import { tmpdir } from "node:os";
import { type SDKUserMessage, query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import { AsyncQueue, type ModelList, type OpenOptions } from "@zoltbot/adapters-sdk";
import type { AgentDefinition } from "@zoltbot/protocol";
import type { ClaudeHost } from "./host.js";
import { claudeModelOptions } from "./session-capabilities.js";
import { HostProcess } from "./transport.js";
import { record } from "./usage.js";

/**
 * Starts Claude without a prompt, reads the models its initialize result offers and stops it.
 * Session persistence is off and no prompt is ever sent, so Claude writes no transcript.
 */
export async function claudeListModels(
  host: ClaudeHost,
  definition: AgentDefinition,
  timeoutMs: number,
): Promise<ModelList> {
  const cwd = tmpdir();
  // The host needs open options to connect; this run has no thread and no host tools.
  const options: OpenOptions = {
    mode: "new",
    cwd,
    identity: { agentId: `models:${definition.id}`, threadId: `models:${definition.id}` },
    permissionProfile: "read_only",
    hostMcp: { url: "", token: "" },
  };
  const prompts = new AsyncQueue<SDKUserMessage>();
  const { command, args } = definition.launch;
  let spawned: HostProcess | undefined;
  const query = sdkQuery({
    prompt: prompts,
    options: {
      pathToClaudeCodeExecutable: command,
      cwd,
      env: { ...definition.launch.env },
      persistSession: false,
      strictMcpConfig: true,
      spawnClaudeCodeProcess: (spawn) => {
        spawned = new HostProcess(
          (launch) => host.connect(definition, options, launch),
          { command, cwd },
          args,
          spawn,
        );
        return spawned;
      },
    },
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const initialized = record(
      await Promise.race([
        query.initializationResult(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("request_timeout")), timeoutMs);
        }),
      ]).catch((error: unknown) => {
        throw spawned?.failure ?? error;
      }),
    );
    return claudeModelOptions(Array.isArray(initialized.models) ? initialized.models : []);
  } finally {
    clearTimeout(timer);
    prompts.close();
    query.close();
    await spawned?.exited;
  }
}
