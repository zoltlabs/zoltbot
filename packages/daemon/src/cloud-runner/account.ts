import {
  CellTokenResultSchema,
  CloudDeviceListSchema,
  CloudRunnerGrantInputSchema,
  CloudRunnerGrantResultSchema,
} from "@zoltbot/cloud-contracts";
import { parse } from "@zoltbot/protocol";
import { RunnerAccessRevokedError, type RunnerCredentials } from "./connection.js";

export interface RunnerAccountOptions {
  origin: string;
  orgId: string;
  deviceId: string;
  /** Resolve the current native account access token from keychain/memory only. */
  accessToken?(signal: AbortSignal): Promise<string>;
  /** A daemon-owned session performs authenticated I/O without handing out its account bearer. */
  nativeRequest?(input: {
    route: string;
    method: "GET" | "POST" | "PUT";
    body: unknown;
    signal: AbortSignal;
  }): Promise<unknown>;
  fetch?: typeof globalThis.fetch;
  allowLoopback?: boolean;
}
const maximumResponse = 65536;
function origin(value: string, allowLoopback: boolean | undefined) {
  try {
    const url = new URL(value);
    const local =
      allowLoopback && url.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(url.hostname);
    if (
      (url.protocol !== "https:" && !local) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/"
    )
      throw new Error("runner_account_unavailable");
    return url;
  } catch {
    throw new Error("runner_account_unavailable");
  }
}
/** This client cannot grant itself permission: its caller must explicitly set both capabilities. */
export function runnerAccount(options: RunnerAccountOptions) {
  const base = origin(options.origin, options.allowLoopback),
    fetcher = options.fetch ?? globalThis.fetch;
  const { orgId, deviceId, accessToken, nativeRequest } = options;
  if (!!accessToken === !!nativeRequest || (nativeRequest && options.fetch))
    throw new Error("runner_account_unavailable");
  if (!orgId || orgId.length > 200 || !/^[A-Za-z0-9_-]{22}$/.test(deviceId))
    throw new Error("runner_account_unavailable");
  const request = async (route: string, input: unknown, signal: AbortSignal, method?: "GET") => {
    try {
      const timeout = AbortSignal.timeout(10000),
        combined = AbortSignal.any([signal, timeout]);
      if (combined.aborted) throw new Error();
      if (nativeRequest) {
        let cancel = () => {};
        try {
          const result = await Promise.race([
            nativeRequest({
              route,
              method: method ?? (route.endsWith("runner-token") ? "POST" : "PUT"),
              body: input,
              signal: combined,
            }),
            new Promise<never>((_resolve, reject) => {
              cancel = () => reject(new Error());
              if (combined.aborted) cancel();
              else combined.addEventListener("abort", cancel, { once: true });
            }),
          ]);
          const encoded = JSON.stringify(result);
          if (typeof encoded !== "string" || Buffer.byteLength(encoded) > maximumResponse)
            throw new Error();
          return result;
        } finally {
          combined.removeEventListener("abort", cancel);
        }
      }
      if (!accessToken) throw new Error();
      let abort = () => {};
      let token: string;
      try {
        token = await Promise.race([
          accessToken(combined),
          new Promise<never>((_resolve, reject) => {
            abort = () => reject(new Error());
            if (combined.aborted) abort();
            else combined.addEventListener("abort", abort, { once: true });
          }),
        ]);
      } finally {
        combined.removeEventListener("abort", abort);
      }
      if (!token || token.length > 8192 || /[\0\r\n]/.test(token) || combined.aborted)
        throw new Error();
      const response = await fetcher(new URL(route, base), {
        method: method ?? (route.endsWith("runner-token") ? "POST" : "PUT"),
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        ...(input !== undefined ? { body: JSON.stringify(input) } : {}),
        redirect: "error",
        signal: combined,
      });
      if ([401, 403, 410].includes(response.status)) {
        await response.body?.cancel().catch(() => {});
        throw new RunnerAccessRevokedError();
      }
      if (
        !response.ok ||
        !response.body ||
        !response.headers.get("content-type")?.toLowerCase().startsWith("application/json")
      ) {
        await response.body?.cancel().catch(() => {});
        throw new Error();
      }
      const reader = response.body.getReader(),
        parts: Uint8Array[] = [];
      let bytes = 0;
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.length;
          if (bytes > maximumResponse) throw new Error();
          parts.push(chunk.value);
        }
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      return JSON.parse(Buffer.concat(parts).toString("utf8")) as unknown;
    } catch (error) {
      if (error instanceof RunnerAccessRevokedError) throw error;
      throw new Error("runner_account_unavailable");
    }
  };
  return {
    async deviceKeys(signal: AbortSignal) {
      try {
        return parse(
          CloudDeviceListSchema,
          await request("/api/cloud/devices", undefined, signal, "GET"),
        ).devices;
      } catch (error) {
        if (error instanceof RunnerAccessRevokedError) throw error;
        throw new Error("runner_account_unavailable");
      }
    },
    async setGrant(
      capabilities: { canRunTasks: boolean; canMacExec: boolean },
      signal: AbortSignal,
    ) {
      if (
        typeof capabilities.canRunTasks !== "boolean" ||
        typeof capabilities.canMacExec !== "boolean"
      )
        throw new Error("runner_account_unavailable");
      try {
        const result = parse(
          CloudRunnerGrantResultSchema,
          await request(
            "/api/cloud/runner-grants",
            parse(CloudRunnerGrantInputSchema, {
              deviceId,
              canRunTasks: capabilities.canRunTasks,
              canMacExec: capabilities.canMacExec,
            }),
            signal,
          ),
        );
        if (
          result.grant &&
          (result.grant.deviceId !== deviceId ||
            result.grant.canRunTasks !== capabilities.canRunTasks ||
            result.grant.canMacExec !== capabilities.canMacExec ||
            !Number.isFinite(Date.parse(result.grant.expiresAt)) ||
            Date.parse(result.grant.expiresAt) <= Date.now())
        )
          throw new Error();
        if ((capabilities.canRunTasks || capabilities.canMacExec) !== (result.grant !== null))
          throw new Error();
        return result;
      } catch (error) {
        if (error instanceof RunnerAccessRevokedError) throw error;
        throw new Error("runner_account_unavailable");
      }
    },
    async credentials(signal: AbortSignal): Promise<RunnerCredentials> {
      try {
        const result = parse(
          CellTokenResultSchema,
          await request("/api/cloud/runner-token", { orgId, deviceId }, signal),
        );
        const url = origin(result.cellUrl, options.allowLoopback),
          expiresAt = Date.parse(result.expiresAt);
        if (
          !Number.isFinite(expiresAt) ||
          expiresAt <= Date.now() + 1000 ||
          expiresAt > Date.now() + 11 * 60000 ||
          result.token.length > 8192 ||
          result.cellUrl.length > 2048 ||
          /[\0\r\n]/.test(result.token)
        )
          throw new Error();
        url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
        url.pathname = `/v1/orgs/${encodeURIComponent(orgId)}/connect`;
        return { url: url.href, token: result.token, expiresAt };
      } catch (error) {
        if (error instanceof RunnerAccessRevokedError) throw error;
        throw new Error("runner_account_unavailable");
      }
    },
  };
}
