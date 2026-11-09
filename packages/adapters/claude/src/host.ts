import type { OpenOptions, ProbeResult } from "@zoltbot/adapters-sdk";
import type { AgentDefinition } from "@zoltbot/protocol";
export interface ClaudeTransport {
  input: ReadableStream<Uint8Array>;
  output: WritableStream<Uint8Array>;
  closed: Promise<void>;
  close(): Promise<void>;
}
export interface ClaudeLaunch {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}
export interface ClaudeHost {
  probe(definition: AgentDefinition): Promise<ProbeResult>;
  config(
    content: unknown,
    manifestId?: string,
  ): Promise<{ path: string; dispose(): Promise<void> }>;
  connect(
    definition: AgentDefinition,
    options: OpenOptions,
    launch: ClaudeLaunch,
  ): Promise<ClaudeTransport>;
}
