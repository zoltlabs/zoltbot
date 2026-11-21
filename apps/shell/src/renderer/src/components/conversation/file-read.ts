import { type DelimitedPreview, parseDelimited } from "@zoltbot/protocol";

/** Text read for a preview: at most this much of the file. */
export const PREVIEW_TEXT_BYTES = 8 * 1024 * 1024;

export class MissingFileError extends Error {}

/** Reads the start of a file, up to `limit` bytes, without loading the rest. */
export async function readTextCapped(
  url: string,
  limit = PREVIEW_TEXT_BYTES,
): Promise<{ text: string; cut: boolean }> {
  const response = await fetch(url);
  if (response.status === 404) throw new MissingFileError();
  if (!response.ok || !response.body) throw new Error("preview_unavailable");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let read = 0;
  let cut = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const room = limit - read;
    if (value.byteLength > room) {
      text += decoder.decode(value.subarray(0, room), { stream: true });
      cut = true;
      await reader.cancel();
      break;
    }
    read += value.byteLength;
    text += decoder.decode(value, { stream: true });
  }
  return { text: text + decoder.decode(), cut };
}

/** Parses in a worker when the window has one; tests and old runtimes parse here. */
export function parseInWorker(text: string, delimiter: "," | "\t"): Promise<DelimitedPreview> {
  if (typeof Worker === "undefined") return Promise.resolve(parseDelimited(text, delimiter));
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./delimited-worker.ts", import.meta.url), {
      type: "module",
    });
    worker.onmessage = (event: MessageEvent<DelimitedPreview>) => {
      worker.terminate();
      resolve(event.data);
    };
    worker.onerror = (event) => {
      worker.terminate();
      reject(new Error(event.message || "preview_unavailable"));
    };
    worker.postMessage({ text, delimiter });
  });
}
