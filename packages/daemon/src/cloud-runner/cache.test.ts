import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { type DomainEvent, parse, QueuedInputBodySchema } from "@zoltbot/protocol";
import { afterEach, expect, it } from "vitest";
import { previousForThread } from "../runtime-configuration.js";
import { CloudTaskCache } from "./cache.js";
import { runnerLease } from "./fixture.js";

const roots: string[] = [],
  caches: CloudTaskCache[] = [];
afterEach(async () => {
  for (const cache of caches.splice(0)) cache.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "zoltbot-runner-cache-"));
  roots.push(root);
  const lease = runnerLease(),
    execution = lease.execution;
  if (!execution) throw new Error("fixture_execution_missing");
  const definition = structuredClone(execution.definition);
  definition.launch = { command: "pinned-fake", args: [], env: {} };
  execution.definition.launch = { command: "untrusted-cell-command", args: [], env: {} };
  const cwd = path.join(root, "repo");
  await mkdir(cwd);
  const options = {
    directory: path.join(root, "cache"),
    orgId: "org",
    memberId: "member",
    lease,
    workspace: { cwd, baseCommit: "a".repeat(40) },
    definition,
    guard(_value: unknown) {},
  };
  const open = async (input = options) => {
    const cache = await CloudTaskCache.open(input);
    caches.push(cache);
    return cache;
  };
  return { root, lease, execution, options, open };
}

it("seeds only the leased task and a locally pinned launch recipe, using the managed cwd", async () => {
  const f = await fixture(),
    cache = await f.open();
  const state = cache.store.snapshot();
  expect(state.project).toHaveLength(1);
  expect(state.task).toHaveLength(1);
  expect(state.thread).toHaveLength(1);
  expect(state.agent).toHaveLength(1);
  expect(state.agentDefinition?.[0]?.launch).toEqual(f.options.definition.launch);
  expect(state.project?.[0]?.roots).toEqual([
    { path: f.options.workspace.cwd, label: f.execution.project.name },
  ]);
  expect(state.item?.[0]?.id).toBe("task:r1:input");
  expect(JSON.stringify(state)).not.toContain("untrusted-cell-command");
});

it("keeps canonical input IDs and local delivery state through repeated leases and command retries", async () => {
  const f = await fixture(),
    cache = await f.open();
  const input = [{ type: "text" as const, text: "Follow up" }];
  const first = cache.queue("command", "canonical-input", input, "queue");
  expect(cache.queue("command", "canonical-input", input, "queue")).toEqual(first);
  cache.update(f.lease);
  expect(cache.store.snapshot().item).toHaveLength(2);
  expect(() => cache.queue("command", "other-id", input, "queue")).toThrow(
    "runner_cache_scope_conflict",
  );
  expect(() =>
    cache.queue("command", "canonical-input", [{ type: "text", text: "Changed" }], "queue"),
  ).toThrow("runner_cache_scope_conflict");
  cache.close();
  const restarted = await f.open();
  expect(restarted.queue("command", "canonical-input", input, "queue")).toEqual(first);
  expect(restarted.store.snapshot().item).toHaveLength(2);
});

it("continues the original native identity and refuses a different one from the Cell", async () => {
  const f = await fixture();
  const cache = await f.open();
  cache.store.dispatch("native-ready", () => ({
    events: [
      {
        eventId: "native-ready",
        aggregateType: "session",
        aggregateId: "prior-session",
        type: "session.created",
        occurredAt: new Date().toISOString(),
        payload: {
          id: "prior-session",
          threadId: "thread",
          nativeId: "original-native",
          provider: f.options.definition.adapter,
          cwd: f.options.workspace.cwd,
          state: "closed",
          capabilities: {},
          startedAt: new Date().toISOString(),
        },
      },
    ],
    result: {},
  }));
  f.execution.previousNativeId = "original-native";
  expect(previousForThread(cache.store.snapshot(), "thread")).toMatchObject({
    nativeId: "original-native",
    cwd: f.options.workspace.cwd,
  });
  cache.close();
  const reopened = await f.open();
  expect(previousForThread(reopened.store.snapshot(), "thread")?.nativeId).toBe("original-native");
  const changed = structuredClone(f.lease);
  if (!changed.execution) throw new Error("fixture_execution_missing");
  changed.execution.previousNativeId = "replacement-native";
  expect(() => reopened.update(changed)).toThrow("runner_native_identity_changed");
});

it("fails closed when a native continuation has lost its task cache and privacy references", async () => {
  const f = await fixture();
  f.execution.previousNativeId = "original-native";
  await expect(f.open()).rejects.toThrow("runner_cache_missing");
});

it("holds an uncertain send after restart instead of queuing it twice", async () => {
  const f = await fixture(),
    cache = await f.open();
  const item = cache.store.record("item", "task:r1:input");
  if (!item) throw new Error("fixture_input_missing");
  cache.store.dispatch("in-flight", () => ({
    events: [
      {
        eventId: "in-flight",
        aggregateType: "item",
        aggregateId: String(item.id),
        type: "item.updated",
        occurredAt: new Date().toISOString(),
        payload: {
          ...item,
          body: {
            ...parse(QueuedInputBodySchema, item.body),
            queueState: "sending",
            sessionId: "session",
            attemptId: "attempt",
            attemptedAt: new Date().toISOString(),
            deliveryMode: "queue",
          },
        },
      } as DomainEvent,
    ],
    result: {},
  }));
  cache.close();
  const reopened = await f.open();
  expect(reopened.store.record("item", "task:r1:input")?.body).toMatchObject({
    queueState: "uncertain",
    errorCode: "delivery_uncertain",
  });
  expect(reopened.store.snapshot().item?.filter((row) => row.kind === "user")).toHaveLength(1);
});

it("rejects scope changes, duplicate canonical IDs and known private values before writing", async () => {
  const f = await fixture(),
    secret = randomBytes(32).toString("base64url");
  const cache = await f.open({
    ...f.options,
    guard(value) {
      if (JSON.stringify(value).includes(secret)) throw new Error("private_value");
    },
  });
  const before = cache.store.lastSeq();
  for (const kind of ["task", "thread", "member", "project", "duplicate"] as const) {
    const changed = structuredClone(f.lease),
      execution = changed.execution;
    if (!execution) throw new Error("fixture_execution_missing");
    if (kind === "task") changed.taskId = "other";
    if (kind === "thread") execution.thread.id = "other";
    if (kind === "member") changed.actor.userId = "other";
    if (kind === "project") execution.project.id = "other";
    if (kind === "duplicate") execution.queuedItems.push(...structuredClone(execution.queuedItems));
    expect(() => cache.update(changed)).toThrow("runner_cache_scope_conflict");
    expect(cache.store.lastSeq()).toBe(before);
  }
  expect(() =>
    cache.queue("private", "private-input", [{ type: "text", text: secret }], "queue"),
  ).toThrow("private_value");
  expect(cache.store.lastSeq()).toBe(before);
});

it("excludes another cache owner and refuses symlink roots", async () => {
  const f = await fixture(),
    first = await f.open();
  await expect(f.open()).rejects.toThrow("runner_cache_unavailable");
  first.close();
  await f.open();
  const linked = path.join(f.root, "linked-cache");
  await symlink(f.options.directory, linked);
  await expect(f.open({ ...f.options, directory: linked })).rejects.toThrow(
    "runner_cache_unavailable",
  );
});

it("does not mutate the caller's lease or definition objects", async () => {
  const f = await fixture(),
    original = structuredClone({ lease: f.lease, definition: f.options.definition });
  const cache = await f.open();
  expect(f.lease).toEqual(original.lease);
  expect(f.options.definition).toEqual(original.definition);
  f.options.definition.launch.command = "later-mutation";
  cache.update(f.lease);
  expect(cache.store.record("agentDefinition", f.options.definition.id)?.launch).toMatchObject({
    command: "pinned-fake",
  });
});

it("requires opaque vault references for provider credentials in its pinned definition", async () => {
  const f = await fixture();
  f.options.definition.launch.env.ANTHROPIC_API_KEY = randomBytes(32).toString("base64url");
  await expect(f.open()).rejects.toThrow("runner_cache_unavailable");
  f.options.definition.launch.env = {};
  const cache = await f.open();
  expect(cache.store.record("agentDefinition", f.options.definition.id)?.launch).toMatchObject({
    env: {},
  });
});

it("refuses Cell-supplied filesystem attachments and accepts portable inline image data", async () => {
  const f = await fixture(),
    cache = await f.open();
  const before = cache.store.lastSeq();
  for (const input of [
    [{ type: "file" as const, path: "/private/Local-only.txt" }],
    [{ type: "image" as const, path: "/private/Local-only.png" }],
  ]) {
    expect(() => cache.queue("path-input", "path-input", input, "queue")).toThrow(
      "runner_input_requires_upload",
    );
    const changed = structuredClone(f.lease),
      item = changed.execution?.queuedItems[0];
    if (!item) throw new Error("fixture_input_missing");
    item.body = { ...parse(QueuedInputBodySchema, item.body), input };
    expect(() => cache.update(changed)).toThrow("runner_input_requires_upload");
    expect(cache.store.lastSeq()).toBe(before);
  }
  expect(
    cache.queue(
      "inline-image",
      "inline-image",
      [{ type: "image", mimeType: "image/png", base64: "c3ludGhldGlj" }],
      "queue",
    ),
  ).toMatchObject({ id: "inline-image" });
});
