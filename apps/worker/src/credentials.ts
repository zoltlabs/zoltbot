import { CellTokenResultSchema, WorkerTokenRequestSchema } from "@zoltbot/cloud-contracts";
import { RunnerAccessRevokedError, type RunnerCredentials } from "@zoltbot/daemon/cloud-runner";
import { parse } from "@zoltbot/protocol";
import { injectedClaims, type WorkerEnvironment } from "./environment.js";

async function responseJson(response: Response) {
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
      const read = await reader.read();
      if (read.done) break;
      bytes += read.value.length;
      if (bytes > 65536) throw new Error();
      parts.push(read.value);
    }
    return JSON.parse(Buffer.concat(parts).toString("utf8")) as unknown;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
/** Short Cell tokens rotate through one task-bound capability; provider keys never enter this route. */
export function workerCredentials(config: WorkerEnvironment, fetcher: typeof fetch = fetch) {
  let refreshing: Promise<RunnerCredentials> | undefined;
  const result = (token: string, expiresAt?: string): RunnerCredentials => {
    const claims = injectedClaims(token, config),
      expiry = claims.exp * 1000;
    if (
      expiry <= Date.now() + 1000 ||
      expiry > Date.now() + 11 * 60000 ||
      (expiresAt !== undefined && Date.parse(expiresAt) !== expiry)
    )
      throw new Error();
    const url = new URL(config.cellOrigin);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = `/v1/orgs/${encodeURIComponent(config.orgId)}/connect`;
    return { token, expiresAt: expiry, url: url.href };
  };
  return async (signal: AbortSignal): Promise<RunnerCredentials> => {
    try {
      if (signal.aborted) throw new Error();
      const token = config.read("ZOLTBOT_RUNNER_TOKEN");
      if (token) {
        const claims = injectedClaims(token, config);
        if (claims.exp * 1000 > Date.now() + 30000) return result(token);
      }
      const refresh = config.read("ZOLTBOT_WORKER_REFRESH");
      if (!refresh) throw new Error();
      const request = async () => {
        const response = await fetcher(new URL("/api/cloud/worker-token", config.cloudOrigin), {
          method: "POST",
          redirect: "error",
          signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]),
          headers: { authorization: `Worker ${refresh}`, "content-type": "application/json" },
          body: JSON.stringify(
            parse(WorkerTokenRequestSchema, {
              orgId: config.orgId,
              taskId: config.taskId,
              runnerId: config.runnerId,
            }),
          ),
        });
        const input = parse(CellTokenResultSchema, await responseJson(response));
        if (
          new URL(input.cellUrl).origin !== config.cellOrigin ||
          new URL(input.cellUrl).href !== `${config.cellOrigin}/`
        )
          throw new Error();
        const credentials = result(input.token, input.expiresAt);
        config.rememberToken(input.token);
        return credentials;
      };
      if (!refreshing) {
        refreshing = request();
        void refreshing
          .finally(() => {
            refreshing = undefined;
          })
          .catch(() => {});
      }
      return await refreshing;
    } catch (error) {
      if (error instanceof RunnerAccessRevokedError) throw error;
      throw new Error("worker_credentials_unavailable");
    }
  };
}
