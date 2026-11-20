import { describe, expect, it } from "vitest";
import type { ConversationMessage } from "../shared/ipc";
import { asideThreads } from "./asides";
import type { Snapshot } from "./daemon-client";
import { relatedThreads } from "./manager-cards";
import { pinnedMessages } from "./pins";

const snapshot = (entities: Record<string, unknown[]>) => ({ entities }) as unknown as Snapshot;
const message = (id: string, extra: Partial<ConversationMessage> = {}) =>
  ({ id, author: "assistant", text: `text ${id}`, ...extra }) as ConversationMessage;

describe("pinnedMessages", () => {
  it("lists pins still in the chat, newest pin first", () => {
    const state = snapshot({
      settings: [
        {
          key: "chat.pins.t1",
          value: [
            { itemId: "a", pinnedAt: "2026-01-01" },
            { itemId: "b", pinnedAt: "2026-02-01" },
            { itemId: "gone", pinnedAt: "2026-03-01" },
          ],
        },
      ],
    });
    const out = pinnedMessages(state, "t1", [message("a", { author: "user" }), message("b")]);
    expect(out).toEqual([
      { messageId: "b", author: "assistant", text: "text b" },
      { messageId: "a", author: "user", text: "text a" },
    ]);
    expect(pinnedMessages(state, "t2", [message("a")])).toEqual([]);
  });
});

describe("chats refreshed by a change", () => {
  it("refreshes the chat whose pins row changed", () => {
    expect(relatedThreads(snapshot({}), "settings", { key: "chat.pins.t1" })).toEqual(["t1"]);
    expect(relatedThreads(snapshot({}), "settings", { key: "theme" })).toEqual([]);
  });

  it("refreshes the chat an aside was asked in, and the chat a continued aside left", () => {
    const state = snapshot({
      thread: [{ id: "aside", kind: "aside", fork: { sourceThreadId: "main" } }],
    });
    expect(asideThreads(state, "item", {}, "aside")).toEqual(["main"]);
    expect(asideThreads(state, "item", {}, "main")).toEqual([]);
    expect(
      asideThreads(state, "thread", { id: "x", fork: { sourceThreadId: "main" } }, "x"),
    ).toEqual(["main"]);
  });
});
