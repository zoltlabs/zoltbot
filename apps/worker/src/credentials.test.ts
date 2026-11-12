import { expect, it } from "vitest";
import { workerCredentials } from "./credentials.js";
import { readWorkerEnvironment } from "./environment.js";
import { workerEnvironmentFixture } from "./test-fixture.js";

it("uses the injected current token without exposing any provider secret or contacting accounts", async () => {
  const f = workerEnvironmentFixture(),
    config = readWorkerEnvironment(f.env);
  let calls = 0;
  const credentials = workerCredentials(config, async () => {
    calls++;
    throw new Error("fixture_unexpected_network");
  });
  expect(await credentials(new AbortController().signal)).toEqual({
    url: "wss://cell.example.invalid/v1/orgs/org/connect",
    token: f.env.ZOLTBOT_RUNNER_TOKEN,
    expiresAt: f.claims.exp * 1000,
  });
  expect(calls).toBe(0);
  config.clear();
});
it("rotates an expired token once for concurrent callers and binds the reply to its existing task and Cell", async () => {
  const f = workerEnvironmentFixture(),
    now = Math.floor(Date.now() / 1000),
    next = f.token({ iat: now, exp: now + 600, jti: "replacement" });
  const config = readWorkerEnvironment({
    ...f.env,
    ZOLTBOT_RUNNER_TOKEN: f.token({ iat: now - 1200, exp: now - 600 }),
  });
  let calls = 0;
  const credentials = workerCredentials(config, async (input, init) => {
    calls++;
    expect(String(input)).toBe("https://accounts.example.invalid/api/cloud/worker-token");
    expect(init?.method).toBe("POST");
    expect(init?.redirect).toBe("error");
    expect(init?.headers).toMatchObject({
      authorization: `Worker ${f.env.ZOLTBOT_WORKER_REFRESH}`,
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      orgId: "org",
      taskId: "task",
      runnerId: f.claims.device,
    });
    for (const key of [
      f.env.GITHUB_TOKEN,
      f.env.ANTHROPIC_API_KEY,
      f.env.ZOLTBOT_PRIVATE_CONTEXT_KEY,
    ])
      expect(String(init?.body)).not.toContain(key);
    await Promise.resolve();
    return Response.json({
      token: next,
      expiresAt: new Date((now + 600) * 1000).toISOString(),
      cellUrl: "https://cell.example.invalid",
    });
  });
  const [first, second] = await Promise.all([
    credentials(new AbortController().signal),
    credentials(new AbortController().signal),
  ]);
  expect(first).toEqual(second);
  expect(first.token).toBe(next);
  expect(calls).toBe(1);
  expect(await credentials(new AbortController().signal)).toEqual(first);
  expect(calls).toBe(1);
  expect(() => config.guard({ text: next })).toThrow("worker_private_value");
  config.clear();
});
it("refuses another task, another Cell, false expiry and private response content with fixed errors", async () => {
  const f = workerEnvironmentFixture(),
    now = Math.floor(Date.now() / 1000);
  const base = {
    token: f.token({ iat: now, exp: now + 600 }),
    expiresAt: new Date((now + 600) * 1000).toISOString(),
    cellUrl: "https://cell.example.invalid",
  };
  for (const input of [
    { ...base, token: f.token({ task: "other" }) },
    { ...base, cellUrl: "https://other.example.invalid" },
    { ...base, cellUrl: "https://cell.example.invalid?query=private" },
    { ...base, expiresAt: new Date((now + 601) * 1000).toISOString() },
    { ...base, apiKey: f.env.ANTHROPIC_API_KEY },
    { ...base, token: "x".repeat(70000) },
  ]) {
    const config = readWorkerEnvironment({
      ...f.env,
      ZOLTBOT_RUNNER_TOKEN: f.token({ iat: now - 1200, exp: now - 600 }),
    });
    await expect(
      workerCredentials(config, async () => Response.json(input))(new AbortController().signal),
    ).rejects.toThrow(/^worker_credentials_unavailable$/);
    config.clear();
  }
});
it("denies revoked refresh access and canceled requests without echoing response or transport errors", async () => {
  const f = workerEnvironmentFixture(),
    now = Math.floor(Date.now() / 1000),
    config = readWorkerEnvironment({
      ...f.env,
      ZOLTBOT_RUNNER_TOKEN: f.token({ iat: now - 1200, exp: now - 600 }),
    });
  const denied = workerCredentials(config, async () =>
    Response.json({ error: f.env.GITHUB_TOKEN }, { status: 403 }),
  );
  await expect(denied(new AbortController().signal)).rejects.toThrow(/^runner_access_revoked$/);
  const broken = workerCredentials(config, async () => {
    throw new Error(f.env.ANTHROPIC_API_KEY);
  });
  await expect(broken(new AbortController().signal)).rejects.toThrow(
    /^worker_credentials_unavailable$/,
  );
  const canceled = new AbortController();
  canceled.abort();
  let calls = 0;
  await expect(
    workerCredentials(config, async () => {
      calls++;
      return Response.json({});
    })(canceled.signal),
  ).rejects.toThrow(/^worker_credentials_unavailable$/);
  expect(calls).toBe(0);
  config.clear();
});
