import type { Stats } from "node:fs";
import { chmod, lstat, mkdir, rm } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import { createConnection } from "node:net";
import path from "node:path";
import { parseCredentials } from "@zoltbot/cloud-contracts";
import { acquireOwnerLock } from "@zoltbot/store";
import { type AccountSessionOptions, accountSession } from "./index.js";

const maximumRequest = 36 * 1024 * 1024;
const maximumResponse = 8 * 1024 * 1024;
const maximumBlob = 25 * 1024 * 1024;
const uuid = "[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}";
const sessionIdPattern = new RegExp(`^${uuid}$`);
const routes: Record<string, RegExp> = {
  GET: new RegExp(`^/(?:me|export|artifacts(?:/${uuid}/view)?)$`),
  POST: new RegExp(
    `^/(?:logout|sessions/revoke-all|artifacts(?:/${uuid}/(?:commit|visibility))?)$`,
  ),
  DELETE: new RegExp(`^/(?:sessions|artifacts)/${uuid}$`),
  PUT: new RegExp(`^/artifacts/${uuid}/blobs/[a-f0-9]{64}$`),
};
interface BrokerRequest {
  origin: string;
  operation: "status" | "save" | "clear" | "request" | "cloud_request";
  credentials?: unknown;
  expectedSessionId?: string | null;
  path?: string;
  method?: string;
  payload?: { encoding: "text" | "base64"; data: string };
}
async function body(request: IncomingMessage): Promise<BrokerRequest> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maximumRequest) throw new Error("native_account_request_invalid");
    chunks.push(Buffer.from(chunk));
  }
  const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("native_account_request_invalid");
  return value as BrokerRequest;
}
async function privateDirectory(directory: string) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (process.getuid && info.uid !== process.getuid())
  )
    throw new Error("native_account_unavailable");
  await chmod(directory, 0o700);
}
async function removeStaleSocket(socketPath: string) {
  let info: Stats;
  try {
    info = await lstat(socketPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (!info.isSocket() || (process.getuid && info.uid !== process.getuid()))
    throw new Error("native_account_unavailable");
  const active = await new Promise<boolean>((resolve, reject) => {
    const socket = createConnection(socketPath);
    socket.setTimeout(500);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("timeout", () => {
      socket.destroy();
      reject(new Error("native_account_unavailable"));
    });
    socket.once("error", (error) => {
      socket.destroy();
      if (["ECONNREFUSED", "ENOENT"].includes((error as NodeJS.ErrnoException).code ?? ""))
        resolve(false);
      else reject(new Error("native_account_unavailable"));
    });
  });
  if (active) throw new Error("native_account_in_use");
  await rm(socketPath);
}
/** One native owner. The Unix endpoint never returns account access or refresh credentials. */
export async function startAccountBroker(
  options: AccountSessionOptions & {
    directory: string;
    /** Local cleanup only: do not call this broker recursively from the callback. */
    onSessionChanged?(sessionId: string | undefined): Promise<void> | void;
  },
) {
  const origin = options.origin,
    referenceFile = options.referenceFile,
    directory = options.directory,
    fetcher = options.fetch ?? fetch,
    onSessionChanged = options.onSessionChanged,
    secretStore = options.secrets;
  if (
    !origin ||
    process.platform === "win32" ||
    !path.isAbsolute(referenceFile) ||
    referenceFile.includes("\0") ||
    directory.includes("\0")
  )
    throw new Error("native_account_unavailable");
  try {
    const url = new URL(origin);
    if (
      url.origin !== origin ||
      (url.protocol !== "https:" && !(url.protocol === "http:" && url.hostname === "127.0.0.1"))
    )
      throw new Error();
  } catch {
    throw new Error("native_account_unavailable");
  }
  const socketPath = path.join(directory, "broker.sock");
  if (!path.isAbsolute(socketPath) || Buffer.byteLength(socketPath) >= 100)
    throw new Error("native_account_unavailable");
  await privateDirectory(directory);
  await privateDirectory(path.dirname(referenceFile));
  const directoryLock = acquireOwnerLock(path.join(directory, "broker.lock"));
  let credentialLock: ReturnType<typeof acquireOwnerLock> | undefined;
  const lifetime = new AbortController();
  let closed = false,
    closing: Promise<void> | undefined;
  let queue: Promise<unknown> = Promise.resolve();
  let lastSessionId: string | undefined;
  const knownCredentials = new Set<string>();
  const remember = (value: unknown) => {
    const credentials = parseCredentials(value);
    knownCredentials.add(credentials.accessToken);
    knownCredentials.add(credentials.refreshToken);
    return credentials;
  };
  const wrapped = (value: unknown) => ({ version: 1, origin, credentials: remember(value) });
  const owner = accountSession({
    ...options,
    origin,
    referenceFile,
    secrets: {
      put: (value) => secretStore.put(wrapped(value)),
      replace: (reference, value) => secretStore.replace(reference, wrapped(value)),
      remove: (reference) => secretStore.remove(reference),
      async read(reference) {
        const value = (await secretStore.read(reference)) as {
          version?: unknown;
          origin?: unknown;
          credentials?: unknown;
        } | null;
        // Legacy credentials have no trustworthy origin binding. Require explicit sign-in.
        if (!value || value.version !== 1 || value.origin !== origin)
          throw new Error("account_session_origin_required");
        const credentials = remember(value.credentials);
        if (!sessionIdPattern.test(credentials.sessionId))
          throw new Error("native_account_unavailable");
        return credentials;
      },
    },
    fetch: (url, init) =>
      fetcher(url, {
        ...init,
        signal: AbortSignal.any([lifetime.signal, ...(init?.signal ? [init.signal] : [])]),
      }),
  });
  const dispatch = async (input: BrokerRequest) => {
    if (closed) throw new Error("native_account_unavailable");
    if (input.origin !== origin) throw new Error("account_origin_changed");
    const fields = {
      status: ["origin", "operation"],
      clear: ["origin", "operation", "expectedSessionId"],
      save: ["origin", "operation", "credentials", "expectedSessionId"],
      request: ["origin", "operation", "path", "method", "payload", "expectedSessionId"],
      cloud_request: ["origin", "operation", "path", "method", "payload", "expectedSessionId"],
    };
    if (typeof input.operation !== "string" || !Object.hasOwn(fields, input.operation))
      throw new Error("native_account_request_invalid");
    const allowed = fields[input.operation];
    if (!allowed || Object.keys(input).some((key) => !allowed.includes(key)))
      throw new Error("native_account_request_invalid");
    try {
      if (input.operation !== "status") {
        if (
          !Object.hasOwn(input, "expectedSessionId") ||
          (input.expectedSessionId !== null &&
            (typeof input.expectedSessionId !== "string" ||
              !sessionIdPattern.test(input.expectedSessionId)))
        )
          throw new Error("native_account_request_invalid");
        let current: Awaited<ReturnType<typeof owner.load>>;
        try {
          current = await owner.load();
        } catch (error) {
          if (
            !(error instanceof Error) ||
            error.message !== "account_session_origin_required" ||
            !["save", "clear"].includes(input.operation)
          )
            throw error;
        }
        if (input.expectedSessionId !== (current?.sessionId ?? null))
          throw new Error("account_session_changed");
      }
      if (input.operation === "status") {
        try {
          const current = await owner.load();
          return { signedIn: !!current, ...(current ? { sessionId: current.sessionId } : {}) };
        } catch (error) {
          if (error instanceof Error && error.message === "account_session_origin_required")
            return { signedIn: false };
          throw error;
        }
      }
      if (input.operation === "save") {
        const value = parseCredentials(input.credentials);
        if (!sessionIdPattern.test(value.sessionId))
          throw new Error("native_account_request_invalid");
        await owner.save(value);
        return null;
      }
      if (input.operation === "clear") {
        await owner.clear();
        return null;
      }
      if (
        typeof input.path !== "string" ||
        (input.operation !== "cloud_request" && !routes[input.method ?? ""]?.test(input.path))
      )
        throw new Error("native_account_request_invalid");
      let payload: string | Buffer | undefined;
      if (input.payload) {
        if (
          typeof input.payload !== "object" ||
          Object.keys(input.payload).sort().join(",") !== "data,encoding" ||
          typeof input.payload.data !== "string"
        )
          throw new Error("native_account_request_invalid");
        if (input.payload.encoding === "text" && Buffer.byteLength(input.payload.data) <= 1048576)
          payload = input.payload.data;
        else if (input.payload.encoding === "base64") {
          const bytes = Buffer.from(input.payload.data, "base64");
          if (bytes.length > maximumBlob || bytes.toString("base64") !== input.payload.data)
            throw new Error("native_account_request_invalid");
          payload = bytes;
        } else throw new Error("native_account_request_invalid");
      }
      if (input.operation === "cloud_request") {
        if (Buffer.isBuffer(payload)) throw new Error("native_account_request_invalid");
        return await owner.cloudRequest(input.path, input.method, payload);
      }
      return await owner.request(input.path, input.method, payload);
    } catch (error) {
      if (error instanceof Error && error.message === "account_session_origin_required")
        throw new Error("sign_in_required");
      throw error;
    } finally {
      const current = owner.sessionId();
      if (current !== lastSessionId) {
        await onSessionChanged?.(current);
        lastSessionId = current;
      }
    }
  };
  let active = 0;
  const server = createServer(async (request, response) => {
    response.setHeader("content-type", "application/json");
    response.setHeader("cache-control", "no-store");
    const fail = (code: string, status = 503) => {
      if (!response.destroyed)
        response.writeHead(status).end(JSON.stringify({ ok: false, error: code }));
    };
    if (
      closed ||
      request.url !== "/v1/native-account" ||
      request.method !== "POST" ||
      active >= 2
    ) {
      fail("native_account_unavailable");
      request.resume();
      return;
    }
    active++;
    try {
      const input = await body(request);
      const action = queue.then(async () => {
        if (response.destroyed || request.aborted) throw new Error("native_account_unavailable");
        return { result: await dispatch(input), sessionId: owner.sessionId() };
      });
      queue = action.catch(() => {});
      const result = await action,
        encoded = JSON.stringify({ ok: true, ...result });
      if (Buffer.byteLength(encoded) > maximumResponse)
        throw new Error("native_account_unavailable");
      if ([...knownCredentials].some((value) => encoded.includes(value)))
        throw new Error("native_account_unavailable");
      if (!response.destroyed) response.end(encoded);
    } catch (error) {
      const code =
        error instanceof Error &&
        [
          "sign_in_required",
          "account_access_revoked",
          "account_origin_changed",
          "account_session_changed",
          "native_account_request_invalid",
          "account_service_unavailable",
        ].includes(error.message)
          ? error.message
          : "native_account_unavailable";
      fail(code);
    } finally {
      active--;
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 5000;
  server.keepAliveTimeout = 1000;
  try {
    credentialLock = acquireOwnerLock(`${referenceFile}.owner.lock`);
    await removeStaleSocket(socketPath);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    await chmod(socketPath, 0o600);
    const owned = await lstat(socketPath);
    const close = () =>
      (closing ??= (async () => {
        closed = true;
        lifetime.abort();
        const stopped = new Promise<void>((resolve) => server.close(() => resolve()));
        server.closeAllConnections();
        await stopped;
        await queue;
        const current = await lstat(socketPath).catch(() => undefined);
        if (current?.isSocket() && current.ino === owned.ino && current.dev === owned.dev)
          await rm(socketPath);
        credentialLock?.release();
        directoryLock.release();
      })());
    return Object.freeze({ location: () => socketPath, close });
  } catch {
    closed = true;
    lifetime.abort();
    const stopped = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    await stopped;
    await queue;
    credentialLock?.release();
    directoryLock.release();
    throw new Error("native_account_unavailable");
  }
}
