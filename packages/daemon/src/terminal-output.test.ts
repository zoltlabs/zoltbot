import { expect, it } from "vitest";
import { TerminalOutputBuffer } from "./terminal-output.js";

it("bounds retained bytes, lines and chunk count and advances valid Unicode cursors", () => {
  const buffer = new TerminalOutputBuffer();
  buffer.append("🧪".repeat(200000));
  let cursor = 0,
    count = 0;
  do {
    const result = buffer.read(cursor);
    expect(result.data).not.toContain("�");
    expect(Buffer.byteLength(result.data)).toBeLessThanOrEqual(32768);
    cursor = result.offset;
    count++;
  } while (cursor < buffer.offset);
  expect(count).toBeLessThanOrEqual(16);
  for (let i = 0; i < 6000; i++) buffer.append("synthetic\n");
  const tail = buffer.read(0);
  expect(tail.truncated).toBe(true);
  expect(tail.data).not.toContain("🧪");
});
it("reads only new output with full scrollback retained", () => {
  const buffer = new TerminalOutputBuffer();
  buffer.append("x".repeat(500000));
  const before = buffer.offset;
  const started = performance.now();
  for (let i = 0; i < 10000; i++) {
    buffer.append("x");
    expect(buffer.read(buffer.offset - 1).data).toBe("x");
  }
  expect(buffer.offset).toBe(before + 10000);
  expect(performance.now() - started).toBeLessThan(5000);
});
