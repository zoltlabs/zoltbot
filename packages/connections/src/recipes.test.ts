import { createServer } from "node:http";
import { expect, it } from "vitest";
import { ConnectionOAuth } from "./oauth.js";
import { recipeResource } from "./recipes.js";

it("constructs only read-scoped Linear or exact project-scoped Sentry destinations", () => {
  expect(recipeResource("linear")).toBe("https://mcp.linear.app/mcp");
  expect(recipeResource("sentry", "example", "web-app")).toBe(
    "https://mcp.sentry.dev/mcp/example/web-app",
  );
  for (const slug of ["../admin", "a/b", "x?secret=1", "", "x#y"])
    expect(() => recipeResource("sentry", slug, "web")).toThrow("project_required");
});

it("registers the reserved loopback URI as a public client, exchanges PKCE and keeps the grant private", async () => {
  let redirect = "",
    challenge = "",
    saved: unknown;
  const issuer = createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    if (req.url === "/register") {
      const value = JSON.parse(text);
      expect(value.token_endpoint_auth_method).toBe("none");
      redirect = value.redirect_uris[0];
      expect(redirect).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
      res.writeHead(201, { "content-type": "application/json" }).end(
        JSON.stringify({
          client_id: "zoltbot-public",
          redirect_uris: [redirect],
          token_endpoint_auth_method: "none",
        }),
      );
    } else {
      const body = new URLSearchParams(text);
      expect(body.get("redirect_uri")).toBe(redirect);
      expect(body.get("client_id")).toBe("zoltbot-public");
      expect(body.get("code_verifier")).toBeTruthy();
      expect(challenge).toBeTruthy();
      res.end(
        JSON.stringify({
          access_token: "private-access",
          refresh_token: "private-refresh",
          token_type: "Bearer",
          expires_in: 3600,
          scope: "read",
        }),
      );
    }
  });
  await new Promise<void>((r) => issuer.listen(0, "127.0.0.1", r));
  const address = issuer.address();
  if (!address || typeof address === "string") throw new Error();
  const origin = `http://127.0.0.1:${address.port}`;
  const oauth = new ConnectionOAuth({
    put: async (value) => {
      saved = value;
      return { reference: "keychain:zoltbot:00000000-0000-4000-8000-000000000000" };
    },
  });
  const pending = await oauth.start({
    identity: "connection",
    issuer: origin,
    resource: `${origin}/mcp`,
    clientId: "",
    authorizationEndpoint: `${origin}/authorize`,
    tokenEndpoint: `${origin}/token`,
    registrationEndpoint: `${origin}/register`,
    scopes: ["read"],
    policy: { origins: [origin], localOrigins: [origin] },
  });
  try {
    const url = new URL(pending.authorizationUrl);
    challenge = url.searchParams.get("code_challenge") ?? "";
    const callback = new URL(redirect);
    callback.search = new URLSearchParams({
      state: url.searchParams.get("state") ?? "",
      code: "code",
      iss: origin,
    }).toString();
    await fetch(callback);
    const result = await pending.result;
    expect(Object.keys(result)).toEqual(["reference"]);
    expect(saved).toMatchObject({
      accessToken: "private-access",
      registration: { clientId: "zoltbot-public", resource: `${origin}/mcp` },
    });
  } finally {
    pending.cancel();
    await new Promise<void>((r) => issuer.close(() => r()));
  }
});

it("refuses a confidential registration without returning an authorization URL", async () => {
  const issuer = createServer((_req, res) =>
    res.writeHead(201).end(JSON.stringify({ client_id: "id", client_secret: "secret" })),
  );
  await new Promise<void>((r) => issuer.listen(0, "127.0.0.1", r));
  const a = issuer.address();
  if (!a || typeof a === "string") throw new Error();
  const origin = `http://127.0.0.1:${a.port}`;
  let writes = 0;
  const oauth = new ConnectionOAuth({
    put: async () => {
      writes++;
      return { reference: "unused" };
    },
  });
  try {
    await expect(
      oauth.start({
        identity: "c",
        issuer: origin,
        resource: `${origin}/mcp`,
        clientId: "",
        registrationEndpoint: `${origin}/register`,
        authorizationEndpoint: `${origin}/authorize`,
        tokenEndpoint: `${origin}/token`,
        scopes: [],
        policy: { origins: [origin], localOrigins: [origin] },
      }),
    ).rejects.toThrow("oauth_setup_failed");
    expect(writes).toBe(0);
  } finally {
    await new Promise<void>((r) => issuer.close(() => r()));
  }
});

it("reads bounded MCP initialize responses delivered as SSE without requiring the stream to close", async () => {
  const { requestJson } = await import("./network.js");
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write('event: message\ndata: {"jsonrpc":"2.0","method":"notifications/test"}\n\n');
    res.write(
      'event: message\ndata: {"jsonrpc":"2.0","id":"health","result":{"protocolVersion":"2025-11-25"}}\n\n',
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error();
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    const result = await requestJson(
      `${origin}/mcp`,
      { origins: [origin], localOrigins: [origin] },
      undefined,
      { mcpResponseId: "health", json: { method: "initialize" } },
    );
    expect(result).toMatchObject({ id: "health", result: { protocolVersion: "2025-11-25" } });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

it("binds an issuer-specific callback without an iss parameter and keeps OAuth audience separate from transport", async () => {
  let origin = "",
    audience = "",
    wrote = 0;
  const server = createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    if (req.url === "/register") {
      const body = JSON.parse(text);
      res.writeHead(201).end(
        JSON.stringify({
          client_id: "public",
          redirect_uris: body.redirect_uris,
          token_endpoint_auth_method: "none",
        }),
      );
    } else {
      audience = new URLSearchParams(text).get("resource") ?? "";
      res.end(JSON.stringify({ access_token: "private", token_type: "Bearer", scope: "read" }));
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error();
  origin = `http://127.0.0.1:${addr.port}`;
  const oauth = new ConnectionOAuth({
    put: async (value) => {
      wrote++;
      expect(value).toMatchObject({ resource: `${origin}/mcp` });
      return { reference: "private-ref" };
    },
  });
  const config = {
    identity: "posthog-fixture",
    resource: `${origin}/mcp`,
    authorizationResource: origin,
    issuer: origin,
    issuerParameterRequired: false,
    clientId: "",
    registrationEndpoint: `${origin}/register`,
    authorizationEndpoint: `${origin}/authorize`,
    tokenEndpoint: `${origin}/token`,
    scopes: ["read"],
    policy: { origins: [origin], localOrigins: [origin] },
  };
  const pending = await oauth.start(config);
  try {
    const auth = new URL(pending.authorizationUrl),
      callback = new URL(auth.searchParams.get("redirect_uri") ?? "");
    expect(callback.pathname).toMatch(/^\/callback\/[a-f0-9]{16}$/);
    expect(auth.searchParams.get("resource")).toBe(origin);
    callback.search = new URLSearchParams({
      state: auth.searchParams.get("state") ?? "",
      code: "code",
    }).toString();
    await fetch(callback);
    await expect(pending.result).resolves.toEqual({ reference: "private-ref" });
    expect(audience).toBe(origin);
    expect(wrote).toBe(1);
    const wrong = await oauth.start(config);
    const auth2 = new URL(wrong.authorizationUrl),
      bad = new URL(auth2.searchParams.get("redirect_uri") ?? "");
    bad.search = new URLSearchParams({
      state: auth2.searchParams.get("state") ?? "",
      code: "code",
      iss: "https://wrong.example",
    }).toString();
    await fetch(bad);
    await expect(wrong.result).rejects.toThrow("callback_rejected");
    expect(wrote).toBe(1);
  } finally {
    pending.cancel();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});
