import { describe, expect, it } from "vitest";
import { insertedText, LONG_PASTE_CHARS, pastedAttachment, takeLongPaste } from "./long-paste";

describe("long paste on the phone", () => {
  it("keeps a paste of exactly 2,000 characters inline", () => {
    const words = "x".repeat(LONG_PASTE_CHARS);
    expect(takeLongPaste("hi ", `hi ${words}`)).toEqual({ draft: `hi ${words}` });
  });

  it("takes a longer paste out of the draft, wherever it lands", () => {
    const words = `${"y".repeat(LONG_PASTE_CHARS)}\nend`;
    expect(takeLongPaste("see  below", `see ${words} below`)).toEqual({
      draft: "see  below",
      pasted: words,
    });
  });

  it("catches a long paste over a selected word", () => {
    const words = "z".repeat(LONG_PASTE_CHARS + 1);
    expect(takeLongPaste("x".repeat(600), `x${words}x`)).toEqual({ draft: "xx", pasted: words });
  });

  it("finds the inserted text between unchanged ends", () => {
    expect(insertedText("abcd", "abXYcd")).toEqual({ start: 2, text: "XY" });
  });

  it("labels the attachment with its line count", () => {
    const attachment = pastedAttachment("p1", "one\ntwo\nthree");
    expect(attachment.label).toBe("Pasted text · 3 lines");
    expect(attachment.part).toEqual({ type: "text", text: "one\ntwo\nthree" });
  });
});
