import type { CellTokenClaims } from "@zoltbot/cloud-contracts";
import type { Store } from "@zoltbot/store/portable";

export interface SocketAttachment {
  claims: CellTokenClaims;
  lastSeq: number;
  subscribed: boolean;
  runnerId?: string;
}
export function attachment(socket: WebSocket): SocketAttachment {
  const value = socket.deserializeAttachment() as SocketAttachment | null;
  if (!value?.claims || !Number.isSafeInteger(value.lastSeq)) throw new Error("unauthorized");
  return value;
}
export class CellSockets {
  constructor(private readonly ctx: DurableObjectState) {}
  connect(request: Request, claims: CellTokenClaims, store: Store): Response {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket")
      return new Response(null, { status: 426 });
    if (this.ctx.getWebSockets().length >= 32) return new Response(null, { status: 429 });
    const lastSeq = Number(new URL(request.url).searchParams.get("lastSeq") ?? store.lastSeq());
    if (!Number.isSafeInteger(lastSeq) || lastSeq < 0 || lastSeq > store.lastSeq())
      return new Response(null, { status: 400 });
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server, [claims.kind === "client" ? "client" : "runner"]);
    server.serializeAttachment({
      claims,
      lastSeq,
      subscribed: claims.kind === "client",
    } satisfies SocketAttachment);
    return new Response(null, { status: 101, webSocket: client });
  }
  /** Bounded batches keep both historical reads and socket output within isolate memory. */
  replay(socket: WebSocket, store: Store): boolean {
    const data = attachment(socket);
    if (!data.subscribed) return false;
    let bytes = 0;
    let count = 0;
    while (count < 64 && bytes < 524288) {
      const event = store.eventsSince(data.lastSeq, 1)[0];
      if (!event) break;
      const message = JSON.stringify({ jsonrpc: "2.0", method: "event", params: event });
      bytes += new TextEncoder().encode(message).byteLength;
      socket.send(message);
      data.lastSeq = event.seq ?? data.lastSeq;
      count++;
    }
    socket.serializeAttachment(data);
    return data.lastSeq < store.lastSeq();
  }
}
