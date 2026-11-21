import { chatCallsKey } from "@zoltbot/protocol";
import { describe, expect, it, vi } from "vitest";
import { createClient } from "./client";
import { FakeTransport } from "./fake";
import type { TranscriptRow } from "./timeline";
import type { Snapshot } from "./transport";
import { newReplies, withCalls } from "./voice";

const row = (id: string, extra: Partial<TranscriptRow> = {}): TranscriptRow => ({
  id,
  kind: "message",
  text: `Reply ${id}`,
  streaming: false,
  ...extra,
});

describe("phone voice", () => {
  it("places a finished call where it ended", () => {
    const snapshot = {
      entities: {
        item: [
          { id: "a", threadId: "t", createdAt: "2026-11-21T10:00:00.000Z" },
          { id: "b", threadId: "t", createdAt: "2026-11-21T10:05:00.000Z" },
        ],
        settings: [
          {
            key: chatCallsKey("t"),
            value: [
              { id: "c1", startedAt: "2026-11-21T10:01:00.000Z", endedAt: "2026-11-21T10:03:15Z" },
            ],
          },
        ],
      },
    } as unknown as Snapshot;
    const rows = withCalls(snapshot, "t", [row("a"), row("b")]);
    expect(rows.map((r) => r.id)).toEqual(["a", "call:c1", "b"]);
    expect(rows[1]?.notice).toEqual({ kind: "call", text: "Call", meta: "2:15" });
  });

  it("reads each new reply once it finishes, never history or notes", () => {
    const seen = new Set(["old"]);
    const rows = [row("old"), row("you", { kind: "user" }), row("new", { streaming: true })];
    expect(newReplies(rows, seen)).toEqual([]);
    rows[2] = row("new");
    rows.push(row("note", { progress: { threadId: "t" } }));
    expect(newReplies(rows, seen).map((r) => r.id)).toEqual(["new"]);
    expect(newReplies(rows, seen)).toEqual([]);
  });
});

describe("phone voice in sample mode", () => {
  it("logs a call in its chat as zoltd does", async () => {
    const fake = new FakeTransport({ replyDelayMs: 1 });
    const client = createClient(fake);
    await vi.waitFor(() => expect(client.getState().status).toBe("online"));
    const threadId = String(client.getState().snapshot.entities.thread?.[0]?.id);
    await client.getState().call("voice.call.log", {
      threadId,
      startedAt: "2026-11-21T10:00:00.000Z",
      endedAt: "2026-11-21T10:00:42.000Z",
    });
    await vi.waitFor(() => {
      const row = client
        .getState()
        .snapshot.entities.settings?.find((s) => s.key === chatCallsKey(threadId));
      expect(row?.value).toEqual([
        expect.objectContaining({ startedAt: "2026-11-21T10:00:00.000Z" }),
      ]);
    });
    await expect(
      client.getState().call("voice.speak", { text: "Hi", voiceId: "x" }),
    ).rejects.toThrow("voice_not_set_up");
  });
});
