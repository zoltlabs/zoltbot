import { expect, it } from "vitest";
import { pinnable, pinnedRows } from "./pins";
import type { TranscriptRow } from "./timeline";
import type { Snapshot } from "./transport";

const row = (id: string, extra: Partial<TranscriptRow> = {}): TranscriptRow => ({
  id,
  kind: "message",
  text: id,
  streaming: false,
  ...extra,
});

it("lists pins still in the chat, newest first", () => {
  const snapshot = {
    entities: {
      settings: [
        {
          key: "chat.pins.chat",
          value: [
            { itemId: "a", pinnedAt: "2026-11-20T10:00:00Z" },
            { itemId: "gone", pinnedAt: "2026-11-20T12:00:00Z" },
            { itemId: "b", pinnedAt: "2026-11-20T11:00:00Z" },
          ],
        },
      ],
    },
  } as unknown as Snapshot;
  expect(pinnedRows(snapshot, "chat", [row("a"), row("b")]).map((r) => r.id)).toEqual(["b", "a"]);
});

it("pins only plain messages", () => {
  expect(pinnable(row("a", { turnId: "t" }))).toBe(true);
  expect(pinnable(row("n"))).toBe(false);
  expect(pinnable(row("s", { turnId: "t", streaming: true }))).toBe(false);
  expect(pinnable(row("t", { kind: "tool" }))).toBe(false);
  expect(pinnable(row("q", { kind: "user", queued: true }))).toBe(false);
  expect(pinnable(row("x", { aside: { threadId: "a", question: true } }))).toBe(false);
});
