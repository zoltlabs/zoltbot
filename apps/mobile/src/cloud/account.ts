import { Type } from "@sinclair/typebox";
import {
  type Credentials,
  NativeStartResultSchema,
  parseCredentials,
} from "@zoltbot/cloud-contracts";
import { toB64 } from "@zoltbot/link";
import { parse } from "@zoltbot/protocol";
import type { SecretStore } from "../data/link-store.js";

export const phoneAccountKey = "zoltbot.account.native.v1";
export const phoneAccountCallback = "zoltbot://account/callback";
const text = Type.String({ minLength: 1, maxLength: 1000 });
const metadataSchema = Type.Object({
  sessionId: text,
  user: Type.Object({ id: text, name: text, email: text }),
  organizations: Type.Array(
    Type.Object({ id: text, name: text, role: text, kind: Type.Optional(text) }),
    { maxItems: 100 },
  ),
});
export interface PhoneAccountMetadata {
  sessionId: string;
  user: { id: string; name: string; email: string };
  organizations: Array<{ id: string; name: string; role: string; kind?: string }>;
}
export interface PhoneAccountStatus {
  configured: boolean;
  signedIn: boolean;
  online: boolean;
  sessionId?: string;
  account?: PhoneAccountMetadata;
}
export interface PhoneAccountOptions {
  origin?: string;
  storage: SecretStore;
  deviceName: string;
  randomBytes(size: number): Promise<Uint8Array>;
  challenge(verifier: string): Promise<string>;
  browser: {
    open(url: string, callback: string): Promise<{ type: string; url?: string }>;
    cancel(): void;
  };
  fetch?: typeof fetch;
  /** Test fixtures only. The packaged native adapter never sets this. */
  allowLoopback?: boolean;
}

/** One phone owner: raw account credentials never enter React state or Local pairing storage. */
export function phoneAccount(options: PhoneAccountOptions) {
  const origin = options.origin;
  if (origin) {
    try {
      const url = new URL(origin);
      if (
        origin.length > 2048 ||
        url.origin !== origin ||
        url.username ||
        url.password ||
        (url.protocol !== "https:" &&
          !(options.allowLoopback && url.protocol === "http:" && url.hostname === "127.0.0.1"))
      )
        throw new Error();
    } catch {
      throw new Error("account_configuration_invalid");
    }
  }
  const send = options.fetch ?? fetch;
  let credentials: Credentials | undefined,
    loaded = false,
    signing = false;
  let cleanupRequired = false;
  let cleanupSessionId: string | undefined;
  let generation = 0,
    operation: AbortController | undefined;
  let queue: Promise<unknown> = Promise.resolve();
  const listeners = new Set<() => void>(),
    privateValues = new Set<string>();
  const notify = () => {
    for (const listener of listeners) {
      try {
        listener();
      } catch {}
    }
  };
  const serialized = <T>(action: () => Promise<T>): Promise<T> => {
    const next = queue.then(action, action);
    queue = next.catch(() => {});
    return next;
  };
  const parseSaved = (value: unknown) => {
    const result = parseCredentials(value);
    if (!result.sessionId || result.sessionId.length > 200 || /[\0\r\n]/.test(result.sessionId))
      throw new Error("account_unavailable");
    const frozen = {
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      sessionId: result.sessionId,
    };
    privateValues.add(frozen.accessToken);
    privateValues.add(frozen.refreshToken);
    return frozen;
  };
  const clear = async () => {
    const previousSessionId = credentials?.sessionId ?? cleanupSessionId;
    credentials = undefined;
    privateValues.clear();
    loaded = true;
    try {
      await options.storage.remove(phoneAccountKey);
      cleanupRequired = false;
      cleanupSessionId = undefined;
    } catch {
      cleanupRequired = true;
      cleanupSessionId = previousSessionId;
      throw new Error("account_cleanup_required");
    }
  };
  const load = async () => {
    if (cleanupRequired) throw new Error("account_cleanup_required");
    if (loaded) return;
    const saved = await options.storage.get(phoneAccountKey);
    if (saved) {
      try {
        const value = JSON.parse(saved);
        if (!origin || value.version !== 1 || value.origin !== origin) throw new Error();
        credentials = parseSaved(value.credentials);
      } catch {
        await clear();
      }
    }
    loaded = true;
  };
  const save = async (value: unknown) => {
    const next = parseSaved(value);
    try {
      await options.storage.set(
        phoneAccountKey,
        JSON.stringify({ version: 1, origin, credentials: next }),
      );
    } catch {
      // A failed write has uncertain custody. Never retry the consumed refresh value.
      await clear();
      throw new Error("account_unavailable");
    }
    credentials = next;
  };
  const http = async (route: string, init: RequestInit = {}) => {
    if (!origin) throw new Error("accounts_not_configured");
    try {
      return await send(`${origin}/api/account${route}`, {
        ...init,
        credentials: "omit",
        redirect: "error",
        signal: init.signal
          ? AbortSignal.any([init.signal, AbortSignal.timeout(15000)])
          : AbortSignal.timeout(15000),
      });
    } catch {
      throw new Error("account_unavailable");
    }
  };
  const json = async (response: Response) => {
    if (
      !response.ok ||
      !response.headers.get("content-type")?.toLowerCase().startsWith("application/json")
    ) {
      await response.body?.cancel().catch(() => {});
      throw new Error("account_unavailable");
    }
    // React Native fetch exposes text(), without requiring a ReadableStream implementation.
    const text = await response.text();
    if (text.length > 65536) throw new Error("account_unavailable");
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new Error("account_unavailable");
    }
  };
  const authenticated = async (route: string, method = "GET") => {
    await load();
    if (!credentials) throw new Error("sign_in_required");
    const perform = () =>
      http(route, { method, headers: { authorization: `Bearer ${credentials?.accessToken}` } });
    let response = await perform();
    if (response.status === 401) {
      await response.body?.cancel().catch(() => {});
      const refreshed = await http("/session/refresh", {
        method: "POST",
        headers: { authorization: `Refresh ${credentials.refreshToken}` },
      });
      if (refreshed.status === 401) {
        await clear();
        notify();
        throw new Error("sign_in_required");
      }
      // Rotation must retain the account session and be persisted before bearer use.
      const rotated = parseSaved(await json(refreshed));
      if (rotated.sessionId !== credentials.sessionId) {
        await clear();
        notify();
        throw new Error("account_session_changed");
      }
      await save(rotated);
      response = await perform();
    }
    return json(response);
  };
  const status = async (): Promise<PhoneAccountStatus> => {
    await load();
    if (!origin || !credentials) return { configured: !!origin, signedIn: false, online: !!origin };
    try {
      const value = parse(metadataSchema, await authenticated("/me"));
      if (value.sessionId !== credentials.sessionId) throw new Error();
      const account: PhoneAccountMetadata = {
        sessionId: value.sessionId,
        user: { id: value.user.id, name: value.user.name, email: value.user.email },
        organizations: value.organizations.map((org) => ({
          id: org.id,
          name: org.name,
          role: org.role,
          ...(org.kind ? { kind: org.kind } : {}),
        })),
      };
      const encoded = JSON.stringify(account);
      if ([...privateValues].some((secret) => encoded.includes(secret))) throw new Error();
      return {
        configured: true,
        signedIn: true,
        online: true,
        sessionId: credentials.sessionId,
        account,
      };
    } catch {
      if (cleanupRequired) throw new Error("account_cleanup_required");
      if (!credentials) return { configured: true, signedIn: false, online: true };
      // Do not return another account's metadata, or expose credentials as an offline cache.
      return { configured: true, signedIn: true, online: false, sessionId: credentials.sessionId };
    }
  };
  return Object.freeze({
    status: () => serialized(status),
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async signIn(): Promise<PhoneAccountStatus> {
      if (signing) throw new Error("sign_in_in_progress");
      signing = true;
      const controller = new AbortController(),
        current = ++generation;
      operation = controller;
      const check = () => {
        if (controller.signal.aborted || generation !== current)
          throw new Error("sign_in_cancelled");
      };
      try {
        return await serialized(async () => {
          await load();
          check();
          if (!origin) throw new Error("accounts_not_configured");
          if (credentials) throw new Error("already_signed_in");
          const verifier = toB64(await options.randomBytes(32)),
            state = toB64(await options.randomBytes(32));
          const challenge = await options.challenge(verifier);
          check();
          if (![verifier, state, challenge].every((value) => /^[A-Za-z0-9_-]{43}$/.test(value)))
            throw new Error("account_unavailable");
          const start = parse(
            NativeStartResultSchema,
            await json(
              await http("/native/start", {
                method: "POST",
                headers: { "content-type": "application/json" },
                signal: controller.signal,
                body: JSON.stringify({ redirectUri: phoneAccountCallback, challenge, state }),
              }),
            ),
          );
          check();
          const url = new URL(start.url);
          if (
            url.origin !== origin ||
            url.username ||
            url.password ||
            url.pathname !== "/api/account/auth/google/start" ||
            url.hash ||
            [...url.searchParams.keys()].join(",") !== "intent" ||
            url.searchParams.get("intent") !== start.intentId ||
            !/^[a-f0-9-]{36}$/.test(start.intentId)
          )
            throw new Error("account_unavailable");
          let cancel = () => {};
          let result: { type: string; url?: string };
          try {
            const canceled = new Promise<never>((_resolve, reject) => {
              cancel = () => reject(new Error("sign_in_cancelled"));
              if (controller.signal.aborted) cancel();
              else controller.signal.addEventListener("abort", cancel, { once: true });
            });
            result = await Promise.race([
              options.browser.open(url.href, phoneAccountCallback),
              canceled,
            ]);
          } finally {
            controller.signal.removeEventListener("abort", cancel);
          }
          check();
          if (result.type !== "success" || !result.url) throw new Error("sign_in_cancelled");
          const callback = new URL(result.url);
          if (
            `${callback.protocol}//${callback.host}${callback.pathname}` !== phoneAccountCallback ||
            callback.username ||
            callback.password ||
            callback.hash ||
            [...callback.searchParams.keys()].sort().join(",") !== "code,state" ||
            callback.searchParams.get("state") !== state ||
            !/^[A-Za-z0-9_-]{43}$/.test(callback.searchParams.get("code") ?? "")
          )
            throw new Error("account_unavailable");
          const redeemed = await json(
            await http("/native/redeem", {
              method: "POST",
              headers: { "content-type": "application/json" },
              signal: controller.signal,
              body: JSON.stringify({
                code: callback.searchParams.get("code"),
                verifier,
                deviceName: options.deviceName.slice(0, 100),
              }),
            }),
          );
          check();
          await save(redeemed);
          try {
            check();
          } catch {
            await clear();
            throw new Error("sign_in_cancelled");
          }
          notify();
          return status();
        });
      } catch (error) {
        if (error instanceof Error && error.message === "account_cleanup_required") throw error;
        if (controller.signal.aborted || generation !== current)
          throw new Error("sign_in_cancelled");
        if (
          error instanceof Error &&
          ["accounts_not_configured", "already_signed_in", "sign_in_cancelled"].includes(
            error.message,
          )
        )
          throw error;
        throw new Error("account_unavailable");
      } finally {
        signing = false;
        if (operation === controller) operation = undefined;
      }
    },
    cancelSignIn() {
      generation++;
      operation?.abort();
      try {
        options.browser.cancel();
      } catch {
        /* The session may not have opened yet. */
      }
    },
    signOut(expectedSessionId: string) {
      return serialized(async () => {
        if (cleanupRequired) {
          if (expectedSessionId !== cleanupSessionId) throw new Error("account_session_changed");
          await clear();
          notify();
          return;
        }
        await load();
        if (!credentials || credentials.sessionId !== expectedSessionId)
          throw new Error("account_session_changed");
        let confirmed = false;
        try {
          await authenticated("/logout", "POST");
          confirmed = true;
        } catch {
        } finally {
          await clear();
          notify();
        }
        if (!confirmed) throw new Error("sign_out_unconfirmed");
      });
    },
  });
}
