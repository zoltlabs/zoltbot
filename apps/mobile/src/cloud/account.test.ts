import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { syntheticCredentials } from "@zoltbot/cloud-contracts";
import { createIdentity, linkId, toB64 } from "@zoltbot/link";
import { afterEach, expect, it } from "vitest";
import { createCloudFake } from "../../../../tools/fakes/src/cloud.js";
import { memoryStore } from "../data/link-store.js";
import {
  type PhoneAccountOptions,
  phoneAccount,
  phoneAccountCallback,
  phoneAccountKey,
} from "./account.js";

const owned: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of owned.splice(0).reverse()) await close();
});
const crypto = {
  async randomBytes(size: number) {
    return new Uint8Array(randomBytes(size));
  },
  async challenge(verifier: string) {
    return createHash("sha256").update(verifier).digest("base64url");
  },
};
async function fixture() {
  const server = createCloudFake();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  owned.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const storage = memoryStore();
  let opened = 0;
  const options: PhoneAccountOptions = {
    origin,
    storage,
    allowLoopback: true,
    deviceName: "Fixture phone",
    ...crypto,
    browser: {
      async open(url, callback) {
        expect(callback).toBe(phoneAccountCallback);
        opened++;
        const response = await fetch(url, { redirect: "manual" });
        const location = response.headers.get("location");
        if (!location) throw new Error("fixture_callback_missing");
        return { type: "success", url: location };
      },
      cancel() {},
    },
  };
  return { options, storage, origin, opened: () => opened };
}
it("signs in through the actual fake broker with PKCE, reloads secure storage and leaves pairing intact", async () => {
  const f = await fixture();
  await f.storage.set("zoltbot.link.identity.v1", "independent-pairing-identity");
  await f.storage.set("zoltbot.link.mac.v1", "independent-paired-mac");
  const account = phoneAccount(f.options),
    status = await account.signIn();
  expect(status.signedIn).toBe(true);
  expect(status.online).toBe(true);
  expect(status.account?.user.name).toBe("Example User");
  expect(f.opened()).toBe(1);
  const encoded = JSON.stringify(status);
  expect(encoded.includes(syntheticCredentials.accessToken)).toBe(false);
  expect(encoded.includes(syntheticCredentials.refreshToken)).toBe(false);
  expect((await phoneAccount(f.options).status()).account?.sessionId).toBe(
    status.account?.sessionId,
  );
  if (!status.account) throw new Error("fixture_account_missing");
  await account.signOut(status.account.sessionId);
  expect((await account.status()).signedIn).toBe(false);
  expect(await f.storage.get(phoneAccountKey)).toBeNull();
  expect(await f.storage.get("zoltbot.link.identity.v1")).toBe("independent-pairing-identity");
  expect(await f.storage.get("zoltbot.link.mac.v1")).toBe("independent-paired-mac");
});
it.each([
  "state",
  "duplicate",
  "different-app",
])("refuses a %s callback before redemption", async (kind) => {
  const f = await fixture();
  let redeemed = 0;
  const original = f.options.browser.open;
  f.options.browser.open = async (...args) => {
    const result = await original(...args);
    if (!result.url) throw new Error("fixture_callback_missing");
    const url = new URL(result.url);
    if (kind === "state") url.searchParams.set("state", "wrong");
    if (kind === "duplicate")
      url.searchParams.append("code", randomBytes(32).toString("base64url"));
    if (kind === "different-app") url.protocol = "other:";
    return { type: "success", url: url.href };
  };
  f.options.fetch = async (input, init) => {
    if (String(input).endsWith("/redeem")) redeemed++;
    return fetch(input, init);
  };
  await expect(phoneAccount(f.options).signIn()).rejects.toThrow("account_unavailable");
  expect(redeemed).toBe(0);
  expect(await f.storage.get(phoneAccountKey)).toBeNull();
});
it("refuses an external broker URL before opening the system browser", async () => {
  const f = await fixture();
  f.options.fetch = async () =>
    Response.json({ intentId: randomUUID(), url: "https://example.invalid/authorize" });
  await expect(phoneAccount(f.options).signIn()).rejects.toThrow("account_unavailable");
  expect(f.opened()).toBe(0);
});
it("cancels a pending browser session without persisting credentials or touching pairing", async () => {
  const f = await fixture();
  let opened = false,
    canceled = 0;
  f.options.browser = {
    open: async () => {
      opened = true;
      return new Promise(() => {});
    },
    cancel: () => {
      canceled++;
    },
  };
  const account = phoneAccount(f.options),
    result = account.signIn().then(
      () => "unexpected",
      (error) => error.message,
    );
  await expect.poll(() => opened).toBe(true);
  account.cancelSignIn();
  expect(await result).toBe("sign_in_cancelled");
  expect(canceled).toBe(1);
  expect(await f.storage.get(phoneAccountKey)).toBeNull();
});
it("refuses stored credentials bound to another service before any HTTP request", async () => {
  const f = await fixture();
  await phoneAccount(f.options).signIn();
  let requests = 0;
  const account = phoneAccount({
    ...f.options,
    origin: "https://example.invalid",
    fetch: async () => {
      requests++;
      throw new Error();
    },
  });
  expect((await account.status()).signedIn).toBe(false);
  expect(requests).toBe(0);
  expect(await f.storage.get(phoneAccountKey)).toBeNull();
});
it("serializes expired requests and persists one refresh rotation before using the new bearer", async () => {
  const f = await fixture(),
    account = phoneAccount(f.options);
  await account.signIn();
  const rotated = {
    accessToken: randomBytes(32).toString("base64url"),
    refreshToken: randomBytes(32).toString("base64url"),
    sessionId: "11111111-1111-4111-8111-111111111111",
  };
  let refreshes = 0,
    persistedBeforeUse = false;
  const original = f.options.fetch;
  const saved = await f.storage.get(phoneAccountKey);
  const owner = phoneAccount({
    ...f.options,
    fetch: async (input, init) => {
      const url = String(input),
        authorization = new Headers(init?.headers).get("authorization");
      if (url.endsWith("/session/refresh")) {
        refreshes++;
        return Response.json(rotated);
      }
      if (url.endsWith("/me") && authorization === `Bearer ${syntheticCredentials.accessToken}`)
        return Response.json({}, { status: 401 });
      if (url.endsWith("/me") && authorization === `Bearer ${rotated.accessToken}`) {
        const stored = await f.storage.get(phoneAccountKey);
        persistedBeforeUse =
          !!stored && JSON.parse(stored).credentials.refreshToken === rotated.refreshToken;
        return Response.json({
          sessionId: rotated.sessionId,
          user: { id: "member", name: "Member", email: "member@example.invalid" },
          organizations: [],
        });
      }
      return (original ?? fetch)(input, init);
    },
  });
  expect(saved !== null).toBe(true);
  const results = await Promise.all([owner.status(), owner.status()]);
  expect(results.every((result) => result.online)).toBe(true);
  expect(refreshes).toBe(1);
  expect(persistedBeforeUse).toBe(true);
});
it("refuses a stale sign-out before HTTP or secure storage effects", async () => {
  const f = await fixture();
  await phoneAccount(f.options).signIn();
  let requests = 0;
  const owner = phoneAccount({
    ...f.options,
    fetch: async () => {
      requests++;
      throw new Error();
    },
  });
  await expect(owner.signOut("another-session")).rejects.toThrow("account_session_changed");
  expect(requests).toBe(0);
  expect((await f.storage.get(phoneAccountKey)) !== null).toBe(true);
});

it("does not reuse a refresh credential after secure persistence fails", async () => {
  const f = await fixture();
  await phoneAccount(f.options).signIn();
  let refreshes = 0;
  const rotated = {
    ...syntheticCredentials,
    accessToken: randomBytes(32).toString("base64url"),
    refreshToken: randomBytes(32).toString("base64url"),
    sessionId: "11111111-1111-4111-8111-111111111111",
  };
  const owner = phoneAccount({
    ...f.options,
    storage: {
      ...f.storage,
      async set() {
        throw new Error("fixture_keychain_unavailable");
      },
    },
    fetch: async (input) => {
      if (String(input).endsWith("/session/refresh")) {
        refreshes++;
        return Response.json(rotated);
      }
      return Response.json({}, { status: 401 });
    },
  });
  await owner.status();
  expect((await owner.status()).signedIn).toBe(false);
  expect(refreshes).toBe(1);
  expect(await f.storage.get(phoneAccountKey)).toBeNull();
});

it("cleans up credentials if cancellation arrives during secure storage completion", async () => {
  const f = await fixture();
  let saving = false,
    release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const account = phoneAccount({
    ...f.options,
    storage: {
      ...f.storage,
      async set(key, value) {
        await f.storage.set(key, value);
        saving = true;
        await held;
      },
    },
  });
  const result = account.signIn().then(
    () => "unexpected",
    (error) => error.message,
  );
  await expect.poll(() => saving).toBe(true);
  account.cancelSignIn();
  release();
  expect(await result).toBe("sign_in_cancelled");
  expect(await f.storage.get(phoneAccountKey)).toBeNull();
  expect((await account.status()).signedIn).toBe(false);
});
it("reports uncertain cleanup and refuses all later account use if secure storage cannot be cleared", async () => {
  const f = await fixture();
  await phoneAccount(f.options).signIn();
  const owner = phoneAccount({
    ...f.options,
    storage: {
      ...f.storage,
      async remove() {
        throw new Error("fixture_cleanup_failed");
      },
    },
  });
  await expect(owner.signOut("11111111-1111-4111-8111-111111111111")).rejects.toThrow(
    "account_cleanup_required",
  );
  await expect(owner.status()).rejects.toThrow("account_cleanup_required");
});
it("clears local account custody while reporting unconfirmed remote logout", async () => {
  const f = await fixture();
  await phoneAccount(f.options).signIn();
  const owner = phoneAccount({
    ...f.options,
    fetch: async () => {
      throw new Error("fixture_offline");
    },
  });
  const offline = await owner.status();
  expect(offline.online).toBe(false);
  expect(offline.account).toBeUndefined();
  if (!offline.sessionId) throw new Error("fixture_session_stamp_missing");
  await expect(owner.signOut(offline.sessionId)).rejects.toThrow("sign_out_unconfirmed");
  expect(await f.storage.get(phoneAccountKey)).toBeNull();
});
it("does not project an account credential echoed in metadata", async () => {
  const f = await fixture();
  await phoneAccount(f.options).signIn();
  const owner = phoneAccount({
    ...f.options,
    fetch: async () =>
      Response.json({
        sessionId: "11111111-1111-4111-8111-111111111111",
        user: {
          id: "member",
          name: syntheticCredentials.accessToken,
          email: "member@example.invalid",
        },
        organizations: [],
      }),
  });
  const status = await owner.status();
  expect(status.online).toBe(false);
  expect(status.account).toBeUndefined();
  expect(JSON.stringify(status).includes(syntheticCredentials.accessToken)).toBe(false);
});

it("does not let a failed view subscriber break account persistence or other subscribers", async () => {
  const f = await fixture(),
    owner = phoneAccount(f.options);
  let notices = 0;
  owner.subscribe(() => {
    throw new Error("fixture_view_unavailable");
  });
  owner.subscribe(() => {
    notices++;
  });
  expect((await owner.signIn()).signedIn).toBe(true);
  expect(notices).toBe(1);
});

it("allows only the same session to retry a failed local cleanup", async () => {
  const f = await fixture();
  await phoneAccount(f.options).signIn();
  let refuse = true,
    removals = 0;
  const owner = phoneAccount({
    ...f.options,
    storage: {
      ...f.storage,
      async remove(key) {
        removals++;
        if (refuse) throw new Error("fixture_cleanup_failed");
        await f.storage.remove(key);
      },
    },
  });
  const sessionId = "11111111-1111-4111-8111-111111111111";
  await expect(owner.signOut(sessionId)).rejects.toThrow("account_cleanup_required");
  const attempted = removals;
  await expect(owner.signOut("other-session")).rejects.toThrow("account_session_changed");
  expect(removals).toBe(attempted);
  refuse = false;
  await owner.signOut(sessionId);
  expect((await owner.status()).signedIn).toBe(false);
  expect(await f.storage.get(phoneAccountKey)).toBeNull();
});
it("refuses a refresh response for a different account session before using its bearer", async () => {
  const f = await fixture();
  await phoneAccount(f.options).signIn();
  const different = {
    ...syntheticCredentials,
    sessionId: randomUUID(),
    accessToken: randomBytes(32).toString("base64url"),
    refreshToken: randomBytes(32).toString("base64url"),
  };
  let used = false;
  const owner = phoneAccount({
    ...f.options,
    fetch: async (input, init) => {
      if (String(input).endsWith("/session/refresh")) return Response.json(different);
      if (new Headers(init?.headers).get("authorization") === `Bearer ${different.accessToken}`)
        used = true;
      return Response.json({}, { status: 401 });
    },
  });
  expect((await owner.status()).signedIn).toBe(false);
  expect(used).toBe(false);
  expect(await f.storage.get(phoneAccountKey)).toBeNull();
});

function phoneKey() {
  const key = createIdentity();
  return { deviceId: linkId(key.publicKey), publicKey: toB64(key.publicKey) };
}
it("registers the phone and scopes push operations without exposing account credentials", async () => {
  const f = await fixture(),
    routes: string[] = [],
    key = phoneKey();
  let privateHeader = true;
  f.options.fetch = async (input, init) => {
    if (String(input).includes("/api/cloud/")) {
      routes.push(`${init?.method} ${new URL(String(input)).pathname}`);
      privateHeader &&= !!new Headers(init?.headers).get("authorization")?.startsWith("Bearer ");
      expect(init?.credentials).toBe("omit");
      expect(init?.redirect).toBe("error");
      return Response.json({ ok: true });
    }
    return fetch(input, init);
  };
  const owner = phoneAccount(f.options),
    status = await owner.signIn();
  const session = status.sessionId as string;
  await owner.registerDevice(session, key);
  await owner.setPushToken(session, {
    deviceId: key.deviceId,
    platform: "apns",
    token: randomBytes(32).toString("hex"),
  });
  await owner.clearPushToken(session, key.deviceId);
  expect(routes).toEqual([
    "POST /api/cloud/devices",
    "PUT /api/cloud/push",
    `DELETE /api/cloud/push/${key.deviceId}`,
  ]);
  expect(privateHeader).toBe(true);
  const encoded = JSON.stringify(await owner.status());
  expect(encoded.includes(syntheticCredentials.accessToken)).toBe(false);
});
it("refuses old-session Cloud actions and mismatched keys before Cloud HTTP", async () => {
  const f = await fixture();
  let calls = 0;
  f.options.fetch = async (input, init) => {
    if (String(input).includes("/api/cloud/")) {
      calls++;
      return Response.json({ ok: true });
    }
    return fetch(input, init);
  };
  const owner = phoneAccount(f.options),
    status = await owner.signIn(),
    key = phoneKey();
  for (const action of [
    () => owner.registerDevice("old", key),
    () =>
      owner.setPushToken("old", {
        deviceId: key.deviceId,
        platform: "apns",
        token: randomBytes(32).toString("hex"),
      }),
    () => owner.clearPushToken("old", key.deviceId),
    () => owner.cellConnection("old", { orgId: "org", deviceId: key.deviceId }),
  ])
    await expect(action()).rejects.toThrow("account_session_changed");
  await expect(
    owner.registerDevice(status.sessionId as string, { ...key, deviceId: phoneKey().deviceId }),
  ).rejects.toThrow("account_request_invalid");
  expect(calls).toBe(0);
});
it("keeps a Cell token in a revocable memory-only handle that cannot survive sign-out", async () => {
  const f = await fixture(),
    key = phoneKey(),
    token = { value: "" };
  f.options.fetch = async (input, init) =>
    String(input).endsWith("/api/cloud/cell-token")
      ? Response.json({
          token: token.value,
          cellUrl: "https://cell.example.invalid",
          expiresAt: new Date(Date.now() + 600000).toISOString(),
        })
      : fetch(input, init);
  const owner = phoneAccount(f.options),
    status = await owner.signIn();
  token.value = fixtureCellToken(
    f.origin,
    status.account?.user.id as string,
    status.sessionId as string,
    key.deviceId,
  );
  const handle = await owner.cellConnection(status.sessionId as string, {
    orgId: "org",
    deviceId: key.deviceId,
  });
  expect(handle.readToken() === token.value).toBe(true);
  expect(JSON.stringify(handle).includes(token.value)).toBe(false);
  expect((await f.storage.get(phoneAccountKey))?.includes(token.value)).toBe(false);
  await owner.signOut(status.sessionId as string);
  expect(() => handle.readToken()).toThrow("account_session_changed");
  handle.clear();
});
it("refuses unsafe Cell origins and overlong token lifetimes", async () => {
  const f = await fixture(),
    key = phoneKey();
  let token = "";
  let cellUrl = "http://cell.example.invalid",
    expiresAt = new Date(Date.now() + 600000).toISOString();
  f.options.fetch = async (input, init) =>
    String(input).endsWith("/api/cloud/cell-token")
      ? Response.json({ token, cellUrl, expiresAt })
      : fetch(input, init);
  const owner = phoneAccount(f.options),
    status = await owner.signIn();
  token = fixtureCellToken(
    f.origin,
    status.account?.user.id as string,
    status.sessionId as string,
    key.deviceId,
  );
  for (const origin of [
    "http://cell.example.invalid",
    "https://name:private@cell.example.invalid",
    "https://cell.example.invalid/path",
  ]) {
    cellUrl = origin;
    await expect(
      owner.cellConnection(status.sessionId as string, { orgId: "org", deviceId: key.deviceId }),
    ).rejects.toThrow("account_unavailable");
  }
  cellUrl = "https://cell.example.invalid";
  expiresAt = new Date(Date.now() + 7200000).toISOString();
  await expect(
    owner.cellConnection(status.sessionId as string, { orgId: "org", deviceId: key.deviceId }),
  ).rejects.toThrow("account_unavailable");
});
it("freezes a Cloud request before it waits behind another account operation", async () => {
  const f = await fixture(),
    owner = phoneAccount(f.options),
    status = await owner.signIn(),
    key = phoneKey();
  let release = () => {},
    started = () => {},
    held = false,
    matched = false;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  // Reopen the saved account with one serialized request owner and a controllable metadata read.
  const reopened = phoneAccount({
    ...f.options,
    fetch: async (input, init) => {
      if (String(input).endsWith("/api/account/me") && held) {
        started();
        await blocked;
      }
      if (String(input).endsWith("/api/cloud/devices")) {
        matched = JSON.parse(String(init?.body)).publicKey === key.publicKey;
        return Response.json({ ok: true });
      }
      return fetch(input, init);
    },
  });
  held = true;
  const pending = reopened.status();
  await ready;
  const input = { ...key },
    registered = reopened.registerDevice(status.sessionId as string, input);
  input.publicKey = phoneKey().publicKey;
  release();
  await pending;
  await registered;
  expect(matched).toBe(true);
});

it("does not reuse a consumed refresh after a malformed successful rotation", async () => {
  const f = await fixture();
  await phoneAccount(f.options).signIn();
  let refreshes = 0;
  const owner = phoneAccount({
    ...f.options,
    fetch: async (input) => {
      if (String(input).endsWith("/session/refresh")) {
        refreshes++;
        return Response.json({ unexpected: "malformed" });
      }
      return Response.json({}, { status: 401 });
    },
  });
  expect((await owner.status()).signedIn).toBe(false);
  expect((await owner.status()).signedIn).toBe(false);
  expect(refreshes).toBe(1);
  expect(await f.storage.get(phoneAccountKey)).toBeNull();
});

it("serializes Cloud refresh rotation and persists it before another protected request", async () => {
  const f = await fixture();
  await phoneAccount(f.options).signIn();
  const previous = JSON.parse((await f.storage.get(phoneAccountKey)) as string).credentials;
  const rotated = {
    ...previous,
    accessToken: randomBytes(32).toString("base64url"),
    refreshToken: randomBytes(32).toString("base64url"),
  };
  let refreshes = 0,
    rotatedResponse = false,
    persistedBeforeUse = true;
  const owner = phoneAccount({
    ...f.options,
    fetch: async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path === "/api/account/session/refresh") {
        refreshes++;
        rotatedResponse = true;
        return Response.json(rotated);
      }
      if (path.startsWith("/api/cloud/")) {
        if (!rotatedResponse) return Response.json({}, { status: 401 });
        persistedBeforeUse &&=
          JSON.parse((await f.storage.get(phoneAccountKey)) as string).credentials.accessToken ===
          rotated.accessToken;
        persistedBeforeUse &&=
          new Headers(init?.headers).get("authorization") === `Bearer ${rotated.accessToken}`;
        return Response.json({ ok: true });
      }
      throw new Error("unexpected_fixture_route");
    },
  });
  const key = phoneKey();
  await Promise.all([
    owner.registerDevice(previous.sessionId, key),
    owner.setPushToken(previous.sessionId, {
      deviceId: key.deviceId,
      platform: "apns",
      token: randomBytes(32).toString("hex"),
    }),
  ]);
  expect(refreshes).toBe(1);
  expect(persistedBeforeUse).toBe(true);
});
it("refuses extra fields in Cloud acknowledgements with a fixed error", async () => {
  const f = await fixture(),
    key = phoneKey();
  f.options.fetch = async (input, init) =>
    String(input).includes("/api/cloud/")
      ? Response.json({ ok: true, privateValue: randomBytes(32).toString("base64url") })
      : fetch(input, init);
  const owner = phoneAccount(f.options),
    status = await owner.signIn();
  await expect(owner.registerDevice(status.sessionId as string, key)).rejects.toThrow(
    "account_unavailable",
  );
});

function fixtureCellToken(
  origin: string,
  userId: string,
  sessionId: string,
  deviceId: string,
  changes: Record<string, unknown> = {},
) {
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: origin,
    aud: "cell",
    sub: userId,
    org: "org",
    device: deviceId,
    surface: "phone",
    kind: "client",
    session: sessionId,
    iat: now,
    exp: now + 600,
    jti: randomUUID(),
    ...changes,
  };
  return `${Buffer.from(JSON.stringify({ alg: "ES256", typ: "JWT" })).toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.${randomBytes(64).toString("base64url")}`;
}

it("refuses Cell claims for another user, org, session, device or execution surface", async () => {
  const f = await fixture(),
    key = phoneKey();
  let token = "";
  f.options.fetch = async (input, init) =>
    String(input).endsWith("/api/cloud/cell-token")
      ? Response.json({
          token,
          cellUrl: "https://cell.example.invalid",
          expiresAt: new Date(Date.now() + 600000).toISOString(),
        })
      : fetch(input, init);
  const owner = phoneAccount(f.options),
    status = await owner.signIn();
  for (const change of [
    { sub: "other" },
    { org: "other" },
    { session: "other" },
    { device: "other" },
    { surface: "desktop" },
    { kind: "sandbox_runner", task: "task" },
    { grant: "grant" },
  ]) {
    token = fixtureCellToken(
      f.origin,
      status.account?.user.id as string,
      status.sessionId as string,
      key.deviceId,
      change,
    );
    await expect(
      owner.cellConnection(status.sessionId as string, { orgId: "org", deviceId: key.deviceId }),
    ).rejects.toThrow("account_session_changed");
  }
});

it("reports refused Cloud authority separately while retaining the native account", async () => {
  const f = await fixture(),
    key = phoneKey();
  f.options.fetch = async (input, init) =>
    String(input).includes("/api/cloud/") ? Response.json({}, { status: 403 }) : fetch(input, init);
  const owner = phoneAccount(f.options),
    status = await owner.signIn();
  await expect(owner.registerDevice(status.sessionId as string, key)).rejects.toThrow(
    "account_access_refused",
  );
  expect((await owner.status()).signedIn).toBe(true);
  expect((await f.storage.get(phoneAccountKey)) !== null).toBe(true);
});
it("clears rejected native refresh authority before a Cloud request can retry", async () => {
  const f = await fixture();
  await phoneAccount(f.options).signIn();
  let cloudCalls = 0,
    refreshes = 0;
  const owner = phoneAccount({
    ...f.options,
    fetch: async (input) => {
      if (String(input).includes("/api/cloud/")) cloudCalls++;
      if (String(input).endsWith("/session/refresh")) refreshes++;
      return Response.json({}, { status: 401 });
    },
  });
  const saved = JSON.parse((await f.storage.get(phoneAccountKey)) as string).credentials;
  await expect(owner.registerDevice(saved.sessionId, phoneKey())).rejects.toThrow(
    "sign_in_required",
  );
  expect(cloudCalls).toBe(1);
  expect(refreshes).toBe(1);
  expect(await f.storage.get(phoneAccountKey)).toBeNull();
});
