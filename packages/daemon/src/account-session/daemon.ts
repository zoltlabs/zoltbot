import path from "node:path";
import type { MacApprovalPayload, SignedMacApproval } from "@zoltbot/protocol";
import { startAccountBroker } from "./broker.js";
import type { AccountSessionOptions } from "./index.js";

export interface DaemonAccountOptions {
  origin: string;
  secrets: AccountSessionOptions["secrets"];
  fetch?: typeof fetch;
  onSessionChanged?(sessionId: string | undefined): Promise<void> | void;
  cloudDevice?(): Promise<{ deviceId: string; publicKey: string }>;
  cloudSign?(payload: MacApprovalPayload): Promise<SignedMacApproval>;
}
/** Account startup receives no Local store or runtime and cannot prevent Local startup. */
export async function daemonAccountOwner(
  options: DaemonAccountOptions,
  dataDir: string,
  unavailable: () => void,
) {
  try {
    return await startAccountBroker({
      ...options,
      referenceFile: path.resolve(dataDir, "desktop", "account-keychain-reference"),
      directory: path.resolve(dataDir, "account-ipc"),
    });
  } catch {
    unavailable();
    return undefined;
  }
}
