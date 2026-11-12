import { randomBytes } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { RunnerOutbox } from "./outbox.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture(guard: (value: unknown) => void = () => {}) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "zoltbot-runner-outbox-"));
  roots.push(directory);
  return {
    directory,
    binding: { orgId: "org", taskId: "task", threadId: "thread", leaseId: "lease" },
    guard,
  };
}
const observation = (text: string) => ({
  threadId: "thread",
  sessionId: "session",
  itemId: "item",
  event: {
    t: "message.done" as const,
    turnId: "turn",
    itemId: "native-item",
    text,
    phase: "final" as const,
  },
});

it("replays only unacknowledged frames with stable sequence numbers after reopening and compaction", () => {
  const options = fixture();
  let outbox = new RunnerOutbox(options);
  const first = outbox.append(observation("First"));
  const second = outbox.append(observation("Second"));
  expect([first.runnerSeq, second.runnerSeq]).toEqual([1, 2]);
  outbox.acknowledge(1);
  outbox.close();
  outbox = new RunnerOutbox(options);
  expect(outbox.lastAck).toBe(1);
  expect([...outbox.pending()]).toEqual([second]);
  outbox.compact();
  outbox.close();
  outbox = new RunnerOutbox(options);
  expect([...outbox.pending()]).toEqual([second]);
  outbox.acknowledge(2);
  outbox.compact();
  expect([...outbox.pending()]).toEqual([]);
  expect(outbox.append(observation("Third")).runnerSeq).toBe(3);
  expect(statSync(outbox.file).mode & 0o777).toBe(0o600);
  outbox.close();
});
it("recovers a partial tail and seeds a recreated cache from the cell cursor", () => {
  const options = fixture();
  let outbox = new RunnerOutbox(options);
  const first = outbox.append(observation("Durable"));
  const file = outbox.file;
  outbox.close();
  appendFileSync(file, '{"t":"event","frame":');
  outbox = new RunnerOutbox(options);
  expect([...outbox.pending()]).toEqual([first]);
  expect(outbox.append(observation("Recovered")).runnerSeq).toBe(2);
  outbox.reconcile(20);
  expect(outbox.append(observation("After cache recovery")).runnerSeq).toBe(21);
  expect(() => outbox.reconcile(19)).toThrow("runner_ack_regressed");
  outbox.close();
});
it("refuses another scope and a complete corrupted frame instead of replaying it", () => {
  const options = fixture();
  let outbox = new RunnerOutbox(options);
  outbox.append(observation("Original"));
  const file = outbox.file;
  outbox.close();
  expect(
    () => new RunnerOutbox({ ...options, binding: { ...options.binding, leaseId: "other" } }),
  ).toThrow("runner_outbox_scope_conflict");
  const content = readFileSync(file, "utf8").replace('"text":"Original"', '"text":"Modified"');
  writeFileSync(file, content);
  expect(() => new RunnerOutbox(options)).toThrow("runner_outbox_corrupt");
  outbox = new RunnerOutbox(fixture());
  expect(() => outbox.append({ ...observation("Local"), threadId: "local-thread" })).toThrow(
    "runner_outbox_scope_conflict",
  );
  expect(outbox.nextSequence).toBe(1);
  outbox.close();
});
it("rejects a known private value before writing or advancing its sequence", () => {
  const value = randomBytes(32).toString("base64url");
  const options = fixture((input) => {
    if (JSON.stringify(input).includes(value)) throw new Error(value);
  });
  const outbox = new RunnerOutbox(options);
  expect(() => outbox.append(observation(value))).toThrow(/^runner_outbox_private_value$/);
  expect(readFileSync(outbox.file, "utf8").includes(value)).toBe(false);
  expect(outbox.nextSequence).toBe(1);
  outbox.close();
});
it("refuses a symlink without modifying its target", () => {
  const options = fixture();
  const outbox = new RunnerOutbox(options);
  const file = outbox.file;
  outbox.close();
  rmSync(file);
  const target = path.join(options.directory, "target");
  writeFileSync(target, "unchanged");
  chmodSync(target, 0o600);
  symlinkSync(target, file);
  expect(() => new RunnerOutbox(options)).toThrow("runner_outbox_unavailable");
  expect(readFileSync(target, "utf8")).toBe("unchanged");
});

it("compacts an acknowledged prefix without loading retained event bodies together", () => {
  const outbox = new RunnerOutbox(fixture());
  outbox.append(observation("a".repeat(700000)));
  outbox.append(observation("b".repeat(700000)));
  const before = statSync(outbox.file).size;
  outbox.acknowledge(1);
  expect(statSync(outbox.file).size).toBeLessThan(before);
  expect([...outbox.pending()].map((frame) => frame.runnerSeq)).toEqual([2]);
  outbox.close();
});
