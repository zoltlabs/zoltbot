import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { syntheticCredentials } from "@zoltbot/cloud-contracts";
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
