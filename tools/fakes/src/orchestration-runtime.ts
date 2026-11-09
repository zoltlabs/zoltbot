import { type AgentSession, AsyncQueue, type SendReceipt } from "@zoltbot/adapters-sdk";
import type { AgentEvent, UserInput } from "@zoltbot/protocol";
import { referenceCapabilities } from "./capabilities.js";

/** A phase session whose test supplies the events for each execution. */
export class PhaseFakeSession implements AgentSession {
  readonly capabilities = referenceCapabilities;
  readonly eventsQueue = new AsyncQueue<AgentEvent>();
  constructor(readonly nativeId: string) {
    void this.eventsQueue.push({
      t: "session.ready",
      nativeId,
      capabilities: this.capabilities,
      providerVersion: "phase-fake-1",
    });
  }
  events() {
    return this.eventsQueue;
  }
  async send(_input: UserInput): Promise<SendReceipt> {
    throw Error("phase_send_not_configured");
  }
  async interrupt() {}
  async respond() {}
  async setModel() {}
  async setMode() {}
  async compact() {}
  async rename() {}
  async contextUsage() {
    return undefined;
  }
  async close() {
    this.eventsQueue.close();
  }
}
