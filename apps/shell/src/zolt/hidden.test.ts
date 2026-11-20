import { describe, expect, it } from "vitest";
import type { ConversationMessage } from "../shared/ipc";
import type { Snapshot } from "./daemon-client";
import { withHidden } from "./hidden";
import { previewText } from "./mapping";

const snapshot = (value: unknown) =>
  ({ entities: { settings: [{ key: "chat.hidden.t1", value }] } }) as unknown as Snapshot;
const message = (id: string) => ({ id, author: "agent", text: id }) as ConversationMessage;

describe("previewText", () => {
  it("skips hidden messages", () => {
    const items = [
      { id: "a", kind: "message", body: { text: "kept" } },
      { id: "b", kind: "message", body: { text: "secret" } },
    ];
    expect(previewText(items, new Set(["b"]))).toBe("kept");
  });
});

describe("withHidden", () => {
  it("marks only the chat's hidden messages", () => {
    const out = withHidden(snapshot(["b"]), "t1", [message("a"), message("b")]);
    expect(out.map((m) => m.hidden ?? false)).toEqual([false, true]);
    expect(withHidden(snapshot(["b"]), "t2", [message("b")])[0]?.hidden).toBeUndefined();
    expect(withHidden(snapshot("bad"), "t1", [message("b")])[0]?.hidden).toBeUndefined();
  });
});
