import { describe, expect, it } from "vitest";
import { linkPreviewsOn, linksIn } from "./link-preview.js";

describe("linksIn", () => {
  it("finds links in order without duplicates or trailing punctuation", () => {
    expect(
      linksIn(
        "See https://example.com/a, then (https://example.com/b). Again: https://example.com/a!",
      ),
    ).toEqual(["https://example.com/a", "https://example.com/b"]);
  });
  it("ignores other schemes and broken addresses", () => {
    expect(linksIn("ftp://example.com file:///etc/passwd http://")).toEqual([]);
  });
  it("finds links inside Markdown", () => {
    expect(linksIn("[docs](https://example.com/docs)")).toEqual(["https://example.com/docs"]);
  });
});

describe("linkPreviewsOn", () => {
  it("is on unless turned off", () => {
    expect(linkPreviewsOn(undefined)).toBe(true);
    expect(linkPreviewsOn(true)).toBe(true);
    expect(linkPreviewsOn(false)).toBe(false);
  });
});
