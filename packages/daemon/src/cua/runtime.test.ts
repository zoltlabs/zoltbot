import { answerInteractions, type Command, handle } from "@zoltbot/core";
import { type connectStdio, RichToolResult } from "@zoltbot/hostmcp";
import { afterEach, expect, it, vi } from "vitest";
import { at, runtimeFixture } from "../../../../tools/fakes/src/runtime-fixture.js";
import { PrivateInputGuard } from "../private-input.js";
import { checkedArgs } from "./policy.js";
import { CuaRuntime } from "./runtime.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
  vi.useRealTimers();
});
async function fixture() {
  const f = await runtimeFixture();
  let seq = 0;
  const change = (command: Command) => {
    const commandId = `change-${++seq}`;
    f.store.dispatch(commandId, (state) =>
      handle(state, command, { commandId, at, actor: { kind: "system", id: "test" } }),
    );
  };
  change({ type: "transition", kind: "session", id: "session", to: "ready" });
  change({ type: "transition", kind: "session", id: "session", to: "running" });
  change({
    type: "create",
    kind: "turn",
    value: {
      id: "turn",
      sessionId: "session",
      threadId: "thread",
      status: "running",
      origin: "human",
      startedAt: at,
    },
  });
  const actor = { agentId: "profile", threadId: "thread", sessionId: "session", turnId: "turn" };
  const callTool = vi.fn(async (_input: unknown) => ({
    content: [
      { type: "text", text: "fresh state" },
      { type: "image", data: "cG5n", mimeType: "image/png" },
    ],
  }));
  const close = vi.fn(async () => {});
  const connect = vi.fn(async () => ({
    callTool,
    close,
    listTools: async () => ({
      tools: [
        "check_permissions",
        "end_session",
        "get_window_state",
        "list_windows",
        "click",
        "set_value",
      ].map((name) => ({
        name,
        inputSchema: { type: "object", properties: { session: { type: "string" } } },
      })),
    }),
  })) as unknown as typeof connectStdio;
  const runtime = new CuaRuntime(
    {
      store: f.store,
      privacy: new PrivateInputGuard({ store: f.store, publish() {} }),
      publish() {},
      async wake() {},
    },
    { platform: "darwin", binary: process.execPath, connect },
  );
  cleanups.push(async () => {
    await runtime.close();
    await f.close();
  });
  const call = (arguments_: unknown, id = `call-${++seq}`) =>
    runtime.call({ actor, arguments: arguments_, idempotencyKey: id });
  async function approve(kind: "human" | "system" = "human") {
    const pending = (await call({ action: "connect" })) as { interactionId: string };
    const id = `answer-${++seq}`;
    f.store.dispatch(id, (state) =>
      answerInteractions(
        state,
        [
          {
            id: pending.interactionId,
            version: 1,
            answer: {
              action: "accept",
              choice: "allow_once",
              by: { kind, id: "owner" },
              at,
              ...(kind === "system" ? { automatic: true } : {}),
            },
          },
        ],
        { commandId: id, at, actor: { kind, id: "owner" } },
      ),
    );
  }
  return { f, runtime, actor, call, approve, connect, callTool, close };
}

it("checks readiness without launching and requires human consent before connecting", async () => {
  const f = await fixture();
  expect(await f.call({ action: "status" })).toMatchObject({ permissions: "unchecked" });
  expect(await f.call({ action: "connect" })).toMatchObject({ state: "pending" });
  expect(f.connect).not.toHaveBeenCalled();
  await f.approve();
  expect(await f.call({ action: "connect" })).toBeInstanceOf(RichToolResult);
  expect(f.connect).toHaveBeenCalledOnce();
  expect(f.callTool).toHaveBeenCalledWith(
    { name: "check_permissions", arguments: { prompt: false } },
    undefined,
    { timeout: 10000 },
  );
});

it("isolates ownership, forces fresh observations and prevents mutation replay", async () => {
  const f = await fixture();
  await f.approve();
  await f.call({ action: "connect" });
  expect(
    await f.runtime.call({
      actor: { ...f.actor, sessionId: "other" },
      arguments: { action: "end" },
      idempotencyKey: "other",
    }),
  ).toMatchObject({ error: "cua_desktop_owned" });
  const click = {
    action: "call",
    tool: "click",
    args: { pid: 42, window_id: 7, element_token: "s1:2" },
  };
  expect(await f.call(click)).toMatchObject({ error: "cua_fresh_observation_required" });
  const observe = { action: "call", tool: "get_window_state", args: { pid: 42, window_id: 7 } };
  const result = (await f.call(observe)) as RichToolResult;
  expect(result.result.content[1]?.type).toBe("image");
  await f.call(click, "one-action");
  expect(f.callTool.mock.calls.at(-1)?.[0]).toMatchObject({
    name: "click",
    arguments: {
      pid: 42,
      window_id: 7,
      delivery_mode: "background",
      session: expect.stringMatching(/^zolt-/),
    },
  });
  expect(await f.call(click)).toMatchObject({ error: "cua_fresh_observation_required" });
  await f.call(observe);
  expect(await f.call(click, "one-action")).toMatchObject({
    error: "cua_action_already_attempted_observe_before_continuing",
  });
  await f.call({ action: "end" });
  expect(f.close).toHaveBeenCalledOnce();
  expect(f.callTool.mock.calls.at(-1)?.[0]).toMatchObject({ name: "end_session" });
  expect(await f.call({ action: "connect" })).toMatchObject({ state: "pending" });
});

it("does not treat automatic approval as human consent", async () => {
  const f = await fixture();
  await f.approve("system");
  expect(await f.call({ action: "connect" })).toMatchObject({ state: "denied" });
  expect(f.connect).not.toHaveBeenCalled();
});

it("expires idle ownership and closes the transport even when driver cleanup fails", async () => {
  const f = await fixture();
  await f.approve();
  await f.call({ action: "connect" });
  f.callTool.mockRejectedValueOnce(Error("cleanup refused"));
  await expect(f.runtime.release("session")).rejects.toThrow("cua_cleanup_unconfirmed");
  expect(f.close).toHaveBeenCalledOnce();
  vi.useFakeTimers();
  await f.call({ action: "connect" });
  await vi.advanceTimersByTimeAsync(300001);
  expect(await f.call({ action: "call", tool: "list_windows" })).toMatchObject({
    error: "cua_connect_required",
  });
});

it.each([
  ["run_script", { script: "anything" }],
  ["launch_app", {}],
  ["invoke_menu", { pid: 1, window_id: 2 }],
  ["click", { target: { kind: "desktop", display_id: "primary" } }],
  ["click", { pid: 1 }],
  ["click", { pid: 1, window_id: 2, delivery_mode: "foreground" }],
  ["get_window_state", { pid: 1, window_id: 2, session: "foreign" }],
  ["get_window_state", { pid: 1, window_id: 2, screenshot_out_file: "/tmp/out.png" }],
])("rejects unsupported authority: %s", (tool, args) => {
  expect(() => checkedArgs(tool as string, args as Record<string, unknown>)).toThrow();
});
