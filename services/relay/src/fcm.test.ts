import { generateKeyPairSync, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import { FcmPush, fcmAccount, fcmAssertion, fcmMessage, RoutedPush } from "./fcm.js";
import { FakePush } from "./push.js";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const account = {
  project_id: "example-project",
  client_email: "relay@example-project.iam.gserviceaccount.com",
  private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
};

/** A stand-in for Google's token and FCM endpoints. */
function fakeGoogle(answer: (body: Record<string, unknown>) => { status: number; body: unknown }) {
  const calls: { url: string; headers: Record<string, string>; body: string }[] = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    const headers = init.headers as Record<string, string>;
    calls.push({ url, headers, body: String(init.body) });
    if (url.endsWith("/token"))
      return Response.json({ access_token: `at-${calls.length}`, expires_in: 3600 });
    const { status, body } = answer(JSON.parse(String(init.body)));
    return Response.json(body, { status });
  }) as typeof fetch;
  return { calls, fetcher };
}

describe("fcm", () => {
  it("reads only a complete service-account key", () => {
    expect(fcmAccount(JSON.stringify({ ...account, extra: 1 }))).toEqual(account);
    expect(() => fcmAccount(JSON.stringify({ ...account, project_id: "Bad Id" }))).toThrow(
      "fcm_account_invalid",
    );
    expect(() => fcmAccount("{}")).toThrow("fcm_account_invalid");
  });

  it("signs the token request with the account key", () => {
    const jwt = fcmAssertion(account, "https://oauth2.example.test/token", 1_700_000_000_000);
    const [header, claims, signature] = jwt.split(".");
    expect(
      verify(
        "sha256",
        Buffer.from(`${header}.${claims}`),
        publicKey,
        Buffer.from(signature ?? "", "base64url"),
      ),
    ).toBe(true);
    expect(JSON.parse(Buffer.from(claims ?? "", "base64url").toString())).toEqual({
      iss: account.client_email,
      scope: "https://www.googleapis.com/auth/firebase.messaging",
      aud: "https://oauth2.example.test/token",
      iat: 1_700_000_000,
      exp: 1_700_003_600,
    });
  });

  it("carries the same fixed sentence and ids as an iPhone push, never content", () => {
    expect(
      fcmMessage({
        platform: "fcm",
        token: "t1",
        kind: "needs_you",
        count: 2,
        macId: "mac_A1",
        action: { category: "approval", interactionId: "r1", threadId: "h1", version: 3 },
      }),
    ).toEqual({
      message: {
        token: "t1",
        notification: { body: "Zoltbot needs you (2)" },
        data: {
          category: "approval",
          interactionId: "r1",
          version: "3",
          threadId: "h1",
          macId: "mac_A1",
        },
        android: {
          priority: "high",
          // No click_action: a tap opens the app, which routes by the data.
          notification: { channel_id: "default", notification_count: 2 },
        },
      },
    });
    expect(
      fcmMessage({ platform: "fcm", token: "t1", kind: "zolt", count: 1, threadId: "chief" }),
    ).toMatchObject({
      message: {
        notification: { body: "A message from your main agent" },
        data: { threadId: "chief" },
        android: { notification: { channel_id: "default" } },
      },
    });
  });

  it("sends with a cached access token and forgets tokens FCM no longer knows", async () => {
    const google = fakeGoogle((body) => {
      const token = (body.message as { token: string }).token;
      return token === "dead"
        ? {
            status: 404,
            body: {
              error: {
                status: "NOT_FOUND",
                details: [{ "@type": "x", errorCode: "UNREGISTERED" }],
              },
            },
          }
        : { status: 200, body: { name: "projects/example-project/messages/1" } };
    });
    const push = new FcmPush({
      account,
      origin: "https://fcm.example.test",
      tokenUri: "https://oauth2.example.test/token",
      fetch: google.fetcher,
    });
    expect(await push.send({ platform: "fcm", token: "t1", kind: "task_done", count: 1 })).toEqual({
      ok: true,
    });
    expect(
      await push.send({ platform: "fcm", token: "dead", kind: "task_done", count: 1 }),
    ).toEqual({ ok: false, gone: true, reason: "UNREGISTERED" });
    // One token exchange serves both sends.
    expect(google.calls.filter((c) => c.url.endsWith("/token"))).toHaveLength(1);
    const sent = google.calls.filter((c) => c.url.includes("messages:send"));
    expect(sent[0]?.url).toBe("https://fcm.example.test/v1/projects/example-project/messages:send");
    expect(sent[0]?.headers.authorization).toBe("Bearer at-1");
  });

  it("asks for a fresh access token once when Google refuses the cached one", async () => {
    let refused = false;
    const google = fakeGoogle(() => {
      if (refused) return { status: 200, body: {} };
      refused = true;
      return { status: 401, body: { error: { status: "UNAUTHENTICATED" } } };
    });
    const push = new FcmPush({
      account,
      origin: "https://fcm.example.test",
      tokenUri: "https://oauth2.example.test/token",
      fetch: google.fetcher,
    });
    expect(await push.send({ platform: "fcm", token: "t1", kind: "task_done", count: 1 })).toEqual({
      ok: true,
    });
    expect(google.calls.filter((c) => c.url.endsWith("/token"))).toHaveLength(2);
  });

  it("routes each platform to its own service; Live Activity stays on APNs", async () => {
    const apns = new FakePush();
    const fcm = new FakePush();
    const routed = new RoutedPush(apns, fcm);
    await routed.send({ platform: "fcm", token: "a", kind: "task_done", count: 1 });
    await routed.send({ platform: "apns", token: "b", kind: "task_done", count: 1 });
    expect(fcm.sent.map((r) => r.token)).toEqual(["a"]);
    expect(apns.sent.map((r) => r.token)).toEqual(["b"]);
    expect(
      await routed.sendActivity?.({ platform: "fcm", token: "c", working: 1, needsYou: 0 }),
    ).toEqual({ ok: false, gone: false, reason: "activity_unsupported" });
    await routed.sendActivity?.({ platform: "apns", token: "d", working: 1, needsYou: 0 });
    expect(apns.activities.map((r) => r.token)).toEqual(["d"]);
  });
});
