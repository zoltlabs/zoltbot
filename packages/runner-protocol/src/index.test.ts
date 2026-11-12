import { Value } from "@sinclair/typebox/value";
import { expect, it } from "vitest";
import { parseRunnerMessage, runnerMethods } from "./index.js";

it("validates every runner method as a JSON-RPC 2.0 message", () => {
  for (const [method, schema] of Object.entries(runnerMethods)) {
    const params =
      method === "runner.heartbeat"
        ? { runnerId: "runner", leaseIds: [], at: "2026-11-11T00:00:00Z" }
        : Value.Create(schema);
    expect(
      () => parseRunnerMessage({ jsonrpc: "2.0", id: 1, method, params }),
      method,
    ).not.toThrow();
    expect(() => parseRunnerMessage({ jsonrpc: "1.0", id: 1, method, params }), method).toThrow();
  }
});
it("refuses unknown commands, invalid event sequence numbers and excessive Mac execution timeouts", () => {
  expect(() =>
    parseRunnerMessage({ jsonrpc: "2.0", id: 1, method: "runner.unknown", params: {} }),
  ).toThrow();
  const params = Value.Create(runnerMethods["runner.event"]);
  expect(() =>
    parseRunnerMessage({
      jsonrpc: "2.0",
      id: 1,
      method: "runner.event",
      params: { ...params, runnerSeq: -1 },
    }),
  ).toThrow();
  const request = Value.Create(runnerMethods["mac.exec.request"]);
  expect(() =>
    parseRunnerMessage({
      jsonrpc: "2.0",
      id: 1,
      method: "mac.exec.request",
      params: { ...request, timeoutSeconds: 3601 },
    }),
  ).toThrow();
});

it("keeps the generated runner schema current", async () => {
  const { readFile } = await import("node:fs/promises");
  const { runnerProtocolVersion, RunnerMessageSchema, runnerResults } = await import("./index.js");
  const generated = JSON.parse(
    await readFile(new URL("../schema/messages.json", import.meta.url), "utf8"),
  );
  expect(generated).toEqual(
    JSON.parse(
      JSON.stringify({
        runnerProtocolVersion,
        message: RunnerMessageSchema,
        methods: runnerMethods,
        results: runnerResults,
      }),
    ),
  );
});

it("accepts RPC results and errors without treating them as runner commands", () => {
  expect(
    parseRunnerMessage({ jsonrpc: "2.0", id: "collect", result: { diff: "synthetic" } }),
  ).toHaveProperty("result");
  expect(
    parseRunnerMessage({
      jsonrpc: "2.0",
      id: "collect",
      error: { code: -32000, message: "runner_offline" },
    }),
  ).toHaveProperty("error");
  expect(() =>
    parseRunnerMessage({ jsonrpc: "2.0", id: "collect", result: {}, method: "runner.stop" }),
  ).toThrow();
});

it("requires an exact commit and task revision for branch publication", () => {
  const params = {
    taskId: "task",
    leaseId: "lease",
    commandId: "publish",
    command: { type: "push_branch", branch: "zoltbot/task", head: "a".repeat(40), revision: 1 },
  };
  const message = { jsonrpc: "2.0", id: 1, method: "runner.command", params };
  expect(() => parseRunnerMessage(message)).not.toThrow();
  for (const command of [
    { type: "push_branch", branch: "zoltbot/task" },
    { ...params.command, head: "HEAD" },
    { ...params.command, revision: 0 },
    { ...params.command, previousHead: "main" },
  ]) {
    expect(() => parseRunnerMessage({ ...message, params: { ...params, command } })).toThrow();
  }
});
