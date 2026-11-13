import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { accountBrokerClient } from "../../../packages/daemon/src/account-session/broker-client.js";
import { type Daemon, startDaemon } from "../../../packages/daemon/src/api.js";
import { cloudAccount } from "./cloud-account.js";
import { desktopAccountClient } from "./native-account-client.js";

it("uses the daemon credential owner for legacy sign-in, refresh after restart and sign-out", async () => {
  const root = await mkdtemp("/private/tmp/zoltbot-native-owner-"),
    origin = "https://account.example.invalid",
    records = new Map<string, unknown>(),
    reference = `keychain:zoltbot:${randomUUID()}`,
    legacy = {
      accessToken: randomBytes(32).toString("base64url"),
      refreshToken: randomBytes(32).toString("base64url"),
      sessionId: randomUUID(),
    },
    issued = {
      accessToken: randomBytes(32).toString("base64url"),
      refreshToken: randomBytes(32).toString("base64url"),
      sessionId: randomUUID(),
    },
    rotated = {
      ...issued,
      accessToken: randomBytes(32).toString("base64url"),
      refreshToken: randomBytes(32).toString("base64url"),
    };
  records.set(reference, legacy);
  await mkdir(path.join(root, "desktop"));
  await writeFile(path.join(root, "desktop", "account-keychain-reference"), reference, {
    mode: 0o600,
  });
  const secrets = {
    async put(value: unknown) {
      const reference = `keychain:zoltbot:${randomUUID()}`;
      records.set(reference, structuredClone(value));
      return { reference };
    },
    async read(reference: string) {
      return structuredClone(records.get(reference));
    },
    async replace(reference: string, value: unknown) {
      records.set(reference, structuredClone(value));
    },
    async remove(reference: string) {
      records.delete(reference);
    },
  };
  let redirect = "",
    state = "",
    challenge = "",
    calls = 0,
    refreshes = 0,
    expired = false;
  const transport: typeof fetch = async (input, init) => {
    calls++;
    const url = new URL(String(input));
    if (url.origin !== origin) throw new Error("unexpected_account_origin");
    if (url.pathname === "/api/account/native/start") {
      const body = JSON.parse(String(init?.body));
      redirect = body.redirectUri;
      state = body.state;
      challenge = body.challenge;
      return Response.json({ url: `${origin}/api/account/auth/google/start?intent=fixture` });
    }
    if (url.pathname === "/api/account/native/redeem") {
      const body = JSON.parse(String(init?.body));
      expect(createHash("sha256").update(body.verifier).digest("base64url") === challenge).toBe(
        true,
      );
      return Response.json(issued);
    }
    const header = new Headers(init?.headers).get("authorization");
    if (url.pathname === "/api/account/session/refresh") {
      expect(header === `Refresh ${issued.refreshToken}`).toBe(true);
      refreshes++;
      expired = false;
      return Response.json(rotated);
    }
    expect(header === `Bearer ${refreshes ? rotated.accessToken : issued.accessToken}`).toBe(true);
    if (url.pathname === "/api/account/me")
      return expired
        ? Response.json({}, { status: 401 })
        : Response.json({
            sessionId: issued.sessionId,
            user: { id: "member", name: "Member", email: "member@example.com" },
            organizations: [],
            sessions: [],
          });
    if (url.pathname === "/api/account/logout") return Response.json({ ok: true });
    throw new Error("unexpected_account_request");
  };
  const options = { dataDir: root, secrets, nativeAccount: { origin, secrets, fetch: transport } };
  let daemon: Daemon | undefined;
  const native = () =>
    accountBrokerClient({ origin, socketPath: path.join(root, "account-ipc", "broker.sock") });
  const controller = cloudAccount({
    origin,
    referenceFile: path.join(root, "desktop", "account-keychain-reference"),
    nativeSession: desktopAccountClient({
      origin,
      socketPath: path.join(root, "account-ipc", "broker.sock"),
    }),
    fetch: transport,
    deviceName: "Synthetic Mac",
    async openBrowser() {
      const url = new URL(redirect);
      url.searchParams.set("state", state);
      url.searchParams.set("code", randomBytes(32).toString("base64url"));
      expect((await fetch(url)).status).toBe(200);
    },
  });
  try {
    const coldStatus = controller.status();
    daemon = await startDaemon(options);
    expect(await coldStatus).toEqual({ configured: true, signedIn: false });
    expect(calls).toBe(0);
    expect((await controller.signIn()).signedIn).toBe(true);
    const wrapped = records.get(reference) as {
      version: number;
      origin: string;
      credentials: typeof issued;
    };
    expect(wrapped.version).toBe(1);
    expect(wrapped.origin).toBe(origin);
    expect(wrapped.credentials.sessionId).toBe(issued.sessionId);
    await daemon.close();
    daemon = undefined;
    daemon = await startDaemon(options);
    expired = true;
    const reader = native();
    await reader.status();
    const status = await Promise.all([controller.status(), reader.request("/me")]);
    expect(status[0]).toMatchObject({ signedIn: true });
    expect(refreshes).toBe(1);
    expect(
      (records.get(reference) as { credentials: typeof rotated }).credentials.accessToken ===
        rotated.accessToken,
    ).toBe(true);
    const visible = JSON.stringify([status, daemon.store.snapshot(), daemon.logger.lines]);
    const hidden = [
      legacy.accessToken,
      legacy.refreshToken,
      issued.accessToken,
      issued.refreshToken,
      rotated.accessToken,
      rotated.refreshToken,
    ];
    expect(hidden.every((value) => !visible.includes(value))).toBe(true);
    await controller.signOut();
    expect(records.has(reference)).toBe(false);
    expect(await controller.status()).toEqual({ configured: true, signedIn: false });
    await daemon.close();
    daemon = undefined;
    daemon = await startDaemon({ dataDir: root });
    expect(daemon.store.snapshot()).toBeTruthy();
  } finally {
    controller.close();
    await daemon?.close();
    await rm(root, { recursive: true, force: true });
  }
}, 20000);

it("refuses an old account action queued behind a status reload that switches sessions", async () => {
  let selected = "first-session",
    release: (() => void) | undefined;
  const routes: string[] = [];
  const controller = cloudAccount({
    origin: "https://account.example.invalid",
    referenceFile: "/unused-reference",
    deviceName: "Synthetic Mac",
    nativeSession: {
      sessionId: () => selected,
      async status() {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        selected = "second-session";
        return { signedIn: true, sessionId: selected };
      },
      async save() {},
      async clear() {},
      async request(route) {
        routes.push(route);
        return { sessionId: selected };
      },
    },
    async openBrowser() {
      throw new Error("unexpected_browser");
    },
  });
  const status = controller.status(),
    queued = controller.export();
  const refused = expect(queued).rejects.toThrow("account_session_changed");
  await Promise.resolve();
  release?.();
  await status;
  await refused;
  expect(routes).toEqual(["/me"]);
});

it("cancels sign-in while waiting for the native account owner", async () => {
  let entered = false,
    release: (() => void) | undefined;
  const browser = vi.fn(async () => {}),
    send = vi.fn(async () => {
      throw new Error("unexpected_http");
    });
  const controller = cloudAccount({
    origin: "https://account.example.invalid",
    referenceFile: "/unused-reference",
    deviceName: "Synthetic Mac",
    fetch: send,
    nativeSession: {
      sessionId: () => undefined,
      async status() {
        entered = true;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return { signedIn: false };
      },
      async save() {},
      async clear() {},
      async request() {
        throw new Error("unexpected_native_request");
      },
    },
    openBrowser: browser,
  });
  const pending = controller.signIn(),
    outcome = pending.then(
      () => "unexpected_success",
      (error: Error) => error.message,
    );
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await expect.poll(() => entered).toBe(true);
    controller.cancel();
    const result = await Promise.race([
      outcome,
      new Promise<string>((resolve) => {
        timer = setTimeout(() => resolve("not_cancelled"), 250);
      }),
    ]);
    expect(result).toBe("sign_in_cancelled");
    expect(browser).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  } finally {
    clearTimeout(timer);
    release?.();
    await outcome;
    controller.close();
  }
});
