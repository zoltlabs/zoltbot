import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { Outbox, type OutboxEntry } from "./outbox";

let dir = "";
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

const entry = (id: string, botId = "chat"): OutboxEntry => ({
  id,
  botId,
  parts: [{ type: "text", text: id }],
  text: id,
  attachments: [],
  createdAt: "2026-11-21T00:00:00.000Z",
});

async function outbox(send: (entry: OutboxEntry) => Promise<unknown>) {
  dir ||= await mkdtemp(join(tmpdir(), "outbox-"));
  const changed = vi.fn();
  const box = new Outbox({ path: join(dir, "outbox.json"), send, changed });
  await box.load();
  return { box, changed };
}

it("keeps waiting messages across a restart", async () => {
  const { box, changed } = await outbox(async () => undefined);
  await box.add(entry("one"));
  await box.add(entry("two"));
  expect(changed).toHaveBeenCalledWith("chat");
  const { box: after } = await outbox(async () => undefined);
  expect(after.list("chat").map((row) => row.id)).toEqual(["one", "two"]);
  expect(JSON.parse(await readFile(join(dir, "outbox.json"), "utf8"))).toHaveLength(2);
});

it("sends in order with the first commandId, once each", async () => {
  const sent: string[] = [];
  const { box } = await outbox(async (row) => sent.push(row.id));
  await box.add(entry("one"));
  await box.add(entry("two"));
  await Promise.all([box.flush(), box.flush()]);
  expect(sent).toEqual(["one", "two"]);
  expect(box.list("chat")).toEqual([]);
});

it("stops while the daemon is unreachable and keeps the rest", async () => {
  let online = false;
  const sent: string[] = [];
  const { box } = await outbox(async (row) => {
    if (!online) throw new Error("Daemon unavailable");
    sent.push(row.id);
  });
  await box.add(entry("one"));
  await box.add(entry("two"));
  await box.flush();
  expect(box.list("chat")).toHaveLength(2);
  online = true;
  await box.flush();
  expect(sent).toEqual(["one", "two"]);
});

it("keeps a refused message, holds that chat's later ones, and sends other chats", async () => {
  const sent: string[] = [];
  const { box } = await outbox(async (row) => {
    if (row.id === "bad") throw new Error("thread_archived");
    sent.push(row.id);
  });
  await box.add(entry("bad"));
  await box.add(entry("after"));
  await box.add(entry("elsewhere", "other"));
  await box.flush();
  expect(sent).toEqual(["elsewhere"]);
  expect(box.list("chat").map((row) => row.id)).toEqual(["bad", "after"]);
  await expect(box.sendNow("bad")).rejects.toThrow("thread_archived");
  await box.remove("bad");
  await box.sendNow("after");
  expect(box.list("chat")).toEqual([]);
});

it("ignores a damaged file", async () => {
  dir = await mkdtemp(join(tmpdir(), "outbox-"));
  const { writeFile } = await import("node:fs/promises");
  await writeFile(join(dir, "outbox.json"), '[{"id":1},"x",{"id":"ok","botId":"chat","parts":[],"text":"","attachments":[],"createdAt":"now"}]');
  const { box } = await outbox(async () => undefined);
  expect(box.list("chat").map((row) => row.id)).toEqual(["ok"]);
});

it("doesn't keep a message it couldn't save", async () => {
  dir = await mkdtemp(join(tmpdir(), "outbox-"));
  const box = new Outbox({
    path: join(dir, "missing", "\0bad", "outbox.json"),
    send: async () => undefined,
    changed: () => undefined,
  });
  await box.load();
  await expect(box.add(entry("one"))).rejects.toThrow();
  expect(box.list("chat")).toEqual([]);
  expect(box.has("chat")).toBe(false);
});

it("sets a damaged file aside instead of overwriting it", async () => {
  dir = await mkdtemp(join(tmpdir(), "outbox-"));
  const { writeFile } = await import("node:fs/promises");
  await writeFile(join(dir, "outbox.json"), "{not json");
  const { box } = await outbox(async () => undefined);
  await box.add(entry("one"));
  expect(await readFile(join(dir, "outbox.json.damaged"), "utf8")).toBe("{not json");
});

it("also sends messages added while it is sending, once each", async () => {
  const sent: string[] = [];
  let box: Outbox | undefined;
  const made = await outbox(async (row) => {
    sent.push(row.id);
    if (row.id === "one") await box?.add(entry("late"));
  });
  box = made.box;
  await box.add(entry("one"));
  await Promise.all([box.flush(), box.sendNow("one")]);
  expect(sent).toEqual(["one", "late"]);
});
