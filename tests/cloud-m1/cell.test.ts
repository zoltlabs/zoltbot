import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { expect, it } from "vitest";
import { createCloudFake } from "../../tools/fakes/src/cloud.js";
import { createCloudM1Account } from "../../tools/fakes/src/cloud-m1-account.js";
import { startTestCell } from "./cell.js";

it("runs authenticated org RPCs against the real Durable Object, refuses cross-org access and preserves state across a runtime restart", async () => {
  const root = await mkdtemp("/private/tmp/zoltbot-m1-cell-");
  let account: Awaited<ReturnType<typeof createCloudM1Account>> | undefined;
  const observed: Array<{ path: string; status?: number; active?: boolean }> = [];
  const server = createCloudFake({
    cloud: async (request) => {
      const result = await account?.handle(request);
      const value = result?.body as { active?: unknown } | undefined;
      observed.push({
        path: request.path,
        ...(result ? { status: result.status } : {}),
        ...(typeof value?.active === "boolean" ? { active: value.active } : {}),
      });
      return result;
    },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const serviceKey = randomBytes(32).toString("base64url");
  const jwksUrl = new URL("/api/cloud/jwks.json", origin);
  const options = {
    directory: root,
    jwksUrl: jwksUrl.href,
    issuer: "https://accounts.example.invalid",
    orchestratorUrl: new URL(".", jwksUrl).href,
    serviceKey,
  };
  let cell: Awaited<ReturnType<typeof startTestCell>> | undefined;
  try {
    cell = await startTestCell(options);
    account = await createCloudM1Account({
      issuer: options.issuer,
      cellUrl: cell.origin(),
      serviceKey,
    });
    const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
    const bytes = Buffer.from(await crypto.subtle.exportKey("raw", pair.publicKey));
    const deviceId = createHash("sha256").update(bytes).digest("base64url").slice(0, 22);
    const native = account.nativeSession({
      userId: "member",
      orgId: "personal",
      deviceId,
      surface: "desktop",
    });
    const headers = {
      authorization: `Bearer ${native.accessToken}`,
      "content-type": "application/json",
    };
    const registered = await fetch(new URL("/api/cloud/devices", origin), {
      method: "POST",
      headers,
      body: JSON.stringify({ deviceId, publicKey: bytes.toString("base64url") }),
    });
    expect(registered.status).toBe(200);
    const issued = await fetch(new URL("/api/cloud/cell-token", origin), {
      method: "POST",
      headers,
      body: JSON.stringify({ orgId: "personal", deviceId }),
    });
    expect(issued.status).toBe(200);
    const input = await issued.json();
    if (typeof input.token !== "string") throw new Error("fixture_token_missing");
    const rpc = (org: string, method: string, params: unknown, commandId?: string) => {
      if (!cell) throw new Error("fixture_cell_missing");
      return fetch(`${cell.origin()}/v1/orgs/${org}/rpc`, {
        method: "POST",
        headers: { authorization: `Bearer ${input.token}`, "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method,
          params,
          ...(commandId ? { commandId } : {}),
        }),
      });
    };
    expect((await rpc("other", "cloud.project.list", {})).status).toBe(401);
    const create = await rpc(
      "personal",
      "cloud.project.create",
      {
        name: "Cloud harness",
        repository: "example/repository",
        defaultBranch: "main",
        setupScript: "",
      },
      "create-project",
    );
    expect(
      create.status,
      JSON.stringify({
        observed,
        paths: cell.outboundPaths(),
      }),
    ).toBe(200);
    const project = await create.json();
    expect(project.error).toBeUndefined();
    expect(project.result?.cloud?.repository).toBe("example/repository");
    await cell.close();
    cell = await startTestCell(options);
    const listed = await (await rpc("personal", "cloud.project.list", {})).json();
    expect(listed.error).toBeUndefined();
    expect(listed.result?.items?.map((p: { id: string }) => p.id)).toEqual([project.result.id]);
    expect(cell.refusedNetwork()).toBe(0);
    await cell.close();
    cell = undefined;
    let leaked = false;
    const protectedValues = [serviceKey, native.accessToken, native.refreshToken, input.token].map(
      (value) => Buffer.from(value),
    );
    const scan = async (directory: string): Promise<void> => {
      for (const item of await readdir(directory, { withFileTypes: true })) {
        const file = path.join(directory, item.name);
        if (item.isDirectory()) await scan(file);
        else if (item.isFile()) {
          const bytes = await readFile(file);
          if (protectedValues.some((value) => bytes.includes(value))) leaked = true;
        }
      }
    };
    await scan(root);
    expect(leaked).toBe(false);
  } finally {
    await cell?.close();
    account?.clear();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
}, 30000);
