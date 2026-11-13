import { generateKeyPairSync, verify } from "node:crypto";
import http2 from "node:http2";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { ApnsPush, apnsJwt, apnsPayload, pushText } from "./push.js";

const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

let server: http2.Http2Server | undefined;
let client: ApnsPush | undefined;
afterEach(async () => {
  client?.close();
  await new Promise((resolve) => (server ? server.close(resolve) : resolve(undefined)));
  server = undefined;
});

describe("push text", () => {
  it("is fixed per kind and never carries content", () => {
    expect(pushText("needs_you", 1)).toBe("Zoltbot needs you");
    expect(pushText("needs_you", 4)).toBe("Zoltbot needs you (4)");
    expect(pushText("task_done", 2)).toBe("A task finished");
    expect(pushText("zolt", 3)).toBe("A message from your main agent");
    // A notice leaves the badge alone and only names the chat a tap opens.
    expect(apnsPayload("zolt", 1, undefined, "chief")).toEqual({
      aps: { alert: { body: "A message from your main agent" }, sound: "default" },
      threadId: "chief",
      body: { threadId: "chief" },
    });
    expect(apnsPayload("needs_you", 2)).toEqual({
      aps: { alert: { body: "Zoltbot needs you (2)" }, badge: 2, sound: "default" },
    });
    expect(
      apnsPayload("needs_you", 1, {
        category: "approval",
        interactionId: "r1",
        threadId: "h1",
        version: 3,
      }),
    ).toEqual({
      aps: {
        alert: { body: "Zoltbot needs you" },
        badge: 1,
        sound: "default",
        category: "approval",
      },
      category: "approval",
      interactionId: "r1",
      version: 3,
      threadId: "h1",
      body: { category: "approval", interactionId: "r1", version: 3, threadId: "h1" },
    });
  });
});

describe("APNs", () => {
  it("signs an ES256 provider token", () => {
    const token = apnsJwt(pem, "KEY123", "TEAM456", 1_700_000_000_000);
    const [header, claims, signature] = token.split(".") as [string, string, string];
    expect(JSON.parse(Buffer.from(header, "base64url").toString())).toEqual({
      alg: "ES256",
      kid: "KEY123",
    });
    expect(JSON.parse(Buffer.from(claims, "base64url").toString())).toEqual({
      iss: "TEAM456",
      iat: 1_700_000_000,
    });
    const ok = verify(
      "sha256",
      Buffer.from(`${header}.${claims}`),
      { key: publicKey, dsaEncoding: "ieee-p1363" },
      Buffer.from(signature, "base64url"),
    );
    expect(ok).toBe(true);
  });

  it("posts over HTTP/2 and reports a dead token as gone", async () => {
    const seen: http2.IncomingHttpHeaders[] = [];
    const bodies: string[] = [];
    server = http2.createServer((req, res) => {
      seen.push(req.headers);
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        bodies.push(body);
        if (req.headers[":path"]?.endsWith("/dead")) {
          res.writeHead(410).end(JSON.stringify({ reason: "Unregistered" }));
        } else res.writeHead(200).end();
      });
    });
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    client = new ApnsPush({
      key: pem,
      keyId: "KEY123",
      teamId: "TEAM456",
      topic: "ai.zoltbot.app",
      origins: { apns: origin, "apns-sandbox": origin },
    });

    expect(
      await client.send({ platform: "apns", token: "live", kind: "needs_you", count: 2 }),
    ).toEqual({
      ok: true,
    });
    expect(
      await client.send({ platform: "apns-sandbox", token: "dead", kind: "task_done", count: 1 }),
    ).toEqual({ ok: false, gone: true, reason: "Unregistered" });

    expect(seen[0]?.[":path"]).toBe("/3/device/live");
    expect(seen[0]?.["apns-topic"]).toBe("ai.zoltbot.app");
    expect(seen[0]?.["apns-push-type"]).toBe("alert");
    expect(seen[0]?.authorization).toMatch(/^bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    expect(JSON.parse(bodies[0] ?? "")).toEqual(apnsPayload("needs_you", 2));
  });
});

describe("Cloud push scope", () => {
  const cloud = { kind: "cloud", orgId: "personal", notificationId: "a".repeat(64) } as const;
  it("carries identifiers with fixed text and no actionable category", () => {
    const payload = apnsPayload("needs_you", 2, undefined, "thread:one", cloud);
    expect(payload).toEqual({
      aps: { alert: { body: "Zoltbot needs you (2)" }, badge: 2, sound: "default" },
      scope: cloud,
      threadId: "thread:one",
      body: { scope: cloud, threadId: "thread:one" },
    });
    expect(() =>
      apnsPayload(
        "needs_you",
        1,
        { category: "approval", interactionId: "request", threadId: "thread:one", version: 1 },
        "thread:one",
        cloud,
      ),
    ).toThrow("push_scope_invalid");
    expect(() => apnsPayload("needs_you", 1, undefined, "private prose", cloud)).toThrow(
      "push_scope_invalid",
    );
    for (const count of [-1, 1.5, 10000])
      expect(() => apnsPayload("needs_you", count, undefined, "thread:one", cloud)).toThrow(
        "push_scope_invalid",
      );
    expect(() => apnsPayload("zolt", 1, undefined, "thread:one", cloud)).toThrow(
      "push_scope_invalid",
    );
  });
  it("refuses malformed Cloud input before creating an APNs connection", async () => {
    const sender = new ApnsPush({
      key: "unused",
      keyId: "unused",
      teamId: "unused",
      topic: "com.example.fixture",
      origins: { apns: "http://127.0.0.1:1" },
    });
    try {
      expect(
        await sender.send({
          platform: "apns",
          token: "a".repeat(64),
          kind: "needs_you",
          count: 1,
          threadId: "thread",
          cloud: { ...cloud, notificationId: "invalid" },
        }),
      ).toEqual({ ok: false, gone: false, reason: "push_scope_invalid" });
    } finally {
      sender.close();
    }
  });
});
