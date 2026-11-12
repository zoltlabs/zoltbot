import { randomBytes, randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { runnerAccount } from "./account.js";

const deviceId = "device".padEnd(22, "x"),
  signal = () => new AbortController().signal;
function fixture() {
  const accessToken = randomBytes(32).toString("base64url"),
    runnerToken = randomBytes(32).toString("base64url");
  const requests: { url: string; input: RequestInit | undefined }[] = [];
  let result: unknown = {
    token: runnerToken,
    cellUrl: "https://cell.example.invalid",
    expiresAt: new Date(Date.now() + 600000).toISOString(),
  };
  let status = 200,
    media = "application/json";
  const options = {
    origin: "https://accounts.example.invalid",
    orgId: "org",
    deviceId,
    accessToken: async () => accessToken,
    fetch: async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(input), input: init });
      return new Response(JSON.stringify(result), { status, headers: { "content-type": media } });
    },
  };
  return {
    options,
    requests,
    accessToken,
    runnerToken,
    client: runnerAccount(options),
    response(value: unknown, code = 200, contentType = "application/json") {
      result = value;
      status = code;
      media = contentType;
    },
  };
}
it("uses the native account bearer only for the configured service and converts the returned Cell origin", async () => {
  const f = fixture();
  const result = await f.client.credentials(signal());
  expect(result).toMatchObject({
    url: "wss://cell.example.invalid/v1/orgs/org/connect",
    token: f.runnerToken,
  });
  expect(f.requests).toHaveLength(1);
  expect(f.requests[0]?.url).toBe("https://accounts.example.invalid/api/cloud/runner-token");
  const request = f.requests[0]?.input;
  expect(request?.method).toBe("POST");
  expect(request?.redirect).toBe("error");
  expect(request?.headers).toMatchObject({ authorization: `Bearer ${f.accessToken}` });
  expect(JSON.parse(String(request?.body))).toEqual({ orgId: "org", deviceId });
  expect(JSON.stringify(result).includes(f.accessToken)).toBe(false);
});
it("reads registered public device keys only through its own bounded account request", async () => {
  const f = fixture(),
    devices = [
      {
        userId: "member",
        deviceId,
        publicKey: randomBytes(32).toString("base64url"),
        registeredAt: new Date().toISOString(),
      },
    ];
  f.response({ devices });
  expect(await f.client.deviceKeys(signal())).toEqual(devices);
  expect(f.requests[0]?.url).toBe("https://accounts.example.invalid/api/cloud/devices");
  expect(f.requests[0]?.input?.method).toBe("GET");
  expect(f.requests[0]?.input?.body).toBeUndefined();
  expect(JSON.stringify(devices).includes(f.accessToken)).toBe(false);
  f.response({ devices, unexpected: true });
  await expect(f.client.deviceKeys(signal())).rejects.toThrow(/^runner_account_unavailable$/);
  f.response({ error: "revoked" }, 403);
  await expect(f.client.deviceKeys(signal())).rejects.toThrow(/^runner_access_revoked$/);
});
it("sets only explicitly supplied task and bridge capabilities and verifies the returned grant", async () => {
  const f = fixture(),
    grant = {
      id: randomUUID(),
      deviceId,
      sessionId: randomUUID(),
      canRunTasks: false,
      canMacExec: true,
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
    };
  f.response({ grant });
  expect(await f.client.setGrant({ canRunTasks: false, canMacExec: true }, signal())).toEqual({
    grant,
  });
  expect(f.requests[0]?.input?.method).toBe("PUT");
  expect(JSON.parse(String(f.requests[0]?.input?.body))).toEqual({
    deviceId,
    canRunTasks: false,
    canMacExec: true,
  });
  f.response({ grant: null });
  expect(await f.client.setGrant({ canRunTasks: false, canMacExec: false }, signal())).toEqual({
    grant: null,
  });
  await expect(
    f.client.setGrant({ canRunTasks: true, canMacExec: false }, signal()),
  ).rejects.toThrow(/^runner_account_unavailable$/);
  f.response({ grant: { ...grant, deviceId: "different".padEnd(22, "x") } });
  await expect(
    f.client.setGrant({ canRunTasks: false, canMacExec: true }, signal()),
  ).rejects.toThrow(/^runner_account_unavailable$/);
});
it("refuses cleartext, URL credentials, paths and query strings before requesting an account token", () => {
  const f = fixture();
  for (const origin of [
    "http://accounts.example.invalid",
    "https://member:private@example.invalid",
    "https://accounts.example.invalid/path",
    "https://accounts.example.invalid?private=value",
    "invalid",
  ])
    expect(() => runnerAccount({ ...f.options, origin })).toThrow(/^runner_account_unavailable$/);
  expect(f.requests).toEqual([]);
  expect(() =>
    runnerAccount({ ...f.options, origin: "http://127.0.0.1:1234", allowLoopback: true }),
  ).not.toThrow();
  expect(() =>
    runnerAccount({ ...f.options, origin: "http://localhost:1234", allowLoopback: true }),
  ).toThrow(/^runner_account_unavailable$/);
});
it("rejects unsafe Cell URLs, expired or overlong credentials and unknown response fields", async () => {
  const f = fixture(),
    valid = {
      token: f.runnerToken,
      cellUrl: "https://cell.example.invalid",
      expiresAt: new Date(Date.now() + 600000).toISOString(),
    };
  for (const result of [
    { ...valid, cellUrl: "http://cell.example.invalid" },
    { ...valid, cellUrl: "https://member:private@cell.example.invalid" },
    { ...valid, cellUrl: "https://cell.example.invalid/other" },
    { ...valid, expiresAt: new Date(0).toISOString() },
    { ...valid, expiresAt: new Date(Date.now() + 3600000).toISOString() },
    { ...valid, token: "x\r\ny" },
    { ...valid, token: "x".repeat(8193) },
    { ...valid, private: f.accessToken },
  ]) {
    f.response(result);
    await expect(f.client.credentials(signal())).rejects.toThrow(/^runner_account_unavailable$/);
  }
});
it("bounds response bytes and returns fixed errors without account/provider response content", async () => {
  const f = fixture();
  for (const [value, status, media] of [
    [{ error: f.accessToken }, 403, "application/json"],
    [{ token: "x".repeat(70000) }, 200, "application/json"],
    [{ error: f.runnerToken }, 200, "text/plain"],
  ] as const) {
    f.response(value, status, media);
    await expect(f.client.credentials(signal())).rejects.toThrow(
      status === 403 ? /^runner_access_revoked$/ : /^runner_account_unavailable$/,
    );
  }
  const broken = runnerAccount({
    ...f.options,
    fetch: async () => {
      throw new Error(f.accessToken);
    },
  });
  await expect(broken.credentials(signal())).rejects.toThrow(/^runner_account_unavailable$/);
});
it("cancels a blocked keychain read without ever starting a network request", async () => {
  const f = fixture(),
    controller = new AbortController();
  const client = runnerAccount({
    ...f.options,
    accessToken: async () => new Promise<string>(() => {}),
  });
  const pending = client.credentials(controller.signal);
  controller.abort();
  await expect(pending).rejects.toThrow(/^runner_account_unavailable$/);
  expect(f.requests).toEqual([]);
});

it("treats explicit authentication or grant refusal as revoked authority without exposing response bodies", async () => {
  const f = fixture();
  for (const status of [401, 403, 410]) {
    f.response({ error: f.accessToken }, status);
    await expect(f.client.credentials(signal())).rejects.toThrow(/^runner_access_revoked$/);
  }
  f.response({ error: f.accessToken }, 503);
  await expect(f.client.credentials(signal())).rejects.toThrow(/^runner_account_unavailable$/);
});
