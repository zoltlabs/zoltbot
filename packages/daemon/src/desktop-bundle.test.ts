import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import WebSocket from "ws";

const execute = promisify(execFile);
it("boots the normal prebuilt daemon without a source loader and resolves ACP schema resources", async () => {
  mkdirSync(".cache/tests", { recursive: true });
  const root = mkdtempSync(path.resolve(".cache/tests/desktop-bundle-"));
  const env = {
    PATH: process.env.PATH ?? "",
    HOME: root,
    TMPDIR: root,
    ZOLTBOT_DATA_DIR: root,
    ZOLTBOT_REPO_ROOT: root,
  };
  let child: ReturnType<typeof spawn> | undefined;
  let socket: WebSocket | undefined;
  let closed: Promise<void> | undefined;
  try {
    await execute(process.execPath, ["scripts/build-desktop.mjs"], { env, timeout: 15000 });
    child = spawn(process.execPath, [path.resolve(".cache/desktop/daemon.mjs")], {
      env,
      stdio: "pipe",
    });
    closed = new Promise<void>((resolve) => child?.once("close", () => resolve()));
    const metadata = path.join(root, "daemon.json");
    await expect.poll(() => existsSync(metadata), { timeout: 5000 }).toBe(true);
    const info = JSON.parse(readFileSync(metadata, "utf8")) as {
      url: string;
      token: string;
      pid: number;
    };
    expect(info.pid).toBe(child.pid);
    socket = new WebSocket(info.url);
    await new Promise<void>((resolve, reject) => {
      socket?.once("open", resolve);
      socket?.once("error", reject);
    });
    const request = (id: number, method: string, params: unknown) =>
      new Promise<Record<string, unknown>>((resolve, reject) => {
        socket?.once("message", (data) => {
          const reply = JSON.parse(data.toString());
          if (reply.error) reject(new Error("bundled_daemon_rpc_failed"));
          else resolve(reply.result);
        });
        socket?.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
      });
    await request(1, "hello", { protocolVersion: 1, token: info.token });
    expect(await request(2, "snapshot.get", {})).toMatchObject({ seq: 0, entities: {} });
    socket.terminate();
    socket = undefined;
    child.kill("SIGTERM");
    await closed;
    expect(child.exitCode).toBe(0);
    const entry = path.join(root, "resources.ts"),
      output = path.join(root, "resources.mjs");
    writeFileSync(
      entry,
      `export { AcpAdapter } from ${JSON.stringify(path.resolve("packages/adapters/acp/src/index.ts"))};`,
    );
    await execute(process.execPath, ["scripts/bundle-runtime.mjs", entry, output], {
      env,
      timeout: 15000,
    });
    const imported = await execute(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `const m = await import(${JSON.stringify(pathToFileURL(output).href)}); if (typeof m.AcpAdapter !== 'function') throw new Error('adapter missing'); process.stdout.write('ready');`,
      ],
      { env, timeout: 5000 },
    );
    expect(imported.stdout).toBe("ready");
  } finally {
    socket?.terminate();
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await closed;
    rmSync(root, { recursive: true, force: true });
  }
});
