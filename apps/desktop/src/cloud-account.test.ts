import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cloudAccount } from "./cloud-account.js";

const temporary: string[] = [];
afterEach(async () => {
  for (const directory of temporary.splice(0))
    await rm(directory, { recursive: true, force: true });
});
async function fixture(options: { callback?: "valid" | "wrong" | "none"; timeout?: number } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "zolt-account-"));
  temporary.push(directory);
  let stored: unknown,
    redirect = "",
    state = "",
    challenge = "",
    refreshes = 0,
    expired = false;
  const first = { accessToken: "a".repeat(43), refreshToken: "r".repeat(43), sessionId: "session" };
  const next = { ...first, accessToken: "b".repeat(43), refreshToken: "s".repeat(43) };
  const secrets = {
    async put(value: unknown) {
      stored = value;
      return { reference: "keychain:zoltbot:test" };
    },
    async read() {
      return stored;
    },
    async replace(_reference: string, value: unknown) {
      stored = value;
    },
    async remove() {
      stored = undefined;
    },
  };
  const transport = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/native/start")) {
      const payload = JSON.parse(String(init?.body));
      redirect = payload.redirectUri;
      state = payload.state;
      challenge = payload.challenge;
      return Response.json({ url: "https://zoltbot.ai/api/account/auth/google/start?intent=id" });
    }
    if (url.pathname.endsWith("/native/redeem")) {
      const payload = JSON.parse(String(init?.body));
      expect(createHash("sha256").update(payload.verifier).digest("base64url")).toBe(challenge);
      expect(payload.code).toBe("c".repeat(43));
      return Response.json(first);
    }
    if (url.pathname.endsWith("/session/refresh")) {
      refreshes++;
      expired = false;
      return Response.json(next);
    }
    if (url.pathname.endsWith("/me"))
      return expired
        ? Response.json({}, { status: 401 })
        : Response.json({ user: { id: "user", email: "user@example.com" }, sessions: [] });
    if (url.pathname.endsWith("/logout")) return Response.json({ ok: true });
    throw new Error("unexpected_request");
  }) as unknown as typeof fetch;
  const browser = vi.fn(async () => {
    if (options.callback === "none") return;
    const callback = new URL(redirect);
    callback.searchParams.set("state", options.callback === "wrong" ? "wrong-state" : state);
    callback.searchParams.set("code", "c".repeat(43));
    const response = await fetch(callback);
    expect(response.status).toBe(options.callback === "wrong" ? 400 : 200);
  });
  const referenceFile = path.join(directory, "reference");
  const controller = cloudAccount({
    origin: "https://zoltbot.ai",
    referenceFile,
    secrets,
    fetch: transport,
    openBrowser: browser,
    deviceName: "Test Mac",
    timeoutMs: options.timeout ?? 1000,
  });
  return {
    controller,
    referenceFile,
    browser,
    transport,
    stored: () => stored,
    refreshes: () => refreshes,
    expire: () => {
      expired = true;
    },
    redirect: () => redirect,
    secrets,
  };
}

describe("desktop account credential boundary", () => {
  it("keeps credentials in Keychain and exposes only metadata after a real loopback callback", async () => {
    const f = await fixture();
    expect(await f.controller.status()).toEqual({ configured: true, signedIn: false });
    const result = await f.controller.signIn();
    expect(result.signedIn).toBe(true);
    expect(JSON.stringify(result)).not.toContain("a".repeat(43));
    expect(await readFile(f.referenceFile, "utf8")).toBe("keychain:zoltbot:test");
    expect(f.stored()).toMatchObject({ refreshToken: "r".repeat(43) });
    await expect(fetch(f.redirect())).rejects.toThrow();
    await f.controller.signOut();
    expect(f.stored()).toBeUndefined();
    expect((await f.controller.status()).signedIn).toBe(false);
  });
  it("serializes concurrent refreshes and writes rotated credentials before reuse", async () => {
    const f = await fixture();
    await f.controller.signIn();
    f.expire();
    const results = await Promise.all([
      f.controller.status(),
      f.controller.status(),
      f.controller.status(),
    ]);
    expect(results.every((r) => r.signedIn)).toBe(true);
    expect(f.refreshes()).toBe(1);
    expect(f.stored()).toMatchObject({ refreshToken: "s".repeat(43) });
  });
  it("rejects wrong callback state, times out and closes its listener", async () => {
    const f = await fixture({ callback: "wrong", timeout: 100 });
    await expect(f.controller.signIn()).rejects.toThrow("sign_in_timed_out");
    expect(f.stored()).toBeUndefined();
    await expect(fetch(f.redirect())).rejects.toThrow();
  });
  it("supports cancellation without opening a native UI", async () => {
    const f = await fixture({ callback: "none" });
    const result = f.controller.signIn();
    await vi.waitFor(() => expect(f.browser).toHaveBeenCalled());
    f.controller.cancel();
    await expect(result).rejects.toThrow("sign_in_cancelled");
    await expect(fetch(f.redirect())).rejects.toThrow();
  });
  it("does not contact cloud services when accounts are unconfigured", async () => {
    const f = await fixture();
    const controller = cloudAccount({
      referenceFile: f.referenceFile,
      secrets: f.secrets,
      openBrowser: f.browser,
      deviceName: "Mac",
      fetch: f.transport,
    });
    expect(await controller.status()).toEqual({ configured: false, signedIn: false });
    await expect(controller.signIn()).rejects.toThrow("accounts_not_configured");
    expect(f.transport).not.toHaveBeenCalled();
    expect(f.browser).not.toHaveBeenCalled();
  });
});
