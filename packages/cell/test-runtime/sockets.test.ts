import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, expect, it, vi } from "vitest";
import worker from "../src/worker.js";
import { signer } from "./identity.js";

afterEach(() => vi.restoreAllMocks());
it("replays events through a hibernating socket after eviction and closes revoked clients", async () => {
  const identity = await signer();
  let active = true;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url) =>
    String(url) === env.CELL_JWKS_URL
      ? Response.json({ keys: [identity.jwk] })
      : Response.json({ active }),
  );
  const org = crypto.randomUUID();
  const response = await worker.fetch(
    new Request(`https://cell.example.invalid/v1/orgs/${org}/connect?lastSeq=0`, {
      headers: { Upgrade: "websocket", Authorization: `Bearer ${await identity.token(org)}` },
    }),
    env,
  );
  expect(response.status).toBe(101);
  const socket = response.webSocket;
  if (!socket) throw new Error("socket_missing");
  socket.accept();
  const messages: {
    id?: number;
    method?: string;
    params?: { seq?: number };
    result?: unknown;
    error?: unknown;
  }[] = [];
  socket.addEventListener("message", (event) => {
    messages.push(JSON.parse(String(event.data)));
  });
  const stub = env.ORG_CELLS.get(env.ORG_CELLS.idFromName(org));
  socket.send(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "hello",
      params: { protocolVersion: 1, token: "unused" },
    }),
  );
  await vi.waitFor(() => expect(messages.some((m) => m.id === 1)).toBe(true));
  expect(messages.filter((m) => m.method === "event").map((m) => m.params?.seq)).toEqual([
    1, 2, 3, 4,
  ]);
  await evictDurableObject(stub);
  socket.send(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "cloud.project.create",
      params: {
        name: "Test",
        repository: "example/repository",
        defaultBranch: "main",
        setupScript: "",
      },
      commandId: crypto.randomUUID(),
    }),
  );
  await vi.waitFor(() => expect(messages.some((m) => m.id === 2)).toBe(true));
  expect(messages.find((m) => m.id === 2)?.error).toBeUndefined();
  await vi.waitFor(() =>
    expect(messages.filter((m) => m.method === "event").map((m) => m.params?.seq)).toEqual([
      1, 2, 3, 4, 5,
    ]),
  );
  expect(
    await runInDurableObject(stub, (_instance, state) => state.getWebSockets("client").length),
  ).toBe(1);
  const closed = new Promise<number>((resolve) =>
    socket.addEventListener("close", (event) => resolve(event.code), { once: true }),
  );
  active = false;
  expect(await runDurableObjectAlarm(stub)).toBe(true);
  expect(await closed).toBe(1008);
});
