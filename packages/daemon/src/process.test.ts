import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, expect, it } from "vitest";
import WebSocket from "ws";
import { readyChild } from "../../../tools/fakes/src/ready-child.js";

const children: ChildProcess[] = [];
const roots: string[] = [];
afterEach(async () => {
  for (const child of children.splice(0))
    if (child.exitCode === null && child.signalCode === null) {
      const done = new Promise((resolve) => child.once("exit", resolve));
      child.kill("SIGKILL");
      await done;
    }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
async function boot(dir: string) {
  const child = spawn(process.execPath, ["--import", "tsx", "tools/fakes/src/daemon-fixture.ts"], {
    cwd: process.cwd(),
    env: {
      PATH: process.env.PATH ?? "",
      HOME: dir,
      TMPDIR: dir,
      TSX_DISABLE_CACHE: "1",
      ZOLTBOT_DATA_DIR: dir,
    },
    stdio: "pipe",
  });
  children.push(child);
  await readyChild(child);
  const file = path.join(dir, "daemon.json");
  for (let i = 0; i < 200; i++) {
    if (existsSync(file)) {
      const info = JSON.parse(readFileSync(file, "utf8")) as {
        url: string;
        token: string;
        pid: number;
      };
      if (info.pid === child.pid) return { child, ...info };
    }
    if (child.exitCode !== null) throw new Error("daemon exited before ready");
    await delay(10);
  }
  throw new Error("daemon did not become ready");
}
async function rpc(
  info: { url: string; token: string },
  method: string,
  params: unknown,
  commandId?: string,
) {
  const socket = new WebSocket(info.url);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  const request = (id: number, name: string, payload: unknown) =>
    new Promise<unknown>((resolve, reject) => {
      socket.once("message", (data) => {
        const reply = JSON.parse(data.toString());
        if (reply.error) reject(new Error(reply.error.message));
        else resolve(reply.result);
      });
      socket.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          method: name,
          params: payload,
          ...(commandId ? { commandId } : {}),
        }),
      );
    });
  try {
    await request(1, "hello", { protocolVersion: 1, token: info.token });
    return await request(2, method, params);
  } finally {
    socket.terminate();
  }
}
it("runs as a separate process, survives client loss, and preserves committed state after SIGKILL", async () => {
  mkdirSync(".cache/tests", { recursive: true });
  const dir = mkdtempSync(path.resolve(".cache/tests/daemon-process-"));
  roots.push(dir);
  const first = await boot(dir);
  await rpc(first, "settings.set", { key: "theme", value: "dark" }, "persistent-setting");
  const ended = new Promise((resolve) => first.child.once("exit", resolve));
  first.child.kill("SIGKILL");
  await ended;
  const second = await boot(dir);
  expect(second.token).not.toBe(first.token);
  expect(await rpc(second, "settings.get", {})).toEqual([{ key: "theme", value: "dark" }]);
  expect(await rpc(second, "snapshot.get", {})).toMatchObject({ seq: 1 });
});
