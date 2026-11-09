import { expect, it } from "vitest";
import { Redactor } from "./logging.js";

it("redacts nested secret fields and known values while preserving usage counts", () => {
  const r = new Redactor(["canary-value"]);
  expect(
    r.value({
      password: "unknown-private",
      nested: [{ api_key: "unknown-key", authorization: "Bearer x" }],
      text: "before canary-value after",
      inputTokens: 42,
      cacheReadTokens: 40,
      injectedTokens: 2,
    }),
  ).toEqual({
    password: "[redacted]",
    nested: [{ api_key: "[redacted]", authorization: "[redacted]" }],
    text: "before [redacted] after",
    inputTokens: 42,
    cacheReadTokens: 40,
    injectedTokens: 2,
  });
});

it("redacts provider account metadata while preserving API key variable references", () => {
  const r = new Redactor();
  expect(
    r.value({
      account: { email: "private@example.invalid" },
      username: "private-user",
      auth: { apiKeyEnv: "SERVICE_API_KEY" },
    }),
  ).toEqual({
    account: "[redacted]",
    username: "[redacted]",
    auth: { apiKeyEnv: "SERVICE_API_KEY" },
  });
});
it("withholds private prefixes split across arbitrary display chunks", () => {
  const secret = "synthetic-private-stream-value";
  const redactor = new Redactor([secret]);
  const text = `before ${secret} after`;
  let accumulated = "",
    previous = "";
  for (const char of text) {
    accumulated += char;
    const visible = redactor.streamText(accumulated);
    expect(visible.startsWith(previous)).toBe(true);
    expect(visible).not.toContain("synthetic");
    previous = visible;
  }
  expect(redactor.streamText(accumulated, true)).toBe("before [redacted] after");
});
it("handles overlapping secrets and flushes an unfinished nonsecret suffix", () => {
  const redactor = new Redactor(["aba", "abacab", "1"]);
  let previous = "";
  for (const text of ["a", "ab", "aba", "abac", "abaca", "abacab", "abacab x"]) {
    const next = redactor.streamText(text);
    expect(next.startsWith(previous)).toBe(true);
    previous = next;
  }
  expect(redactor.streamText("abacab x", true)).toBe("[redacted] x");
  expect(redactor.streamText("not ab", true)).toBe("not ab");
  expect(redactor.streamText("1", true)).toBe("[redacted]");
});
it("omits image payload bytes in nested native image formats without mutating the native frame", () => {
  const original = {
    content: [
      {
        type: "image",
        source: { type: "base64", data: "synthetic-image-bytes", media_type: "image/png" },
      },
      { type: "image", data: "synthetic-image-bytes", mimeType: "image/png" },
      { type: "image", url: "data:image/png;base64,synthetic-image-bytes" },
    ],
  };
  const safe = new Redactor().value(original);
  expect(JSON.stringify(safe)).not.toContain("synthetic-image-bytes");
  expect(JSON.stringify(safe)).toContain("image/png");
  expect(original.content[0]?.source?.data).toBe("synthetic-image-bytes");
});
