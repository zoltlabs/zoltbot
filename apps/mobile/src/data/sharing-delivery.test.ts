import { describe, expect, it, vi } from "vitest";
import type { SharedDraft } from "./sharing.js";
import { deliverSharedDraft, SharedDraftSentError } from "./sharing-delivery.js";

const draft: SharedDraft = {
  version: 1,
  id: "draft",
  createdAt: "now",
  macId: "mac",
  recipientId: "recipient",
  text: "Link",
  images: [],
};
function operations() {
  return {
    save: vi.fn(async () => {}),
    destination: vi.fn(() => ({ id: "recipient", macId: "mac", threadId: "thread", name: "Main" })),
    send: vi.fn(async () => ({})),
    acknowledged: vi.fn(),
    markSent: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
  };
}
describe("shared draft delivery", () => {
  it("persists edits before sending, marks acknowledged delivery before deleting", async () => {
    const ops = operations();
    await expect(deliverSharedDraft(draft, "Edited", ops)).resolves.toBe("thread");
    expect(ops.send).toHaveBeenCalledWith("thread", [{ type: "text", text: "Edited" }]);
    expect(ops.save.mock.invocationCallOrder[0]).toBeLessThan(
      ops.destination.mock.invocationCallOrder[0] ?? 0,
    );
    expect(ops.send.mock.invocationCallOrder[0]).toBeLessThan(
      ops.acknowledged.mock.invocationCallOrder[0] ?? 0,
    );
    expect(ops.acknowledged.mock.invocationCallOrder[0]).toBeLessThan(
      ops.markSent.mock.invocationCallOrder[0] ?? 0,
    );
    expect(ops.markSent.mock.invocationCallOrder[0]).toBeLessThan(
      ops.remove.mock.invocationCallOrder[0] ?? 0,
    );
  });
  it("retains the draft and stops before networking if persistence fails", async () => {
    const ops = operations();
    ops.save.mockRejectedValueOnce(new Error("Storage unavailable"));
    await expect(deliverSharedDraft(draft, "Edited", ops)).rejects.toThrow("Storage unavailable");
    expect(ops.send).not.toHaveBeenCalled();
    expect(ops.remove).not.toHaveBeenCalled();
  });
  it("revalidates the destination after saving, blocking a Mac switch", async () => {
    const ops = operations();
    ops.destination.mockReturnValue({
      id: "recipient",
      macId: "other-mac",
      threadId: "thread",
      name: "Main",
    });
    await expect(deliverSharedDraft(draft, "Edited", ops)).rejects.toThrow("original Mac");
    expect(ops.send).not.toHaveBeenCalled();
  });
  it("keeps failed or uncertain sends for explicit review without donating or deleting", async () => {
    const ops = operations();
    ops.send.mockRejectedValueOnce(new Error("Connection dropped"));
    await expect(deliverSharedDraft(draft, "Edited", ops)).rejects.toThrow("Connection dropped");
    expect(ops.acknowledged).not.toHaveBeenCalled();
    expect(ops.markSent).not.toHaveBeenCalled();
    expect(ops.remove).not.toHaveBeenCalled();
  });
  it("reports cleanup failure as already sent and never sends a persisted sent draft", async () => {
    const ops = operations();
    ops.remove.mockRejectedValueOnce(new Error("Storage unavailable"));
    await expect(deliverSharedDraft(draft, "Edited", ops)).rejects.toBeInstanceOf(
      SharedDraftSentError,
    );
    expect(ops.markSent).toHaveBeenCalledWith("thread");
    ops.send.mockClear();
    await expect(
      deliverSharedDraft({ ...draft, sentThreadId: "thread" }, "Edited", ops),
    ).rejects.toMatchObject({ threadId: "thread" });
    expect(ops.send).not.toHaveBeenCalled();
  });
});
