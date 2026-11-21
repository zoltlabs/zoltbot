import { messageReactionsKey } from "@zoltbot/protocol";
import { expect, it, vi } from "vitest";
import { createClient } from "./client";
import { FakeTransport } from "./fake";
import { withReactions } from "./reactions";
import type { TranscriptRow } from "./timeline";

it("shows the owner's and the agent's reactions on their messages", async () => {
  const rows = [{ id: "a", kind: "user", text: "Fix it" }] as TranscriptRow[];
  const snapshot = {
    seq: 1,
    counters: {},
    entities: {
      settings: [
        {
          key: messageReactionsKey("chat"),
          value: [
            { itemId: "a", actor: "agent", emoji: "👀", at: "" },
            { itemId: "a", actor: "owner", emoji: "👍", at: "" },
          ],
        },
      ],
    },
  };
  expect(withReactions(snapshot, "chat", rows)[0]?.reactions).toEqual({ agent: "👀", owner: "👍" });
  expect(withReactions(snapshot, "other", rows)).toBe(rows);
});

it("saves the owner's reaction in sample mode", async () => {
  const client = createClient(new FakeTransport({ replyDelayMs: 1 }));
  await vi.waitFor(() => expect(client.getState().status).toBe("online"));
  const call = client.getState().call;
  const params = { threadId: "thread-meal-search", itemId: "item-1" };
  expect(await call("message.react", { ...params, emoji: "🎉" })).toMatchObject({
    reactions: [{ itemId: "item-1", actor: "owner", emoji: "🎉" }],
  });
  expect(await call("message.react", { ...params, emoji: null })).toEqual({ reactions: [] });
  client.stop();
});
