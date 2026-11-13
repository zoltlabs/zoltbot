import type { RunnerAccountOptions } from "../cloud-runner/account.js";
import { RunnerAccessRevokedError } from "../cloud-runner/connection.js";
import type { accountBrokerClient } from "./broker-client.js";

/** Native runner requests share the daemon's account owner; account bearers never leave it. */
export function brokerRunnerRequest(
  client: Pick<ReturnType<typeof accountBrokerClient>, "cloudRequest">,
): NonNullable<RunnerAccountOptions["nativeRequest"]> {
  return async ({ route, method, body, signal }) => {
    if (signal.aborted) throw new Error("runner_account_unavailable");
    try {
      return await client.cloudRequest(
        route,
        method,
        body === undefined ? undefined : JSON.stringify(body),
        signal,
      );
    } catch (error) {
      if (
        error instanceof Error &&
        ["sign_in_required", "account_access_revoked", "account_origin_changed"].includes(
          error.message,
        )
      )
        throw new RunnerAccessRevokedError();
      throw new Error("runner_account_unavailable");
    }
  };
}
