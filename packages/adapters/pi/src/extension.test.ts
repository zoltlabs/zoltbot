import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { type GateApi, type GateContext, type GateEvent, registerGate } from "./extension.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function setup(profile: string, confirm: GateContext["ui"]["confirm"] = async () => false) {
  let handler:
    | ((event: GateEvent, ctx: GateContext) => Promise<{ block: true; reason: string } | undefined>)
    | undefined;
  const api: GateApi = {
    on(_name, value) {
      handler = value;
    },
    registerMcpServer() {},
    registerTool() {},
    registerCommand() {},
    getAllTools() {
      return [{ name: "mcp__zoltbot__team_status" }];
    },
  };
  mkdirSync(".cache/tests", { recursive: true });
  const cwd = mkdtempSync(path.resolve(".cache/tests/pi-gate-"));
  roots.push(cwd);
  registerGate(api, {
    profile,
    cwd,
    hostMcp: { url: "http://127.0.0.1:1/mcp", token: "synthetic" },
    nonce: "nonce",
  });
  return Object.assign(
    (event: GateEvent) => handler?.(event, { hasUI: true, ui: { confirm, notify() {} } }),
    { cwd },
  );
}
it("blocks writes and execution in read only mode without asking", async () => {
  const gate = setup("read_only", async () => {
    throw new Error("must_not_ask");
  });
  expect(await gate({ toolName: "read", input: { path: "/work/a" } })).toBeUndefined();
  expect(await gate({ toolName: "zoltbot_ask_human", input: {} })).toBeUndefined();
  expect(await gate({ toolName: "zoltbot_ask_human_extra", input: {} })).toMatchObject({
    block: true,
  });
  expect(await gate({ toolName: "bash", input: { command: "echo" } })).toMatchObject({
    block: true,
  });
  expect(await gate({ toolName: "edit", input: { path: "/work/a" } })).toMatchObject({
    block: true,
  });
});
it("requires explicit confirmation and blocks host failure", async () => {
  for (const confirm of [
    async () => false,
    async () => {
      throw new Error("offline");
    },
  ])
    expect(
      await setup("workspace_write", confirm)({ toolName: "bash", input: { command: "echo" } }),
    ).toMatchObject({ block: true });
  expect(
    await setup(
      "workspace_write",
      async () => true,
    )({ toolName: "bash", input: { command: "echo" } }),
  ).toBeUndefined();
});
it("bounds edit paths to the workspace and rejects invalid configuration", async () => {
  const gate = setup("workspace_write");
  expect(await gate({ toolName: "write", input: { path: "a.txt" } })).toBeUndefined();
  expect(await gate({ toolName: "write", input: { path: "../outside" } })).toMatchObject({
    block: true,
  });
  expect(() => setup("unknown")).toThrow("invalid_gate_config");
});

it("rejects edits through a symlink that leaves the workspace", async () => {
  const gate = setup("workspace_write");
  symlinkSync(path.dirname(gate.cwd), path.join(gate.cwd, "escape"));
  expect(await gate({ toolName: "write", input: { path: "escape/outside.txt" } })).toMatchObject({
    block: true,
  });
});
it("waits for host tool discovery before proving readiness", async () => {
  let command: Parameters<GateApi["registerCommand"]>[1] | undefined;
  let checks = 0;
  const notices: string[] = [];
  const api: GateApi = {
    on() {},
    registerMcpServer() {},
    registerTool() {},
    registerCommand(_name, value) {
      command = value;
    },
    getAllTools() {
      return ++checks > 1 ? [{ name: "mcp__zoltbot__team_status" }] : [];
    },
  };
  registerGate(api, {
    profile: "read_only",
    cwd: process.cwd(),
    hostMcp: { url: "http://127.0.0.1:1/mcp", token: "synthetic" },
    nonce: "challenge",
  });
  await command?.handler("", {
    hasUI: true,
    ui: {
      confirm: async () => false,
      notify(message) {
        notices.push(message);
      },
    },
  });
  expect(checks).toBe(2);
  expect(notices).toEqual(["zoltbot_ready:challenge"]);
});
