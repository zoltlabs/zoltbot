import type { accountBrokerClient } from "../../../../packages/daemon/src/account-session/broker-client.js";
import type { CloudAccountBinding } from "./manager.js";

/** Native-only Cell token request; the account bearer stays behind the broker. */
export function brokerCellCredentials(
  client: Pick<ReturnType<typeof accountBrokerClient>, "cloudRequest" | "sessionId">,
  account: Readonly<CloudAccountBinding>,
  deviceId: string,
) {
  const sessionId = account.sessionId,
    payload = JSON.stringify({ orgId: account.orgId, deviceId });
  if (client.sessionId() !== sessionId) throw new Error("account_session_changed");
  return async (signal: AbortSignal) => {
    if (client.sessionId() !== sessionId) throw new Error("account_session_changed");
    const credentials = await client.cloudRequest("/api/cloud/cell-token", "POST", payload, signal);
    if (signal.aborted || client.sessionId() !== sessionId)
      throw new Error("account_session_changed");
    return credentials;
  };
}
