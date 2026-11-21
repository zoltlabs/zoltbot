import { describe, expect, it } from "vitest";
import type { ConversationMessage } from "../../../shared/ipc";
import { lastMessage } from "./mini-chat";

const message = (patch: Partial<ConversationMessage>): ConversationMessage =>
  ({
    id: "m",
    author: "assistant",
    text: "Hi",
    createdAt: "",
    status: "completed",
    ...patch,
  }) as ConversationMessage;

describe("lastMessage", () => {
  it("picks the newest message with text, skipping hidden, system and empty ones", () => {
    const messages = [
      message({ id: "1", text: "First answer" }),
      message({ id: "2", author: "user", text: "Thanks" }),
      message({ id: "3", hidden: true, text: "Hidden" }),
      message({ id: "4", author: "system", text: "Joined" }),
      message({ id: "5", text: "  " }),
    ];
    expect(lastMessage(messages)?.id).toBe("2");
    expect(lastMessage([])).toBeNull();
  });
});
