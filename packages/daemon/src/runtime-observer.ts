import type { AgentEvent } from "@zoltbot/protocol";
import type { Redactor } from "./logging.js";

export interface RuntimeObservationContext {
  itemId?: string;
  turnId?: string;
}
export interface RuntimeObservation extends RuntimeObservationContext {
  threadId: string;
  sessionId: string;
  event: AgentEvent;
}
export interface RuntimeObservationSink {
  active(): boolean;
  record?(event: AgentEvent, context: RuntimeObservationContext): void;
  recordTransient?(event: AgentEvent, context: RuntimeObservationContext): void;
  emit(event: AgentEvent, context: RuntimeObservationContext): Promise<void>;
}
/** Optional runner consumers see the same normalized identities and redacted output as the store. */
export class RuntimeObserver {
  private readonly streamed = new Map<string, string>();
  constructor(
    private readonly sink: RuntimeObservationSink | undefined,
    private readonly redactor: Redactor,
  ) {}
  get active(): boolean {
    return this.sink?.active() ?? false;
  }
  record(event: AgentEvent, context: RuntimeObservationContext = {}) {
    this.sink?.record?.(structuredClone(event), context);
  }
  async emit(event: AgentEvent, context: RuntimeObservationContext = {}) {
    if (!this.sink?.active()) return;
    await this.sink.emit(structuredClone(event), context);
    if ((event.t === "message.done" || event.t === "thought.done") && context.itemId)
      this.streamed.delete(context.itemId);
    if (event.t === "turn.done") this.streamed.clear();
  }
  async delta(
    event: Extract<AgentEvent, { t: "text.delta" | "thought.delta" }>,
    itemId: string,
    text: string,
  ) {
    if (!this.sink?.active()) return;
    const safe = this.redactor.streamText(text);
    const previous = this.streamed.get(itemId) ?? "";
    const delta = safe.startsWith(previous) ? safe.slice(previous.length) : "";
    this.streamed.set(itemId, safe);
    if (delta) {
      const observation = { ...event, text: delta },
        context = { itemId, turnId: event.turnId };
      this.sink.recordTransient?.(observation, context);
      await this.sink.emit(observation, context);
    }
  }
}
