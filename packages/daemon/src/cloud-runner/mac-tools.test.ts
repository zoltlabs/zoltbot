import { RichToolResult, type ToolInvocation } from "@zoltbot/hostmcp";
import type { MacExecRequest } from "@zoltbot/runner-protocol";
import type { Store } from "@zoltbot/store";
import { afterEach, expect, it, vi } from "vitest";
import { RunnerCalls } from "./calls.js";
import { runnerLease } from "./fixture.js";
import { cloudMacTools } from "./mac-tools.js";

afterEach(() => vi.useRealTimers());
function fixture() {
  const lease = runnerLease(),
    execution = lease.execution;
  if (!execution) throw new Error("fixture_execution_missing");
  execution.task.location = "sandbox";
  let running = true,
    online = true;
  const frames: { id: string; method: string; params: MacExecRequest }[] = [];
  const calls = new RunnerCalls({
    guard() {},
    send(raw) {
      const frame = raw as (typeof frames)[number];
      frames.push(frame);
      calls.receive({
        id: frame.id,
        result:
          frame.method === "mac.status.request"
            ? online
              ? {
                  available: true,
                  targetDeviceId: "mac",
                  mac: "Test Mac",
                  osVersion: "15.0",
                  cwd: "/work/src",
                }
              : { available: false, reason: "offline" }
            : {
                state: "complete",
                requestId: frame.params.requestId,
                result: {
                  requestId: frame.params.requestId,
                  taskId: lease.taskId,
                  exitCode: 0,
                  stdout: "x".repeat(6000),
                  stderr: "",
                  durationMs: 1,
                  truncated: false,
                  mac: "Test Mac",
                },
              },
      });
      return true;
    },
  });
  const input = {
    lease,
    cwd: "/work",
    baseCommit: "a".repeat(40),
    signal: new AbortController().signal,
    store: {
      record(kind: string) {
        return kind === "session"
          ? { threadId: execution.thread.id, state: running ? "running" : "closed" }
          : { sessionId: "session", status: running ? "running" : "interrupted" };
      },
    } as unknown as Store,
    assertPublic: vi.fn(async (_value: unknown) => {}),
  };
  const transport = { call: calls.call.bind(calls), flush: vi.fn(async () => {}) };
  const set = cloudMacTools(input, transport);
  const invoke = (name: string, args: unknown) => {
    const tool = set.tools.get(name);
    if (!tool) throw new Error("fixture_tool_missing");
    const call: ToolInvocation = {
      actor: {
        agentId: execution.profile.id,
        threadId: execution.thread.id,
        sessionId: "session",
        turnId: "turn",
      },
      arguments: args,
      idempotencyKey: "native-call",
    };
    return tool(call);
  };
  return {
    input,
    transport,
    set,
    frames,
    invoke,
    calls,
    offline() {
      online = false;
    },
    stop() {
      running = false;
    },
  };
}
it("uses the resolved Mac folder and preserves a bounded rich result larger than 4000 characters", async () => {
  const f = fixture();
  const result = await f.invoke("mac_exec", { command: "uname", cwd: "src" });
  expect(result).toBeInstanceOf(RichToolResult);
  const rich = result as RichToolResult;
  expect(rich.result.structuredContent?.stdout).toHaveLength(6000);
  expect(rich.result.structuredContent?.taskId).toBeUndefined();
  expect(f.frames.map((frame) => frame.method)).toEqual(["mac.status.request", "mac.exec.request"]);
  expect(f.frames[1]?.params).toMatchObject({
    taskId: f.input.lease.taskId,
    userId: f.input.lease.actor.userId,
    cwd: "/work/src",
    targetDeviceId: "mac",
    command: "uname",
  });
  expect(f.transport.flush).toHaveBeenCalledOnce();
  f.calls.close();
});
it("returns offline without requesting command execution and refuses stopped actors", async () => {
  const f = fixture();
  f.offline();
  const result = (await f.invoke("mac_exec", { command: "uname" })) as RichToolResult;
  expect(result.result.isError).toBe(true);
  expect(result.result.structuredContent?.error).toBe("mac_offline");
  expect(f.frames).toHaveLength(1);
  f.stop();
  await expect(f.invoke("mac_status", {})).rejects.toThrow("mac_unavailable");
  f.calls.close();
});
it("bounds a stalled private-context lookup and sends no request after its deadline", async () => {
  vi.useFakeTimers();
  const f = fixture();
  let release = () => {};
  f.input.assertPublic.mockImplementationOnce(
    async () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  const pending = f.invoke("mac_status", {});
  await vi.advanceTimersByTimeAsync(1900);
  expect(((await pending) as RichToolResult).result.structuredContent).toEqual({
    available: false,
    reason: "offline",
  });
  release();
  await vi.advanceTimersByTimeAsync(0);
  expect(f.frames).toHaveLength(0);
  f.calls.close();
});
it("checks private input before any RPC and rejects oversized UTF-8 stdin", async () => {
  const f = fixture();
  f.input.assertPublic.mockRejectedValueOnce(new Error("private_value_requires_secure_field"));
  await f.invoke("mac_exec", { command: "uname" });
  expect(f.frames).toHaveLength(0);
  await expect(f.invoke("mac_exec", { command: "cat", stdin: "🌈".repeat(20000) })).rejects.toThrow(
    "invalid_tool_arguments",
  );
  expect(f.frames).toHaveLength(0);
  f.calls.close();
});
