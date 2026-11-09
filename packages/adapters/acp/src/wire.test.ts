import { expect, it, vi } from "vitest";
import { safeWire } from "./wire.js";

it("rejects malformed known notifications before SDK diagnostics can print their payload", async () => {
  const error = vi.fn();
  const input = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        new TextEncoder().encode(
          `${JSON.stringify({
            jsonrpc: "2.0",
            method: "session/update",
            params: {
              sessionId: "s",
              update: {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: 3 },
                private: "seeded-secret",
              },
            },
          })}\n`,
        ),
      );
      controller.close();
    },
  });
  const stream = safeWire({ input, output: new WritableStream<Uint8Array>() }, error);
  await expect(stream.readable.getReader().read()).rejects.toThrow("provider_protocol_error");
  expect(error).toHaveBeenCalledWith("provider_protocol_error");
  expect(JSON.stringify(error.mock.calls)).not.toContain("seeded-secret");
});
