import { describe, expect, it } from "vitest";
import { FirestoreRegistry } from "./firestore.js";

type Fields = Record<string, unknown>;

/** A tiny stand in for the Firestore REST API: GET, and PATCH with an update mask. */
function fakeFirestore() {
  const docs = new Map<string, Fields>();
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
      return fields ? Response.json({ fields }) : new Response("", { status: 404 });
    }
    const body = JSON.parse(String(init?.body)) as { fields: Fields };
    const next = { ...docs.get(path) };
    for (const name of url.searchParams.getAll("updateMask.fieldPaths")) {
      if (name in body.fields) next[name] = body.fields[name];
      else delete next[name];
    }
    docs.set(path, next);
    return Response.json({ fields: next });
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
