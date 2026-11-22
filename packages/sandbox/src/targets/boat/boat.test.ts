import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ResponseError, type Sandbox } from "@boatdev/sdk";
import { describe, expect, it, vi } from "vitest";
import { runConformance, scenarios } from "../../conformance/index.js";
import type { ExecProcess, SandboxRef } from "../../interface.js";
import { collect } from "../../stream.js";
import { createFakeTarget } from "../fake/index.js";
import { type BoatSdk, boatSize, createBoatTarget } from "./index.js";

const apiKey = "synthetic-boat-fixture";
const home = "/home/user";
const missing = () => new ResponseError(new Response(null, { status: 404 }));
const atHome = (ref: SandboxRef, path?: string) =>
  path?.startsWith(home) ? `${ref.workdir}${path.slice(home.length)}` : (path ?? ref.workdir);

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "zoltbot-boat-stand-in-"));
  const fake = createFakeTarget({ root, capabilities: { sleepKeepsProcesses: false } });
  const boxes = new Map<string, { ref: SandboxRef; sandbox: Sandbox }>();
  const snapshots = new Map<string, { id: string; source: string }>();
  const previews = new Map<string, string>();
  const commands = new Map<number, { process: ExecProcess; ref: SandboxRef }>();
  let nextProcess = 0;
  const get = (id: string) => {
    const item = boxes.get(id);
    if (!item) throw missing();
    return item;
  };
  const action = (id: string, status: string) => ({ ok: true, type: "sandbox.action", id, status });
  const sdk = {
    create: vi.fn<BoatSdk["create"]>(async (request) => {
      if (!request || !("createSandboxRequest" in request) || !request.createSandboxRequest)
        throw new Error("The fixture requires a create request body");
      const body = request.createSandboxRequest;
      const snapshot = body.from && snapshots.get(body.from);
      const ref = await fake.create({
        ...(snapshot ? { from: { target: fake.id, id: snapshot.id } } : {}),
        ...(body.env ? { env: body.env } : {}),
        ...(body.labels ? { labels: body.labels } : {}),
      });
      const sandbox: Sandbox = {
        id: ref.id,
        name: "fixture",
        state: "ready",
        desktopAvailable: false,
        snapshotAvailable: true,
        labels: body.labels ?? {},
      };
      boxes.set(ref.id, { ref, sandbox });
      return {
        ok: true,
        type: "sandbox.created",
        status: "ready",
        ttlSeconds: body.ttlSeconds ?? null,
        sandbox,
      };
    }),
    get: vi.fn<BoatSdk["get"]>(async ({ sandboxId }) => ({
      ok: true,
      type: "sandbox.info",
      sandbox: get(sandboxId).sandbox,
    })),
    deleteSandbox: vi.fn<BoatSdk["deleteSandbox"]>(async ({ sandboxId, xAsciiConfirmDelete }) => {
      expect(xAsciiConfirmDelete).toBe(sandboxId);
      await fake.destroy(get(sandboxId).ref);
      boxes.delete(sandboxId);
      return {
        ok: true,
        type: "deletion.operation",
        operation: {
          id: sandboxId,
          targetId: sandboxId,
          kind: "sandbox",
          reason: "explicit",
          status: "completed",
          attemptCount: 1,
          requestedAt: new Date(),
          completedAt: new Date(),
        },
      };
    }),
    getDeletionOperation: vi.fn<BoatSdk["getDeletionOperation"]>(async () => {
      throw new Error("Deletion finished synchronously in this fixture");
    }),
    stop: vi.fn<BoatSdk["stop"]>(async ({ sandboxId }) => {
      const { ref, sandbox } = get(sandboxId);
      await fake.sleep(ref);
      sandbox.state = "archived";
      return action(sandboxId, "archived");
    }),
    resume: vi.fn<BoatSdk["resume"]>(async ({ sandboxId }) => {
      const { ref, sandbox } = get(sandboxId);
      await fake.wake(ref);
      sandbox.state = "ready";
      return action(sandboxId, "ready");
    }),
    sandboxes: vi.fn<BoatSdk["sandboxes"]>(async () => ({
      ok: true,
      type: "sandbox.list",
      sandboxes: Array.from(boxes.values(), (v) => v.sandbox),
    })),
    ready: vi.fn<BoatSdk["ready"]>(async () => undefined),
    command: vi.fn<BoatSdk["command"]>(async (request) => {
      const { command, cwd } = "commandRequest" in request ? request.commandRequest : request;
      const { ref } = get(request.sandboxId);
      const process = await fake.exec(ref, ["sh", "-c", command], { cwd: atHome(ref, cwd) });
      const processId = ++nextProcess;
      commands.set(processId, { process, ref });
      return {
        ok: true,
        type: "command.started",
        success: true,
        processId,
        pid: processId,
        command,
        startedAt: new Date(),
      };
    }),
    async *follow(_id: string, processId: number) {
      const item = commands.get(processId);
      if (!item) throw missing();
      try {
        for await (const chunk of item.process)
          yield { type: chunk.stream, data: chunk.data.replaceAll(item.ref.workdir, home) };
        yield { type: "exit" as const, exitCode: (await item.process.exit).code };
      } finally {
        commands.delete(processId);
      }
    },
    stopCommand: vi.fn<BoatSdk["stopCommand"]>(async ({ processId }) => {
      await commands.get(processId)?.process.kill();
      return {
        ok: true,
        type: "command.stopped",
        processId,
        running: false,
        signaled: true,
        command: null,
      };
    }),
    execWithEnvironment: vi.fn<BoatSdk["execWithEnvironment"]>(async (_api, id, argv, cwd, env) => {
      const { ref } = get(id);
      const process = await fake.exec(ref, argv, { cwd: atHome(ref, cwd), env });
      return {
        exit: process.exit,
        kill: () => process.kill(),
        async *[Symbol.asyncIterator]() {
          for await (const chunk of process)
            yield { ...chunk, data: chunk.data.replaceAll(ref.workdir, home) };
        },
      };
    }),
    sshKey: vi.fn<BoatSdk["sshKey"]>(async () => {
      throw new Error("Unexpected SSH setup");
    }),
    readFile: vi.fn<BoatSdk["readFile"]>(async ({ sandboxId, path }) => {
      const bytes = await fake.files.read(get(sandboxId).ref, atHome(get(sandboxId).ref, path));
      return {
        ok: true,
        type: "file.read",
        success: true,
        path: path ?? ".",
        encoding: "base64",
        size: bytes.length,
        content: Buffer.from(bytes).toString("base64"),
      };
    }),
    writeFile: vi.fn<BoatSdk["writeFile"]>(async (request) => {
      const { path, content } = "fileWriteRequest" in request ? request.fileWriteRequest : request;
      const bytes = Buffer.from(content, "base64");
      const { ref } = get(request.sandboxId);
      await fake.files.write(ref, atHome(ref, path), bytes);
      return {
        ok: true,
        type: "file.written",
        success: true,
        path,
        size: bytes.length,
        encoding: "base64",
      };
    }),
    listFiles: vi.fn<BoatSdk["listFiles"]>(async ({ sandboxId, path }) => {
      const files = await fake.files.list(get(sandboxId).ref, atHome(get(sandboxId).ref, path));
      return {
        ok: true,
        type: "file.list",
        path: path ?? ".",
        truncated: false,
        files: files.map((entry) => ({
          name: entry.name,
          path: entry.name,
          size: entry.size,
          isDir: entry.type === "dir",
          isSymlink: entry.type === "symlink",
          mode: "0600",
          modifiedAt: new Date(),
        })),
      };
    }),
    hostPort: vi.fn<BoatSdk["hostPort"]>(async (request) => {
      const { sandboxId } = request;
      const { port } = "hostPortRequest" in request ? request.hostPortRequest : request;
      const url = `https://fixture.invalid:${port}/?_token=fixture`;
      previews.set(url, await fake.ports.expose(get(sandboxId).ref, port));
      return { ok: true, type: "port.host", access: "private", url };
    }),
    saveSavedSnapshot: vi.fn<BoatSdk["saveSavedSnapshot"]>(async (request) => {
      const { sandboxId, name } =
        "savedSnapshotSaveRequest" in request ? request.savedSnapshotSaveRequest : request;
      const copy = await fake.snapshot(get(sandboxId).ref);
      snapshots.set(name, { id: copy.id, source: sandboxId });
      return {
        ok: true,
        type: "snapshot.saved.saving",
        status: "saving",
        snapshot: { name, status: "saving", sourceSandboxId: sandboxId, createdAt: new Date() },
      };
    }),
    getSavedSnapshot: vi.fn<BoatSdk["getSavedSnapshot"]>(async ({ name }) => {
      const saved = snapshots.get(name);
      if (!saved) throw missing();
      return {
        ok: true,
        type: "snapshot.saved.info",
        snapshot: {
          name,
          status: "ready",
          snapshotId: saved.id,
          sourceSandboxId: saved.source,
          createdAt: new Date(),
        },
      };
    }),
  } satisfies BoatSdk;
  return {
    sdk,
    previews,
    target: createBoatTarget({ apiKey, sdk, ttlSeconds: 600 }),
    async dispose() {
      await fake.dispose();
      await rm(root, { recursive: true, force: true });
    },
  };
}

describe("Boat execution target", () => {
  it.each(scenarios)("passes conformance: %s", async (scenario) => {
    const fixture = await setup();
    const fetch = globalThis.fetch;
    const routing = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation((input, init) =>
        fetch(fixture.previews.get(String(input)) ?? input, init),
      );
    try {
      await runConformance(fixture.target, scenario);
    } finally {
      routing.mockRestore();
      await fixture.dispose();
    }
  }, 15_000);

  it("keeps previews private and requires a token-gated HTTPS URL", async () => {
    const { target, sdk, dispose } = await setup();
    try {
      const ref = await target.create();
      expect(await target.ports.expose(ref, 8080)).toBe(
        "https://fixture.invalid:8080/?_token=fixture",
      );
      expect(sdk.hostPort).toHaveBeenCalledWith({ sandboxId: ref.id, port: 8080, _public: false });
      sdk.hostPort.mockResolvedValueOnce({
        ok: true,
        type: "port.host",
        access: "private",
        url: "https://fixture.invalid:8080/",
      });
      await expect(target.ports.expose(ref, 8080)).rejects.toMatchObject({ code: "provider" });
    } finally {
      await dispose();
    }
  });

  it("keeps lookup scoped and does not wake a matching stopped sandbox", async () => {
    const { target, sdk, dispose } = await setup();
    try {
      const ref = await target.create({ labels: { task: "match" } });
      await target.create({ labels: { task: "elsewhere" } });
      await target.sleep(ref);
      expect(await target.find({ task: "match" })).toEqual([ref]);
      expect(sdk.sandboxes).toHaveBeenCalledWith({ label: ["task=match"], limit: 100 });
      await expect(target.files.read(ref, "a")).rejects.toMatchObject({ code: "not_running" });
      await expect(target.find({})).rejects.toMatchObject({ code: "invalid" });
      expect(sdk.resume).not.toHaveBeenCalled();
    } finally {
      await dispose();
    }
  });

  it("finds a labelled failed VM and resumes it from its newest snapshot", async () => {
    const { target, sdk, dispose } = await setup();
    try {
      const ref = await target.create({ labels: { task: "match" } });
      await target.create({ labels: { task: "other" } });
      await target.sleep(ref);
      (await sdk.get({ sandboxId: ref.id })).sandbox.state = "error";
      expect(await target.find({ task: "match" })).toEqual([ref]);
      expect((await target.status(ref)).state).toBe("sleeping");
      expect(sdk.resume).not.toHaveBeenCalled();
      await target.wake(ref);
      expect(sdk.resume).toHaveBeenCalledExactlyOnceWith({
        sandboxId: ref.id,
        noEnv: true,
        ttlSeconds: 600,
      });
      expect((await target.status(ref)).state).toBe("running");
    } finally {
      await dispose();
    }
  });

  it("retries only a command start that Boat confirms never executed", async () => {
    const { target, sdk, dispose } = await setup();
    try {
      const ref = await target.create();
      sdk.command.mockRejectedValueOnce(
        new ResponseError(Response.json({ retryable: true }, { status: 409 })),
      );
      expect((await collect(await target.exec(ref, ["printf", "ok"]))).stdout).toBe("ok");
      expect(sdk.command.mock.calls).toHaveLength(2);
      expect(sdk.command.mock.calls[0]).toEqual(sdk.command.mock.calls[1]);

      sdk.command.mockClear().mockRejectedValueOnce(new Error("synthetic unknown start result"));
      await expect(target.exec(ref, ["true"])).rejects.toThrow(/^Boat request failed$/);
      expect(sdk.command.mock.calls).toHaveLength(1);
    } finally {
      await dispose();
    }
  });

  it("sets the template, auto-stop and isolation settings and strips provider error text", async () => {
    const { target, sdk, dispose } = await setup();
    try {
      expect(target.capabilities).toMatchObject({
        maxLifetimeMs: 600_000,
        sleepKeepsProcesses: false,
      });
      expect(boatSize({ cpus: 2, memoryMiB: 4096 })).toBe("small");
      expect(boatSize({ cpus: 4, memoryMiB: 8192 })).toBe("default");
      expect(boatSize({ cpus: 8, memoryMiB: 16384 })).toBe("large");
      expect(() => boatSize({ cpus: 16, memoryMiB: 32768 })).toThrow("largest supported Boat tier");
      await target.create();
      expect(sdk.create).toHaveBeenCalledWith(
        expect.objectContaining({
          createSandboxRequest: {
            from: "zoltbot-base",
            type: "default",
            ttlSeconds: 600,
            noEnv: true,
            visibility: "private",
            snapshots: true,
          },
        }),
      );
      sdk.create.mockRejectedValueOnce(new Error(`${apiKey} synthetic-env-value`));
      await expect(
        target.create({ env: { EXAMPLE: "synthetic-env-value" } }),
      ).rejects.toMatchObject({
        code: "provider",
        message: "Boat request failed",
      });
    } finally {
      await dispose();
    }
  });
});
