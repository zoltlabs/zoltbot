import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as httpServer } from "node:http";
import { createServer as httpsServer, request } from "node:https";
import path from "node:path";
import type { AgentAdapter, AgentSession, OpenOptions } from "@zoltbot/adapters-sdk";
import type { AgentDefinition, Profile, Thread } from "@zoltbot/protocol";
import { openStore } from "@zoltbot/store";
import { expect, it } from "vitest";
import { ConnectionOAuth } from "../../connections/src/oauth.js";
import { ConnectionRegistry } from "../../connections/src/registry.js";
import { connectionsRuntime } from "./connections-runtime.js";
import { Redactor } from "./logging.js";
import { NativeRuntimeHost } from "./native-runtime.js";
import { KeychainSecrets } from "./secrets.js";

it("authenticates a local fake recipe, attaches it natively to one profile, calls a read-only tool and revokes resume", async () => {
  mkdirSync(".cache/tests", { recursive: true });
  const root = mkdtempSync(path.resolve(".cache/tests/connections-recipe-"));
  writeFileSync(
    path.join(root, "openssl.cnf"),
    "[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=localhost\n[ext]\nsubjectAltName=IP:127.0.0.1\nbasicConstraints=critical,CA:TRUE\n",
  );
  execFileSync(
    "/usr/bin/openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-config",
      path.join(root, "openssl.cnf"),
      "-keyout",
      path.join(root, "key.pem"),
      "-out",
      path.join(root, "cert.pem"),
    ],
    { stdio: "ignore", timeout: 10000 },
  );
  const cert = readFileSync(path.join(root, "cert.pem"));
  const privateToken = "SENTINEL_NATIVE_RECIPE_ACCESS";
  let reads = 0;
  const mcp = httpsServer({ key: readFileSync(path.join(root, "key.pem")), cert }, (req, res) => {
    if (req.headers.authorization !== `Bearer ${privateToken}`) {
      res.writeHead(401).end();
      return;
    }
    let body = "";
    req.on("data", (part) => {
      body += part;
    });
    req.on("end", () => {
      const message = JSON.parse(body) as { id: string; method: string };
      if (message.method === "tools/call") reads++;
      res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          result:
            message.method === "initialize"
              ? {
                  protocolVersion: "2025-11-25",
                  capabilities: { tools: {} },
                  serverInfo: { name: "local-fixture", version: "1" },
                }
              : { content: [{ type: "text", text: "read-only fixture result" }] },
        }),
      );
    });
  });
  await new Promise<void>((yes, no) => {
    mcp.once("error", no);
    mcp.listen(0, "127.0.0.1", yes);
  });
  const address = mcp.address();
  if (!address || typeof address === "string") throw new Error();
  const resource = `https://127.0.0.1:${address.port}/mcp`;
  const issuer = httpServer((req, res) => {
    let body = "";
    req.on("data", (part) => {
      body += part;
    });
    req.on("end", () => {
      const form = new URLSearchParams(body);
      if (form.get("resource") !== resource || !form.get("code_verifier")) {
        res.writeHead(400).end();
        return;
      }
      res
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ token_type: "Bearer", access_token: privateToken }));
    });
  });
  await new Promise<void>((yes, no) => {
    issuer.once("error", no);
    issuer.listen(0, "127.0.0.1", yes);
  });
  const issuerAddress = issuer.address();
  if (!issuerAddress || typeof issuerAddress === "string") throw new Error();
  const origin = `http://127.0.0.1:${issuerAddress.port}`;
  const values = new Map<string, string>();
  const vault = new KeychainSecrets(async (input) => {
    if (input.op === "put") {
      values.set(input.account, input.value ?? "");
      return { ok: true };
    }
    return { ok: true, value: values.get(input.account) };
  });
  const store = await openStore(path.join(root, "recipe.db"));
  try {
    const flow = await new ConnectionOAuth(vault).start({
      identity: "recipe",
      issuer: origin,
      resource,
      clientId: "local-public-client",
      authorizationEndpoint: `${origin}/authorize`,
      tokenEndpoint: `${origin}/token`,
      scopes: ["fixture:read"],
      policy: {
        origins: [origin, new URL(resource).origin],
        localOrigins: [origin, new URL(resource).origin],
      },
    });
    const authorize = new URL(flow.authorizationUrl),
      callback = new URL(authorize.searchParams.get("redirect_uri") as string);
    callback.search = new URLSearchParams({
      state: authorize.searchParams.get("state") as string,
      iss: origin,
      code: "local-one-use",
    }).toString();
    expect((await fetch(callback)).status).toBe(200);
    const credential = await flow.result;
    const registry = new ConnectionRegistry(store.database);
    registry.save(
      {
        id: "recipe",
        name: "fixture",
        version: 1,
        projectId: "project",
        transport: { kind: "https", url: resource },
        credentialReference: credential.reference,
        schemaTokens: { value: 512, source: "estimated" },
        source: "local-test",
        enabled: true,
        profileIds: ["a"],
        credentialStatus: "connected",
        health: "not_checked",
      },
      0,
      true,
    );
    const nativeCall = (
      connection: NonNullable<OpenOptions["connections"]>[number],
      method: string,
    ) =>
      new Promise<unknown>((yes, no) => {
        if (connection.kind !== "https") throw new Error();
        // Only the synthetic native client trusts this per-test CA; production trust is unchanged.
        const req = request(
          connection.url,
          {
            method: "POST",
            ca: cert,
            headers: {
              ...connection.headers,
              "content-type": "application/json",
              connection: "close",
            },
            timeout: 3000,
          },
          (res) => {
            let body = "";
            res.on("data", (part) => {
              body += part;
            });
            res.on("end", () => {
              if (res.statusCode !== 200) no(new Error("fake_auth_failed"));
              else yes(JSON.parse(body));
            });
          },
        );
        req.on("error", no);
        req.on("timeout", () => req.destroy());
        req.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: method,
            method,
            params: { name: "read_fixture", arguments: {} },
          }),
        );
      });
    let returned: unknown;
    const adapter = {
      manifest: () => ({ supportsConnections: true }),
      open: async (_definition: AgentDefinition, options: OpenOptions) => {
        expect(options.hostMcp.token).toBe("host-token");
        const external = options.connections?.[0];
        if (external) await nativeCall(external, "initialize");
        return {
          nativeId: `native-${options.identity.agentId}`,
          close: async () => {},
          send: async () => {
            if (!external) throw new Error("connection_unavailable");
            returned = await nativeCall(external, "tools/call");
            return { disposition: "started" };
          },
        } as unknown as AgentSession;
      },
    } as unknown as AgentAdapter;
    const input = {
      thread: { id: "thread-a", agentId: "a", projectId: "project" } as Thread,
      profile: {
        id: "a",
        definitionId: "fake",
        name: "A",
        avatar: "A",
        kind: "profile",
        permissionProfile: "read_only",
        instructions: "",
        hidden: false,
        archived: false,
      } as Profile,
      definition: {
        id: "fake",
        adapter: "fake",
        displayName: "Fake native client",
        binaryNames: [],
        versionCommand: [],
        testedVersions: "fixture",
        defaults: { permissionProfile: "read_only" },
        staticCapabilities: {},
        nativeSessionRoots: [],
        experimental: false,
        launch: { command: "fake", args: [], env: {} },
      } as AgentDefinition,
    };
    const runtime = new NativeRuntimeHost({
      adapters: new Map([["fake", () => adapter]]),
      workspace: async () => ({ cwd: root }),
      estimate: (text) => Math.ceil(text.length / 3),
      toolTokens: 5,
      extensions: connectionsRuntime(store, vault),
      bind: async () => ({
        url: "http://127.0.0.1/host",
        token: "host-token",
        setTurn() {},
        close: async () => {},
      }),
    });
    const prepared = await runtime.prepare(input, new Redactor());
    expect(JSON.stringify(prepared.configuration)).not.toContain(privateToken);
    const native = await prepared.open({ sessionId: "session-a", mode: "new" });
    await native.send([{ type: "text", text: "Read the local fixture" }], "queue");
    await native.close();
    expect(returned).toMatchObject({ result: { content: [{ text: "read-only fixture result" }] } });
    const other = await runtime.prepare(
      {
        ...input,
        thread: { ...input.thread, id: "thread-b", agentId: "b" },
        profile: { ...input.profile, id: "b" },
      },
      new Redactor(),
    );
    const otherNative = await other.open({ sessionId: "session-b", mode: "new" });
    await expect(otherNative.send([{ type: "text", text: "Read" }], "queue")).rejects.toThrow(
      "connection_unavailable",
    );
    await otherNative.close();
    expect(reads).toBe(1);
    const current = registry.get("recipe");
    registry.save(
      { ...current, enabled: false, revokedThroughVersion: current.version },
      current.version,
    );
    await expect(
      runtime.prepare(
        {
          ...input,
          previous: {
            nativeId: "native-a",
            cwd: root,
            provider: "fake",
            configuration: prepared.configuration,
          },
        },
        new Redactor(),
      ),
    ).rejects.toThrow("connection_revoked");
    expect(
      JSON.stringify(store.database.prepare("SELECT body FROM connections_aux").all()),
    ).not.toContain(privateToken);
  } finally {
    store.close();
    issuer.closeAllConnections();
    mcp.closeAllConnections();
    await Promise.all([
      new Promise<void>((yes) => issuer.close(() => yes())),
      new Promise<void>((yes) => mcp.close(() => yes())),
    ]);
    rmSync(root, { recursive: true, force: true });
  }
});
