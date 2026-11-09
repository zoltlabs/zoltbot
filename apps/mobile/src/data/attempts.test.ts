import { describe, expect, it } from "vitest";
import { actionKey, attemptBook } from "./attempts.js";
import { FakeTransport } from "./fake.js";
import { OutcomeUnknownError } from "./transport.js";

describe("attempts", () => {
  it("replays the first command after an unknown outcome and forgets it after an answer", async () => {
    let n = 0;
    const book = attemptBook(() => `id-${++n}`);
    const sent: [unknown, string][] = [];
    const fail = (params: unknown, id: string) => {
      sent.push([params, id]);
      return Promise.reject(new OutcomeUnknownError("Your Mac did not answer in time."));
    };
    await expect(book.run("send", { text: "a" }, fail)).rejects.toThrow("in time");
    expect(book.pending("send")).toBe(true);
    // The retry carries the first params and id, even if the caller built new ones.
    await book.run("send", { text: "b" }, async (params, id) => sent.push([params, id]));
    expect(sent).toEqual([
      [{ text: "a" }, "id-1"],
      [{ text: "a" }, "id-1"],
    ]);
    expect(book.pending("send")).toBe(false);
    await expect(
      book.run("send", {}, () => Promise.reject(new Error("invalid_params"))),
    ).rejects.toThrow();
    expect(book.pending("send")).toBe(false);
  });

  it("keys an action by method and params regardless of key order", () => {
    expect(actionKey("x", { a: 1, b: [2, { c: 3, d: 4 }] })).toBe(
      actionKey("x", { b: [2, { d: 4, c: 3 }], a: 1 }),
    );
    expect(actionKey("x", { a: 1 })).not.toBe(actionKey("y", { a: 1 }));
  });

  it("gets the same refusals and receipts from the fake as from zoltd", async () => {
    const fake = new FakeTransport({ replyDelayMs: 1 });
    fake.start({ status() {}, event() {} });
    await expect(fake.call("diagnostics.export", {})).rejects.toThrow(/^mac_only/);
    await expect(fake.call("workspace.diff", { threadId: "t" })).rejects.toThrow(
      /method_unavailable|Bad params/,
    );
    const input = [{ type: "text", text: "Hi" }];
    const first = await fake.call(
      "turn.send",
      { threadId: "thread-rate-limits", input, mode: "queue" },
      "c-1",
    );
    expect(first).toMatchObject({ disposition: "queued" });
    const again = await fake.call(
      "turn.send",
      { threadId: "thread-rate-limits", input, mode: "queue" },
      "c-1",
    );
    expect(again).toEqual(first);
    fake.stop();
  });
});
