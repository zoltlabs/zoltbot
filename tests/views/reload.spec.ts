import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { expect, test, type WebSocketRoute } from "@playwright/test";
import { viewProtocol } from "../../apps/desktop/src/view-protocol.js";
import { ViewRegistry } from "../../packages/daemon/src/views/registry.js";
import { viewFixture } from "../../packages/daemon/src/views/test-fixture.js";
import fixture from "../../packages/view-api/src/fixtures/snapshot.json" with { type: "json" };

test("a watched edit replaces the isolated frame without restarting the host", async ({ page }) => {
  const f = await viewFixture(),
    sockets = new Set<WebSocketRoute>();
  const registry = new ViewRegistry(f.store, f.builtin, f.registry.user, (events) => {
    for (const event of events)
      for (const socket of sockets)
        socket.send(JSON.stringify({ jsonrpc: "2.0", method: "event", params: event }));
  });
  await registry.reload();
  await registry.api("view.customize", { id: "example" }, "customize");
  await registry.api(
    "view.setGrants",
    { id: "example", permissions: ["read"], confirmed: true },
    "grant",
  );
  const entry = path.join(registry.user, "example/index.html");
  const html = (text: string) =>
    `<!doctype html><html lang="en"><meta charset="utf-8"><title>Example</title><p>${text}</p><script src="_host/v1/zolt.js"></script></html>`;
  await writeFile(entry, html("First version"));
  await registry.start([]);
  let origin = "";
  const client = await readFile(new URL("../../packages/view-api/client/zolt.js", import.meta.url));
  const handler = viewProtocol({
    origin: "http://127.0.0.1",
    client: () => client,
    asset: async (kind, hash, fileHash) =>
      (await registry.asset(hash, kind === "file" ? fileHash : undefined)).bytes,
  });
  const root = path.resolve("dist/ui");
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", origin);
      const prepare = /^\/prepare\/([a-f0-9]{64})$/.exec(url.pathname);
      if (prepare?.[1]) {
        const result = await handler.prepare(prepare[1]);
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(
          JSON.stringify({ url: result.url.replace("zoltbot-view://", `${origin}/view/`) }),
        );
        return;
      }
      const view = /^\/view\/([a-f0-9]{64})\/(.*)$/.exec(url.pathname);
      if (view?.[1]) {
        const result = await handler.handle(new Request(`zoltbot-view://${view[1]}/${view[2]}`));
        const headers = Object.fromEntries(result.headers);
        headers["content-security-policy"] = (headers["content-security-policy"] ?? "")
          .replaceAll(`zoltbot-view://${view[1]}`, `${origin}/view/${view[1]}/`)
          .replace("frame-ancestors http://127.0.0.1", `frame-ancestors ${origin}`);
        response.writeHead(result.status, headers);
        response.end(Buffer.from(await result.arrayBuffer()));
        return;
      }
      const relative = url.pathname === "/" ? "index.html" : url.pathname.slice(1),
        target = path.resolve(root, relative);
      if (!target.startsWith(root + path.sep)) throw Error("path");
      let bytes = await readFile(target);
      if (relative === "index.html")
        bytes = Buffer.from(
          bytes
            .toString()
            .replace(
              "frame-src zoltbot-artifact: zoltbot-view:",
              `frame-src zoltbot-artifact: zoltbot-view: ${origin}`,
            ),
        );
      response.writeHead(200, {
        "Content-Type": relative.endsWith("html")
          ? "text/html"
          : relative.endsWith("js")
            ? "text/javascript"
            : relative.endsWith("css")
              ? "text/css"
              : "application/octet-stream",
      });
      response.end(bytes);
    })().catch(() => {
      response.writeHead(404);
      response.end();
    });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw Error("address");
    origin = `http://127.0.0.1:${address.port}`;
    await page.routeWebSocket("**/*", (socket) => {
      sockets.add(socket);
      socket.onClose(() => sockets.delete(socket));
      socket.onMessage((bytes) => {
        const message = JSON.parse(bytes.toString()),
          seq = f.store.lastSeq();
        const result =
          message.method === "snapshot.get"
            ? {
                seq,
                entities: { ...fixture.entities, view: f.store.snapshot().view },
                counters: {},
              }
            : message.method === "events.subscribe"
              ? { seq, resync: false, events: [] }
              : message.method.endsWith(".list") || message.method.endsWith(".history")
                ? { items: [] }
                : { ok: true };
        socket.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
      });
    });
    await page.addInitScript(
      ({ origin }) => {
        if (window.top !== window) return;
        window.zoltDesktop = {
          connection: async () => ({
            url: origin.replace("http:", "ws:"),
            token: "synthetic-owner-token",
          }),
          onConnectionChanged: () => () => {},
          prepareView: async (hash: string) => (await fetch(`${origin}/prepare/${hash}`)).json(),
        };
      },
      { origin },
    );
    await page.goto(`${origin}/#view/example`);
    const frame = page.frameLocator('iframe[title="Example"]');
    await expect(frame.getByText("First version", { exact: true })).toBeVisible();
    const old = await page.locator("iframe").getAttribute("src");
    await writeFile(entry, html("Changed without restarting"));
    await expect(page.locator("iframe")).not.toHaveAttribute("src", old ?? "");
    await expect(frame.getByText("Changed without restarting", { exact: true })).toBeVisible();
    expect(await frame.locator("body").evaluate(() => typeof window.zoltDesktop)).toBe("undefined");
  } finally {
    await registry.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await f.close();
  }
});
