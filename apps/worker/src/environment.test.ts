import { randomBytes, randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { injectedClaims, readWorkerEnvironment } from "./environment.js";
import { workerEnvironmentFixture as fixture } from "./test-fixture.js";

it("reads one sandbox scope without exposing environment credentials through JSON or metadata", () => {
  const f = fixture(),
    config = readWorkerEnvironment(f.env);
  expect(config).toMatchObject({
    orgId: "org",
    taskId: "task",
    memberId: "member",
    runnerId: f.claims.device,
    provider: "claude",
    sleepKeepsProcesses: false,
  });
  expect(config.read("ANTHROPIC_API_KEY")).toBe(f.env.ANTHROPIC_API_KEY);
  for (const name of [
    "ZOLTBOT_RUNNER_TOKEN",
    "ZOLTBOT_WORKER_REFRESH",
    "ZOLTBOT_PRIVATE_CONTEXT_KEY",
    "GITHUB_TOKEN",
    "ANTHROPIC_API_KEY",
  ] as const) {
    expect(JSON.stringify(config)).not.toContain(f.env[name]);
    expect(() => config.guard({ text: `echo ${f.env[name]}` })).toThrow("worker_private_value");
  }
  expect(() => config.guard({ text: "Public task result" })).not.toThrow();
  config.clear();
  expect(() => config.read("GITHUB_TOKEN")).toThrow("worker_environment_closed");
  expect(() => config.guard({})).toThrow("worker_environment_closed");
});
it("requires API-key mode, refresh/private-context keys and an explicit sleep capability", () => {
  const f = fixture();
  for (const name of Object.keys(f.env)) {
    if (name === "ZOLTBOT_RUNNER_TOKEN") continue;
    const input: Record<string, string | undefined> = { ...f.env, [name]: undefined };
    expect(() => readWorkerEnvironment(input), name).toThrow(/^worker_environment_invalid$/);
  }
  expect(() => readWorkerEnvironment({ ...f.env, ZOLTBOT_PROVIDER: "codex" })).toThrow(
    /^worker_environment_invalid$/,
  );
  const codex = readWorkerEnvironment({
    ...f.env,
    ZOLTBOT_PROVIDER: "codex",
    OPENAI_API_KEY: randomBytes(32).toString("base64url"),
    ZOLTBOT_SLEEP_KEEPS_PROCESSES: "true",
  });
  expect(codex.provider).toBe("codex");
  expect(codex.sleepKeepsProcesses).toBe(true);
  codex.clear();
  expect(() =>
    readWorkerEnvironment({ ...f.env, ZOLTBOT_PRIVATE_CONTEXT_KEY: "not-a-task-key" }),
  ).toThrow(/^worker_environment_invalid$/);
});
it("boots without an initial Cell token only with the task-bound refresh capability and required secrets", () => {
  const f = fixture();
  const config = readWorkerEnvironment({ ...f.env, ZOLTBOT_RUNNER_TOKEN: undefined });
  expect(config.read("ZOLTBOT_RUNNER_TOKEN")).toBeUndefined();
  expect(config.runnerId).toBe(f.claims.device);
  config.clear();
  expect(() =>
    readWorkerEnvironment({
      ...f.env,
      ZOLTBOT_RUNNER_TOKEN: undefined,
      ZOLTBOT_WORKER_REFRESH: undefined,
    }),
  ).toThrow(/^worker_environment_invalid$/);
});
it("rejects a client, another task/member/runner and changed lifetime before dialing a Cell", () => {
  const f = fixture();
  for (const changed of [
    { org: "other" },
    { task: "other" },
    { sub: "other" },
    { device: "other" },
    { kind: "client" },
    { session: randomUUID() },
    { grant: randomUUID() },
    { exp: f.claims.iat + 601 },
    { iat: f.claims.iat + 60, exp: f.claims.iat + 600 },
  ])
    expect(() =>
      readWorkerEnvironment({ ...f.env, ZOLTBOT_RUNNER_TOKEN: f.token(changed) }),
    ).toThrow(/^worker_environment_invalid$/);
  const config = readWorkerEnvironment(f.env);
  expect(() => injectedClaims(f.token({ task: "other" }), config)).toThrow(
    /^worker_environment_invalid$/,
  );
});
it("refuses URL credentials, cleartext and query paths except explicit numeric-loopback fixtures", () => {
  const f = fixture();
  for (const origin of [
    "http://cell.example.invalid",
    "https://member:private@cell.example.invalid",
    "https://cell.example.invalid?key=value",
    "https://cell.example.invalid/path",
  ])
    expect(() => readWorkerEnvironment({ ...f.env, ZOLTBOT_CELL_URL: origin })).toThrow(
      /^worker_environment_invalid$/,
    );
  const config = readWorkerEnvironment(
    { ...f.env, ZOLTBOT_CELL_URL: "http://127.0.0.1:1234" },
    { allowLoopback: true },
  );
  expect(config.cellOrigin).toBe("http://127.0.0.1:1234");
  config.clear();
});
