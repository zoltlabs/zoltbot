import { describe, expect, it } from "vitest";
import { appendOutput, plainOutput } from "./terminal";

describe("terminal output on the phone", () => {
  it("removes escape codes and keeps only the last redraw of a line", () => {
    expect(plainOutput("\u001b[32mok\u001b[0m\r\n")).toBe("ok\n");
    expect(plainOutput("\u001b]0;title\u0007$ ls\r\n")).toBe("$ ls\n");
    expect(plainOutput("10%\r50%\r100%\r\ndone")).toBe("100%\ndone");
    expect(plainOutput("a\u0007b")).toBe("ab");
  });

  it("keeps the newest output, cut at a line break", () => {
    const line = `${"x".repeat(99)}\n`;
    let shown = "";
    for (let index = 0; index < 1000; index++) shown = appendOutput(shown, line);
    expect(shown.length).toBeLessThanOrEqual(64 * 1024);
    expect(shown.startsWith("x")).toBe(true);
    expect(shown.endsWith(line)).toBe(true);
  });
});
