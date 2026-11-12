import { expect, it } from "vitest";
import { completionReceipt } from "./completion-data.js";
import type { Row } from "./types.js";

const turn = { id: "t", threadId: "chat", status: "completed" };
const tool = (id: string, status: string, kind = "execute", extra: Row = {}): Row => ({
  id,
  threadId: "chat",
  turnId: "t",
  kind: "tool",
  seq: Number(id),
  body: { kind, title: "test", status, ...extra },
});
it("summarizes recorded file and command outcomes without inventing tests or publication", () => {
  const receipt = completionReceipt(
    {
      turn: [turn],
      item: [
        tool("1", "error"),
        tool("2", "ok"),
        tool("3", "ok", "edit", {
          diffs: [
            { path: "a", patch: "+one" },
            { path: "a", patch: "+two" },
          ],
        }),
        { ...tool("4", "ok"), turnId: "old" },
        {
          kind: "message",
          threadId: "chat",
          turnId: "t",
          body: { text: "100 tests passed and pushed" },
        },
      ],
    },
    "chat",
  );
  expect(receipt.summary).toBe("1 file changed · 1 command completed");
  expect(receipt.action).toBe("changes");
  expect(receipt.failed).toBe(0);
});
it("retains unresolved failures and omits generic completion for ordinary answers", () => {
  expect(completionReceipt({ turn: [turn], item: [tool("1", "error")] }, "chat").summary).toBe(
    "1 step failed",
  );
  expect(completionReceipt({ turn: [turn] }, "chat").visible).toBe(false);
  expect(
    completionReceipt({ turn: [{ ...turn, status: "running" }], item: [tool("1", "ok")] }, "chat")
      .visible,
  ).toBe(false);
});
