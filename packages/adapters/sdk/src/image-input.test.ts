import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { materializeImages } from "./image-input.js";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aE9sAAAAASUVORK5CYII=",
  "base64",
);
it("materializes selected image paths without changing exact text or plain file references", async () => {
  mkdirSync(".cache/tests", { recursive: true });
  const root = mkdtempSync(path.resolve(".cache/tests/images-"));
  try {
    const file = path.join(root, "fixture.png");
    writeFileSync(file, png);
    const input = [
      { type: "text" as const, text: "  Exact text\n" },
      { type: "image" as const, path: file, mimeType: "image/png" },
      { type: "file" as const, path: file },
    ];
    expect(await materializeImages(input)).toEqual([
      input[0],
      { type: "image", base64: png.toString("base64"), mimeType: "image/png" },
      input[2],
    ]);
    expect(input[1]).not.toHaveProperty("base64");
    await expect(
      materializeImages([{ type: "image", path: file, mimeType: "image/jpeg" }]),
    ).rejects.toThrow("invalid_image_format");
    await expect(
      materializeImages([{ type: "image", path: path.join(root, "missing.png") }]),
    ).rejects.toThrow("attachment_unavailable");
    writeFileSync(file, Buffer.alloc(512 * 1024 + 1));
    await expect(materializeImages([{ type: "image", path: file }])).rejects.toThrow(
      "image_budget_exceeded",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
it("bounds aggregate image bytes and the native serialized input before any native write", async () => {
  const image = {
    type: "image" as const,
    mimeType: "image/png",
    base64: Buffer.concat([png, Buffer.alloc(300 * 1024)]).toString("base64"),
  };
  await expect(materializeImages([image, image])).rejects.toThrow("image_budget_exceeded");
  await expect(
    materializeImages([
      { type: "text", text: "x".repeat(900 * 1024) },
      { type: "image", base64: png.toString("base64"), mimeType: "image/png" },
    ]),
  ).rejects.toThrow("native_input_too_large");
  expect(await materializeImages([{ type: "text", text: "ordinary" }])).toEqual([
    { type: "text", text: "ordinary" },
  ]);
});
