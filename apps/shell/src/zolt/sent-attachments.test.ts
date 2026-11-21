import { describe, expect, it } from "vitest";
import { sentAttachmentSource, sentAttachments } from "./sent-attachments";

const item = (input: unknown[], extra: Record<string, unknown> = {}) => ({
  id: "msg:1",
  kind: "user",
  threadId: "t",
  body: { input, ...extra },
});

describe("sent attachments", () => {
  it("lists the owner's files and pictures with a preview kind from the name", () => {
    const sent = item([
      { type: "text", text: "see" },
      { type: "file", path: "/tmp/does-not-exist/sales.csv" },
      { type: "image", path: "/tmp/does-not-exist/shot.png", mimeType: "image/png" },
      { type: "file", path: "relative/notes.md" },
      { type: "image", base64: "aGVsbG8=", mimeType: "image/png" },
    ]);
    const cards = sentAttachments(sent);
    expect(cards.map((c) => [c.id, c.name, c.previewKind, c.kind])).toEqual([
      ["item:msg:1:1", "sales.csv", "csv", "file"],
      ["item:msg:1:2", "shot.png", "image", "image"],
      ["item:msg:1:3", "notes.md", "none", "file"],
      ["item:msg:1:4", "Photo", "image", "image"],
    ]);
    expect(cards[0]?.previewUrl).toBe("openbot-attachment://file/item%3Amsg%3A1%3A1");
    expect(cards[2]?.previewUrl).toBeNull();
  });

  it("never lists or serves parts of an agent's message", () => {
    const fromAgent = item([{ type: "file", path: "/etc/hosts" }], { origin: "agent" });
    expect(sentAttachments(fromAgent)).toEqual([]);
    expect(sentAttachmentSource([fromAgent], "item:msg:1:0")).toBeUndefined();
  });

  it("finds a part's bytes only through its own message", () => {
    const sent = item([
      { type: "text", text: "x" },
      { type: "file", path: "/tmp/a.svg" },
      { type: "image", base64: "aGVsbG8=", mimeType: "image/png" },
      { type: "image", base64: "PHN2Zz4=", mimeType: "image/svg+xml" },
    ]);
    expect(sentAttachmentSource([sent], "item:msg:1:1")).toEqual({
      path: "/tmp/a.svg",
      mimeType: "image/svg+xml",
    });
    const photo = sentAttachmentSource([sent], "item:msg:1:2");
    expect(photo && "bytes" in photo && Buffer.from(photo.bytes).toString()).toBe("hello");
    for (const id of ["item:msg:1:0", "item:msg:1:3", "item:msg:1:9", "item:other:1", "draft-1"])
      expect(sentAttachmentSource([sent], id)).toBeUndefined();
  });
});
