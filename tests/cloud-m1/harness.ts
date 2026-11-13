import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { promisify } from "node:util";
import { expect } from "vitest";
import { serviceToken } from "../../packages/cell/src/service.js";
import { createFakeTarget } from "../../packages/sandbox/src/targets/fake/index.js";
import { createCloudFake } from "../../tools/fakes/src/cloud.js";
import { createCloudM1Account } from "../../tools/fakes/src/cloud-m1-account.js";
import { createSandboxHarness } from "../../tools/fakes/src/cloud-m1-orchestrator.js";
import { createCloudM1Publication } from "../../tools/fakes/src/cloud-m1-publication.js";
import { createCloudM1Workers } from "../../tools/fakes/src/cloud-m1-workers.js";
import { startTestCell } from "./cell.js";
import { cellClient, loopbackClient, responseJson } from "./client.js";
import { type FrameHook, startTlsProxy } from "./proxy.js";
import { harnessRepository } from "./repository.js";
import { loopbackTls } from "./tls.js";

// Build from current source so a clean checkout cannot accidentally test a stale CLI.
let built: Promise<void> | undefined;
export const buildTestWorker = () =>
  (built ??= (async () => {
    try {
      await promisify(execFile)(process.execPath, ["apps/worker/build.mjs"], {
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
        timeout: 60000,
        maxBuffer: 1024 * 1024,
      });
    } catch {
      throw new Error("fixture_worker_build_failed");
    }
  })());

export async function cloudHarness(
  provider: "claude" | "codex",
  options: { now?: () => number; limitSeconds?: number; transformFrame?: FrameHook } = {},
) {
  await buildTestWorker();
  const root = await mkdtemp("/private/tmp/zoltbot-m1-worker-live-");
  const target = createFakeTarget({ root: path.join(root, "sandboxes") });
  let cell: Awaited<ReturnType<typeof startTestCell>> | undefined, globalOrigin: string | undefined;
  const tls = await loopbackTls();
  const proxy = await startTlsProxy(
    tls,
    (pathname) =>
      pathname.startsWith("/api/")
        ? globalOrigin
          ? new URL(globalOrigin)
          : undefined
        : cell
          ? new URL(cell.origin())
          : undefined,
    options.transformFrame,
  );
  const serviceKey = randomBytes(32).toString("base64url");
  const fetch = loopbackClient(tls.certificate());
  let removeAccount = async (_scope: { userId: string; orgId: string }): Promise<void> => {
    throw new Error("fixture_deletion_not_ready");
  };
  const account = await createCloudM1Account({
    issuer: proxy.origin(),
    cellUrl: proxy.origin(),
    serviceKey,
    deleteAccount: (scope) => removeAccount(scope),
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
    ...options,
    command: [process.execPath, path.resolve("apps/worker/dist/main.mjs")],
    environment: {
      ...tls.childEnvironment(),
      PATH: [repository.bin, path.dirname(process.execPath), "/usr/bin", "/bin"].join(
        path.delimiter,
      ),
    },
  });
  const publication = createCloudM1Publication({
    issuer: proxy.origin(),
    serviceKey,
    orgId: "personal",
    repository: "example/repository",
    base: "main",
    async branchHead(branch) {
      return repository
        .git(root, [
          "--git-dir",
          repository.remote,
          "rev-parse",
          "--verify",
          `refs/heads/${branch}`,
        ])
        .toString()
        .trim();
    },
  });
  removeAccount = async (scope) => {
    if (scope.orgId !== "personal" || scope.userId !== "member")
      throw new Error("fixture_deletion_scope_refused");
    await orchestrator.deleteOrg(scope.orgId);
    const result = await fetch(new URL(`/v1/orgs/${scope.orgId}`, proxy.origin()), {
      method: "DELETE",
      headers: {
        authorization: `Bearer ${await serviceToken(serviceKey, proxy.origin(), "cell-service", scope.orgId)}`,
      },
    });
    if (result.status !== 200) throw new Error("fixture_cell_deletion_failed");
    workers.clearOrg(scope.orgId);
  };
  const global = createCloudFake({
    cloud: async (request) =>
      (await publication.handle(request)) ??
      (await orchestrator.handle(request)) ??
      workers.handle(request),
  });
  await new Promise<void>((resolve) => global.listen(0, "127.0.0.1", resolve));
  globalOrigin = `http://127.0.0.1:${(global.address() as AddressInfo).port}`;
  const close = async () => {
    await orchestrator.deleteOrg("personal").catch(() => {});
    await target.dispose();
    await cell?.close();
    account.clear();
    workers.clearOrg("personal");
    await proxy.close();
    global.closeAllConnections();
    await new Promise<void>((resolve) => global.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  };
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
    const headers = { authorization: `Bearer ${session.accessToken}` };
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
    return Object.freeze({
      root,
      target,
      tls,
      account,
      workers,
      repository,
      orchestrator,
      publication,
      proxy,
      cell,
      fetch,
      client,
      project,
      deviceId,
      session,
      close,
      async task(brief = "Complete the synthetic CLI task", id = "cli-task") {
        return (await client.rpc(
          "task.create",
          {
            title: "Worker CLI",
            brief,
            profileId: `cloud-${provider}`,
            node: { type: "project", id: project.id },
            location: "sandbox",
          },
          id,
        )) as { id: string; threadId: string };
      },
    });
  } catch (error) {
    await close();
    throw error;
  }
}
