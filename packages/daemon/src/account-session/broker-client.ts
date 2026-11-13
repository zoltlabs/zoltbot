import { lstat } from "node:fs/promises";
import { request } from "node:http";
import path from "node:path";
import { type Credentials, parseCredentials } from "@zoltbot/cloud-contracts";

const maximumResponse = 8 * 1024 * 1024;
const sessionPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
/** Native callers only. No raw bearer can be loaded through this endpoint. */
export function accountBrokerClient(options: { socketPath: string; origin: string }) {
  const { socketPath, origin } = options,
    base = new URL(origin);
  if (
    !path.isAbsolute(socketPath) ||
    base.origin !== origin ||
    (base.protocol !== "https:" && !(base.protocol === "http:" && base.hostname === "127.0.0.1"))
  )
    throw new Error("native_account_unavailable");
  let sessionId: string | undefined;
  let queue: Promise<unknown> = Promise.resolve();
  const call = (operation: string, input: Record<string, unknown> = {}, signal?: AbortSignal) => {
    const encoded = JSON.stringify({ origin, operation, ...input });
    const next = queue
      .then(async () => {
        if (signal?.aborted) throw new Error("native_account_unavailable");
        const [folder, socket] = await Promise.all([
          lstat(path.dirname(socketPath)),
          lstat(socketPath),
        ]);
        if (
          !folder.isDirectory() ||
          folder.isSymbolicLink() ||
          folder.mode & 0o077 ||
          !socket.isSocket() ||
          socket.mode & 0o077 ||
          (process.getuid && (folder.uid !== process.getuid() || socket.uid !== process.getuid()))
        )
          throw new Error("native_account_unavailable");
        return await new Promise<unknown>((resolve, reject) => {
          const fail = (code = "native_account_unavailable") => reject(new Error(code));
          const client = request(
            {
              socketPath,
              signal,
              path: "/v1/native-account",
              method: "POST",
              agent: false,
              headers: {
                "content-type": "application/json",
                "content-length": Buffer.byteLength(encoded),
              },
            },
            (response) => {
              const chunks: Buffer[] = [];
              let size = 0;
              response.on("data", (chunk) => {
                size += chunk.length;
                if (size > maximumResponse) client.destroy();
                else chunks.push(Buffer.from(chunk));
              });
              response.once("error", () => fail());
              response.once("end", () => {
                try {
                  const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
                  if (!value || typeof value !== "object") throw new Error();
                  if (value.ok !== true || response.statusCode !== 200) {
                    const code = [
                      "sign_in_required",
                      "account_access_revoked",
                      "account_origin_changed",
                      "native_account_request_invalid",
                      "account_service_unavailable",
                    ].includes(value.error)
                      ? value.error
                      : "native_account_unavailable";
                    fail(code);
                    return;
                  }
                  if (
                    Object.keys(value).some(
                      (key) => !["ok", "result", "sessionId"].includes(key),
                    ) ||
                    (value.sessionId !== undefined &&
                      (typeof value.sessionId !== "string" ||
                        !sessionPattern.test(value.sessionId)))
                  )
                    throw new Error();
                  sessionId = value.sessionId;
                  resolve(value.result);
                } catch {
                  fail();
                }
              });
            },
          );
          client.setTimeout(50000, () => client.destroy());
          client.once("error", () => fail());
          client.end(encoded);
        });
      })
      .catch((error) => {
        if (
          error instanceof Error &&
          [
            "sign_in_required",
            "account_access_revoked",
            "account_origin_changed",
            "native_account_request_invalid",
            "account_service_unavailable",
          ].includes(error.message)
        )
          throw error;
        throw new Error("native_account_unavailable");
      });
    queue = next.catch(() => {});
    return next;
  };
  const empty = async (operation: "save" | "clear", input?: Record<string, unknown>) => {
    if ((await call(operation, input)) !== null) throw new Error("native_account_unavailable");
  };
  return Object.freeze({
    status: async () => {
      const value = (await call("status")) as { signedIn?: unknown; sessionId?: unknown } | null;
      if (
        !value ||
        typeof value !== "object" ||
        typeof value.signedIn !== "boolean" ||
        Object.keys(value).some((key) => !["signedIn", "sessionId"].includes(key)) ||
        (value.sessionId !== undefined &&
          (typeof value.sessionId !== "string" || !sessionPattern.test(value.sessionId))) ||
        (value.signedIn && !value.sessionId)
      )
        throw new Error("native_account_unavailable");
      return value as { signedIn: boolean; sessionId?: string };
    },
    save: (value: Credentials) =>
      empty("save", { credentials: parseCredentials(structuredClone(value)) }),
    clear: () => empty("clear"),
    request: (route: string, method = "GET", payload?: string | Buffer) => {
      if (
        (Buffer.isBuffer(payload) && payload.length > 25 * 1024 * 1024) ||
        (typeof payload === "string" && Buffer.byteLength(payload) > 1048576)
      )
        return Promise.reject(new Error("native_account_request_invalid"));
      return call("request", {
        path: route,
        method,
        ...(payload === undefined
          ? {}
          : {
              payload: Buffer.isBuffer(payload)
                ? { encoding: "base64", data: payload.toString("base64") }
                : { encoding: "text", data: payload },
            }),
      });
    },
    cloudRequest: (route: string, method = "GET", payload?: string, signal?: AbortSignal) => {
      if (payload !== undefined && Buffer.byteLength(payload) > 1048576)
        return Promise.reject(new Error("native_account_request_invalid"));
      return call(
        "cloud_request",
        {
          path: route,
          method,
          ...(payload === undefined ? {} : { payload: { encoding: "text", data: payload } }),
        },
        signal,
      );
    },
    endpoint: (route: string) => `${origin}/api/account${route}`,
    sessionId: () => sessionId,
  });
}
