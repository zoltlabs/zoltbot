import { describe, expect, it } from "vitest";
import { SandboxError } from "../../interface.js";
import { collect } from "../../stream.js";
import { createE2bTarget, type E2bHandle, type E2bInstance, type E2bSdk } from "./index.js";

const apiKey = "e2b_test_key_not_real_0123456789";
const named = (name: string, message = name) => Object.assign(new Error(message), { name });

function stub(overrides: Partial<E2bSdk> = {}, instance: Partial<E2bInstance> = {}) {
  const calls: Array<[string, unknown]> = [];
  const box: E2bInstance = {
    sandboxId: "sbx-1",
    run: async () => ({ wait: async () => ({ exitCode: 0 }), kill: async () => true }),
    read: async () => new Uint8Array(),
    write: async () => undefined,
    list: async () => [],
    getHost: (port) => `${port}-sbx-1.e2b.app`,
    pause: async () => true,
    createSnapshot: async () => ({ snapshotId: "snap-1" }),
    ...instance,
  };
  const sdk: E2bSdk = {
    list: async () => [],
    create: async (template, options) => {
      calls.push(["create", { template, ...options }]);
      return box;
    },
    connect: async (id) => {
      calls.push(["connect", id]);
      return box;
    },
    kill: async (id) => calls.push(["kill", id]),
    getInfo: async () => ({ state: "running" }),
    getMetrics: async () => [{ cpuUsedPct: 12, memUsed: 1024 }],
    ...overrides,
  };
  return { sdk, calls, box };
}

async function code(work: Promise<unknown>) {
  const error = await work.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(SandboxError);
  return error as SandboxError;
}

describe("e2b execution target", () => {
  it("requires a key and passes it only to the SDK", async () => {
    expect(() => createE2bTarget({ apiKey: "" })).toThrow(SandboxError);
    const { sdk, calls } = stub();
    const target = createE2bTarget({ apiKey, sdk, template: "zoltbot-base" });
    const ref = await target.create({ env: { A: "1" }, labels: { task: "t1" } });
    expect(ref).toEqual({ target: "e2b", id: "sbx-1", workdir: "/home/user" });
    expect(calls[0]).toEqual([
      "create",
      {
        template: "zoltbot-base",
        apiKey,
        envs: { A: "1" },
        metadata: { task: "t1" },
        timeoutMs: 3_600_000,
      },
    ]);
  });

  it("redacts the key and environment values from provider errors", async () => {
    const { sdk } = stub({
      create: async () => {
        throw new Error(`rejected ${apiKey} with secret-env-value`);
      },
    });
    const target = createE2bTarget({ apiKey, sdk });
    const error = await code(target.create({ env: { TOKEN: "secret-env-value" } }));
    expect(error.code).toBe("provider");
    expect(error.message).not.toContain(apiKey);
    expect(error.message).not.toContain("secret-env-value");
    expect(error.message).toContain("[redacted]");
  });

  it("maps SDK errors to sandbox error codes", async () => {
    const { sdk } = stub(
      { getInfo: async () => Promise.reject(named("SandboxNotFoundError")) },
      { read: async () => Promise.reject(named("FileNotFoundError")) },
    );
    const target = createE2bTarget({ apiKey, sdk });
    const ref = await target.create();
    expect((await code(target.files.read(ref, "missing.txt"))).code).toBe("not_found");
    expect(await target.status(ref)).toEqual({ state: "destroyed" });
    await target.destroy(ref);
    expect((await code(target.exec(ref, ["true"]))).code).toBe("gone");
    expect((await code(target.create({ size: { cpus: 2, memoryMiB: 2048 } }))).code).toBe(
      "unsupported",
    );
  });

  it("does not resume a paused sandbox it was not asked to wake", async () => {
    const { sdk, calls } = stub({ getInfo: async () => ({ state: "paused" }) });
    const target = createE2bTarget({ apiKey, sdk });
    const ref = { target: "e2b", id: "sbx-9", workdir: "/home/user" };
    expect((await code(target.files.read(ref, "a"))).code).toBe("not_running");
    expect(await target.status(ref)).toEqual({ state: "sleeping" });
    expect(calls.some(([name]) => name === "connect")).toBe(false);
    await target.wake(ref);
    expect(calls).toContainEqual(["connect", "sbx-9"]);
  });

  it("streams exec output, quotes argv and reports exit codes and kills", async () => {
    let command = "";
    let finish: (value: { exitCode: number }) => void = () => undefined;
    let fail: (error: unknown) => void = () => undefined;
    const { sdk } = stub(
      {},
      {
        run: async (line, options) => {
          command = line;
          options.onStdout("out");
          options.onStderr("err");
          const handle: E2bHandle = {
            wait: () =>
              new Promise((resolve, reject) => {
                finish = resolve;
                fail = reject;
              }),
            kill: async () => {
              fail(Object.assign(named("CommandExitError"), { exitCode: -1 }));
              return true;
            },
          };
          return handle;
        },
      },
    );
    const target = createE2bTarget({ apiKey, sdk });
    const ref = await target.create();
    const process = await target.exec(ref, ["echo", "a b", "c'd"]);
    expect(command).toBe(`echo 'a b' 'c'\\''d'`);
    fail(Object.assign(named("CommandExitError"), { exitCode: 3 }));
    expect(await collect(process)).toEqual({ stdout: "out", stderr: "err", code: 3 });
    const long = await target.exec(ref, ["sleep", "60"]);
    await long.kill();
    expect(await long.exit).toEqual({ code: null, killed: true });
    const fine = await target.exec(ref, ["true"]);
    finish({ exitCode: 0 });
    expect((await fine.exit).code).toBe(0);
  });

  it("exposes ports on the provider host and reports usage", async () => {
    const { sdk } = stub();
    const target = createE2bTarget({ apiKey, sdk });
    const ref = await target.create();
    expect(await target.ports.expose(ref, 3000)).toBe("https://3000-sbx-1.e2b.app");
    expect(await target.snapshot(ref)).toEqual({ target: "e2b", id: "snap-1" });
    expect(await target.status(ref)).toEqual({
      state: "running",
      usage: { cpuPercent: 12, memoryBytes: 1024 },
    });
  });
});
