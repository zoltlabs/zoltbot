import type { OpenOptions, ProbeResult } from "@zoltbot/adapters-sdk";
import type { AgentDefinition } from "@zoltbot/protocol";
export interface PiTransport {
  input: ReadableStream<Uint8Array>;
  output: WritableStream<Uint8Array>;
  closed: Promise<void>;
  close(): Promise<void>;
}
export interface PiLaunch {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}
export interface PiFile {
  path: string;
  dispose(): Promise<void>;
}
export interface PiHost {
  probe(definition: AgentDefinition): Promise<ProbeResult>;
  config(content: unknown): Promise<PiFile>;
  extension(source: string, sha256: string): Promise<PiFile>;
  connect(
    definition: AgentDefinition,
    options: OpenOptions,
    launch: PiLaunch,
  ): Promise<PiTransport>;
}
