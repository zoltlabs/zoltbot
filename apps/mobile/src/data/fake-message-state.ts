import {
  isReactionEmoji,
  messageHiddenKey,
  messagePinsKey,
  messageReactionsKey,
  withHiddenMessage,
  withMessagePin,
  withMessageReaction,
} from "@zoltbot/protocol";
import type { FakeRows } from "./fake-manage.js";
import type { Row } from "./transport.js";

/** Sample message state follows the same settings records as the daemon. */
export function answerMessageState(store: FakeRows, method: string, p: Row, now: string): unknown {
  switch (method) {
    case "message.pin":
    case "message.unpin": {
      // As zoltd (message-pins-api): one settings row per chat, newest pin first.
      store.find("thread", p.threadId);
      const key = messagePinsKey(String(p.threadId));
      const prior = store.rows("settings").find((row) => row.key === key)?.value;
      const pins = withMessagePin(prior, String(p.itemId), method === "message.pin", now);
      store.put("settings", { key, value: pins });
      return { pins };
    }
    case "message.hide":
    case "message.unhide": {
      // As zoltd (message-hidden-api): display only; the item itself is unchanged.
      store.find("thread", p.threadId);
      const key = messageHiddenKey(String(p.threadId));
      const prior = store.rows("settings").find((row) => row.key === key)?.value;
      const hidden = withHiddenMessage(prior, String(p.itemId), method === "message.hide");
      store.put("settings", { key, value: hidden });
      return { hidden };
    }
    case "message.react": {
      // As zoltd (message-reactions-api): the owner's reaction, in one settings row per chat.
      store.find("thread", p.threadId);
      const key = messageReactionsKey(String(p.threadId));
      const prior = store.rows("settings").find((row) => row.key === key)?.value;
      const emoji = isReactionEmoji(p.emoji) ? p.emoji : null;
      const reactions = withMessageReaction(prior, {
        itemId: String(p.itemId),
        actor: "owner",
        emoji,
        at: now,
      });
      store.put("settings", { key, value: reactions });
      return { reactions };
    }
    default:
      return undefined;
  }
}
