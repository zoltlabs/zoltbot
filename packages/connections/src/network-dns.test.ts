import { createServer } from "node:http";
import { expect, it, vi } from "vitest";

vi.mock("node:dns/promises", () => ({ lookup: async () => [{ address: "127.0.0.1", family: 4 }] }));

import { requestJson } from "./network.js";

it("pins checked DNS while honoring Node 24's all-address lookup callback", async () => {
  const server = createServer((_req, res) => res.end(JSON.stringify({ ok: true })));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error();
  const origin = `http://fixture.test:${address.port}`;
  try {
    await expect(
      requestJson(`${origin}/metadata`, { origins: [origin], localOrigins: [origin] }),
    ).resolves.toEqual({ ok: true });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
