// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { branchService, parseBranchRequest } from "./branch-service";
import type { DaemonClient } from "./daemon-client";
import { branchOrigin } from "./mapping";

describe("branch service", () => {
  it("previews and forks at the message's turn, reusing the attempt id", async () => {
    const call = vi.fn(async (method: string) =>
      method === "thread.forkPreview"
        ? { available: true, kind: "copied", copiedMessages: 3, omittedMessages: 0 }
        : { childThreadId: "child", state: "ready" },
    );
    const service = branchService({ call } as unknown as DaemonClient);
    const input = { botId: "chat", turnId: "turn-1", at: "after_turn" as const };
    expect(await service.preview(input)).toEqual({
      available: true,
      kind: "copied",
      copiedMessages: 3,
      omittedMessages: 0,
      reason: "",
    });
    expect(call).toHaveBeenCalledWith("thread.forkPreview", {
      id: "chat",
      boundary: { kind: "after_turn", turnId: "turn-1" },
    });
    const result = await service.branch({ ...input, title: "Chat (branch)", attemptId: "a1" });
    expect(result).toEqual({ botId: "child", ready: true, failed: false });
    expect(call).toHaveBeenLastCalledWith(
      "thread.fork",
      { id: "chat", title: "Chat (branch)", boundary: { kind: "after_turn", turnId: "turn-1" } },
      "a1",
    );
  });

  it("rejects requests without a turn or a known starting point", () => {
    expect(() =>
      parseBranchRequest({ botId: "c", at: "after_turn", title: "t", attemptId: "a" }),
    ).toThrow();
    expect(() =>
      parseBranchRequest({ botId: "c", turnId: "t1", at: "latest", title: "t", attemptId: "a" }),
    ).toThrow();
  });

  it("reads where a chat was branched from", () => {
    expect(
      branchOrigin({
        id: "child",
        fork: { sourceThreadId: "chat", boundary: { kind: "before_user", turnId: "turn-1" } },
      }),
    ).toEqual({ botId: "chat", turnId: "turn-1", at: "before_user" });
    expect(branchOrigin({ id: "chat" })).toBeUndefined();
    expect(
      branchOrigin({ id: "x", fork: { sourceThreadId: "chat", boundary: { kind: "latest" } } }),
    ).toBeUndefined();
  });
});
