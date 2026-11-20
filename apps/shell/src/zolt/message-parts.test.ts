import { describe, expect, it } from "vitest";
import { messageParts } from "./message-parts";

const items = [
  {
    id: "asked",
    kind: "user",
    body: {
      input: [
        { type: "text", text: "Look at this" },
        { type: "image", path: "/tmp/shot.png", mimeType: "image/png" },
      ],
    },
  },
  { id: "answer", kind: "message", body: { text: "The build is green." } },
];

describe("messageParts", () => {
  it("sends a reply's quote ahead of the words", () => {
    expect(messageParts(items, "answer", "Ship it?", [])).toEqual([
      { type: "text", text: "> The build is green.\n\nShip it?" },
    ]);
  });

  it("sends the quoted message's pictures with the reply", () => {
    expect(
      messageParts(items, "asked", "", [
        { path: "/tmp/notes.txt", summary: { kind: "file" } as never },
      ]),
    ).toEqual([
      { type: "text", text: "> Look at this" },
      { type: "image", path: "/tmp/shot.png", mimeType: "image/png" },
      { type: "file", path: "/tmp/notes.txt" },
    ]);
  });

  it("sends only the words when the quoted message is gone or there is no reply", () => {
    expect(messageParts(items, "missing", "Hello", [])).toEqual([{ type: "text", text: "Hello" }]);
    expect(messageParts(items, null, "Hello", [])).toEqual([{ type: "text", text: "Hello" }]);
  });
});
