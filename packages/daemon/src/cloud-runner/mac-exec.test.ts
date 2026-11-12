import { mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CloudDevice } from "@zoltbot/cloud-contracts";
import { approvalStdinHash, createIdentity, linkId, signApproval, toB64 } from "@zoltbot/link";
import type { MacExecRequest } from "@zoltbot/runner-protocol";
import { afterEach, expect, it, vi } from "vitest";
import { type MacExecution, MacExecutionHost, type MacExecutionOptions } from "./mac-exec.js";

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const signal = () => new AbortController().signal;
function fixture() {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "mac-execution-")));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const identity = createIdentity(),
    deviceId = linkId(identity.publicKey),
    now = Date.now();
  let mode: "off" | "ask" | "allow_listed" = "ask";
  const keys: CloudDevice[] = [
    {
      userId: "member",
      deviceId,
      publicKey: toB64(identity.publicKey),
      registeredAt: new Date(now).toISOString(),
    },
  ];
  const execute = vi.fn(async (input: MacExecution) => ({
    requestId: input.requestId,
    taskId: input.taskId,
    exitCode: 0,
    stdout: "synthetic output",
    stderr: "",
    durationMs: 1,
    truncated: false,
    mac: "Test Mac",
  }));
  const options: MacExecutionOptions = {
    directory: path.join(root, "journal"),
    orgId: "org",
    userId: "member",
    deviceId: "target",
    mac: "Test Mac",
    osVersion: "15.0",
    mode: () => mode,
    async deviceKeys() {
      return keys;
    },
    async task() {
      return { active: true, folder: root };
    },
    execute,
    now: () => now,
  };
  const request = (): MacExecRequest => ({
    requestId: "request",
    taskId: "task",
    turnId: "turn",
    userId: "member",
    targetDeviceId: "target",
    command: "uname",
    approval: signApproval(identity, {
      v: 1,
      orgId: "org",
      userId: "member",
      signerDeviceId: deviceId,
      requestId: "request",
      taskId: "task",
      turnId: "turn",
      targetDeviceId: "target",
      scope: "command",
      command: "uname",
      cwd: root,
      stdinHash: approvalStdinHash(),
      timeoutSeconds: 600,
      issuedAt: now,
      expiresAt: now + 300000,
    }),
  });
  const open = () => {
    const host = new MacExecutionHost(options);
    cleanup.push(() => host.close());
    return host;
  };
  return {
    root,
    identity,
    now,
    keys,
    options,
    request,
    open,
    execute,
    mode(value: typeof mode) {
      mode = value;
    },
  };
}
it("executes an exact signed request once and replays its result across a host restart", async () => {
  const f = fixture(),
    request = f.request(),
    host = f.open();
  const first = await host.request(request, signal());
  expect(first.exitCode).toBe(0);
  expect((await host.request(request, signal())).stdout).toBe(first.stdout);
  await host.close();
  const reordered = f.request();
  if (reordered.approval)
    reordered.approval.payload = Object.fromEntries(
      Object.entries(reordered.approval.payload).reverse(),
    ) as typeof reordered.approval.payload;
  expect((await f.open().request(reordered, signal())).stdout).toBe(first.stdout);
  expect(f.execute).toHaveBeenCalledTimes(1);
});
function prefixRequest(f: ReturnType<typeof fixture>) {
  const initial = f.request();
  if (!initial.approval) throw new Error("fixture_approval_missing");
  initial.command = "pnpm test --filter core";
  initial.approval = signApproval(f.identity, {
    ...initial.approval.payload,
    scope: "prefix",
    command: "pnpm test",
    expiresAt: f.now + 86400000,
  });
  return initial;
}
it("reuses a registered signed prefix only for this active task and retains one claim per command", async () => {
  const f = fixture();
  f.mode("allow_listed");
  const host = f.open(),
    initial = prefixRequest(f);
  const next = {
    ...initial,
    requestId: "next",
    turnId: "later-turn",
    command: "pnpm test --filter store",
  };
  await expect(host.request(next, signal())).rejects.toThrow(/^mac_approval_refused$/);
  await host.request(initial, signal());
  await host.request(next, signal());
  await host.request(next, signal());
  expect(f.execute).toHaveBeenCalledTimes(2);
  await expect(
    host.request({ ...next, command: "pnpm test --filter changed" }, signal()),
  ).rejects.toThrow(/^mac_request_conflict$/);
  await host.close();
  if (!initial.approval) throw new Error("fixture_approval_missing");
  initial.approval.payload = Object.fromEntries(
    Object.entries(initial.approval.payload).reverse(),
  ) as typeof initial.approval.payload;
  const resumed = f.open();
  await resumed.request(
    {
      ...initial,
      requestId: "third",
      turnId: "third-turn",
      command: "pnpm test --filter protocol",
    },
    signal(),
  );
  expect(f.execute).toHaveBeenCalledTimes(3);
});
it("requires allow-listed mode and fresh approvals for settings, keychain, shell syntax and stdin", async () => {
  const f = fixture(),
    initial = prefixRequest(f),
    host = f.open();
  await expect(host.request(initial, signal())).rejects.toThrow(/^mac_approval_required$/);
  f.mode("allow_listed");
  await host.request(initial, signal());
  for (const change of [
    { command: "pnpm test; uname" },
    { command: "pnpm test $(uname)" },
    { command: "pnpm test sudo" },
    { command: "pnpm test /usr/bin/security" },
    { command: "pnpm test systemsetup" },
    { command: "pnpm testing" },
    { stdin: "input" },
  ])
    await expect(
      host.request({ ...initial, ...change, requestId: "unsafe" }, signal()),
    ).rejects.toThrow(/^mac_approval_required$/);
  f.mode("ask");
  await expect(host.request(initial, signal())).rejects.toThrow(/^mac_approval_required$/);
  expect(f.execute).toHaveBeenCalledTimes(1);
});
it("rechecks prefix task scope, expiry, device revocation and mode before each execution", async () => {
  const f = fixture();
  f.mode("allow_listed");
  const initial = prefixRequest(f),
    host = f.open();
  await host.request(initial, signal());
  const next = { ...initial, requestId: "next" };
  for (const change of [
    { taskId: "other" },
    { targetDeviceId: "other" },
    { userId: "other" },
    { timeoutSeconds: 1 },
  ])
    await expect(host.request({ ...next, ...change }, signal())).rejects.toThrow(
      /^mac_approval_refused$/,
    );
  const registered = f.keys[0];
  if (!registered) throw new Error("fixture_key_missing");
  registered.revokedAt = new Date(f.now).toISOString();
  await expect(host.request(next, signal())).rejects.toThrow(/^mac_approval_refused$/);
  delete registered.revokedAt;
  f.options.task = async () => ({ active: false, folder: f.root });
  await expect(host.request(next, signal())).rejects.toThrow(/^mac_unavailable$/);
  f.options.task = async () => ({ active: true, folder: f.root });
  f.options.now = () => f.now + 86400001;
  await expect(host.request(next, signal())).rejects.toThrow(/^mac_approval_refused$/);
  expect((await host.request(initial, signal())).exitCode).toBe(0);
  f.mode("off");
  await expect(host.request(initial, signal())).rejects.toThrow(/^mac_unavailable$/);
  expect(f.execute).toHaveBeenCalledTimes(1);
});
it("refuses a forged Cell approval and unsigned requests before starting any process", async () => {
  const f = fixture(),
    host = f.open(),
    request = f.request();
  if (request.approval) request.approval.signature = toB64(new Uint8Array(64));
  await expect(host.request(request, signal())).rejects.toThrow("mac_approval_refused");
  const unsigned = f.request();
  delete unsigned.approval;
  await expect(host.request(unsigned, signal())).rejects.toThrow("mac_approval_required");
  expect(f.execute).not.toHaveBeenCalled();
});
it("retrieves a completed result after approval expiry without authorizing another execution", async () => {
  const f = fixture(),
    host = f.open(),
    request = f.request();
  const first = await host.request(request, signal());
  await host.close();
  f.options.now = () => f.now + 600000;
  const reopened = f.open();
  expect(await reopened.request(request, signal())).toEqual(first);
  const other = { ...request, requestId: "other" };
  await expect(reopened.request(other, signal())).rejects.toThrow("mac_approval_refused");
  if (!request.approval) throw new Error("fixture_approval_missing");
  const changedProof = {
    ...request,
    approval: signApproval(f.identity, {
      ...request.approval.payload,
      issuedAt: f.now + 1,
      expiresAt: f.now + 300001,
    }),
  };
  await expect(reopened.request(changedProof, signal())).rejects.toThrow("mac_approval_refused");
  const device = f.keys[0];
  if (!device) throw new Error("fixture_device_missing");
  device.revokedAt = new Date(f.now).toISOString();
  await expect(reopened.request(request, signal())).rejects.toThrow("mac_approval_refused");
  expect(f.execute).toHaveBeenCalledTimes(1);
});
it("reports the configured Mac and canonical folder without executing a command", async () => {
  const f = fixture(),
    host = f.open();
  const request = { requestId: "status", taskId: "task", turnId: "turn", userId: "member" };
  expect(await host.status(request, signal())).toEqual({
    available: true,
    targetDeviceId: "target",
    mac: "Test Mac",
    osVersion: "15.0",
    cwd: f.root,
    allowListedCommands: false,
  });
  expect(await host.status({ ...request, userId: "other" }, signal())).toEqual({
    available: false,
    reason: "unavailable",
  });
  expect(await host.status({ ...request, targetDeviceId: "other" }, signal())).toEqual({
    available: false,
    reason: "unavailable",
  });
  expect(await host.status({ ...request, cwd: ".." }, signal())).toEqual({
    available: false,
    reason: "unavailable",
  });
  f.mode("off");
  expect(await host.status(request, signal())).toEqual({ available: false, reason: "off" });
  expect(f.execute).not.toHaveBeenCalled();
});
it("bounds a stalled status lookup and cancels its task port", async () => {
  const f = fixture(),
    host = f.open();
  let cancelled = false;
  f.options.task = async (_task, _turn, signal) => {
    signal.addEventListener(
      "abort",
      () => {
        cancelled = true;
      },
      { once: true },
    );
    return new Promise(() => {});
  };
  vi.useFakeTimers();
  try {
    const pending = host.status(
      { requestId: "status", taskId: "task", turnId: "turn", userId: "member" },
      signal(),
    );
    await vi.advanceTimersByTimeAsync(1500);
    expect(await pending).toEqual({ available: false, reason: "unavailable" });
    expect(cancelled).toBe(true);
  } finally {
    vi.useRealTimers();
  }
});
it.each([
  ["command", "false"],
  ["cwd", ".."],
  ["stdin", "unapproved"],
  ["timeoutSeconds", 1],
  ["targetDeviceId", "other"],
  ["userId", "other"],
  ["taskId", "other"],
  ["turnId", "other"],
  ["requestId", "other"],
])("refuses changed execution field %s", async (field, value) => {
  const f = fixture(),
    host = f.open(),
    request = { ...f.request(), [field]: value };
  await expect(host.request(request, signal())).rejects.toThrow("mac_approval_refused");
  expect(f.execute).not.toHaveBeenCalled();
});
it("rechecks registered keys and refuses revoked, foreign, changed and expired approvals", async () => {
  const f = fixture(),
    host = f.open();
  const device = f.keys[0];
  if (!device) throw new Error("fixture_device_missing");
  device.revokedAt = new Date(f.now).toISOString();
  await expect(host.request(f.request(), signal())).rejects.toThrow("mac_approval_refused");
  delete device.revokedAt;
  device.userId = "other";
  await expect(host.request(f.request(), signal())).rejects.toThrow("mac_approval_refused");
  device.userId = "member";
  const old = device.publicKey;
  device.publicKey = toB64(createIdentity().publicKey);
  await expect(host.request(f.request(), signal())).rejects.toThrow("mac_approval_refused");
  device.publicKey = old;
  f.options.now = () => f.now + 300000;
  await expect(host.request(f.request(), signal())).rejects.toThrow("mac_approval_refused");
  expect(f.execute).not.toHaveBeenCalled();
});
it("honors Off, inactive tasks and symlink escapes even with a valid signature", async () => {
  const f = fixture(),
    host = f.open();
  f.mode("off");
  await expect(host.request(f.request(), signal())).rejects.toThrow("mac_unavailable");
  f.mode("ask");
  f.options.task = async () => ({ active: false, folder: f.root });
  await expect(host.request(f.request(), signal())).rejects.toThrow("mac_unavailable");
  f.options.task = async () => ({ active: true, folder: f.root });
  symlinkSync(path.dirname(f.root), path.join(f.root, "escape"));
  await expect(host.request({ ...f.request(), cwd: "escape" }, signal())).rejects.toThrow(
    "mac_approval_refused",
  );
  expect(f.execute).not.toHaveBeenCalled();
});
it("keeps uncertain failures claimed and never exposes a process host's raw error", async () => {
  const f = fixture(),
    host = f.open();
  f.options.execute = async () => {
    throw new Error("raw_private_process_error");
  };
  await expect(host.request(f.request(), signal())).rejects.toThrow(/^mac_exec_unavailable$/);
  await expect(host.request(f.request(), signal())).rejects.toThrow(/^mac_execution_uncertain$/);
  await host.close();
  await expect(f.open().request(f.request(), signal())).rejects.toThrow(
    /^mac_execution_uncertain$/,
  );
});
it("does not start a second process for concurrent delivery of the same signed request", async () => {
  const f = fixture(),
    host = f.open();
  let ready = () => {},
    finish = () => {},
    calls = 0;
  const started = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });
  f.options.execute = async (input) => {
    calls++;
    ready();
    await done;
    return {
      requestId: input.requestId,
      taskId: input.taskId,
      exitCode: 0,
      stdout: "once",
      stderr: "",
      durationMs: 1,
      truncated: false,
      mac: "Test Mac",
    };
  };
  const results = Promise.all([
    host.request(f.request(), signal()),
    host.request(f.request(), signal()),
  ]);
  await started;
  finish();
  expect((await results).map((result) => result.stdout)).toEqual(["once", "once"]);
  expect(calls).toBe(1);
});
it("aborts its owned process before closing the journal and refuses authority after close", async () => {
  const f = fixture(),
    host = f.open();
  let ready = () => {},
    aborted = false;
  const started = new Promise<void>((resolve) => {
    ready = resolve;
  });
  f.options.execute = async (_input, signal) =>
    new Promise((_resolve, reject) => {
      ready();
      signal.addEventListener(
        "abort",
        () => {
          aborted = true;
          reject(new Error("synthetic_stop"));
        },
        { once: true },
      );
    });
  const result = expect(host.request(f.request(), signal())).rejects.toThrow(
    "mac_exec_unavailable",
  );
  await started;
  await host.close();
  await result;
  expect(aborted).toBe(true);
  await expect(host.request(f.request(), signal())).rejects.toThrow("mac_unavailable");
});
