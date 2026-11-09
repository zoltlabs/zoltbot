import { expect, it, vi } from "vitest";
import type { ConnectionDescriptor } from "../../connections/src/launch-manifest.js";
import { requestJson } from "../../connections/src/network.js";
import { brokerServices } from "../../connections/src/service-catalog.js";
import { startGoogleAdapter } from "./google-adapter.js";

vi.mock("../../connections/src/network.js", () => ({ requestJson: vi.fn() }));

it("keeps Google credentials behind a loopback capability, rejects writes/invalid IDs, and fences revocation", async () => {
  const descriptor: ConnectionDescriptor = {
    id: "google",
    version: 1,
    name: "gmail",
    projectId: "project",
    transport: { kind: "https", url: brokerServices.gmail.resource },
    credentialReference: "keychain:zoltbot:00000000-0000-0000-0000-000000000000",
    schemaTokens: { value: 512, source: "estimated" },
  };
  let revoked = false;
  const assert = () => {
    if (revoked) throw Error("revoked");
  };
  const adapter = await startGoogleAdapter(
    descriptor,
    async () => ({
      resource: brokerServices.gmail.resource,
      issuer: "https://zoltbot.ai",
      accessToken: "GOOGLE_PRIVATE_SENTINEL",
    }),
    assert,
    () => {},
  );
  if (adapter.connection.kind !== "https") throw Error();
  const connection = adapter.connection;
  const send = (method: string, params: unknown = {}, headers: Record<string, string> = {}) =>
    fetch(connection.url, {
      method: "POST",
      headers: {
        ...connection.headers,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...headers,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
  try {
    expect(JSON.stringify(connection)).not.toContain("GOOGLE_PRIVATE_SENTINEL");
    expect((await send("tools/list", {}, { Authorization: "Bearer wrong" })).status).toBe(401);
    expect((await send("tools/list", {}, { Origin: "https://example.com" })).status).toBe(403);
    const listed = await (await send("tools/list")).json();
    expect(listed.result.tools.map((t: { name: string }) => t.name)).toEqual([
      "gmail_search",
      "gmail_read_thread",
      "gmail_read_message",
    ]);
    await send("tools/call", { name: "gmail_send", arguments: {} });
    await send("tools/call", {
      name: "gmail_read_message",
      arguments: { messageId: "../../evil" },
    });
    expect(requestJson).not.toHaveBeenCalled();
    vi.mocked(requestJson).mockImplementation(async (url, _policy, body, options) => {
      expect(new URL(url).origin).toBe("https://gmail.googleapis.com");
      expect(body).toBeUndefined();
      expect(options?.headers?.Authorization).toBe("Bearer GOOGLE_PRIVATE_SENTINEL");
      return { messages: [{ id: "message" }] };
    });
    const read = await (
      await send("tools/call", {
        name: "gmail_search",
        arguments: { query: "verification", limit: 1 },
      })
    ).json();
    expect(read.result.isError).not.toBe(true);
    expect(read.result.content[0].text).toContain("message");
    revoked = true;
    const denied = await (await send("tools/call", { name: "gmail_search", arguments: {} })).json();
    expect(denied.result.isError).toBe(true);
    expect(requestJson).toHaveBeenCalledTimes(1);
    revoked = false;
    let entered!: () => void;
    let finish!: (value: Record<string, unknown>) => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    vi.mocked(requestJson).mockImplementation(() => {
      entered();
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    const pending = send("tools/call", { name: "gmail_search", arguments: {} });
    await started;
    revoked = true;
    finish({ messages: [{ id: "PRIVATE_AFTER_REVOCATION" }] });
    const fenced = await (await pending).json();
    expect(fenced.result.isError).toBe(true);
    expect(JSON.stringify(fenced)).not.toContain("PRIVATE_AFTER_REVOCATION");
  } finally {
    await adapter.close();
  }
  await expect(fetch(connection.url)).rejects.toThrow();
});
