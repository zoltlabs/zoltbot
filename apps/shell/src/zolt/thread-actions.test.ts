// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS } from "../shared/ipc";
import type { DaemonClient } from "./daemon-client";
import { threadUnread } from "./mapping";
import { parseThreadAction, threadActionHandlers, threadCommand } from "./thread-actions";

describe("thread actions", () => {
  it("maps each action to its daemon command", () => {
    expect(threadCommand({ botId: "c", action: "pin" })).toEqual([
      "thread.pin",
      { id: "c", pinned: true },
    ]);
    expect(threadCommand({ botId: "c", action: "unpin" })).toEqual([
      "thread.pin",
      { id: "c", pinned: false },
    ]);
    expect(threadCommand({ botId: "c", action: "markUnread" })[0]).toBe("thread.markUnread");
    expect(threadCommand({ botId: "c", action: "markRead" })[0]).toBe("thread.markRead");
    expect(threadCommand({ botId: "c", action: "archive" })).toEqual([
      "thread.archive",
      { id: "c", confirmed: true },
    ]);
    expect(threadCommand({ botId: "c", action: "unarchive" })[0]).toBe("thread.unarchive");
    expect(threadCommand({ botId: "c", action: "mute" })).toEqual([
      "settings.set",
      { key: "chat.muted.c", value: true },
    ]);
    expect(threadCommand({ botId: "c", action: "unmute" })).toEqual([
      "settings.set",
      { key: "chat.muted.c", value: false },
    ]);
  });

  it("clears Zolt and says whether it is writing a handoff first", async () => {
    expect(threadCommand({ botId: "z", action: "clear" })).toEqual(["chief.clear", {}]);
    const call = vi
      .fn()
      .mockResolvedValueOnce({ threadId: "z2", previousThreadId: "z", handedOff: false })
      .mockResolvedValueOnce({ threadId: "z", handingOff: true });
    const handlers = threadActionHandlers({ call } as unknown as DaemonClient);
    const clear = () => handlers[IPC_CHANNELS.agentThreadAction]?.({ botId: "z", action: "clear" });
    expect(await clear()).toEqual({ threadId: "z2" });
    expect(await clear()).toEqual({ threadId: "z", handingOff: true });
  });

  it("rejects unknown actions and missing chats", () => {
    expect(() => parseThreadAction({ botId: "c", action: "delete" })).toThrow();
    expect(() => parseThreadAction({ action: "pin" })).toThrow();
  });

  it("sends the command with a fresh command id", async () => {
    const call = vi.fn(async () => ({}));
    const handlers = threadActionHandlers({ call } as unknown as DaemonClient);
    await handlers[IPC_CHANNELS.agentThreadAction]?.({ botId: "c", action: "archive" });
    expect(call).toHaveBeenCalledWith(
      "thread.archive",
      { id: "c", confirmed: true },
      expect.any(String),
    );
  });
});

describe("threadUnread", () => {
  const snapshot = (endedAt: string) =>
    ({ entities: { turn: [{ threadId: "c", status: "completed", endedAt }] } }) as never;
  it("counts a turn that ended after the last read, or a manual mark", () => {
    expect(threadUnread(snapshot("2026-01-02"), { id: "c", lastReadAt: "2026-01-01" })).toBe(true);
    expect(threadUnread(snapshot("2026-01-01"), { id: "c", lastReadAt: "2026-01-02" })).toBe(false);
    expect(threadUnread(snapshot("2026-01-02"), { id: "c", wakeUnreadAt: "2026-01-03" })).toBe(
      true,
    );
  });

  it("treats a chat never read here as read", () => {
    expect(threadUnread(snapshot("2026-01-02"), { id: "c" })).toBe(false);
  });
});
