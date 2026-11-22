import { pairingOfferTtlMs } from "@zoltbot/link";
import { localCommandActor, parseRequest } from "@zoltbot/protocol";
import type { Store } from "@zoltbot/store";
import { WebSocket, WebSocketServer } from "ws";
import { assetServer } from "./api-assets.js";
import { equalToken } from "./api-token.js";
import type { DaemonOptions } from "./api-types.js";
import type { Cleanup } from "./daemon-resources.js";
import type { deviceBook } from "./devices.js";
import type { Logger, Redactor } from "./logging.js";
import { type LinkClient, type RelayLinkOptions, relayLink } from "./relay-link.js";
import type { TerminalRuntime } from "./terminal-runtime.js";
import type { ViewRegistry } from "./views/registry.js";

/** Local sockets and paired phones share one authenticated request envelope. */
export function apiTransports({
  server,
  token,
  call,
  redactor,
  logger,
  clients,
  terminals,
  identity,
  devices,
  relay,
  store,
  secrets,
}: {
  server: WebSocketServer;
  token: string;
  call(request: ReturnType<typeof parseRequest>, client: LinkClient): Promise<unknown>;
  redactor: Redactor;
  logger: Logger;
  clients: Set<LinkClient>;
  terminals: Pick<TerminalRuntime, "detach">;
  identity: RelayLinkOptions["identity"];
  devices: ReturnType<typeof deviceBook>;
  relay: DaemonOptions["relay"];
  store: Store;
  secrets: boolean;
}) {
  const respond = async (text: string, client: LinkClient): Promise<string> => {
    let id: string | number | null = null;
    try {
      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch {
        throw new Error("malformed_json");
      }
      if (
        raw &&
        typeof raw === "object" &&
        "id" in raw &&
        (typeof raw.id === "string" || typeof raw.id === "number")
      )
        id = raw.id;
      const request = parseRequest(raw, localCommandActor(client.deviceId));
      const result = await call(request, client);
      if (request.method !== "browser.input")
        logger.write("info", "API request", {
          method: request.method,
          ...(client.deviceId ? { from: "phone" } : {}),
        });
      return JSON.stringify({ jsonrpc: "2.0", id, result });
    } catch (error) {
      const message = redactor.text(error instanceof Error ? error.message : "internal");
      logger.write("warn", "Rejected API request", { message });
      return JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32602, message } });
    }
  };
  server.on("connection", (socket) => {
    let authenticated = false;
    const client: LinkClient = {
      subscribed: false,
      send(text) {
        if (socket.readyState === WebSocket.OPEN) socket.send(text);
      },
    };
    const authTimer = setTimeout(() => {
      if (!authenticated) socket.close(4401, "unauthorized");
    }, 5000);
    authTimer.unref();
    socket.on("close", () => {
      clearTimeout(authTimer);
      terminals.detach(client);
      clients.delete(client);
    });
    socket.on("error", (error) =>
      logger.write("warn", "Client connection error", { message: error.message }),
    );
    socket.on("message", async (data) => {
      const text = data.toString();
      if (!authenticated) {
        let raw: { id?: unknown; method?: unknown; params?: { token?: unknown } } | undefined;
        try {
          raw = JSON.parse(text);
        } catch {}
        if (raw?.method !== "hello" || !equalToken(String(raw.params?.token), token)) {
          const id = typeof raw?.id === "string" || typeof raw?.id === "number" ? raw.id : null;
          socket.send(
            JSON.stringify({
              jsonrpc: "2.0",
              id,
              error: { code: -32001, message: "unauthorized" },
            }),
          );
          socket.close(4401, "unauthorized");
          return;
        }
        authenticated = true;
        clearTimeout(authTimer);
        clients.add(client);
      }
      client.send(await respond(text, client));
    });
  });
  const link = relayLink({
    identity,
    answer: (hello, from) => devices.answer(hello, from),
    allowed: (deviceId) => devices.allowed(deviceId),
    serve: (text, client) => respond(text, client),
    attach: (client) => clients.add(client),
    detach: (client) => {
      terminals.detach(client);
      clients.delete(client);
    },
    ready: () => devices.ready(),
    presence: (deviceId, online, lastSeenAt) =>
      devices.seen(deviceId, online ? undefined : (lastSeenAt ?? new Date().toISOString())),
    log: (level, message, detail) => logger.write(level, message, detail),
    ...(relay?.retry ? { retry: relay.retry } : {}),
    ...(relay?.pingMs ? { pingMs: relay.pingMs } : {}),
  });
  const ownedLink = link;
  const relaySetting = () => {
    const value = store
      .snapshot(["settings"])
      .settings?.find((row) => row.key === "link.relayUrl")?.value;
    return typeof value === "string" ? value : undefined;
  };
  // A chosen address stays connected. The build's default relay serves only Macs that have
  // a phone paired, waiting, or about to scan a code, so idle installs hold no socket.
  const syncRelay = () => {
    if (!secrets) return;
    const chosen = relaySetting()?.trim();
    const fallback = devices.wanted() ? relay?.defaultUrl : undefined;
    ownedLink.configure(chosen || fallback);
  };
  const wakeRelay = async () => {
    syncRelay();
    // Let the link close again if the code expires unscanned.
    setTimeout(syncRelay, pairingOfferTtlMs + 1000).unref();
    await ownedLink.online(10_000);
  };
  return { link, syncRelay, wakeRelay };
}

/** Own the HTTP assets and WebSocket listener on one loopback port. */
export async function listenApi({
  store,
  token,
  origins,
  getViews,
  resources,
}: {
  store: Store;
  token: string;
  origins: Set<string>;
  getViews(): ViewRegistry | undefined;
  resources: Cleanup[];
}) {
  const assets = assetServer(store, token, origins, getViews);
  const server = new WebSocketServer({
    server: assets,
    maxPayload: 1_048_576,
    verifyClient: (info: { origin: string }) => !info.origin || origins.has(info.origin),
  });
  resources.push(async () => {
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  assets.listen(0, "127.0.0.1");
  resources.push(
    () =>
      new Promise<void>((resolve) => {
        for (const socket of server.clients) socket.terminate();
        assets.closeAllConnections();
        assets.close(() => resolve());
      }),
  );
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("invalid listen address");
  const url = `ws://127.0.0.1:${address.port}`;
  return { server, url };
}
