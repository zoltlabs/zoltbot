import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { promisify } from "node:util";
import { beforeAll, expect, it } from "vitest";
import { createFakeTarget } from "../../packages/sandbox/src/targets/fake/index.js";
import { createCloudFake } from "../../tools/fakes/src/cloud.js";
import { createCloudM1Account } from "../../tools/fakes/src/cloud-m1-account.js";
import { createSandboxHarness } from "../../tools/fakes/src/cloud-m1-orchestrator.js";
import { createCloudM1Workers } from "../../tools/fakes/src/cloud-m1-workers.js";
import { startTestCell } from "./cell.js";
import { cellClient, loopbackClient, responseJson } from "./client.js";
import { startTlsProxy } from "./proxy.js";
import { harnessRepository } from "./repository.js";
import { loopbackTls } from "./tls.js";

// Build from current source so a clean checkout cannot accidentally test a stale CLI.
beforeAll(async () => {
  try {
    await promisify(execFile)(process.execPath, ["apps/worker/build.mjs"], {
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
      timeout: 60000,
      maxBuffer: 1024 * 1024,
    });
  } catch {
    throw new Error("fixture_worker_build_failed");
  }
}, 65000);

for (const provider of ["claude", "codex"] as const) {
  it(`starts the actual ${provider} worker CLI inside the fake target and delivers native events to the real Cell`, async () => {
    const root = await mkdtemp("/private/tmp/zoltbot-m1-worker-live-");
    const target = createFakeTarget({ root: path.join(root, "sandboxes") });
    let cell: Awaited<ReturnType<typeof startTestCell>> | undefined,
      globalOrigin: string | undefined;
    const tls = await loopbackTls();
    const proxy = await startTlsProxy(tls, (pathname) =>
      pathname.startsWith("/api/")
        ? globalOrigin
          ? new URL(globalOrigin)
          : undefined
        : cell
          ? new URL(cell.origin())
          : undefined,
    );
    const serviceKey = randomBytes(32).toString("base64url");
    const account = await createCloudM1Account({
      issuer: proxy.origin(),
      cellUrl: proxy.origin(),
      serviceKey,
    });
    const workers = await createCloudM1Workers({
      issuer: proxy.origin(),
      cellUrl: proxy.origin(),
      serviceKey,
      account,
    });
    const repository = await harnessRepository(root);
    const orchestrator = createSandboxHarness({
      issuer: proxy.origin(),
      serviceKey,
      cellOrigin: proxy.origin(),
      cloudOrigin: proxy.origin(),
      target,
      account,
      workers,
      command: [process.execPath, path.resolve("apps/worker/dist/main.mjs")],
      environment: {
        ...tls.childEnvironment(),
        PATH: [repository.bin, path.dirname(process.execPath), "/usr/bin", "/bin"].join(
          path.delimiter,
        ),
      },
    });
    const global = createCloudFake({
      cloud: async (request) => (await orchestrator.handle(request)) ?? workers.handle(request),
    });
    await new Promise<void>((resolve) => global.listen(0, "127.0.0.1", resolve));
    globalOrigin = `http://127.0.0.1:${(global.address() as AddressInfo).port}`;
    try {
      const jwks = new URL("/api/cloud/jwks.json", globalOrigin);
      cell = await startTestCell({
        directory: path.join(root, "cell"),
        jwksUrl: jwks.href,
        issuer: proxy.origin(),
        orchestratorUrl: new URL(".", jwks).href,
        serviceKey,
      });
      const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
      const publicKey = Buffer.from(await crypto.subtle.exportKey("raw", pair.publicKey));
      const deviceId = createHash("sha256").update(publicKey).digest("base64url").slice(0, 22);
      const session = account.nativeSession({
        userId: "member",
        orgId: "personal",
        deviceId,
        surface: "desktop",
      });
      const fetch = loopbackClient(tls.certificate()),
        headers = { authorization: `Bearer ${session.accessToken}` };
      expect(
        (
          await fetch(new URL("/api/cloud/devices", proxy.origin()), {
            headers,
            body: { deviceId, publicKey: publicKey.toString("base64url") },
          })
        ).status,
      ).toBe(200);
      for (const [name, value] of [
        ["github", randomBytes(32).toString("base64url")],
        [provider === "claude" ? "anthropic" : "openai", randomBytes(32).toString("base64url")],
      ]) {
        const url = new URL(["", "api", "cloud", "secrets", name].join("/"), proxy.origin());
        expect((await fetch(url, { method: "PUT", headers, body: { value } })).status).toBe(200);
      }
      const token = await responseJson(
        await fetch(new URL("/api/cloud/cell-token", proxy.origin()), {
          headers,
          body: { orgId: "personal", deviceId },
        }),
      );
      if (typeof token.token !== "string") throw new Error("fixture_token_missing");
      const client = cellClient({
        origin: proxy.origin(),
        orgId: "personal",
        token: token.token,
        fetch,
      });
      const project = (await client.rpc(
        "cloud.project.create",
        {
          name: "Worker CLI",
          repository: "example/repository",
          defaultBranch: "main",
          setupScript: "",
        },
        "cli-project",
      )) as { id: string };
      const task = (await client.rpc(
        "task.create",
        {
          title: "Worker CLI",
          brief: "Complete the synthetic CLI task",
          profileId: `cloud-${provider}`,
          node: { type: "project", id: project.id },
          location: "sandbox",
        },
        "cli-task",
      )) as { id: string; threadId: string };
      const deadline = Date.now() + 30000;
      let finished = false;
      while (Date.now() < deadline) {
        const listed = (await client.rpc("task.list", { projectId: project.id })) as {
          items: Array<{ id: string; state: string }>;
        };
        if (
          listed.items.some(
            (row) => row.id === task.id && ["review", "completed"].includes(row.state),
          )
        ) {
          finished = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(finished, JSON.stringify(orchestrator.summaries())).toBe(true);
      const history = (await client.rpc("thread.history", {
        threadId: task.threadId,
        limit: 200,
      })) as { items: Array<{ kind: string; body?: { text?: string } }> };
      expect(
        history.items.some((item) => item.kind === "message" && item.body?.text?.includes("ok")),
      ).toBe(true);
      expect(orchestrator.summaries().filter((job) => job.state === "running")).toHaveLength(1);
      expect(cell.refusedNetwork()).toBe(0);
      await orchestrator.deleteOrg("personal");
      expect(
        await target.find({
          "zoltbot.org": createHash("sha256").update(JSON.stringify("personal")).digest("hex"),
        }),
      ).toEqual([]);
    } finally {
      await orchestrator.deleteOrg("personal").catch(() => {});
      await target.dispose();
      await cell?.close();
      account.clear();
      workers.clearOrg("personal");
      await proxy.close();
      global.closeAllConnections();
      await new Promise<void>((resolve) => global.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  }, 45000);
}
