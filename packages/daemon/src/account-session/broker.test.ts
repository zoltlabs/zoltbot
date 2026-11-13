import { randomBytes, randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Credentials } from "@zoltbot/cloud-contracts";
import { afterEach, expect, it } from "vitest";
import { startAccountBroker } from "./broker.js";
import { accountBrokerClient } from "./broker-client.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
const credentials = (sessionId: string = randomUUID()): Credentials => ({
  accessToken: randomBytes(32).toString("base64url"),
  refreshToken: randomBytes(32).toString("base64url"),
  sessionId,
});
async function fixture(fetcher: typeof fetch = async () => Response.json({ ok: true })) {
  const root = await mkdtemp("/private/tmp/zoltbot-native-account-");
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const entries = new Map<string, unknown>(),
    origin = "https://accounts.example.invalid";
  const options = {
    directory: path.join(root, "ipc"),
    referenceFile: path.join(root, "reference"),
    origin,
    fetch: fetcher,
    secrets: {
      async put(value: unknown) {
        const reference = `keychain:zoltbot:${randomUUID()}`;
        entries.set(reference, structuredClone(value));
        return { reference };
      },
      async read(reference: string) {
        return structuredClone(entries.get(reference));
      },
      async replace(reference: string, value: unknown) {
        if (!entries.has(reference)) throw new Error("fixture_entry_missing");
        entries.set(reference, structuredClone(value));
      },
      async remove(reference: string) {
        entries.delete(reference);
      },
    },
  };
  const start = async (
    overrides: Partial<
      typeof options & Pick<Parameters<typeof startAccountBroker>[0], "onSessionChanged">
    > = {},
  ) => {
    const broker = await startAccountBroker({ ...options, ...overrides });
    cleanups.push(() => broker.close());
    return {
      broker,
      client: accountBrokerClient({
        socketPath: broker.location(),
        origin: overrides.origin ?? origin,
      }),
    };
  };
  return { root, entries, options, start };
}
async function scan(directory: string, values: readonly string[]) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) await scan(file, values);
    else if (entry.isFile()) {
      const bytes = await readFile(file, "utf8");
      expect(values.some((value) => bytes.includes(value))).toBe(false);
    }
  }
}
it("keeps credentials in the fake keychain and exposes only native metadata over a private Unix socket", async () => {
  const value = credentials();
  let requests = 0;
  const f = await fixture(async (url, init) => {
    requests++;
    expect(String(url)).toBe("https://accounts.example.invalid/api/account/me");
    expect(new Headers(init?.headers).get("authorization") === `Bearer ${value.accessToken}`).toBe(
      true,
    );
    return Response.json({ name: "Example" });
  });
  const { broker, client } = await f.start();
  expect(await client.status()).toEqual({ signedIn: false });
  await client.save(value);
  expect(await client.status()).toEqual({ signedIn: true, sessionId: value.sessionId });
  expect(await client.request("/me")).toEqual({ name: "Example" });
  expect(requests).toBe(1);
  expect(JSON.stringify(broker)).toBe("{}");
  expect(JSON.stringify(client)).toBe("{}");
  const stored = [...f.entries.values()][0] as { origin: string; credentials: Credentials };
  expect(stored.origin).toBe(f.options.origin);
  expect(stored.credentials.accessToken === value.accessToken).toBe(true);
  expect((await lstat(broker.location())).mode & 0o777).toBe(0o600);
  expect((await lstat(f.options.directory)).mode & 0o777).toBe(0o700);
  await scan(f.root, [value.accessToken, value.refreshToken]);
});
it("serializes two native clients through one refresh owner", async () => {
  const initial = credentials(),
    rotated = credentials(initial.sessionId);
  let refreshes = 0;
  const f = await fixture(async (url, init) => {
    const authorization = new Headers(init?.headers).get("authorization");
    if (String(url).endsWith("/session/refresh")) {
      refreshes++;
      expect(authorization === `Refresh ${initial.refreshToken}`).toBe(true);
      return Response.json(rotated);
    }
    return authorization === `Bearer ${rotated.accessToken}`
      ? Response.json({ ok: true })
      : Response.json({ error: "expired" }, { status: 401 });
  });
  const { broker, client } = await f.start();
  await client.save(initial);
  const second = accountBrokerClient({ socketPath: broker.location(), origin: f.options.origin });
  expect(await Promise.all([client.request("/me"), second.request("/me")])).toEqual([
    { ok: true },
    { ok: true },
  ]);
  expect(refreshes).toBe(1);
  const stored = [...f.entries.values()][0] as { credentials: Credentials };
  expect(stored.credentials.refreshToken === rotated.refreshToken).toBe(true);
  await scan(f.root, [
    initial.accessToken,
    initial.refreshToken,
    rotated.accessToken,
    rotated.refreshToken,
  ]);
});
it("clears an existing keychain reference after reopening without first loading credentials", async () => {
  const f = await fixture(),
    first = await f.start();
  await first.client.save(credentials());
  await first.broker.close();
  const reopened = await f.start();
  await reopened.client.clear();
  expect(f.entries.size).toBe(0);
  await expect(readFile(f.options.referenceFile)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await reopened.client.status()).toEqual({ signedIn: false });
});
it("refuses origin changes and never sends another origin's saved credentials", async () => {
  let requests = 0;
  const f = await fixture(async () => {
    requests++;
    return Response.json({ ok: true });
  });
  const first = await f.start();
  await first.client.save(credentials());
  const otherOrigin = "https://other.example.invalid";
  const wrong = accountBrokerClient({ socketPath: first.broker.location(), origin: otherOrigin });
  await expect(wrong.status()).rejects.toThrow("account_origin_changed");
  await first.broker.close();
  const second = await f.start({ origin: otherOrigin });
  expect(await second.client.status()).toEqual({ signedIn: false });
  await expect(second.client.request("/me")).rejects.toThrow("sign_in_required");
  expect(requests).toBe(0);
  await second.client.save(credentials());
  expect((await second.client.status()).signedIn).toBe(true);
  expect(f.entries.size).toBe(1);
});
it("requires explicit sign-in for a legacy credential without an origin binding", async () => {
  let requests = 0;
  const f = await fixture(async () => {
    requests++;
    return Response.json({ ok: true });
  });
  const value = credentials(),
    reference = await f.options.secrets.put(value);
  await writeFile(f.options.referenceFile, reference.reference, { mode: 0o600 });
  const { client } = await f.start();
  expect(await client.status()).toEqual({ signedIn: false });
  await expect(client.request("/me")).rejects.toThrow("sign_in_required");
  expect(requests).toBe(0);
  await client.save(credentials());
  expect((await client.status()).signedIn).toBe(true);
  expect(f.entries.size).toBe(1);
  await scan(f.root, [value.accessToken, value.refreshToken]);
});
it("keeps one socket owner and one credential owner without deleting an unrelated file", async () => {
  const f = await fixture(),
    first = await f.start();
  await expect(f.start()).rejects.toThrow();
  await expect(f.start({ directory: path.join(f.root, "other") })).rejects.toThrow();
  expect(await first.client.status()).toEqual({ signedIn: false });
  await first.broker.close();
  await mkdir(f.options.directory, { recursive: true });
  await writeFile(path.join(f.options.directory, "broker.sock"), "Preserve this fixture file");
  await expect(f.start()).rejects.toThrow();
  expect(await readFile(path.join(f.options.directory, "broker.sock"), "utf8")).toBe(
    "Preserve this fixture file",
  );
});
it("refuses credential endpoints, path traversal and oversized payloads before contacting the account service", async () => {
  let requests = 0;
  const f = await fixture(async () => {
      requests++;
      return Response.json({ ok: true });
    }),
    { client } = await f.start();
  await client.save(credentials());
  await expect(client.request("/session/refresh", "POST")).rejects.toThrow(
    "native_account_request_invalid",
  );
  await expect(client.request("/../account/me", "GET")).rejects.toThrow(
    "native_account_request_invalid",
  );
  await expect(client.request("/me", "POST", "x".repeat(1048577))).rejects.toThrow(
    "native_account_request_invalid",
  );
  expect(requests).toBe(0);
});
it("aborts account I/O before releasing the broker for another process", async () => {
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const f = await fixture(async (_url, init) => {
    started();
    return await new Promise<Response>((_resolve, reject) =>
      init?.signal?.addEventListener("abort", () => reject(new Error("Untrusted backend detail")), {
        once: true,
      }),
    );
  });
  const first = await f.start();
  await first.client.save(credentials());
  const result = first.client.request("/me").then(
    () => "unexpected_success",
    (error) => String(error.message),
  );
  await ready;
  await first.broker.close();
  expect((await result) === "native_account_unavailable").toBe(true);
  const second = await f.start();
  expect((await second.client.status()).signedIn).toBe(true);
});

it("preserves binary artifact uploads through the native account transport", async () => {
  const bytes = Buffer.from([0, 255, 1, 0]),
    artifactId = randomUUID(),
    digest = "f".repeat(64);
  const f = await fixture(async (url, init) => {
    expect(String(url)).toBe(
      `https://accounts.example.invalid/api/account/artifacts/${artifactId}/blobs/${digest}`,
    );
    expect(new Headers(init?.headers).get("content-type")).toBe("application/octet-stream");
    expect(init?.body instanceof Uint8Array).toBe(true);
    expect(Buffer.from(init?.body as Uint8Array).equals(bytes)).toBe(true);
    return Response.json({ stored: true });
  });
  const { client } = await f.start();
  await client.save(credentials());
  expect(await client.request(`/artifacts/${artifactId}/blobs/${digest}`, "PUT", bytes)).toEqual({
    stored: true,
  });
});

it("retries native session cleanup after a failed notification without creating another keychain entry", async () => {
  const f = await fixture();
  let calls = 0;
  const { client } = await f.start({
    onSessionChanged: async () => {
      calls++;
      if (calls === 1) throw new Error("Injected cleanup failure");
    },
  });
  await expect(client.save(credentials())).rejects.toThrow("native_account_unavailable");
  expect((await client.status()).signedIn).toBe(true);
  expect(calls).toBe(2);
  expect(f.entries.size).toBe(1);
  await client.clear();
  expect(calls).toBe(3);
  expect(client.sessionId()).toBeUndefined();
});

it("refuses an account credential echoed in upstream metadata without returning it to a native client", async () => {
  const value = credentials();
  const f = await fixture(async () => Response.json({ accidentalValue: value.accessToken }));
  const { client } = await f.start();
  await client.save(value);
  const error = await client.request("/me").then(
    () => "unexpected_success",
    (error) => String(error.message),
  );
  expect(error === "native_account_unavailable").toBe(true);
  expect(error.includes(value.accessToken)).toBe(false);
  await scan(f.root, [value.accessToken, value.refreshToken]);
});

it("drains an accepted keychain write before releasing credential ownership", async () => {
  const f = await fixture();
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const resume = new Promise<void>((resolve) => {
    release = resolve;
  });
  const put = f.options.secrets.put;
  f.options.secrets.put = async (value) => {
    entered();
    await resume;
    return put(value);
  };
  const first = await f.start();
  const saved = first.client.save(credentials()).then(
    () => "completed",
    () => "closed",
  );
  await started;
  const closing = first.broker.close();
  await expect(f.start({ directory: path.join(f.root, "next") })).rejects.toThrow();
  release();
  await closing;
  await saved;
  const next = await f.start();
  expect((await next.client.status()).signedIn).toBe(true);
  expect(f.entries.size).toBe(1);
});
