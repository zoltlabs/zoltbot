import { describe, expect, it } from "vitest";
import { quoteText, replyQuote, splitQuote, withQuote } from "./reply-quote.js";

it("quotes an agent message's words", () => {
  const items = [{ id: "m1", kind: "message", body: { text: "First line\n\nSecond" } }];
  expect(replyQuote(items, "m1")).toEqual({ text: "> First line\n>\n> Second", images: [] });
});

it("quotes the owner's words and brings their pictures", () => {
  const items = [
    {
      id: "u1",
      kind: "user",
      body: {
        input: [
          { type: "text", text: "Look at this" },
          { type: "image", path: "/tmp/a.png", mimeType: "image/png" },
          { type: "file", path: "/tmp/b.pdf" },
        ],
      },
    },
  ];
  expect(replyQuote(items, "u1")).toEqual({
    text: "> Look at this",
    images: [{ type: "image", path: "/tmp/a.png", mimeType: "image/png" }],
  });
});

it("cuts long quotes, skips missing messages and joins the reply", () => {
  const quoted = quoteText("x".repeat(400));
  expect(quoted).toHaveLength(302);
  expect(quoted.endsWith("…")).toBe(true);
  expect(replyQuote([], "gone")).toBeUndefined();
  expect(withQuote("> a", "b")).toBe("> a\n\nb");
  expect(withQuote("", "b")).toBe("b");
  expect(withQuote("> a", " ")).toBe("> a");
});

describe("splitQuote", () => {
  it("splits a leading quote from the reply", () => {
    expect(splitQuote("> Use the beta build\n>\n> today\n\nWhy?")).toEqual({
      quote: "Use the beta build\n\ntoday",
      rest: "Why?",
    });
    expect(splitQuote("> Only the quote")).toEqual({ quote: "Only the quote", rest: "" });
  });

  it("leaves other messages alone", () => {
    expect(splitQuote("Plain words")).toBeUndefined();
    expect(splitQuote("> quote\nno blank line")).toBeUndefined();
    expect(splitQuote(">not a quote")).toBeUndefined();
    expect(splitQuote(">\n\nreply")).toBeUndefined();
  });
});

it("quotes only the words under a quoted reply", () => {
  expect(quoteText("> Earlier\n\nNewer words")).toBe("> Newer words");
});

it("quotes the inner quote of a reply that has no words of its own", () => {
  expect(quoteText("> Earlier")).toBe("> Earlier");
});
