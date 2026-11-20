import { describe, expect, it } from "vitest";
import { selectedWords, withAskQuote } from "./ask-about";

describe("Ask about this", () => {
  it("adds the quote after the draft, ready for a question", () => {
    expect(withAskQuote("", "the beta build")).toBe("> the beta build\n\n");
    expect(withAskQuote("First thought ", "two\nlines")).toBe(
      "First thought\n\n> two\n> lines\n\n",
    );
  });

  it("only takes words selected inside the transcript's messages", () => {
    // jsdom has no layout; the position isn't under test here.
    Range.prototype.getBoundingClientRect ??= () => new DOMRect();
    document.body.innerHTML = `
      <div id="root"><div class="message-shell"><p id="a">Ship the beta build today</p></div>
      <p id="outside">Not a message</p></div>
      <p id="elsewhere">Elsewhere</p>`;
    const root = document.getElementById("root") ?? undefined;
    const select = (id: string, from: number, to: number) => {
      const node = document.getElementById(id)?.firstChild;
      if (!node) throw Error("missing");
      const range = document.createRange();
      range.setStart(node, from);
      range.setEnd(node, to);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    };
    select("a", 9, 19);
    expect(selectedWords(root)?.text).toBe("beta build");
    select("outside", 0, 3);
    expect(selectedWords(root)).toBeUndefined();
    select("elsewhere", 0, 3);
    expect(selectedWords(root)).toBeUndefined();
    window.getSelection()?.removeAllRanges();
    expect(selectedWords(root)).toBeUndefined();
  });
});
