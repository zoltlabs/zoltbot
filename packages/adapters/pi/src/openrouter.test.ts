import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { startOpenRouterLogin } from "./openrouter.js";

it("uses S256 and a matching state before exchanging a code directly into credential storage", async () => {
  let opened = "",
    saved = "",
    calls = 0;
  const flow = await startOpenRouterLogin(
    {
      async open(url) {
        opened = url;
      },
      async saveKey(key) {
        saved = key;
      },
    },
    {
      fetch: async (url, options) => {
        calls++;
        expect(String(url)).toBe("https://openrouter.ai/api/v1/auth/keys");
        const body = JSON.parse(String(options?.body));
        expect(body.code).toBe("synthetic-code");
        expect(body.code_challenge_method).toBe("S256");
        expect(createHash("sha256").update(body.code_verifier).digest("base64url")).toBe(
          new URL(opened).searchParams.get("code_challenge"),
        );
        return new Response(JSON.stringify({ key: "synthetic-private-key" }));
      },
    },
  );
  try {
    const authorize = new URL(opened),
      callback = new URL(authorize.searchParams.get("callback_url") ?? "");
    expect(authorize.origin).toBe("https://openrouter.ai");
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
    callback.searchParams.set("code", "synthetic-code");
    callback.searchParams.set("state", "wrong");
    expect((await fetch(callback)).status).toBe(400);
    expect(calls).toBe(0);
    callback.searchParams.set("state", authorize.searchParams.get("state") ?? "");
    const response = await fetch(callback);
    expect(response.status).toBe(200);
    expect(await response.text()).not.toContain("synthetic-private-key");
    await flow.completion;
    expect(saved).toBe("synthetic-private-key");
    expect(calls).toBe(1);
  } finally {
    await flow.cancel();
  }
});
it("times out and cancels without returning or saving credentials", async () => {
  let saves = 0;
  const flow = await startOpenRouterLogin(
    {
      async open() {},
      async saveKey() {
        saves++;
      },
    },
    { timeoutMs: 20 },
  );
  await expect(flow.completion).rejects.toThrow("login_timeout");
  await flow.cancel();
  expect(saves).toBe(0);
  const cancelled = await startOpenRouterLogin({
    async open() {},
    async saveKey() {
      saves++;
    },
  });
  await cancelled.cancel();
  await expect(cancelled.completion).rejects.toThrow("login_cancelled");
  expect(saves).toBe(0);
});
it("keeps provider errors and response bodies out of diagnostics", async () => {
  let opened = "";
  const flow = await startOpenRouterLogin(
    {
      async open(url) {
        opened = url;
      },
      async saveKey() {
        throw new Error("must_not_save");
      },
    },
    { fetch: async () => new Response("private-provider-body", { status: 401 }) },
  );
  try {
    const authorize = new URL(opened),
      callback = new URL(authorize.searchParams.get("callback_url") ?? "");
    callback.searchParams.set("state", authorize.searchParams.get("state") ?? "");
    callback.searchParams.set("code", "synthetic-code");
    const response = await fetch(callback);
    expect(await response.text()).not.toContain("private-provider-body");
    await expect(flow.completion).rejects.toThrow("code_exchange_failed");
  } finally {
    await flow.cancel();
  }
});
it("rejects multibyte state and duplicate code parameters without consuming the login", async () => {
  let opened = "",
    calls = 0;
  const flow = await startOpenRouterLogin(
    {
      async open(url) {
        opened = url;
      },
      async saveKey() {},
    },
    {
      fetch: async () => {
        calls++;
        return new Response(JSON.stringify({ key: "synthetic" }));
      },
    },
  );
  try {
    const auth = new URL(opened),
      callback = new URL(auth.searchParams.get("callback_url") ?? "");
    callback.searchParams.set("state", "é".repeat(43));
    callback.searchParams.set("code", "a");
    expect((await fetch(callback)).status).toBe(400);
    callback.searchParams.set("state", auth.searchParams.get("state") ?? "");
    callback.searchParams.append("code", "b");
    expect((await fetch(callback)).status).toBe(400);
    expect(calls).toBe(0);
  } finally {
    await flow.cancel();
  }
});
it("handles a provider denial without requiring state that the provider does not return", async () => {
  let opened = "";
  const flow = await startOpenRouterLogin({
    async open(url) {
      opened = url;
    },
    async saveKey() {
      throw new Error("must_not_save");
    },
  });
  const callback = new URL(new URL(opened).searchParams.get("callback_url") ?? "");
  callback.searchParams.set("error", "access_denied");
  expect((await fetch(callback)).status).toBe(200);
  await expect(flow.completion).rejects.toThrow("authorization_declined");
  await flow.cancel();
});
