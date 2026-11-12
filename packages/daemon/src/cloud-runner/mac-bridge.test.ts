import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { approvalStdinHash, createIdentity, linkId, signApproval, toB64 } from "@zoltbot/link";
import type { MacExecRequest } from "@zoltbot/runner-protocol";
import { expect, it } from "vitest";
import { type WebSocket, WebSocketServer } from "ws";
import { runnerAccount } from "./account.js";
import { type MacRunnerOptions, startMacRunner } from "./mac.js";

const quote = (value: string) => `'${value.replaceAll("'", "'\"'\"'")}'`;
it("runs only signed member commands over the runner socket and replays their result after Cell loss", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "mac-signed-bridge-")));
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture_cell_missing");
  const identity = createIdentity(),
    signer = linkId(identity.publicKey),
    deviceId = "target".padEnd(22, "x");
  const accountToken = randomBytes(32).toString("base64url"),
    runnerToken = randomBytes(32).toString("base64url");
  const registered = {
    userId: "member",
    deviceId: signer,
    publicKey: toB64(identity.publicKey),
    registeredAt: new Date().toISOString(),
  };
  const replies = new Map<
    string,
    { result?: { stdout: string; exitCode: number }; error?: unknown }
  >();
  const chunks: { requestId: string; taskId: string; chunkSeq: number; data: string }[] = [];
  let socket: WebSocket | undefined,
    hellos = 0,
    keyReads = 0,
    nativeStarts = 0,
    enrolled = false;
  let mode: "off" | "ask" | "allow_listed" = "ask";
  server.on("connection", (connected) => {
    socket = connected;
    connected.on("message", (data) => {
      const message = JSON.parse(data.toString());
      if (message.method === "runner.hello") hellos++;
      else if (message.method === "mac.exec.chunk") {
        chunks.push(message.params);
        connected.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { ok: true } }));
      } else if (typeof message.id === "string") replies.set(message.id, message);
    });
  });
  const options: MacRunnerOptions = {
    directory: root,
    memberId: "member",
    capabilities: { canRunTasks: false, canMacExec: true },
    versions: { daemon: "fixture" },
    clis: [],
    guard() {},
    account: {
      origin: "https://accounts.example.invalid",
      orgId: "org",
      deviceId,
      allowLoopback: true,
      accessToken: async () => accountToken,
      async fetch(input, init) {
        const authorized =
          new Headers(init?.headers).get("authorization") === `Bearer ${accountToken}`;
        if (!authorized) return Response.json({ error: "denied" }, { status: 401 });
        const route = new URL(String(input)).pathname;
        if (route.endsWith("runner-grants")) {
          const grant = JSON.parse(String(init?.body));
          enrolled = grant.canMacExec;
          return Response.json({
            grant: enrolled
              ? {
                  ...grant,
                  id: randomUUID(),
                  sessionId: randomUUID(),
                  expiresAt: new Date(Date.now() + 3600000).toISOString(),
                }
              : null,
          });
        }
        if (!enrolled) return Response.json({ error: "denied" }, { status: 403 });
        if (route.endsWith("devices")) {
          keyReads++;
          return Response.json({ devices: [registered] });
        }
        return Response.json({
          token: runnerToken,
          cellUrl: `http://127.0.0.1:${address.port}`,
          expiresAt: new Date(Date.now() + 600000).toISOString(),
        });
      },
    },
    async vault() {
      nativeStarts++;
      throw new Error("fixture_native_unexpected");
    },
    async tools() {
      nativeStarts++;
      throw new Error("fixture_native_unexpected");
    },
    macExecution: {
      mac: "Test Mac",
      mode: () => mode,
      environment: { HOME: root, ZDOTDIR: root, PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C" },
      shell: process.platform === "darwin" ? "/bin/zsh" : "/bin/sh",
      async task() {
        return { active: true, folder: root };
      },
    },
  };
  const request = (id: string, command: string): MacExecRequest => {
    const now = Date.now();
    return {
      requestId: id,
      taskId: "task",
      turnId: "turn",
      userId: "member",
      targetDeviceId: deviceId,
      command,
      approval: signApproval(identity, {
        v: 1,
        orgId: "org",
        userId: "member",
        signerDeviceId: signer,
        requestId: id,
        taskId: "task",
        turnId: "turn",
        targetDeviceId: deviceId,
        scope: "command",
        command,
        cwd: root,
        stdinHash: approvalStdinHash(),
        timeoutSeconds: 600,
        issuedAt: now,
        expiresAt: now + 300000,
      }),
    };
  };
  const send = (id: string, params: MacExecRequest) => {
    if (!socket) throw new Error("fixture_socket_missing");
    socket.send(JSON.stringify({ jsonrpc: "2.0", id, method: "mac.exec.request", params }));
  };
  await runnerAccount(options.account).setGrant(options.capabilities, new AbortController().signal);
  const runner = startMacRunner(options);
  try {
    await expect.poll(() => hellos).toBe(1);
    const marker = path.join(root, "once"),
      command = `printf x >> ${quote(marker)}; uname`;
    const forged = request("forged", command);
    if (forged.approval) forged.approval.signature = toB64(new Uint8Array(64));
    send("forged", forged);
    await expect.poll(() => replies.has("forged")).toBe(true);
    expect(Boolean(replies.get("forged")?.error)).toBe(true);
    expect(existsSync(marker)).toBe(false);
    const signed = request("signed", command);
    send("first", signed);
    await expect.poll(() => replies.has("first")).toBe(true);
    expect(replies.get("first")?.result?.exitCode).toBe(0);
    expect(replies.get("first")?.result?.stdout.trim()).toBe(os.type());
    await expect
      .poll(() =>
        chunks
          .filter((frame) => frame.requestId === "signed")
          .map((frame) => frame.data)
          .join("")
          .trim(),
      )
      .toBe(os.type());
    expect(chunks.every((frame) => frame.taskId === "task" && frame.chunkSeq >= 1)).toBe(true);
    expect(chunks.some((frame) => frame.requestId === "forged")).toBe(false);
    send("repeat", signed);
    await expect.poll(() => replies.has("repeat")).toBe(true);
    expect(replies.get("repeat")?.result?.stdout.trim()).toBe(os.type());
    expect(readFileSync(marker, "utf8")).toBe("x");
    const pendingMarker = path.join(root, "pending"),
      pending = request("pending", `printf x >> ${quote(pendingMarker)}; sleep 0.3; uname`);
    send("lost", pending);
    await expect.poll(() => existsSync(pendingMarker)).toBe(true);
    socket?.terminate();
    await expect.poll(() => hellos, { timeout: 5000 }).toBe(2);
    send("replayed", pending);
    await expect.poll(() => replies.has("replayed")).toBe(true);
    expect(replies.get("replayed")?.result?.stdout.trim()).toBe(os.type());
    expect(readFileSync(pendingMarker, "utf8")).toBe("x");
    mode = "off";
    send("off", request("off", "uname"));
    await expect.poll(() => replies.has("off")).toBe(true);
    expect(Boolean(replies.get("off")?.error)).toBe(true);
    expect(keyReads).toBeGreaterThanOrEqual(4);
    expect(nativeStarts).toBe(0);
    const encoded = JSON.stringify([...replies.values()]);
    expect(encoded.includes(accountToken)).toBe(false);
    expect(encoded.includes(runnerToken)).toBe(false);
    await runner.disable(new AbortController().signal);
    expect(enrolled).toBe(false);
  } finally {
    await runner.close();
    for (const client of server.clients) client.terminate();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(root, { recursive: true, force: true });
  }
});
