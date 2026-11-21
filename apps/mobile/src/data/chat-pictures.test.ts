import { expect, it } from "vitest";
import { chatPictures } from "./timeline";
import type { Snapshot } from "./transport";

const item = (id: string, seq: number, input: unknown[], extra: Record<string, unknown> = {}) => ({
  id,
  seq,
  threadId: "chat",
  kind: "user",
  body: { input, ...extra },
});

it("lists every picture the owner sent in the chat, oldest first", () => {
  const snapshot = {
    entities: {
      item: [
        item("later", 2, [{ type: "file", path: "/w/b.png" }]),
        item("first", 1, [
          { type: "text", text: "look" },
          { type: "image", base64: "AA==", mimeType: "image/png" },
          { type: "file", path: "/w/notes.csv" },
          { type: "file", path: "/w/a.JPG" },
        ]),
        item("agent", 3, [{ type: "file", path: "/w/c.png" }], { origin: "agent" }),
        { ...item("elsewhere", 4, [{ type: "file", path: "/w/d.png" }]), threadId: "other" },
      ],
    },
  } as unknown as Snapshot;
  expect(chatPictures(snapshot, "chat")).toEqual([
    { itemId: "first", part: 1, name: "Photo" },
    { itemId: "first", part: 3, name: "a.JPG" },
    { itemId: "later", part: 0, name: "b.png" },
  ]);
});
