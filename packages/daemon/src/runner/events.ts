import { AsyncQueue } from "@zoltbot/adapters-sdk";
import type { RuntimeObservation, RuntimeObservationSink } from "../runtime-observer.js";

/** Backpressure applies only while a runner consumer is attached. Local tasks attach none. */
export class RunnerEvents {
  private readonly readers = new Set<AsyncQueue<RuntimeObservation>>();
  private closed = false;
  scope(threadId: string, sessionId: string): RuntimeObservationSink {
    return {
      active: () => !this.closed && this.readers.size > 0,
      emit: async (event, context) => {
        if (this.closed) return;
        const observation = { threadId, sessionId, event, ...context };
        await Promise.all(
          [...this.readers].map((reader) => reader.push(structuredClone(observation))),
        );
      },
    };
  }
  async *events(): AsyncIterable<RuntimeObservation> {
    if (this.closed) return;
    const queue = new AsyncQueue<RuntimeObservation>();
    this.readers.add(queue);
    try {
      for await (const event of queue) yield event;
    } finally {
      this.readers.delete(queue);
      queue.close();
    }
  }
  close() {
    this.closed = true;
    for (const reader of this.readers) reader.close();
  }
}
