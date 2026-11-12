import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { runnerAccount } from "./account.js";
import { type MacRunnerOptions, startMacRunner } from "./mac.js";

it("uses an explicitly enrolled grant, connects with a short-lived token and withdraws them before disabling", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "zoltbot-mac-runner-")),
    server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture_cell_missing");
  const deviceId = "device".padEnd(22, "x"),
    accountToken = randomBytes(32).toString("base64url"),
    runnerToken = randomBytes(32).toString("base64url");
  const grants: unknown[] = [],
    messages: Record<string, unknown>[] = [],
    requests: string[] = [];
  let bridgeCalls = 0,
    nativeCalls = 0,
    authenticated = false,
    revoked = false;
  server.on("connection", (socket, request) => {
    authenticated = request.headers.authorization === `Bearer ${runnerToken}`;
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString());
      messages.push(message);
      if (message.method === "runner.hello")
        socket.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id: "bridge",
            method: "mac.exec.request",
            params: {
              requestId: "request",
              taskId: "task",
              turnId: "turn",
              userId: "member",
              targetDeviceId: deviceId,
              command: "uname",
            },
          }),
        );
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
      fetch: async (input, init) => {
        requests.push(String(input));
        expect(init?.headers).toMatchObject({ authorization: `Bearer ${accountToken}` });
        const payload = JSON.parse(String(init?.body));
        if (String(input).endsWith("runner-grants")) {
          grants.push(payload);
          return Response.json({
            grant:
              payload.canRunTasks || payload.canMacExec
                ? {
                    ...payload,
                    id: randomUUID(),
                    sessionId: randomUUID(),
                    expiresAt: new Date(Date.now() + 86400000).toISOString(),
                  }
                : null,
          });
        }
        if (revoked) return Response.json({ error: "runner_grant_required" }, { status: 403 });
        return Response.json({
          token: runnerToken,
          expiresAt: new Date(Date.now() + 600000).toISOString(),
          cellUrl: `http://127.0.0.1:${address.port}`,
        });
      },
    },
    vault: async () => {
      nativeCalls++;
      throw new Error("fixture_native_unexpected");
    },
    tools: async () => {
      nativeCalls++;
      throw new Error("fixture_native_unexpected");
    },
    macExecution: {
      mac: "Test Mac",
      environment: { HOME: root, ZDOTDIR: root, PATH: "/usr/bin:/bin" },
      mode: () => "ask",
      async task() {
        bridgeCalls++;
        return { active: true, folder: root };
      },
    },
  };
  await runnerAccount(options.account).setGrant(options.capabilities, new AbortController().signal);
  const runner = startMacRunner(options);
  try {
    await expect
      .poll(() => messages.some((message) => message.id === "bridge" && message.error))
      .toBe(true);
    expect(authenticated).toBe(true);
    expect(bridgeCalls).toBe(0);
    expect(nativeCalls).toBe(0);
    expect(messages.find((message) => message.method === "runner.hello")?.params).toMatchObject({
      kind: "mac",
      runnerId: deviceId,
      acceptTasks: false,
    });
    expect(grants).toEqual([{ deviceId, canRunTasks: false, canMacExec: true }]);
    revoked = true;
    for (const socket of server.clients) socket.close();
    await expect
      .poll(() => requests.filter((url) => url.endsWith("runner-token")).length, { timeout: 5000 })
      .toBe(2);
    expect(grants).toHaveLength(1);
    expect(bridgeCalls).toBe(0);
    await runner.disable(new AbortController().signal);
    expect(grants.at(-1)).toEqual({ deviceId, canRunTasks: false, canMacExec: false });
    expect(requests).toHaveLength(4);
    expect(JSON.stringify(messages)).not.toContain(accountToken);
    expect(JSON.stringify(messages)).not.toContain(runnerToken);
  } finally {
    await runner.close();
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(root, { recursive: true, force: true });
  }
});

it("refuses implicit opt-in and a bridge grant without its verified execution host before network access", () => {
  for (const capabilities of [
    { canRunTasks: false, canMacExec: false },
    { canRunTasks: false, canMacExec: true },
  ]) {
    expect(() => startMacRunner({ capabilities } as MacRunnerOptions)).toThrow(
      "runner_opt_in_required",
    );
  }
});
