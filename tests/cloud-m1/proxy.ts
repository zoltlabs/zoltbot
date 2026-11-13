import { request } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import type { loopbackTls } from "./tls.js";

/** A TLS front door for the real localhost Cell and fake Global HTTP services. */
export async function startTlsProxy(
  tls: Awaited<ReturnType<typeof loopbackTls>>,
  target: (pathname: string) => URL | undefined,
) {
  const sockets = new Set<Duplex>();
  let closing: Promise<void> | undefined;
  const destination = (pathname: string) => {
    const result = target(pathname);
    if (
      !result ||
      result.protocol !== "http:" ||
      result.hostname !== "127.0.0.1" ||
      result.username ||
      result.password
    )
      throw new Error("fixture_proxy_target_invalid");
    const resolved = new URL(pathname, result);
    if (resolved.origin !== result.origin) throw new Error("fixture_proxy_target_invalid");
    return resolved;
  };
  const server = tls.server((incoming, outgoing) => {
    let url: URL;
    try {
      url = destination(incoming.url ?? "/");
    } catch {
      outgoing.writeHead(503).end();
      return;
    }
    const upstream = request(
      url,
      { method: incoming.method, headers: { ...incoming.headers, host: url.host } },
      (response) => {
        outgoing.writeHead(response.statusCode ?? 502, response.headers);
        response.once("error", () => outgoing.destroy());
        response.pipe(outgoing);
      },
    );
    upstream.once("error", () => {
      if (!outgoing.headersSent) outgoing.writeHead(502);
      outgoing.end();
    });
    incoming.once("aborted", () => upstream.destroy());
    incoming.once("error", () => upstream.destroy());
    outgoing.once("close", () => upstream.destroy());
    incoming.pipe(upstream);
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.on("upgrade", (incoming, client, head) => {
    let url: URL;
    try {
      url = destination(incoming.url ?? "/");
    } catch {
      client.end("HTTP/1.1 503 Unavailable\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    const upstream = request(url, {
      method: "GET",
      headers: { ...incoming.headers, host: url.host },
    });
    upstream.once("error", () => client.destroy());
    upstream.once("response", (response) => {
      response.resume();
      client.end(`HTTP/1.1 ${response.statusCode ?? 502} Refused\r\nContent-Length: 0\r\n\r\n`);
    });
    upstream.once("upgrade", (response, remote, remoteHead) => {
      sockets.add(remote);
      remote.once("close", () => sockets.delete(remote));
      const headers = response.rawHeaders;
      const lines: string[] = [];
      for (let n = 0; n < headers.length; n += 2) lines.push(`${headers[n]}: ${headers[n + 1]}`);
      client.write(`HTTP/1.1 101 Switching Protocols\r\n${lines.join("\r\n")}\r\n\r\n`);
      if (head.length) remote.write(head);
      if (remoteHead.length) client.write(remoteHead);
      client.once("error", () => remote.destroy());
      remote.once("error", () => client.destroy());
      client.once("close", () => remote.destroy());
      remote.once("close", () => client.destroy());
      client.pipe(remote);
      remote.pipe(client);
    });
    upstream.end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", () => reject(new Error("fixture_proxy_unavailable")));
    server.listen(0, "127.0.0.1", resolve);
  });
  const origin = `https://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return Object.freeze({
    origin: () => origin,
    close: () =>
      (closing ??= (async () => {
        for (const socket of sockets) socket.destroy();
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      })()),
  });
}
