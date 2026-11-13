import { request } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import WebSocket, { WebSocketServer } from "ws";
import type { loopbackTls } from "./tls.js";

export type FrameHook = (frame: {
  direction: "to-cell" | "from-cell";
  data: string;
}) => string | readonly string[] | undefined;

/** A TLS front door for the real localhost Cell and fake Global HTTP services. */
export async function startTlsProxy(
  tls: Awaited<ReturnType<typeof loopbackTls>>,
  target: (pathname: string) => URL | undefined,
  transformFrame?: FrameHook,
) {
  const sockets = new Set<Duplex>();
  const peers = new Set<WebSocket>();
  const upgrades = transformFrame
    ? new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024 })
    : undefined;
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
    if (upgrades && transformFrame) {
      const endpoint = new URL(url);
      endpoint.protocol = "ws:";
      const remote = new WebSocket(endpoint, {
        headers:
          typeof incoming.headers.authorization === "string"
            ? { authorization: incoming.headers.authorization }
            : {},
        maxPayload: 2 * 1024 * 1024,
      });
      peers.add(remote);
      let front: WebSocket | undefined,
        queuedBytes = 0;
      const queued: Array<{ data: Buffer; binary: boolean }> = [];
      const closePeer = (peer: WebSocket | undefined) => {
        if (!peer) return;
        if (peer.readyState === WebSocket.OPEN) peer.close(1000);
        else if (peer.readyState === WebSocket.CONNECTING) peer.terminate();
      };
      const forward = (
        peer: WebSocket,
        data: Buffer,
        binary: boolean,
        direction: "to-cell" | "from-cell",
      ) => {
        try {
          const transformed = transformFrame({ direction, data: data.toString("utf8") });
          const frames = typeof transformed === "string" ? [transformed] : (transformed ?? []);
          if (frames.length > 8) throw new Error("fixture_frame_limit");
          for (const frame of frames)
            if (peer.readyState === WebSocket.OPEN) peer.send(frame, { binary });
        } catch {
          peer.terminate();
        }
      };
      remote.on("message", (data, binary) => {
        const bytes = Buffer.from(data as Buffer);
        if (front) forward(front, bytes, binary, "from-cell");
        else {
          queuedBytes += bytes.length;
          if (queuedBytes > 8 * 1024 * 1024) remote.terminate();
          else queued.push({ data: bytes, binary });
        }
      });
      remote.once("open", () => {
        try {
          upgrades.handleUpgrade(incoming, client, head, (socket) => {
            front = socket;
            peers.add(socket);
            socket.on("message", (data, binary) =>
              forward(remote, Buffer.from(data as Buffer), binary, "to-cell"),
            );
            socket.once("error", () => remote.terminate());
            socket.once("close", () => {
              peers.delete(socket);
              closePeer(remote);
            });
            for (const frame of queued) forward(socket, frame.data, frame.binary, "from-cell");
            queued.length = 0;
          });
        } catch {
          remote.terminate();
          client.destroy();
        }
      });
      remote.once("error", () => {
        client.destroy();
        front?.terminate();
      });
      remote.once("close", () => {
        peers.delete(remote);
        if (front) closePeer(front);
        else client.destroy();
      });
      client.once("error", () => remote.terminate());
      client.once("close", () => remote.terminate());
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
        for (const peer of peers) peer.terminate();
        if (upgrades) await new Promise<void>((resolve) => upgrades.close(() => resolve()));
        for (const socket of sockets) socket.destroy();
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      })()),
  });
}
