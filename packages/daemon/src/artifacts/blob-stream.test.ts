// C18: agent files stream out of the store, up to 100 MB, checked on the way.
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { blobStream } from "./blob-stream.js";
import { artifactLimits } from "./intake.js";

let directory = "";
beforeEach(async () => {
  directory = await realpath(await mkdtemp(path.join(tmpdir(), "blob-stream-")));
  await mkdir(path.join(directory, "blobs"), { mode: 0o700 });
});
afterEach(() => rm(directory, { recursive: true, force: true }));

const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

async function drain(stream: NodeJS.ReadableStream) {
  let total = 0;
  let pieces = 0;
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    total += chunk.length;
    pieces++;
  }
  return { total, pieces };
}

it("allows one file up to 100 MB", () => {
  expect(artifactLimits.file).toBe(100 * 1024 * 1024);
});

it("streams a file bigger than the old 25 MB limit in pieces", async () => {
  const bytes = Buffer.alloc(30 * 1024 * 1024, 5);
  const hash = sha(bytes);
  await writeFile(path.join(directory, "blobs", hash), bytes);
  const blob = await blobStream(directory, hash);
  expect(blob.size).toBe(bytes.length);
  const { total, pieces } = await drain(blob.stream);
  expect(total).toBe(bytes.length);
  expect(pieces).toBeGreaterThan(1);
});

it("errors when the stored bytes don't match their name", async () => {
  const hash = sha(Buffer.from("original"));
  await writeFile(path.join(directory, "blobs", hash), "tampered");
  const blob = await blobStream(directory, hash);
  await expect(drain(blob.stream)).rejects.toThrow("artifact_blob_corrupt");
});

it("refuses a file over 100 MB without reading it", async () => {
  const hash = "c".repeat(64);
  const file = path.join(directory, "blobs", hash);
  await writeFile(file, "");
  await truncate(file, artifactLimits.file + 1);
  await expect(blobStream(directory, hash)).rejects.toThrow("artifact_file_denied");
});

it("streams an empty file", async () => {
  const bytes = Buffer.alloc(0);
  const hash = sha(bytes);
  await writeFile(path.join(directory, "blobs", hash), bytes);
  expect((await drain((await blobStream(directory, hash)).stream)).total).toBe(0);
});
