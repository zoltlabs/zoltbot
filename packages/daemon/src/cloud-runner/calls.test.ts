import { afterEach, expect, it, vi } from "vitest";
import { RunnerCalls } from "./calls.js";

afterEach(() => vi.useRealTimers());
const status = {
  requestId: "request",
  taskId: "task",
  turnId: "turn",
  userId: "member",
  targetDeviceId: "mac",
};
const exec = { ...status, command: "uname", cwd: "/work" };
function fixture() {
  const frames: { id: string; method: string; params: unknown }[] = [];
  const calls = new RunnerCalls({
    send(frame) {
      frames.push(frame as (typeof frames)[number]);
      return true;
    },
    guard() {},
  });
  return { calls, frames, signal: new AbortController().signal };
}
it("replays one request ID after reconnect and accepts only a matching bounded result", async () => {
  const f = fixture(),
    pending = f.calls.call("mac.exec.request", exec, f.signal);
  f.calls.reconnect();
  expect(f.frames).toHaveLength(2);
  expect(f.frames[0]).toEqual(f.frames[1]);
  const id = f.frames[0]?.id;
  if (!id) throw new Error("fixture_id_missing");
  expect(f.calls.receive({ id: "other", result: {} })).toBe(false);
  f.calls.receive({
    id,
    result: { state: "pending", requestId: "request", interactionId: "approval" },
  });
  expect(await pending).toEqual({
    state: "pending",
    requestId: "request",
    interactionId: "approval",
  });
  f.calls.reconnect();
  expect(f.frames).toHaveLength(2);
  f.calls.close();
});
it("bounds status to 1.9 seconds even without a connection and clears timed-out work", async () => {
  vi.useFakeTimers();
  const f = fixture();
  const pending = expect(f.calls.call("mac.status.request", status, f.signal)).rejects.toThrow(
    /^runner_call_unavailable$/,
  );
  await vi.advanceTimersByTimeAsync(1900);
  await pending;
  f.calls.reconnect();
  expect(f.frames).toHaveLength(1);
  f.calls.close();
});
it("refuses mismatched request and task results without exposing error details", async () => {
  for (const result of [
    { state: "pending", requestId: "other", interactionId: "approval" },
    {
      state: "complete",
      requestId: "request",
      result: {
        requestId: "request",
        taskId: "other",
        exitCode: 0,
        stdout: "",
        stderr: "",
        truncated: false,
        durationMs: 1,
        mac: "Test Mac",
      },
    },
  ]) {
    const f = fixture(),
      pending = expect(f.calls.call("mac.exec.request", exec, f.signal)).rejects.toThrow(
        /^runner_call_unavailable$/,
      );
    f.calls.receive({ id: f.frames[0]?.id ?? "", result });
    await pending;
    f.calls.close();
  }
});
it("cancels calls, bounds concurrency and closes without retaining pending work", async () => {
  const f = fixture(),
    controller = new AbortController();
  const pending = expect(
    f.calls.call("mac.status.request", status, controller.signal),
  ).rejects.toThrow(/^runner_call_unavailable$/);
  controller.abort();
  await pending;
  const work = Array.from({ length: 16 }, () =>
    expect(f.calls.call("mac.exec.request", exec, f.signal)).rejects.toThrow(
      /^runner_call_unavailable$/,
    ),
  );
  await expect(f.calls.call("mac.exec.request", exec, f.signal)).rejects.toThrow(
    /^runner_call_unavailable$/,
  );
  f.calls.close();
  await Promise.all(work);
  const before = f.frames.length;
  f.calls.reconnect();
  expect(f.frames).toHaveLength(before);
  await expect(f.calls.call("mac.status.request", status, f.signal)).rejects.toThrow(
    /^runner_call_unavailable$/,
  );
});
