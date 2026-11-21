import { expect, it } from "vitest";
import {
  MAX_MESSAGE_REACTIONS,
  reactionsByItem,
  readMessageReactions,
  withMessageReaction,
} from "./message-reactions.js";

const at = "2026-11-20T00:00:00.000Z";

it("keeps one reaction per message and actor", () => {
  let value = withMessageReaction([], { itemId: "a", actor: "owner", emoji: "👍", at });
  value = withMessageReaction(value, { itemId: "a", actor: "agent", emoji: "👀", at });
  value = withMessageReaction(value, { itemId: "a", actor: "agent", emoji: "✅", at });
  expect(reactionsByItem(value).get("a")).toEqual({ owner: "👍", agent: "✅" });
  value = withMessageReaction(value, { itemId: "a", actor: "owner", emoji: null, at });
  expect(reactionsByItem(value).get("a")).toEqual({ agent: "✅" });
});

it("drops malformed rows and emoji outside the set", () => {
  expect(
    readMessageReactions([
      { itemId: "a", actor: "owner", emoji: "💩", at },
      { itemId: "", actor: "owner", emoji: "👍", at },
      { itemId: "b", actor: "someone", emoji: "👍", at },
      null,
      { itemId: "c", actor: "agent", emoji: "👀" },
    ]),
  ).toEqual([{ itemId: "c", actor: "agent", emoji: "👀", at: "" }]);
  expect(readMessageReactions("nope")).toEqual([]);
});

it("drops the oldest reactions past the limit", () => {
  let value: unknown = [];
  for (let i = 0; i <= MAX_MESSAGE_REACTIONS; i++)
    value = withMessageReaction(value, { itemId: `m${i}`, actor: "owner", emoji: "👍", at });
  const kept = readMessageReactions(value);
  expect(kept).toHaveLength(MAX_MESSAGE_REACTIONS);
  expect(kept[0]?.itemId).toBe("m1");
});
