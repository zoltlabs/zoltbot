import { methodCatalog, parse } from "@zoltbot/protocol";
import { OutcomeUnknownError, type Snapshot } from "../data/transport.js";
import type { PhoneCellConnection } from "./account.js";

export interface PhoneCloudSocket {
  send(text: string): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code?: number }) => void) | null;
  onerror: (() => void) | null;
}
export interface PhoneCloudState {
  status: "connecting" | "online" | "offline";
  readOnly: boolean;
  snapshot: Snapshot;
  error?: "cloud_unavailable" | "cloud_authority_refused";
}
const blank = (): Snapshot => ({ seq: 0, entities: {}, counters: {} });
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const maximumFrame = 8 * 1024 * 1024;
const reads = /^(?:snapshot\.get|events\.(?:un)?subscribe)$|\.(?:list|get|history|search|output)$/;
const utf8Length = (value: string) =>
  encodeURIComponent(value).replace(/%[0-9A-F]{2}/g, "x").length;

/** One account/org cache and socket; never falls back to the paired Mac or replays a command. */
export function phoneCloudConnection(options: {
  owner: PhoneCellConnection["owner"];
  credentials(): Promise<PhoneCellConnection>;
  socket(url: string, headers: Readonly<Record<string, string>>): PhoneCloudSocket;
  watchAuthority?(refuse: () => void): () => void;
}) {
  const owner = Object.freeze({ ...options.owner });
  let state: PhoneCloudState = { status: "connecting", readOnly: true, snapshot: blank() };
  let started = false,
    stopped = false,
    generation = 0,
    nextId = 0,
    failures = 0,
    refreshing = false,
    dirty = false;
  let socket: PhoneCloudSocket | undefined,
    authority: PhoneCellConnection | undefined,
    pinnedOrigin: string | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined,
    renewal: ReturnType<typeof setTimeout> | undefined,
    deadline: ReturnType<typeof setTimeout> | undefined;
  let unwatch: (() => void) | undefined;
  const listeners = new Set<(state: PhoneCloudState) => void>();
  const pending = new Map<
    number,
    {
      method: keyof typeof methodCatalog;
      resolve(value: unknown): void;
      reject(error: Error): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  const notify = (listener: (state: PhoneCloudState) => void) => {
    try {
      listener(clone(state));
    } catch {}
  };
  const publish = (next: PhoneCloudState) => {
    state = next;
    for (const listener of [...listeners]) {
      if (state !== next) break;
      if (listeners.has(listener)) notify(listener);
    }
  };
  const rejectPending = () => {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(
        reads.test(request.method)
          ? new Error("cloud_connection_lost")
          : new OutcomeUnknownError("cloud_outcome_unknown"),
      );
    }
    pending.clear();
  };
  const closeAttempt = () => {
    generation++;
    clearTimeout(deadline);
    clearTimeout(renewal);
    clearTimeout(retry);
    const previous = socket;
    socket = undefined;
    authority?.clear();
    authority = undefined;
    rejectPending();
    refreshing = false;
    dirty = false;
    try {
      previous?.close();
    } catch {}
  };
  const stopWatching = () => {
    const unsubscribe = unwatch;
    unwatch = undefined;
    unsubscribe?.();
  };
  const disconnect = (refused = false) => {
    if (stopped) return;
    closeAttempt();
    if (refused) {
      stopped = true;
      stopWatching();
      publish({
        status: "offline",
        readOnly: true,
        snapshot: blank(),
        error: "cloud_authority_refused",
      });
    } else {
      retry = setTimeout(() => void connect(), Math.min(30000, 500 * 2 ** Math.min(failures++, 6)));
      publish({
        status: "offline",
        readOnly: true,
        snapshot: state.snapshot,
        error: "cloud_unavailable",
      });
    }
  };
  const request = (method: string, params: unknown, commandId?: string): Promise<unknown> => {
    const active = socket;
    if (stopped || !active) return Promise.reject(new Error("cloud_offline"));
    if (!Object.hasOwn(methodCatalog, method))
      return Promise.reject(new Error("method_unavailable"));
    const key = method as keyof typeof methodCatalog,
      definition = methodCatalog[key];
    if (definition.where === "local") return Promise.reject(new Error("method_unavailable"));
    let value: unknown;
    try {
      value = parse(definition.params, params);
    } catch {
      return Promise.reject(new Error("cloud_request_invalid"));
    }
    if (commandId !== undefined && !/^[A-Za-z0-9:._-]{1,200}$/.test(commandId))
      return Promise.reject(new Error("cloud_request_invalid"));
    const id = ++nextId,
      frame = JSON.stringify({
        jsonrpc: "2.0",
        id,
        method,
        params: value,
        ...(commandId ? { commandId } : {}),
      });
    if (utf8Length(frame) > maximumFrame || pending.size >= 64)
      return Promise.reject(new Error("cloud_request_limit"));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(
          reads.test(method)
            ? new Error("cloud_request_timed_out")
            : new OutcomeUnknownError("cloud_outcome_unknown"),
        );
      }, 15000);
      pending.set(id, { method: key, resolve, reject, timer });
      try {
        active.send(frame);
      } catch {
        disconnect();
      }
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
        if (!stopped && current === generation)
          publish({ status: "online", readOnly: false, snapshot });
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
    deadline = setTimeout(() => {
      if (current === generation) disconnect();
    }, 15000);
    publish({ status: "connecting", readOnly: true, snapshot: state.snapshot });
    if (stopped || current !== generation) return;
    try {
      const next = await options.credentials();
      if (stopped || current !== generation) {
        next.clear();
        return;
      }
      authority = next;
      if (
        Object.keys(owner).some(
          (key) => next.owner[key as keyof typeof owner] !== owner[key as keyof typeof owner],
        )
      )
        throw new Error("account_session_changed");
      const origin = new URL(next.cellUrl),
        expiry = Date.parse(next.expiresAt);
      if (
        origin.protocol !== "https:" ||
        origin.origin !== next.cellUrl ||
        !Number.isFinite(expiry) ||
        expiry <= Date.now() + 1000
      )
        throw new Error("account_session_changed");
      if (pinnedOrigin && pinnedOrigin !== origin.origin)
        throw new Error("account_session_changed");
      pinnedOrigin = origin.origin;
      const endpoint = new URL(`/v1/orgs/${encodeURIComponent(owner.orgId)}/connect`, origin);
      endpoint.protocol = "wss:";
      const active = options.socket(endpoint.href, { Authorization: `Bearer ${next.readToken()}` });
      socket = active;
      active.onmessage = (event) => {
        if (stopped || socket !== active || current !== generation) return;
        try {
          if (
            typeof event.data !== "string" ||
            event.data.length > maximumFrame ||
            utf8Length(event.data) > maximumFrame
          )
            throw new Error();
          const frame = JSON.parse(event.data);
          if (!frame || frame.jsonrpc !== "2.0") throw new Error();
          if (frame.method === "event") {
            void refresh(current);
            return;
          }
          const waiting = pending.get(frame.id);
          if (!waiting) return;
          pending.delete(frame.id);
          clearTimeout(waiting.timer);
          if (frame.error) {
            waiting.reject(new Error("cloud_request_refused"));
            if (frame.error.message === "unauthorized") disconnect(true);
          } else {
            try {
              waiting.resolve(parse(methodCatalog[waiting.method].result, frame.result));
            } catch {
              waiting.reject(new Error("cloud_response_invalid"));
              disconnect();
            }
          }
        } catch {
          disconnect();
        }
      };
      active.onclose = (event) => {
        if (socket === active) disconnect(event.code === 1008);
      };
      active.onerror = () => {
        if (socket === active) disconnect();
      };
      active.onopen = () => {
        if (stopped || socket !== active || current !== generation) return;
        void (async () => {
          await request("events.subscribe", { fromSeq: state.snapshot.seq });
          if (stopped || current !== generation) return;
          await refresh(current);
          if (stopped || current !== generation) return;
          clearTimeout(deadline);
          failures = 0;
          renewal = setTimeout(
            () => {
              if (socket === active) disconnect();
            },
            Math.max(1000, Math.min(570000, expiry - Date.now() - 30000)),
          );
        })().catch(() => {
          if (current === generation) disconnect();
        });
      };
    } catch (error) {
      if (!stopped && current === generation)
        disconnect(
          error instanceof Error &&
            [
              "account_session_changed",
              "account_access_refused",
              "sign_in_required",
              "account_cleanup_required",
            ].includes(error.message),
        );
    }
  };
  return Object.freeze({
    owner,
    state: () => clone(state),
    subscribe(listener: (state: PhoneCloudState) => void) {
      listeners.add(listener);
      notify(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    start() {
      if (started) return;
      started = true;
      const unsubscribe = options.watchAuthority?.(() => disconnect(true));
      if (stopped) unsubscribe?.();
      else unwatch = unsubscribe;
      void connect();
    },
    stop() {
      if (stopped && state.snapshot.seq === 0) return;
      stopped = true;
      closeAttempt();
      stopWatching();
      publish({ status: "offline", readOnly: true, snapshot: blank() });
    },
    call(method: string, params: unknown, commandId?: string) {
      if (state.status !== "online" || state.readOnly)
        return Promise.reject(new Error("cloud_offline"));
      return request(method, params, commandId);
    },
  });
}
