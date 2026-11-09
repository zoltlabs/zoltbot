import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DomainState } from "@zoltbot/core/projectors";
import type { TerminalInfo, TerminalOutput } from "@zoltbot/protocol";
import { type IPty, spawn } from "node-pty";
import { afterEach, expect, it, vi } from "vitest";
import { TerminalRuntime } from "./terminal-runtime.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
function fixture(real = false) {
  const cwd = realpathSync(mkdtempSync(path.join(os.tmpdir(), "zolt-terminal-")));
  const state: DomainState = {
    thread: [{ id: "thread", agentId: "agent" }],
    agent: [{ id: "agent", permissionProfile: "workspace_write" }],
    session: [{ id: "session", threadId: "thread", cwd, startedAt: "2026-11-07T00:00:00.000Z" }],
  };
  let output: (data: string) => void = () => {};
  let exit: (event: { exitCode: number; signal?: number }) => void = () => {};
  const write = vi.fn(),
    resize = vi.fn(),
    kill = vi.fn(() => exit({ exitCode: 0 }));
  const fake = vi.fn(
    () =>
      ({
        pid: 2147483647,
        write,
        resize,
        kill,
        onData(listener: typeof output) {
          output = listener;
          return { dispose() {} };
        },
        onExit(listener: typeof exit) {
          exit = listener;
          return { dispose() {} };
        },
      }) as unknown as IPty,
  );
  let spawnedPid = 0;
  const runtime = real
    ? new TerminalRuntime(
        () => state,
        (_shell, _args, options) => {
          const pty = spawn("/bin/sh", [], {
            ...options,
            env: { PATH: "/bin:/usr/bin", HOME: cwd, TERM: "xterm-256color" },
          });
          spawnedPid = pty.pid;
          return pty;
        },
      )
    : new TerminalRuntime(() => state, fake as unknown as typeof spawn);
  cleanups.push(async () => {
    await runtime.close();
    rmSync(cwd, { recursive: true, force: true });
  });
  const client = {},
    owner = "local-owner";
  const call = (
    method: string,
    params: Record<string, unknown> = {},
    commandId?: string,
    identity = owner,
    connection = client,
  ) => runtime.api(method, { threadId: "thread", ...params }, commandId, identity, connection);
  const create = () =>
    call(
      "terminal.create",
      { cols: 80, rows: 20, confirmed: true },
      "create",
    ) as Promise<TerminalInfo>;
  const attach = async (id: string) => ({
    id,
    ...((await call("terminal.attach", { id })) as { attachmentId: string }),
  });
  return {
    runtime,
    pid: () => spawnedPid,
    state,
    cwd,
    call,
    create,
    attach,
    fake,
    write,
    resize,
    output: (data: string) => output(data),
    exit: (code: number) => exit({ exitCode: code }),
  };
}
it("deduplicates creation and input retries, rejects conflicting retries and cross-device/thread access", async () => {
  const f = fixture();
  const terminal = await f.create();
  expect(await f.create()).toEqual(terminal);
  expect(f.fake).toHaveBeenCalledTimes(1);
  const params = { id: terminal.id, data: "synthetic\r" };
  await f.call("terminal.input", params, "input");
  await f.call("terminal.input", params, "input");
  expect(f.write).toHaveBeenCalledTimes(1);
  await expect(f.call("terminal.input", { ...params, data: "other" }, "input")).rejects.toThrow(
    "terminal_command_conflict",
  );
  await expect(
    f.call("terminal.attach", { id: terminal.id }, undefined, "device:other"),
  ).rejects.toThrow("terminal_unavailable");
  await expect(f.call("terminal.attach", { id: terminal.id, threadId: "other" })).rejects.toThrow(
    "terminal_unavailable",
  );
});
it("lets another device view a terminal read-only but never type in or resize it", async () => {
  const f = fixture();
  const terminal = await f.create();
  const phone = {},
    device = "device:phone";
  const as = (method: string, params: Record<string, unknown>, commandId?: string) =>
    f.call(method, params, commandId, device, phone);
  expect(((await as("terminal.list", {})) as { items: TerminalInfo[] }).items).toEqual([]);
  expect(
    ((await as("terminal.list", { readOnly: true })) as { items: TerminalInfo[] }).items,
  ).toEqual([terminal]);
  const { attachmentId } = (await as("terminal.attach", { id: terminal.id, readOnly: true })) as {
    attachmentId: string;
  };
  f.output("build ok\r\n");
  const read = (await as("terminal.read", {
    id: terminal.id,
    attachmentId,
    offset: 0,
  })) as TerminalOutput;
  expect(read.data).toBe("build ok\r\n");
  for (const [method, params] of [
    ["terminal.input", { id: terminal.id, data: "\u0003" }],
    ["terminal.resize", { id: terminal.id, cols: 40, rows: 10 }],
    ["terminal.close", { id: terminal.id }],
  ] as const)
    await expect(as(method, params, `phone-${method}`), method).rejects.toThrow(
      "terminal_unavailable",
    );
  expect(f.write).not.toHaveBeenCalled();
  // A read-only attachment never becomes an owner's attachment, even for its own socket.
  await expect(
    f.call("terminal.read", { id: terminal.id, attachmentId, offset: 0 }, undefined, device, {}),
  ).rejects.toThrow("terminal_attachment_unavailable");
  await as("terminal.detach", { id: terminal.id, attachmentId });
});
it("detaches without stopping, replays bounded UTF-8 output, and binds readers to their socket", async () => {
  const f = fixture();
  const terminal = await f.create();
  const scope = await f.attach(terminal.id);
  f.output("hello 🧪\r\n");
  const first = (await f.call("terminal.read", { ...scope, offset: 0 })) as TerminalOutput;
  expect(first.data).toBe("hello 🧪\r\n");
  await expect(
    f.call("terminal.read", { ...scope, offset: 0 }, undefined, "local-owner", {}),
  ).rejects.toThrow("terminal_attachment_unavailable");
  await f.call("terminal.detach", scope);
  expect(f.write).not.toHaveBeenCalled();
  f.output("🧪".repeat(200000));
  const reattached = await f.attach(terminal.id);
  const tail = (await f.call("terminal.read", { ...reattached, offset: 0 })) as TerminalOutput;
  expect(tail.truncated).toBe(true);
  expect(tail.data).not.toContain("�");
  expect(Buffer.byteLength(tail.data)).toBeLessThanOrEqual(32768);
  expect(f.fake).toHaveBeenCalledTimes(1);
  f.exit(7);
  expect(((await f.call("terminal.list")) as { items: TerminalInfo[] }).items[0]?.exitCode).toBe(7);
});
it("allows only one outstanding pull per attachment and cancels detached readers", async () => {
  const f = fixture();
  const terminal = await f.create();
  const scope = await f.attach(terminal.id);
  const read = f.call("terminal.read", { ...scope, offset: 0 });
  await expect(f.call("terminal.read", { ...scope, offset: 0 })).rejects.toThrow(
    "terminal_read_pending",
  );
  await f.call("terminal.detach", scope);
  await expect(read).rejects.toThrow("terminal_attachment_unavailable");
});
it("revalidates workspace ownership, permissions and session changes without spawning in client paths", async () => {
  const f = fixture();
  const terminal = await f.create();
  const session = f.state.session?.[0];
  if (!session) throw Error("fixture");
  session.id = "new-session";
  await expect(f.call("terminal.input", { id: terminal.id, data: "x" }, "input")).rejects.toThrow(
    "terminal_workspace_changed",
  );
  const agent = f.state.agent?.[0];
  if (!agent) throw Error("fixture");
  agent.permissionProfile = "read_only";
  await expect(f.call("terminal.list")).rejects.toThrow("terminal_permission_denied");
  expect(f.fake.mock.calls[0]).toBeDefined();
});
it("runs a real disposable PTY, survives view disconnect and reports exit status", async () => {
  const f = fixture(true);
  const terminal = await f.create();
  const scope = await f.attach(terminal.id);
  await f.call("terminal.detach", scope);
  await f.call(
    "terminal.input",
    { id: terminal.id, data: "printf 'ZOLT_SYNTHETIC_PTY_OK\\n'; exit 7\r" },
    "run",
  );
  const next = await f.attach(terminal.id);
  let offset = 0,
    data = "",
    output: TerminalOutput;
  do {
    output = (await f.call("terminal.read", { ...next, offset })) as TerminalOutput;
    data += output.data;
    offset = output.offset;
  } while (output.terminal.status !== "exited");
  expect(data).toContain("ZOLT_SYNTHETIC_PTY_OK");
  expect(output.terminal.exitCode).toBe(7);
  expect(output.terminal.cwd).toBe(f.cwd);
}, 20000);

it("bounds shell count and input pressure while keeping explicit stop available", async () => {
  const f = fixture();
  const terminal = await f.create();
  for (let i = 0; i < 3; i++)
    await f.call("terminal.create", { confirmed: true, cols: 80, rows: 20 }, `extra:${i}`);
  await expect(
    f.call("terminal.create", { confirmed: true, cols: 80, rows: 20 }, "too-many"),
  ).rejects.toThrow("terminal_limit");
  for (let i = 0; i < 4; i++)
    await f.call("terminal.input", { id: terminal.id, data: "x".repeat(16384) }, `input:${i}`);
  await expect(
    f.call("terminal.input", { id: terminal.id, data: "x".repeat(16384) }, "overflow"),
  ).rejects.toThrow("terminal_input_backpressure");
  await f.call("terminal.close", { id: terminal.id }, "stop");
});

it("respects fork/task read-only ceilings independently of a writable profile", async () => {
  const f = fixture();
  const thread = f.state.thread?.[0];
  if (!thread) throw Error("fixture");
  thread.fork = { permissionCeiling: "read_only" };
  await expect(f.create()).rejects.toThrow("terminal_permission_denied");
  delete thread.fork;
  thread.taskId = "task";
  f.state.task = [{ id: "task", threadId: "thread", permissionCeiling: "read_only" }];
  await expect(f.create()).rejects.toThrow("terminal_permission_denied");
  expect(f.fake).not.toHaveBeenCalled();
});

it("reaps a running real PTY on graceful daemon runtime shutdown", async () => {
  const f = fixture(true);
  await f.create();
  const pid = f.pid();
  expect(pid).toBeGreaterThan(1);
  await f.runtime.close();
  expect(() => process.kill(pid, 0)).toThrow();
  await expect(f.call("terminal.list")).rejects.toThrow("terminal_runtime_closed");
});
