import { lstat } from "node:fs/promises";
import { accountBrokerClient } from "../../../packages/daemon/src/account-session/broker-client.js";

/** Wait for the daemon's private socket; credential ownership never falls back to main. */
export function desktopAccountClient(options: {
  origin: string;
  socketPath: string;
  readyTimeoutMs?: number;
}) {
  const native = accountBrokerClient(options);
  const ready = async () => {
    const deadline = Date.now() + (options.readyTimeoutMs ?? 5000);
    for (;;) {
      try {
        const info = await lstat(options.socketPath);
        if (!info.isSocket() || (process.getuid && info.uid !== process.getuid()))
          throw new Error("native_account_unavailable");
        if (!(info.mode & 0o077)) return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT")
          throw new Error("native_account_unavailable");
      }
      if (Date.now() >= deadline) throw new Error("native_account_unavailable");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  };
  const protectedCall = async <T>(action: () => Promise<T>) => {
    const expected = native.sessionId();
    await ready();
    if (native.sessionId() !== expected) throw new Error("account_session_changed");
    return action();
  };
  return Object.freeze({
    async status() {
      await ready();
      return native.status();
    },
    save(value: Parameters<typeof native.save>[0]) {
      const frozen = structuredClone(value);
      return protectedCall(() => native.save(frozen));
    },
    clear: () => protectedCall(() => native.clear()),
    request(route: string, method = "GET", payload?: string | Buffer) {
      const frozen = Buffer.isBuffer(payload) ? Buffer.from(payload) : payload;
      return protectedCall(() => native.request(route, method, frozen));
    },
    sessionId: native.sessionId,
  });
}
