import path from "node:path";
import { type Identity, linkId, signApproval, toB64 } from "@zoltbot/link";
import { daemonAccountOwner } from "../account-session/daemon.js";
import type { DaemonOptions } from "../api-types.js";
import type { Cleanup } from "../daemon-resources.js";
import { daemonMacRunner } from "./daemon.js";

/** Register the account broker first so daemon shutdown closes runners before their account. */
export async function ownCloudHosts(
  options: Pick<
    DaemonOptions,
    "dataDir" | "nativeAccount" | "macCloudRunner" | "cloudRunner" | "secrets"
  >,
  resources: Cleanup[],
  status: (code: string) => void,
) {
  const { dataDir, nativeAccount, macCloudRunner, cloudRunner, secrets } = options;
  let macIdentity: (() => Promise<Identity>) | undefined;
  let macCloud: ReturnType<typeof daemonMacRunner> | undefined;
  const account = nativeAccount
    ? await daemonAccountOwner(
        {
          ...nativeAccount,
          async cloudSign(payload) {
            if (!macIdentity) throw new Error("native_account_unavailable");
            const identity = await macIdentity();
            if (linkId(identity.publicKey) !== payload.signerDeviceId)
              throw new Error("approval_invalid");
            return signApproval(identity, payload);
          },
          async cloudDevice() {
            if (!macIdentity) throw new Error("native_account_unavailable");
            const identity = await macIdentity();
            return { deviceId: linkId(identity.publicKey), publicKey: toB64(identity.publicKey) };
          },
          onSessionChanged(sessionId) {
            macCloud?.sessionChanged(sessionId);
            return nativeAccount.onSessionChanged?.(sessionId);
          },
        },
        dataDir,
        () => status("native_account_unavailable"),
      )
    : undefined;
  if (account) resources.push(() => account.close());
  if (cloudRunner) {
    try {
      const cloud = cloudRunner({ dataDir: path.join(dataDir, "cloud"), status });
      resources.push(() => cloud.close());
    } catch {
      status("cloud_runner_unavailable");
    }
  }
  const start = (identity: () => Promise<Identity>) => {
    macIdentity = identity;
    if (!macCloudRunner || !nativeAccount || !account || !secrets) return;
    const cloud = daemonMacRunner({
      ...(macCloudRunner === true ? {} : macCloudRunner),
      dataDir,
      origin: nativeAccount.origin,
      socketPath: account.location(),
      vault: secrets,
      identity,
      status,
    });
    macCloud = cloud;
    resources.push(() => cloud.close());
  };
  // I8: the GitHub bot asks the same account broker for installation tokens.
  return Object.assign(start, {
    accountLocation: account?.location(),
    accountHookCloud: account?.hookCloud,
  });
}
