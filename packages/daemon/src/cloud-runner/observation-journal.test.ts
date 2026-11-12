import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { DomainEvent } from "@zoltbot/protocol";
import { openStore, type Store } from "@zoltbot/store";
import { afterEach, expect, it, vi } from "vitest";
import { ObservationJournal } from "./observation-journal.js";
import { RunnerOutbox } from "./outbox.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const observation = {
  threadId: "thread",
  sessionId: "session",
  event: {
    t: "message.done" as const,
    turnId: "turn",
    itemId: "item",
    text: "Committed result",
    phase: "final" as const,
  },
};
const projected: DomainEvent = {
  eventId: "event",
  aggregateType: "settings",
  aggregateId: "native-id",
  type: "settings.created",
  occurredAt: "2026-11-11T00:00:00.000Z",
  payload: { key: "native-id", value: "original-native" },
};
async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zoltbot-observation-journal-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const options = {
    directory,
    binding: { orgId: "org", taskId: "task", threadId: "thread", leaseId: "lease" },
    guard(_value: unknown) {},
  };
  let store: Store | undefined, outbox: RunnerOutbox | undefined;
  const close = async () => {
    outbox?.close();
    store?.close();
    outbox = undefined;
    store = undefined;
  };
  cleanup.push(close);
  const open = async (guard = options.guard) => {
    store = await openStore(path.join(directory, "cache.db"));
    outbox = new RunnerOutbox({ ...options, guard });
    const journal = new ObservationJournal({ store, outbox, threadId: "thread", guard });
    return { store, outbox, journal };
  };
  return { directory, options, open, close };
}

it("rolls back an observation with its projection and rejects private output before either commit", async () => {
  const f = await fixture(),
    value = randomBytes(32).toString("base64url");
  const { store, outbox, journal } = await f.open((input) => {
    if (JSON.stringify(input).includes(value)) throw new Error("fixture_private");
  });
  expect(() => journal.record(observation)).toThrow("runner_observation_transaction_required");
  expect(() =>
    store.dispatch(
      "rollback",
      () => {
        journal.record(observation);
        return { events: [projected], result: {} };
      },
      { killPoint: "after_projections" },
    ),
  ).toThrow("kill point: after_projections");
  expect(() =>
    store.dispatch("private", () => {
      journal.record({ ...observation, event: { ...observation.event, text: value } });
      return { events: [projected], result: {} };
    }),
  ).toThrow("runner_observation_private_value");
  expect(store.lastSeq()).toBe(0);
  journal.flush();
  expect([...outbox.pending()]).toEqual([]);
  store.dispatch("committed", () => {
    journal.record(observation);
    return { events: [projected], result: {} };
  });
  expect(store.record("settings", "native-id")?.value).toBe("original-native");
  journal.flush();
  expect([...outbox.pending()]).toHaveLength(1);
});

it("retries a crash after the JSONL fsync even when ack and compaction precede SQLite retirement", async () => {
  const f = await fixture();
  let { outbox, journal } = await f.open();
  journal.recordTransient(observation);
  const append = outbox.appendSource.bind(outbox);
  vi.spyOn(outbox, "appendSource").mockImplementation((...args) => {
    append(...args);
    outbox.acknowledge(1);
    outbox.compact();
    throw new Error("fixture_crash_after_fsync");
  });
  expect(() => journal.flush()).toThrow("fixture_crash_after_fsync");
  await f.close();
  ({ outbox, journal } = await f.open());
  journal.flush();
  expect(outbox.nextSequence).toBe(2);
  expect([...outbox.pending()]).toEqual([]);
  journal.recordTransient({ ...observation, event: { ...observation.event, text: "Next result" } });
  journal.flush();
  expect([...outbox.pending()].map((frame) => frame.runnerSeq)).toEqual([2]);
});

it("recovers a committed observation after SIGKILL before the outbound copy", async () => {
  const f = await fixture(),
    launcher = path.join(f.directory, "launcher.mjs");
  const storeUrl = new URL("../../../store/src/index.ts", import.meta.url).href;
  await writeFile(
    launcher,
    `import { openStore } from ${JSON.stringify(storeUrl)};
import { ObservationJournal } from ${JSON.stringify(new URL("./observation-journal.ts", import.meta.url).href)};
import { RunnerOutbox } from ${JSON.stringify(new URL("./outbox.ts", import.meta.url).href)};
const store=await openStore(${JSON.stringify(path.join(f.directory, "cache.db"))});
const outbox=new RunnerOutbox({...${JSON.stringify(f.options)},guard(){}});
const journal=new ObservationJournal({store,outbox,threadId:"thread",guard(){}});
store.dispatch("committed",()=>{journal.record(${JSON.stringify(observation)});return {events:[${JSON.stringify(projected)}],result:{}};});
process.send("committed");setInterval(()=>{},1000);
`,
  );
  const child = spawn(process.execPath, ["--import", "tsx", launcher], {
    cwd: process.cwd(),
    env: { PATH: process.env.PATH },
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  const exit = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("fixture_child_start_timeout")), 5000);
      child.once("message", (message) => {
        clearTimeout(timer);
        message === "committed" ? resolve() : reject(new Error("fixture_child_invalid"));
      });
      child.once("exit", () => {
        clearTimeout(timer);
        reject(new Error("fixture_child_early_exit"));
      });
    });
    child.kill("SIGKILL");
    await exit;
    const { store, outbox, journal } = await f.open();
    expect(store.record("settings", "native-id")?.value).toBe("original-native");
    expect([...outbox.pending()]).toEqual([]);
    journal.flush();
    expect([...outbox.pending()].map((frame) => frame.event)).toEqual([observation.event]);
    journal.flush();
    expect(outbox.nextSequence).toBe(2);
  } finally {
    if (child.exitCode === null && !child.signalCode) child.kill("SIGKILL");
    await exit;
  }
});
