import { readFileSync } from "node:fs";
import { ndJsonStream, type Stream } from "@agentclientprotocol/sdk";
import { Ajv2020 } from "ajv/dist/2020.js";

const schema = JSON.parse(
  readFileSync(
    new URL(import.meta.resolve("@agentclientprotocol/sdk/schema/v1/schema.json")),
    "utf8",
  ),
);
const ajv = new Ajv2020({ strict: false, validateFormats: false });
const completedElicitation = ajv.compile({
  $defs: schema.$defs,
  $ref: "#/$defs/CompleteElicitationNotification",
});
const notification = ajv.compile({ $defs: schema.$defs, $ref: "#/$defs/SessionNotification" });

export function safeWire(
  transport: { input: ReadableStream<Uint8Array>; output: WritableStream<Uint8Array> },
  onError: (code: string) => void,
): Stream {
  const raw = ndJsonStream(transport.output, transport.input, { maxMessageBytes: 1048576 });
  const requests = new Set<string | number>();
  const writer = raw.writable.getWriter();
  return {
    writable: new WritableStream({
      async write(message) {
        if ("method" in message && "id" in message && message.id !== null) requests.add(message.id);
        await writer.write(message);
      },
      async close() {
        await writer.close();
      },
      async abort(error) {
        await writer.abort(error);
      },
    }),
    readable: raw.readable.pipeThrough(
      new TransformStream({
        transform(message, controller) {
          const object = message && typeof message === "object" && !Array.isArray(message);
          if (
            !object ||
            message.jsonrpc !== "2.0" ||
            ("method" in message &&
              (typeof message.method !== "string" ||
                (message.method === "session/update" && !notification(message.params)) ||
                (message.method === "elicitation/complete" &&
                  !completedElicitation(message.params))))
          ) {
            onError("provider_protocol_error");
            controller.error(new Error("provider_protocol_error"));
            return;
          }
          if (!("method" in message)) {
            const hasResult = "result" in message;
            const hasError = "error" in message;
            if (hasResult === hasError) {
              onError("provider_protocol_error");
              controller.error(new Error("provider_protocol_error"));
              return;
            }
            if (!("id" in message) || message.id === null || !requests.delete(message.id)) return;
          }
          controller.enqueue(message);
        },
      }),
    ),
  };
}
