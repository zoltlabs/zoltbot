// C18: agent files up to 100 MB stream to the window, checked as they go.
import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { ARTIFACT_FILE_BYTES, artifactProtocol, verified } from "./artifact-protocol";

const sha = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");

function streamOf(bytes: Uint8Array, piece = 1024 * 1024) {
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) return controller.close();
      controller.enqueue(bytes.subarray(offset, offset + piece));
      offset += piece;
    },
  });
}

async function drain(stream: ReadableStream<Uint8Array>) {
  let total = 0;
  for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) total += chunk.length;
  return total;
}

it("passes good bytes and errors on a changed or longer file", async () => {
  const bytes = new Uint8Array(3 * 1024 * 1024).fill(9);
  expect(await drain(streamOf(bytes).pipeThrough(verified(sha(bytes), bytes.length)))).toBe(
    bytes.length,
  );
  const changed = bytes.slice();
  changed[5] = 1;
  await expect(
    drain(streamOf(changed).pipeThrough(verified(sha(bytes), bytes.length))),
  ).rejects.toThrow("artifact_blob_corrupt");
  await expect(
    drain(streamOf(bytes).pipeThrough(verified(sha(bytes), bytes.length - 1))),
  ).rejects.toThrow("artifact_blob_corrupt");
});

it("streams a file over the old 25 MB limit and refuses one over 100 MB", async () => {
  const big = new Uint8Array(30 * 1024 * 1024).fill(3);
  const files = [
    { path: "index.html", bytes: 5, hash: sha(Buffer.from("hello")), mime: "text/html" },
    { path: "video.mp4", bytes: big.length, hash: sha(big), mime: "video/mp4" },
    {
      path: "huge.bin",
      bytes: ARTIFACT_FILE_BYTES + 1,
      hash: "a".repeat(64),
      mime: "application/octet-stream",
    },
  ];
  const text = JSON.stringify({ version: 1, entry: "index.html", files, screens: [] });
  const id = sha(Buffer.from(text));
  let buffered = 0;
  const handler = artifactProtocol({
    origin: "http://127.0.0.1:5173",
    asset: async (kind) => {
      if (kind === "blob") buffered++;
      return Buffer.from(text);
    },
    blob: async () => streamOf(big),
  });
  // A file over 100 MB never passes the manifest check, so it's never served.
  await expect(handler.prepare(id)).rejects.toThrow();
  const fits = JSON.stringify({
    version: 1,
    entry: "index.html",
    files: files.slice(0, 2),
    screens: [],
  });
  const fitsId = sha(Buffer.from(fits));
  const streaming = artifactProtocol({
    origin: "http://127.0.0.1:5173",
    asset: async (kind) => {
      if (kind === "blob") buffered++;
      return Buffer.from(fits);
    },
    blob: async () => streamOf(big),
  });
  await streaming.prepare(fitsId);
  const response = await streaming.handle(new Request(`zoltbot-artifact://${fitsId}/video.mp4`));
  expect(response.status).toBe(200);
  expect(response.headers.get("Content-Length")).toBe(String(big.length));
  expect(await drain(response.body as ReadableStream<Uint8Array>)).toBe(big.length);
  // Nothing was read whole through the buffered path.
  expect(buffered).toBe(0);
});

it("streams only kinds a page can't run; HTML and SVG are checked whole first", async () => {
  const { streamable } = await import("./artifact-protocol");
  expect(["video/mp4", "image/png", "audio/mpeg", "application/zip"].every(streamable)).toBe(true);
  expect(
    ["text/html", "image/svg+xml", "text/javascript", "text/markdown", "application/json"].some(
      streamable,
    ),
  ).toBe(false);
  const page = Buffer.from("<script>run()</script>");
  const files = [{ path: "index.html", bytes: page.length, hash: sha(page), mime: "text/html" }];
  const fits = JSON.stringify({ version: 1, entry: "index.html", files, screens: [] });
  const id = sha(Buffer.from(fits));
  let streamed = 0;
  const handler = artifactProtocol({
    origin: "http://127.0.0.1:5173",
    asset: async (kind) =>
      kind === "manifest" ? Buffer.from(fits) : Buffer.from("<script>evil()</script>"),
    blob: async () => {
      streamed++;
      return streamOf(page);
    },
  });
  await handler.prepare(id);
  // The swapped page fails its hash before any of it is served.
  expect((await handler.handle(new Request(`zoltbot-artifact://${id}/index.html`))).status).toBe(
    404,
  );
  expect(streamed).toBe(0);
});
