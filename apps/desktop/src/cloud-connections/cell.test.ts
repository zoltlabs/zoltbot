import { randomBytes } from "node:crypto";
import { once } from "node:events";
import path from "node:path";
import { expect, it, vi } from "vitest";
import WebSocket from "ws";
import { startAccountBroker } from "../../../../packages/daemon/src/account-session/broker.js";
import { accountBrokerClient } from "../../../../packages/daemon/src/account-session/broker-client.js";
import type { ConnectionState } from "../../../../packages/ui/src/connection.js";
import { cloudHarness } from "../../../../tests/cloud-m1/harness.js";
import { loopbackTls } from "../../../../tests/cloud-m1/tls.js";
import { cellConnection } from "./cell.js";
import { brokerCellCredentials } from "./credentials.js";

it("keeps the Cell bearer native while following real Cell projections and dispatching scoped calls", async () => {
  const f = await cloudHarness("claude");
  const states: ConnectionState[] = [],
    tokens = new Set<string>();
  let stored: unknown;
  const broker = await startAccountBroker({
    origin: f.proxy.origin(),
    directory: path.join(f.root, "desktop-ipc"),
    referenceFile: path.join(f.root, "desktop-reference"),
    secrets: {
      async put(value) {
        stored = structuredClone(value);
        return { reference: "keychain:test-native-desktop" };
      },
      async read() {
        return structuredClone(stored);
      },
      async replace(_reference, value) {
        stored = structuredClone(value);
      },
      async remove() {
        stored = undefined;
      },
    },
    fetch: async (url, init) =>
      f.fetch(new URL(String(url)), {
        ...(init?.method ? { method: init.method } : {}),
        headers: Object.fromEntries(new Headers(init?.headers)),
        ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
      }),
  });
  const control = accountBrokerClient({ origin: f.proxy.origin(), socketPath: broker.location() });
  await control.save(f.session);
  const native = accountBrokerClient({
    origin: f.proxy.origin(),
    socketPath: broker.location(),
    expectedSessionId: f.session.sessionId,
  });
  await native.status();
  const binding = {
      userId: "member",
      sessionId: f.session.sessionId,
      orgId: "personal",
      name: "Personal organization",
    },
    credentials = brokerCellCredentials(native, binding, f.deviceId);
  const client = cellConnection({
    origin: f.proxy.origin(),
    account: {
      userId: "member",
      sessionId: f.session.sessionId,
      orgId: "personal",
      name: "Personal organization",
    },
    deviceId: f.deviceId,
    credentials: async (signal) => {
      const result = await credentials(signal);
      if (
        result &&
        typeof result === "object" &&
        "token" in result &&
        typeof result.token === "string"
      )
        tokens.add(result.token);
      return result;
    },
    socket: (url, config) => new WebSocket(url, { ...config, ca: f.tls.certificate() }),
  });
  const stop = client.subscribe((state) => states.push(state));
  try {
    await client.start();
    await expect.poll(() => states.at(-1)?.status).toBe("online");
    expect(states.at(-1)?.snapshot.entities.project).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: f.project.id })]),
    );
    const result = (await client.call("project.list", {})) as { items: Array<{ id: string }> };
    expect(result.items.some((project) => project.id === f.project.id)).toBe(true);
    const created = (await f.client.rpc(
      "cloud.project.create",
      {
        name: "Another cloud project",
        repository: "example/another",
        defaultBranch: "main",
        setupScript: "",
      },
      "native-view-project",
    )) as { id: string };
    await expect
      .poll(() =>
        states.at(-1)?.snapshot.entities.project?.some((project) => project.id === created.id),
      )
      .toBe(true);
    await expect(client.call("detect.scan", {})).rejects.toThrow("method_unavailable");
    await expect(client.call("constructor", {})).rejects.toThrow("method_unavailable");
    const visible = JSON.stringify(states);
    expect(tokens.size).toBeGreaterThan(0);
    expect([...tokens].every((token) => !visible.includes(token))).toBe(true);
    expect(visible.includes(f.session.accessToken)).toBe(false);
    expect(visible.includes(f.session.refreshToken)).toBe(false);
    await control.clear();
    await expect(credentials(new AbortController().signal)).rejects.toThrow(
      "account_session_changed",
    );
    await f.cell.close();
    await expect.poll(() => states.at(-1)?.status).toBe("offline");
    expect(
      states.at(-1)?.snapshot.entities.project?.some((project) => project.id === created.id),
    ).toBe(true);
    await expect(client.call("task.create", {}, "offline-task")).rejects.toThrow("cloud_offline");
  } finally {
    stop();
    client.stop();
    await broker.close();
    await f.close();
  }
}, 60000);

it("refuses mismatched account/device tokens before opening any Cell socket", async () => {
  const binding = {
    userId: "member",
    sessionId: "native-session",
    orgId: "personal",
    name: "Personal organization",
  };
  for (const mismatch of [
    { sub: "other" },
    { org: "other" },
    { device: "other" },
    { session: "other" },
    { kind: "mac_runner" },
  ]) {
    const claims = {
      iss: "https://account.example.invalid",
      aud: "cell",
      sub: binding.userId,
      org: binding.orgId,
      device: "device",
      session: binding.sessionId,
      surface: "desktop",
      kind: "client",
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 600,
      jti: randomBytes(16).toString("base64url"),
      ...mismatch,
    };
    const socket = vi.fn((): WebSocket => {
        throw new Error("unexpected_socket");
      }),
      states: ConnectionState[] = [];
    const client = cellConnection({
      origin: "https://cell.example.invalid",
      account: binding,
      deviceId: "device",
      socket,
      credentials: async () => ({
        token: [
          "header",
          Buffer.from(JSON.stringify(claims)).toString("base64url"),
          "signature",
        ].join("."),
        cellUrl: "https://cell.example.invalid",
        expiresAt: new Date(Date.now() + 600000).toISOString(),
      }),
    });
    client.subscribe((state) => states.push(state));
    try {
      await client.start();
      expect(socket).not.toHaveBeenCalled();
      expect(states.at(-1)).toMatchObject({
        status: "offline",
        error: "unauthorized",
        snapshot: { entities: {} },
      });
    } finally {
      client.stop();
    }
  }
});

it("treats revoked native account credentials as lost authority with no retry socket", async () => {
  for (const reason of ["account_session_changed", "sign_in_required", "account_access_revoked"]) {
    const socket = vi.fn((): WebSocket => {
        throw new Error("unexpected_socket");
      }),
      states: ConnectionState[] = [];
    const client = cellConnection({
      origin: "https://cell.example.invalid",
      account: {
        userId: "member",
        sessionId: "native-session",
        orgId: "personal",
        name: "Personal organization",
      },
      deviceId: "device",
      socket,
      credentials: async () => {
        throw new Error(reason);
      },
    });
    client.subscribe((state) => states.push(state));
    try {
      await client.start();
      expect(socket).not.toHaveBeenCalled();
      expect(states.at(-1)?.error).toBe("unauthorized");
    } finally {
      client.stop();
    }
  }
});

it("clears native Cloud projections when the authenticated upgrade is refused", async () => {
  const tls = await loopbackTls(),
    server = tls.server((_request, response) => {
      response.writeHead(401).end();
    });
  server.on("upgrade", (_request, socket) =>
    socket.end("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"),
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture_address_missing");
  const origin = `https://127.0.0.1:${address.port}`,
    claims = {
      iss: origin,
      aud: "cell",
      sub: "member",
      org: "personal",
      device: "device",
      session: "native-session",
      surface: "desktop",
      kind: "client",
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 600,
      jti: randomBytes(16).toString("base64url"),
    },
    states: ConnectionState[] = [],
    client = cellConnection({
      origin,
      account: {
        userId: "member",
        sessionId: "native-session",
        orgId: "personal",
        name: "Personal organization",
      },
      deviceId: "device",
      socket: (url, config) => new WebSocket(url, { ...config, ca: tls.certificate() }),
      credentials: async () => ({
        token: [
          "header",
          Buffer.from(JSON.stringify(claims)).toString("base64url"),
          "signature",
        ].join("."),
        cellUrl: origin,
        expiresAt: new Date(Date.now() + 600000).toISOString(),
      }),
    });
  client.subscribe((state) => states.push(state));
  try {
    await client.start();
    expect(states.at(-1)).toMatchObject({
      status: "offline",
      error: "unauthorized",
      snapshot: { entities: {} },
    });
  } finally {
    client.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
