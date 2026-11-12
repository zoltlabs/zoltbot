import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Credentials } from "@zoltbot/cloud-contracts";
import { afterEach, expect, it } from "vitest";
import { accountSession } from "./index.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});
const credentials = (sessionId: string = randomUUID()): Credentials => ({
  accessToken: randomBytes(32).toString("base64url"),
  refreshToken: randomBytes(32).toString("base64url"),
  sessionId,
});
async function fixture(fetcher: typeof fetch) {
  const root = await mkdtemp(path.join(os.tmpdir(), "zoltbot-account-session-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const referenceFile = path.join(root, "account-reference"),
    entries = new Map<string, unknown>();
  const secrets = {
    async put(value: unknown) {
      const reference = `keychain:zoltbot:${randomUUID()}`;
      entries.set(reference, structuredClone(value));
      return { reference };
    },
    async read(reference: string) {
      return structuredClone(entries.get(reference));
    },
    async replace(reference: string, value: unknown) {
      if (!entries.has(reference)) throw new Error("synthetic_missing_entry");
      entries.set(reference, structuredClone(value));
    },
    async remove(reference: string) {
      entries.delete(reference);
    },
  };
  const options = {
    origin: "https://accounts.example.invalid",
    referenceFile,
    secrets,
    fetch: fetcher,
  };
  return {
    session: accountSession(options),
    reopen: () => accountSession(options),
    entries,
    referenceFile,
  };
}
it("serializes concurrent requests and saves one refresh rotation before retrying", async () => {
  const initial = credentials(),
    rotated = credentials(initial.sessionId);
  let refreshes = 0,
    requests = 0;
  const f = await fixture(async (url, init) => {
    const authorization = new Headers(init?.headers).get("authorization");
    expect(init?.redirect).toBe("error");
    if (String(url).endsWith("/session/refresh")) {
      refreshes++;
      expect(authorization === `Refresh ${initial.refreshToken}`).toBe(true);
      return Response.json(rotated);
    }
    requests++;
    if (authorization === `Bearer ${initial.accessToken}`)
      return new Response(null, { status: 401 });
    expect(authorization === `Bearer ${rotated.accessToken}`).toBe(true);
    expect(
      [...f.entries.values()].some(
        (value) => (value as Credentials).refreshToken === rotated.refreshToken,
      ),
    ).toBe(true);
    return Response.json({ ok: true });
  });
  await f.session.save(initial);
  expect(await Promise.all(Array.from({ length: 3 }, () => f.session.request("/me")))).toEqual([
    { ok: true },
    { ok: true },
    { ok: true },
  ]);
  expect(refreshes).toBe(1);
  expect(requests).toBe(4);
  const file = await readFile(f.referenceFile, "utf8");
  expect(file.startsWith("keychain:zoltbot:")).toBe(true);
  expect(
    [initial.accessToken, initial.refreshToken, rotated.accessToken, rotated.refreshToken].some(
      (value) => file.includes(value),
    ),
  ).toBe(false);
  expect(JSON.stringify(f.session)).toBe("{}");
  expect((await f.reopen().load())?.sessionId).toBe(initial.sessionId);
});
it("clears a refused refresh and permits a later explicit sign-in without poisoning the queue", async () => {
  let allow = false;
  const f = await fixture(async () =>
    allow ? Response.json({ ok: true }) : new Response(null, { status: 401 }),
  );
  await f.session.save(credentials());
  await expect(f.session.request("/me")).rejects.toThrow("sign_in_required");
  expect(await f.session.load()).toBeUndefined();
  expect(f.entries.size).toBe(0);
  await expect(readFile(f.referenceFile)).rejects.toMatchObject({ code: "ENOENT" });
  allow = true;
  await f.session.save(credentials());
  expect(await f.session.request("/me")).toEqual({ ok: true });
});
it("keeps configuration and sign-in failures headless", async () => {
  const f = await fixture(async () => {
    throw new Error("unexpected_network");
  });
  await expect(f.session.request("/me")).rejects.toThrow("sign_in_required");
  expect(() =>
    accountSession({
      origin: "http://accounts.example.invalid",
      referenceFile: f.referenceFile,
      secrets: {
        async put() {
          throw new Error();
        },
        async read() {},
        async replace() {},
        async remove() {},
      },
    }),
  ).toThrow("invalid_account_origin");
});
it("replaces and clears a reopened keychain reference without leaving old credentials behind", async () => {
  const f = await fixture(async () => Response.json({ ok: true }));
  await f.session.save(credentials());
  const reference = await readFile(f.referenceFile, "utf8");
  const reopened = f.reopen();
  await reopened.save(credentials());
  expect(f.entries.size).toBe(1);
  expect(await readFile(f.referenceFile, "utf8")).toBe(reference);
  await f.reopen().clear();
  expect(f.entries.size).toBe(0);
  await expect(readFile(f.referenceFile)).rejects.toMatchObject({ code: "ENOENT" });
});
