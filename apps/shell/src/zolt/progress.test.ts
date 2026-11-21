import { describe, expect, it } from "vitest";
import type { ConversationMessage } from "../shared/ipc";
import type { Snapshot } from "./daemon-client";
import { withProgress } from "./progress";

const snapshot = (value: unknown) =>
  ({ entities: { settings: [{ key: "chat.progress.c1", value }] } }) as unknown as Snapshot;
const message = (id: string, createdAt: string) =>
  ({ id, author: "assistant", text: id, createdAt, status: "completed" }) as ConversationMessage;

describe("withProgress", () => {
  it("places each note at the time it was posted", () => {
    const messages = [message("asked", "10:00"), message("answer", "10:05")];
    const notes = [
      { id: "n1", turnId: "t", text: "Plan first", at: "10:01" },
      { id: "n2", turnId: "t", text: "Tests pass", at: "10:03" },
    ];
    const merged = withProgress(snapshot(notes), "c1", messages);
    expect(merged.map((m) => m.id)).toEqual(["asked", "progress:n1", "progress:n2", "answer"]);
    expect(merged[1]).toMatchObject({ progress: true, text: "Plan first" });
    expect(merged[1]?.turnId).toBeUndefined();
  });

  it("leaves chats without notes alone", () => {
    const messages = [message("a", "1")];
    expect(withProgress(snapshot(undefined), "c1", messages)).toBe(messages);
    expect(withProgress(snapshot([]), "other", messages)).toBe(messages);
  });
});
