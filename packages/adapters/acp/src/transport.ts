import type { OpenOptions, ProbeResult } from "@zoltbot/adapters-sdk";
import type { AgentDefinition } from "@zoltbot/protocol";

/** Supplied by the daemon supervisor. Adapters never own process spawning policy. */
export interface AcpTransport {
  input: ReadableStream<Uint8Array>;
  output: WritableStream<Uint8Array>;
  closed: Promise<void>;
  close(): Promise<void>;
}
export interface AcpHost {
  connect(definition: AgentDefinition, options: OpenOptions): Promise<AcpTransport>;
  probe(definition: AgentDefinition): Promise<ProbeResult>;
}
