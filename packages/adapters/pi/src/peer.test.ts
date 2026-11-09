import { expect, it } from "vitest";
import { PiPeer } from "./peer.js";

function setup(reply: (value: Record<string, unknown>) => unknown) {
  let controller: ReadableStreamDefaultController<Uint8Array>;
  let done = () => {};
  const closed = new Promise<void>((resolve) => {
    done = resolve;
  });
  const peer = new PiPeer(
    {
      input: new ReadableStream({
        start(value) {
          controller = value;
        },
      }),
      output: new WritableStream({
        write(bytes) {
          const response = reply(JSON.parse(new TextDecoder().decode(bytes)));
          if (response)
            controller.enqueue(new TextEncoder().encode(`${JSON.stringify(response)}\n`));
        },
      }),
      closed,
      async close() {
        done();
      },
    },
    25,
  );
  return peer;
}
it("correlates command responses and keeps Unicode separators inside one record", async () => {
  const peer = setup((request) => ({
    type: "response",
    command: request.type,
    id: request.id,
    success: true,
    data: { text: "a\u2028b\u2029c" },
  }));
  try {
    expect(await peer.request("get_state", {})).toEqual({ text: "a\u2028b\u2029c" });
  } finally {
    await peer.close();
  }
});
it("rejects malformed known replies without leaving the matching request pending", async () => {
  const peer = setup((request) => ({
    type: "response",
    command: request.type,
    id: request.id,
    success: true,
    data: 42,
  }));
  try {
    await expect(peer.request("get_state", {})).rejects.toThrow("provider_protocol_error");
  } finally {
    await peer.close();
  }
});
it("bounds a hung state probe", async () => {
  const peer = setup(() => undefined);
  try {
    await expect(peer.request("get_state", {})).rejects.toThrow("request_timeout");
  } finally {
    await peer.close();
  }
});
