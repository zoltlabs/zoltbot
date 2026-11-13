import { CellTokenClaimsSchema, CellTokenResultSchema } from "@zoltbot/cloud-contracts";
import { methodCatalog, parse } from "@zoltbot/protocol";
import WebSocket from "ws";
import type { ConnectionState, Snapshot } from "../../../../packages/ui/src/connection.js";
import type { CloudAccountBinding, NativeConnection } from "./manager.js";

const maximumFrame = 8 * 1024 * 1024;
const blank = (): Snapshot => ({ seq: 0, entities: {}, counters: {} });
/** Cell credentials and the authenticated socket remain in the native main process. */
export function cellConnection(options: {
  origin: string;
  account: Readonly<CloudAccountBinding>;
  deviceId: string;
  credentials(signal: AbortSignal): Promise<unknown>;
  socket?(url: URL, options: WebSocket.ClientOptions): WebSocket;
}): NativeConnection {
  const origin = new URL(options.origin);
  if (
    origin.protocol !== "https:" ||
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash
  )
    throw new Error("cell_configuration_invalid");
  const binding = Object.freeze({ ...options.account });
  const listeners = new Set<(state: ConnectionState) => void>();
  let state: ConnectionState = { status: "connecting", snapshot: blank() },
    socket: WebSocket | undefined,
    controller: AbortController | undefined,
    retry: ReturnType<typeof setTimeout> | undefined,
    renewal: ReturnType<typeof setTimeout> | undefined,
    started = false,
    stopped = false,
    nextId = 0,
    generation = 0,
    failures = 0,
    refreshing = false,
    dirty = false;
  const pending = new Map<
    number,
    {
      method: keyof typeof methodCatalog;
      resolve(value: unknown): void;
      reject(error: Error): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  const publish = (next: ConnectionState) => {
    state = next;
    for (const listener of listeners) listener(structuredClone(state));
  };
  const rejectPending = () => {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error("cloud_connection_lost"));
    }
    pending.clear();
  };
  const disconnect = (unauthorized = false) => {
    if (stopped) return;
    generation++;
    controller?.abort();
    clearTimeout(renewal);
    const previous = socket;
    socket = undefined;
    previous?.terminate();
    rejectPending();
    refreshing = false;
    dirty = false;
    if (unauthorized) {
      stopped = true;
      clearTimeout(retry);
      publish({ status: "offline", snapshot: blank(), error: "unauthorized" });
    } else {
      publish({
        status: "offline",
        snapshot: state.snapshot,
        error: "cloud_connection_unavailable",
      });
      clearTimeout(retry);
      retry = setTimeout(() => void connect(), Math.min(30000, 500 * 2 ** Math.min(failures++, 6)));
    }
  };
  const request = (method: string, params: unknown, commandId?: string): Promise<unknown> => {
    const active = socket;
    if (stopped || !active || active.readyState !== WebSocket.OPEN)
      return Promise.reject(new Error("cloud_offline"));
    if (!Object.hasOwn(methodCatalog, method))
      return Promise.reject(new Error("method_unavailable"));
    const key = method as keyof typeof methodCatalog,
      definition = methodCatalog[key];
    if (definition.where === "local") return Promise.reject(new Error("method_unavailable"));
    const payload = parse(definition.params, params),
      id = ++nextId,
      frame = JSON.stringify({
        jsonrpc: "2.0",
        id,
        method,
        params: payload,
        ...(commandId ? { commandId } : {}),
      });
    if (Buffer.byteLength(frame) > maximumFrame || pending.size >= 64)
      return Promise.reject(new Error("cloud_request_limit"));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error("cloud_request_timed_out"));
      }, 15000);
      pending.set(id, { method: key, resolve, reject, timer });
      active.send(frame, (error) => {
        if (error && socket === active) disconnect();
      });
    });
  };
  const refresh = async (current: number) => {
    dirty = true;
    if (refreshing) return;
    refreshing = true;
    try {
      while (dirty && !stopped && current === generation) {
        dirty = false;
        const snapshot = (await request("snapshot.get", {})) as Snapshot;
        if (!stopped && current === generation) publish({ status: "online", snapshot });
      }
    } catch {
      if (!stopped && current === generation) disconnect();
    } finally {
      if (current === generation) refreshing = false;
    }
  };
  const connect = async () => {
    if (stopped) return;
    const current = ++generation;
    controller = new AbortController();
    const signal = controller.signal;
    publish({ status: "connecting", snapshot: state.snapshot });
    const deadline = setTimeout(() => {
      if (current === generation) disconnect();
    }, 10000);
    try {
      const credentials = parse(CellTokenResultSchema, await options.credentials(signal));
      if (stopped || signal.aborted || current !== generation) return;
      if (credentials.token.length > 16384) throw new Error("cell_configuration_invalid");
      const target = new URL(credentials.cellUrl);
      if (target.href !== origin.href) throw new Error("cell_configuration_invalid");
      const claims = parse(
        CellTokenClaimsSchema,
        JSON.parse(
          Buffer.from(credentials.token.split(".")[1] ?? "", "base64url").toString("utf8"),
        ),
      );
      const expiry = Math.min(Date.parse(credentials.expiresAt), claims.exp * 1000);
      if (
        claims.kind !== "client" ||
        claims.task !== undefined ||
        claims.grant !== undefined ||
        claims.surface !== "desktop" ||
        claims.sub !== binding.userId ||
        claims.org !== binding.orgId ||
        claims.device !== options.deviceId ||
        claims.session !== binding.sessionId ||
        !Number.isFinite(expiry) ||
        expiry <= Date.now() + 1000
      )
        throw new Error("account_session_changed");
      const endpoint = new URL(`/v1/orgs/${encodeURIComponent(binding.orgId)}/connect`, origin);
      endpoint.protocol = "wss:";
      const active = (options.socket ?? ((url, config) => new WebSocket(url, config)))(endpoint, {
        headers: { Authorization: `Bearer ${credentials.token}` },
        maxPayload: maximumFrame,
        handshakeTimeout: 10000,
        followRedirects: false,
      });
      socket = active;
      active.on("unexpected-response", (_request, response) => {
        response.resume();
        if (socket === active) disconnect([401, 403].includes(response.statusCode ?? 0));
      });
      active.on("error", () => {
        if (socket === active) disconnect();
      });
      active.on("close", (code) => {
        if (socket === active) disconnect(code === 1008);
      });
      active.on("message", (raw, binary) => {
        if (stopped || socket !== active || generation !== current) return;
        try {
          if (binary) throw new Error();
          const frame = JSON.parse(raw.toString());
          if (!frame || frame.jsonrpc !== "2.0") throw new Error();
          if (frame.method === "event") {
            // Refresh from authoritative scoped projections; coalesce event bursts.
            void refresh(current);
            return;
          }
          const waiting = pending.get(frame.id);
          if (!waiting) return;
          pending.delete(frame.id);
          clearTimeout(waiting.timer);
          if (frame.error) {
            if (frame.error.message === "unauthorized") {
              waiting.reject(new Error("unauthorized"));
              disconnect(true);
            } else waiting.reject(new Error("cloud_request_refused"));
          } else {
            try {
              waiting.resolve(parse(methodCatalog[waiting.method].result, frame.result));
            } catch {
              waiting.reject(new Error("cloud_response_invalid"));
              disconnect();
            }
          }
        } catch {
          if (socket === active) disconnect();
        }
      });
      await new Promise<void>((resolve, reject) => {
        active.once("open", resolve);
        active.once("error", () => reject(new Error("cloud_connection_unavailable")));
        active.once("close", () => reject(new Error("cloud_connection_unavailable")));
      });
      if (stopped || current !== generation) return;
      clearTimeout(deadline);
      renewal = setTimeout(
        () => {
          if (socket === active) disconnect();
        },
        Math.max(1000, Math.min(570000, expiry - Date.now() - 30000)),
      );
      // Subscribe before the first projection, retaining any concurrent event signal.
      await request("events.subscribe", {});
      if (current !== generation || stopped) return;
      await refresh(current);
      failures = 0;
    } catch (error) {
      if (!stopped && current === generation)
        disconnect(
          error instanceof Error &&
            [
              "account_session_changed",
              "account_refresh_refused",
              "not_signed_in",
              "sign_in_required",
              "account_access_revoked",
              "account_origin_changed",
              "cell_configuration_invalid",
            ].includes(error.message),
        );
    } finally {
      clearTimeout(deadline);
    }
  };
  return {
    subscribe(listener) {
      listeners.add(listener);
      listener(structuredClone(state));
      return () => {
        listeners.delete(listener);
      };
    },
    async start() {
      if (!started && !stopped) {
        started = true;
        await connect();
      }
    },
    call(method, params, commandId) {
      if (state.status !== "online") return Promise.reject(new Error("cloud_offline"));
      return request(method, params, commandId);
    },
    stop() {
      if (stopped && !socket) {
        listeners.clear();
        return;
      }
      stopped = true;
      generation++;
      controller?.abort();
      clearTimeout(retry);
      clearTimeout(renewal);
      const previous = socket;
      socket = undefined;
      previous?.terminate();
      rejectPending();
      state = { status: "offline", snapshot: blank() };
      listeners.clear();
    },
  };
}
