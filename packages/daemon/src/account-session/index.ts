import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { type Credentials, parseCredentials as credentials } from "@zoltbot/cloud-contracts";

export interface AccountSessionOptions {
  origin?: string;
  referenceFile: string;
  secrets: {
    put(value: unknown): Promise<{ reference: string }>;
    read(reference: string): Promise<unknown>;
    replace(reference: string, value: unknown): Promise<void>;
    remove(reference: string): Promise<void>;
  };
  fetch?: typeof fetch;
}
/** One native owner serializes account requests and persists refresh rotation before reuse. */
export function accountSession(options: AccountSessionOptions) {
  const send = options.fetch ?? fetch,
    origin = options.origin;
  if (origin) {
    const url = new URL(origin);
    if (
      url.origin !== origin ||
      (url.protocol !== "https:" && !(url.protocol === "http:" && url.hostname === "127.0.0.1"))
    )
      throw new Error("invalid_account_origin");
  }
  let reference: string | undefined, tokens: Credentials | undefined;
  let queue: Promise<unknown> = Promise.resolve();
  function serialized<T>(action: () => Promise<T>): Promise<T> {
    const next = queue.then(action, action);
    queue = next.catch(() => {});
    return next;
  }
  const endpoint = (path: string) => {
    if (!origin) throw new Error("accounts_not_configured");
    return `${origin}/api/account${path}`;
  };
  async function storedReference() {
    if (reference) return reference;
    try {
      reference = (await readFile(options.referenceFile, "utf8")).trim();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    return reference;
  }
  async function load() {
    if (tokens) return tokens;
    const saved = await storedReference();
    if (!saved) return undefined;
    tokens = credentials(await options.secrets.read(saved));
    return tokens;
  }
  async function save(value: Credentials) {
    await storedReference();
    if (reference) await options.secrets.replace(reference, value);
    else {
      const next = await options.secrets.put(value);
      const temporary = `${options.referenceFile}.tmp`;
      try {
        await writeFile(temporary, next.reference, { mode: 0o600 });
        await rename(temporary, options.referenceFile);
      } catch (error) {
        await options.secrets.remove(next.reference);
        throw error;
      }
      reference = next.reference;
    }
    tokens = value;
  }
  async function clear() {
    await storedReference();
    if (reference) await options.secrets.remove(reference);
    await rm(options.referenceFile, { force: true });
    reference = undefined;
    tokens = undefined;
  }
  async function request(path: string, method = "GET", payload?: string | Buffer, cloud = false) {
    const current = await load();
    if (!current) throw new Error("sign_in_required");
    const perform = () =>
      send(cloud ? `${origin}${path}` : endpoint(path), {
        method,
        headers: {
          Authorization: `Bearer ${tokens?.accessToken}`,
          ...(payload === undefined
            ? {}
            : {
                "Content-Type": Buffer.isBuffer(payload)
                  ? "application/octet-stream"
                  : "application/json",
              }),
        },
        ...(payload === undefined
          ? {}
          : { body: Buffer.isBuffer(payload) ? Uint8Array.from(payload) : payload }),
        redirect: "error",
        signal: AbortSignal.timeout(15000),
      });
    let response = await perform();
    if (response.status === 401) {
      const rotated = await send(endpoint("/session/refresh"), {
        method: "POST",
        headers: { Authorization: `Refresh ${current.refreshToken}` },
        redirect: "error",
        signal: AbortSignal.timeout(15000),
      });
      if (!rotated.ok) {
        if (rotated.status === 401) await clear();
        throw new Error(
          rotated.status === 401 ? "sign_in_required" : "account_service_unavailable",
        );
      }
      // Persist rotation before issuing another request. A crash cannot reuse an old in-memory token.
      await save(credentials(await rotated.json()));
      response = await perform();
    }
    if (cloud && [401, 403, 410].includes(response.status)) {
      await response.body?.cancel().catch(() => {});
      throw new Error("account_access_revoked");
    }
    if (!response.ok) throw new Error("account_service_unavailable");
    return response.json();
  }
  return Object.freeze({
    load: () =>
      serialized(async () => {
        const value = await load();
        return value ? structuredClone(value) : undefined;
      }),
    save: (value: Credentials) => {
      const frozen = credentials(structuredClone(value));
      return serialized(() => save(frozen));
    },
    clear: () => serialized(clear),
    request: (path: string, method = "GET", payload?: string | Buffer) => {
      const frozen = Buffer.isBuffer(payload) ? Buffer.from(payload) : payload;
      return serialized(() => request(path, method, frozen));
    },
    // This port stays inside the native owner; trusted IPC applies its own route allowlist.
    cloudRequest: (path: string, method = "GET", payload?: string) =>
      serialized(() => {
        if (!origin) throw new Error("accounts_not_configured");
        const routes: Record<string, string> = {
          "/api/cloud/devices": "GET",
          "/api/cloud/runner-token": "POST",
          "/api/cloud/runner-grants": "PUT",
        };
        if (routes[path] !== method) throw new Error("account_request_invalid");
        return request(path, method, payload, true);
      }),
    endpoint,
    sessionId: () => tokens?.sessionId,
  });
}
