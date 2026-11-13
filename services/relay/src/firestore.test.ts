import { describe, expect, it } from "vitest";
import { FirestoreRegistry } from "./firestore.js";

type Fields = Record<string, unknown>;

/** A tiny stand in for the Firestore REST API: GET, and PATCH with an update mask. */
function fakeFirestore() {
  const docs = new Map<string, Fields>();
  const versions = new Map<string, string>();
  let version = 0;
  const calls: { method: string; url: string; auth: string }[] = [];
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const auth = new Headers(init?.headers).get("authorization") ?? "";
    calls.push({ method, url: url.pathname, auth });
    if (url.hostname === "metadata.google.internal")
      return Response.json({ access_token: "tok", expires_in: 3600 });
    const path = url.pathname.split("/documents/")[1] ?? "";
    if (method === "GET") {
      const fields = docs.get(path);
      return fields
        ? Response.json({ fields, updateTime: versions.get(path) })
        : new Response("", { status: 404 });
    }
    if (url.searchParams.get("currentDocument.exists") === "false" && docs.has(path))
      return new Response(null, { status: 409 });
    const expected = url.searchParams.get("currentDocument.updateTime");
    if (expected && expected !== versions.get(path)) return new Response(null, { status: 400 });
    const body = JSON.parse(String(init?.body)) as { fields: Fields };
    const next = { ...docs.get(path) };
    for (const name of url.searchParams.getAll("updateMask.fieldPaths")) {
      if (name in body.fields) next[name] = body.fields[name];
      else delete next[name];
    }
    docs.set(path, next);
    const updateTime = `2026-01-01T00:00:00.${String(++version).padStart(9, "0")}Z`;
    versions.set(path, updateTime);
    return Response.json({ fields: next, updateTime });
  }) as typeof fetch;
  return { docs, calls, fetchImpl };
}

describe("Firestore registry", () => {
  it("stores devices, push tokens and offers through REST", async () => {
    const fake = fakeFirestore();
    const registry = new FirestoreRegistry({ project: "p", fetch: fake.fetchImpl });
    const mac = "M".repeat(22);
    const device = "D".repeat(22);

    expect(await registry.getDevice(mac, device)).toBeUndefined();
    expect(await registry.setPushToken(mac, device, "apns", "t1")).toBe(false);
    await registry.allowDevice(mac, device, "pubkey");
    expect(await registry.setPushToken(mac, device, "apns", "t1")).toBe(true);
    expect(await registry.getDevice(mac, device)).toMatchObject({
      status: "allowed",
      publicKey: "pubkey",
      pushToken: "t1",
      platform: "apns",
    });

    await registry.revokeDevice(mac, device);
    const revoked = await registry.getDevice(mac, device);
    expect(revoked?.status).toBe("revoked");
    expect(revoked?.pushToken).toBeUndefined();
    expect(revoked?.publicKey).toBe("pubkey");
    expect(fake.docs.has(`macs/${mac}/devices/${device}`)).toBe(true);

    await registry.putOffer({ offerId: "O".repeat(22), macId: mac, expiresAt: 1_800_000_000_000 });
    expect(await registry.getOffer("O".repeat(22))).toEqual({
      offerId: "O".repeat(22),
      macId: mac,
      expiresAt: 1_800_000_000_000,
    });

    const metadataCalls = fake.calls.filter((c) => c.url.includes("service-accounts"));
    expect(metadataCalls).toHaveLength(1);
    expect(fake.calls.at(-1)?.auth).toBe("Bearer tok");
    expect(fake.calls.at(-1)?.url).toBe(
      "/v1/projects/p/databases/(default)/documents/offers/OOOOOOOOOOOOOOOOOOOOOO",
    );
  });
});

for (const write of ["allow", "token"] as const) {
  it(`permanent session revocation fences a late ${write} write from another registry instance`, async () => {
    const fake = fakeFirestore();
    let held = false,
      release = () => {},
      started = () => {};
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const slowFetch = (async (input: string | URL, init?: RequestInit) => {
      const fields = init?.body ? JSON.parse(String(init.body)).fields : {};
      if (
        held &&
        init?.method === "PATCH" &&
        (write === "allow" ? fields.status?.stringValue === "allowed" : !!fields.pushToken)
      ) {
        started();
        await blocked;
      }
      return fake.fetchImpl(input, init);
    }) as typeof fetch;
    const registry = new FirestoreRegistry({
      project: "fixture",
      emulatorHost: "127.0.0.1:1",
      fetch: slowFetch,
      permanentRevocation: true,
    });
    const other = new FirestoreRegistry({
      project: "fixture",
      emulatorHost: "127.0.0.1:1",
      fetch: fake.fetchImpl,
      permanentRevocation: true,
    });
    const room = "cloud:fixture",
      device = "fixture-device";
    if (write === "token") await registry.allowDevice(room, device, "public-fixture");
    held = true;
    const pending = (
      write === "allow"
        ? registry.allowDevice(room, device, "public-fixture")
        : registry.setPushToken(room, device, "apns", "synthetic-token")
    ).then(
      () => {},
      () => {},
    );
    await ready;
    await other.revokeDevice(room, device);
    release();
    await pending;
    const row = await other.getDevice(room, device);
    expect(row?.status).toBe("revoked");
    expect(row?.pushToken).toBeUndefined();
    expect(row?.publicKey).toBeUndefined();
  });
}
it("permanent revocation cannot be allowed again, while the default Local mode can re-pair", async () => {
  for (const permanentRevocation of [true, false]) {
    const fake = fakeFirestore(),
      registry = new FirestoreRegistry({
        project: "fixture",
        emulatorHost: "127.0.0.1:1",
        fetch: fake.fetchImpl,
        permanentRevocation,
      });
    await registry.allowDevice("room", "device", "public-fixture");
    await registry.revokeDevice("room", "device");
    if (permanentRevocation)
      await expect(registry.allowDevice("room", "device", "public-fixture")).rejects.toThrow(
        "registry_revoked",
      );
    else {
      await registry.allowDevice("room", "device", "public-fixture");
      expect((await registry.getDevice("room", "device"))?.status).toBe("allowed");
    }
  }
});
