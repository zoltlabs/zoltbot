// A keychain kept in memory for tests, so no test touches the Mac's login keychain.
import { type KeychainRequest, KeychainSecrets } from "../../../packages/daemon/src/secrets.js";

/** `present` decides whether the owner passes the Touch ID or password prompt on reveal. */
export function memoryKeychain(options: { present?: () => boolean } = {}) {
  const items = new Map<string, string>();
  const requests: KeychainRequest["op"][] = [];
  const transport = async (request: KeychainRequest) => {
    requests.push(request.op);
    // Like the helper: vault items are read only through reveal or use.
    if (request.vault ? request.op === "get" : ["reveal", "use"].includes(request.op))
      return { ok: false };
    switch (request.op) {
      case "put":
      case "replace":
        items.set(request.account, request.value ?? "");
        return { ok: true };
      case "get":
      case "use":
        return items.has(request.account)
          ? { ok: true, value: items.get(request.account) }
          : { ok: false };
      case "reveal":
        if (!(options.present?.() ?? true) || !items.has(request.account)) return { ok: false };
        return { ok: true, value: items.get(request.account) };
      case "remove":
        items.delete(request.account);
        return { ok: true };
      case "exists":
        return { ok: true, found: items.has(request.account) };
    }
  };
  return { secrets: new KeychainSecrets(transport), items, requests };
}
