import type { Supervisor } from "./supervisor.js";

/** One connection owns one supervised process lifetime. Session recovery opens a new connection. */
export function supervisedTransport(supervisor: Supervisor) {
  let controller: ReadableStreamDefaultController<Uint8Array>;
  let ended = false;
  let resolveClosed: () => void = () => {};
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  const encoder = new TextEncoder();
  const line = (value: string) => {
    if (ended) return;
    controller.enqueue(encoder.encode(`${value}\n`));
    if ((controller.desiredSize ?? 0) <= 0) supervisor.pauseOutput();
  };
  const finish = () => {
    if (!ended) {
      ended = true;
      controller.close();
    }
    supervisor.off("stdout", line);
    resolveClosed();
  };
  const fault = () => {
    if (!ended) {
      ended = true;
      controller.error(new Error("provider_transport_error"));
    }
  };
  const input = new ReadableStream<Uint8Array>(
    {
      start(c) {
        controller = c;
      },
      pull() {
        supervisor.resumeOutput();
      },
      async cancel() {
        ended = true;
        await supervisor.close();
      },
    },
    { highWaterMark: 65536, size: (chunk) => chunk.byteLength },
  );
  const decoder = new TextDecoder();
  let buffer = "";
  const output = new WritableStream<Uint8Array>({
    async write(chunk) {
      buffer += decoder.decode(chunk, { stream: true });
      if (Buffer.byteLength(buffer) > 1048576) throw new Error("frame_too_large");
      while (buffer.includes("\n")) {
        const index = buffer.indexOf("\n");
        const record = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (record) await supervisor.writeAsync(record);
      }
    },
    async close() {
      await supervisor.close();
    },
    async abort() {
      await supervisor.close();
    },
  });
  supervisor.on("stdout", line);
  supervisor.once("exit", finish);
  supervisor.once("fault", fault);
  supervisor.start();
  return {
    input,
    output,
    closed,
    async close() {
      supervisor.resumeOutput();
      await supervisor.close();
      supervisor.off("fault", fault);
      finish();
    },
  };
}
