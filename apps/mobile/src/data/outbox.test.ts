import { expect, it, vi } from "vitest";
import { createOutbox, type WaitingMessage } from "./outbox";
import { OutcomeUnknownError } from "./transport";

function memory() {
  const values = new Map<string, string>();
  return {
    values,
    get: async (key: string) => values.get(key) ?? null,
    set: async (key: string, value: string) => {
      values.set(key, value);
    },
  };
}

const message = (id: string, threadId = "chat"): WaitingMessage => ({
  id,
  threadId,
  input: [{ type: "text", text: id }],
  text: id,
  createdAt: "2026-11-21T00:00:00.000Z",
});

it("keeps waiting messages across a restart", async () => {
  const storage = memory();
  const changed = vi.fn();
  const first = createOutbox({ storage, send: async () => undefined, changed });
  await first.load();
  await first.add(message("one"));
  const second = createOutbox({ storage, send: async () => undefined, changed: () => undefined });
  await second.load();
  expect(second.list("chat").map((row) => row.id)).toEqual(["one"]);
  expect(changed).toHaveBeenLastCalledWith([expect.objectContaining({ id: "one" })]);
});

it("waits while the Mac is unreachable, then sends once in order with the same id", async () => {
  let reachable = false;
  const sent: string[] = [];
  const outbox = createOutbox({
    storage: memory(),
    send: async (row) => {
      if (!reachable) throw new Error("Your Mac is offline.");
      sent.push(row.id);
    },
    changed: () => undefined,
  });
  await outbox.load();
  await outbox.add(message("one"));
  await outbox.add(message("two"));
  await outbox.flush();
  expect(outbox.list("chat")).toHaveLength(2);
  reachable = true;
  await Promise.all([outbox.flush(), outbox.flush()]);
  expect(sent).toEqual(["one", "two"]);
  expect(outbox.list("chat")).toEqual([]);
});

it("keeps a message whose outcome is unknown so it resends with its id", async () => {
  const ids: string[] = [];
  let fail = true;
  const outbox = createOutbox({
    storage: memory(),
    send: async (row) => {
      ids.push(row.id);
      if (fail) throw new OutcomeUnknownError("timeout");
    },
    changed: () => undefined,
  });
  await outbox.load();
  await outbox.add(message("one"));
  await outbox.flush();
  fail = false;
  await outbox.flush();
  expect(ids).toEqual(["one", "one"]);
  expect(outbox.list("chat")).toEqual([]);
});

it("keeps a refused message and holds that chat's later ones", async () => {
  const sent: string[] = [];
  const outbox = createOutbox({
    storage: memory(),
    send: async (row) => {
      if (row.id === "bad") throw new Error("thread_archived");
      sent.push(row.id);
    },
    changed: () => undefined,
  });
  await outbox.load();
  await outbox.add(message("bad"));
  await outbox.add(message("after"));
  await outbox.add(message("other", "elsewhere"));
  await outbox.flush();
  expect(sent).toEqual(["other"]);
  await expect(outbox.sendNow("bad")).rejects.toThrow("thread_archived");
  await outbox.remove("bad");
  await outbox.flush();
  expect(sent).toEqual(["other", "after"]);
});

it("refuses long messages", async () => {
  const outbox = createOutbox({
    storage: memory(),
    send: async () => undefined,
    changed: () => undefined,
  });
  await outbox.load();
  await expect(outbox.add({ ...message("long"), text: "x".repeat(4001) })).rejects.toThrow(
    "too long",
  );
});

it("treats an offline link and an unknown outcome as unreachable, and refusals as not", async () => {
  const { unreachable } = await import("./outbox");
  const { offlineReason } = await import("./client");
  expect(unreachable(new Error(offlineReason("offline")))).toBe(true);
  expect(unreachable(new Error(offlineReason("mac_offline")))).toBe(true);
  expect(unreachable(new OutcomeUnknownError("timeout"))).toBe(true);
  expect(unreachable(new Error("thread_archived"))).toBe(false);
});
