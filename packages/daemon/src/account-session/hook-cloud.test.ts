import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { webhookEventSource } from "../webhook-event-source.js";
import { accountHookCloud } from "./hook-cloud.js";
import { hookRouteRequest } from "./hook-routes.js";

const ORIGIN = "https://cloud.example.test";
const ACCOUNT = "00000000-0000-4000-8000-000000000001";

/** The cloud's hook routes in memory, behind the same allowlist the account owner applies. */
function fakeCloud() {
  const hooks = new Map<string, { id: string; token: string }>();
  const received = new Map<string, { id: string; receivedAt: string; body: string }[]>();
  let next = 1;
  const uuid = () => `00000000-0000-4000-8000-${String(next++).padStart(12, "0")}`;
  const token = () => `${"t".repeat(40)}${String(next++).padStart(3, "0")}`;
  const calls: string[] = [];
  async function request(route: string, method = "GET", payload?: string) {
    const check = hookRouteRequest(route, method, payload);
    if (!check) throw new Error("account_request_invalid");
    calls.push(`${method} ${route.split("?")[0]}`);
    let value: unknown;
    if (route === "/api/cloud/hooks" && method === "GET")
      value = {
        account: { id: ACCOUNT },
        hooks: [...hooks].map(([resource, hook]) => ({
          id: hook.id,
          resource,
          createdAt: "2026-11-21T10:00:00.000Z",
        })),
      };
    else if (route === "/api/cloud/hooks" && method === "POST") {
      const { resource } = JSON.parse(check.payload ?? "{}") as { resource: string };
      const hook = { id: uuid(), token: token() };
      hooks.set(resource, hook);
      value = { id: hook.id, resource, url: `${ORIGIN}/h/${hook.token}` };
    } else {
      const id = route.split("/")[4] ?? "";
      value = { requests: received.get(id) ?? [] };
    }
    return check.response(value);
  }
  async function post(url: string, body: string) {
    const hook = [...hooks.values()].find((entry) => url.endsWith(`/h/${entry.token}`));
    if (!hook) return new Response(null, { status: 404 });
    const list = received.get(hook.id) ?? [];
    list.push({ id: uuid(), receivedAt: new Date().toISOString(), body });
    received.set(hook.id, list);
    return new Response(null, { status: 202 });
  }
  return { request, post, hooks, calls };
}

function memorySecrets() {
  const items = new Map<string, unknown>();
  let next = 1;
  return {
    items,
    async put(value: unknown) {
      const reference = `ref-${next++}`;
      items.set(reference, structuredClone(value));
      return { reference };
    },
    async read(reference: string) {
      return structuredClone(items.get(reference));
    },
    async replace(reference: string, value: unknown) {
      items.set(reference, structuredClone(value));
    },
    async remove(reference: string) {
      items.delete(reference);
    },
  };
}

describe("the Mac's cloud client for routine web addresses", () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "zoltbot-hooks-"));
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  const client = (
    cloud: ReturnType<typeof fakeCloud>,
    secrets = memorySecrets(),
    mac = "this-mac",
  ) =>
    accountHookCloud({
      request: cloud.request,
      origin: ORIGIN,
      secrets,
      referenceFile: path.join(directory, `${mac}-hook-addresses-reference`),
      fetch: (async (url: string, init: RequestInit) =>
        cloud.post(url, String(init.body))) as unknown as typeof fetch,
    });

  it("makes an address once, keeps it in the keychain and delivers a test to the routine", async () => {
    const cloud = fakeCloud();
    const secrets = memorySecrets();
    const hooks = client(cloud, secrets);
    const first = await hooks.address("webhook/deploys");
    expect(first).toMatchObject({ state: "ready", url: expect.stringMatching(/\/h\/t+\d+$/) });
    // Asking again returns the kept address instead of rotating it.
    expect(await hooks.address("webhook/deploys")).toEqual(first);
    expect(cloud.calls.filter((call) => call === "POST /api/cloud/hooks")).toHaveLength(1);
    expect(JSON.stringify([...secrets.items.values()])).toContain(
      first.state === "ready" ? first.url : "",
    );
    // A fresh client (a restarted daemon) reads the address back from the keychain.
    expect(await client(cloud, secrets).address("webhook/deploys")).toEqual(first);

    const identity = await hooks.hook("webhook/deploys");
    expect(identity).toMatchObject({ accountId: ACCOUNT });
    await hooks.test("webhook/deploys");
    const source = webhookEventSource(hooks);
    const verified = await source.verify({ kind: "webhook.received", resource: "webhook/deploys" });
    expect(verified).toMatchObject({ sourceMode: "cloud_pull", repositoryId: identity?.hookId });
    const since = new Date(Date.now() - 60_000).toISOString();
    expect(await hooks.requests(identity?.hookId ?? "", since)).toMatchObject([
      { body: expect.stringContaining('"test":true') },
    ]);
  });

  it("rotates on request, and says when the address was made on another Mac", async () => {
    const cloud = fakeCloud();
    const hooks = client(cloud);
    const first = await hooks.address("webhook/builds");
    const rotated = await hooks.address("webhook/builds", { rotate: true });
    expect(rotated).toMatchObject({ state: "ready" });
    expect(rotated).not.toEqual(first);
    // Another Mac, with its own keychain, can't show the address without rotating it.
    const other = client(cloud, memorySecrets(), "other-mac");
    expect(await other.address("webhook/builds")).toEqual({ state: "elsewhere" });
    await expect(other.test("webhook/builds")).rejects.toThrow("webhook_address_elsewhere");
  });

  it("never erases kept addresses when the keychain can't be read", async () => {
    const cloud = fakeCloud();
    const secrets = memorySecrets();
    const hooks = client(cloud, secrets);
    const kept = await hooks.address("webhook/one");
    const read = secrets.read;
    secrets.read = async () => {
      throw new Error("keychain_unavailable");
    };
    await expect(hooks.address("webhook/two")).rejects.toThrow("keychain_unavailable");
    secrets.read = read;
    expect(await hooks.address("webhook/one")).toEqual(kept);
    // The item is labelled, so it is never mistaken for account credentials.
    expect([...secrets.items.values()]).toMatchObject([
      { kind: "hook-addresses", version: 1, origin: ORIGIN },
    ]);
  });

  it("refuses addresses on another origin and malformed cloud answers", async () => {
    const cloud = fakeCloud();
    const hooks = accountHookCloud({
      request: async (route, method, payload) => {
        const check = hookRouteRequest(route, method ?? "GET", payload);
        if (method === "POST")
          return check?.response({
            id: "00000000-0000-4000-8000-000000000009",
            resource: "webhook/x",
            url: "https://elsewhere.example.test/h/".concat("a".repeat(43)),
          });
        return cloud.request(route, method, payload);
      },
      origin: ORIGIN,
      secrets: memorySecrets(),
      referenceFile: path.join(directory, "reference"),
    });
    await expect(hooks.address("webhook/x")).rejects.toThrow("account_service_unavailable");
    expect(() => hookRouteRequest("/api/cloud/hooks", "POST", '{"resource":"../x"}')).toThrow(
      "account_request_invalid",
    );
    expect(() => hookRouteRequest("/api/cloud/hooks/other", "GET")).toThrow(
      "account_request_invalid",
    );
    const listing = hookRouteRequest("/api/cloud/hooks", "GET");
    expect(() => listing?.response({ hooks: [] })).toThrow("account_service_unavailable");
    expect(hookRouteRequest("/api/cloud/devices", "GET")).toBeUndefined();
  });
});
