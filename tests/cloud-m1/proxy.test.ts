import { createServer } from "node:http";
import { get } from "node:https";
import type { AddressInfo } from "node:net";
import { expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { startTlsProxy } from "./proxy.js";
import { loopbackTls } from "./tls.js";

it("proxies verified localhost HTTPS and WebSockets and refuses an absolute target outside loopback", async () => {
  const tls = await loopbackTls();
  let requests = 0;
  const backend = createServer((_request, response) => {
    requests++;
    response.end("proxy");
  });
  const sockets = new WebSocketServer({ noServer: true });
  backend.on("upgrade", (request, socket, head) =>
    sockets.handleUpgrade(request, socket, head, (connection) =>
      connection.on("message", (data) => connection.send(data)),
    ),
  );
  await new Promise<void>((resolve) => backend.listen(0, "127.0.0.1", resolve));
  const target = new URL(`http://127.0.0.1:${(backend.address() as AddressInfo).port}`);
  const proxy = await startTlsProxy(tls, () => target);
  const read = (pathname: string) =>
    new Promise<{ status: number; text: string }>((resolve, reject) => {
      const request = get(
        {
          hostname: "127.0.0.1",
          port: new URL(proxy.origin()).port,
          path: pathname,
          ca: tls.certificate(),
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
          response.once("end", () =>
            resolve({
              status: response.statusCode ?? 0,
              text: Buffer.concat(chunks).toString("utf8"),
            }),
          );
        },
      );
      request.once("error", () => reject(new Error("fixture_proxy_request_failed")));
    });
  let client: WebSocket | undefined;
  try {
    expect(await read("/health")).toEqual({ status: 200, text: "proxy" });
    expect((await read("http://other.example.invalid/health")).status).toBe(503);
    expect(requests).toBe(1);
    client = new WebSocket(`${proxy.origin().replace("https:", "wss:")}/connect`, {
      ca: tls.certificate(),
    });
    const owned = client;
    const echoed = new Promise<string>((resolve, reject) => {
      owned.once("open", () => owned.send("hello"));
      owned.once("message", (data) => resolve(data.toString()));
      owned.once("error", () => reject(new Error("fixture_proxy_socket_failed")));
    });
    expect(await echoed).toBe("hello");
  } finally {
    client?.terminate();
    for (const connection of sockets.clients) connection.terminate();
    await proxy.close();
    sockets.close();
    backend.closeAllConnections();
    await new Promise<void>((resolve) => backend.close(() => resolve()));
  }
});
