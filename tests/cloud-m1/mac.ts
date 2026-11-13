import { fork } from "node:child_process";
import path from "node:path";
import type { Credentials } from "../../packages/cloud-contracts/src/index.js";
import type { loopbackTls } from "./tls.js";

/** A real headless daemon child; its only keychain is a Map inside that child. */
export async function startTestMac(input: {
  directory: string;
  origin: string;
  orgId: string;
  memberId: string;
  deviceId: string;
  taskId: string;
  credentials: Credentials;
  tls: Awaited<ReturnType<typeof loopbackTls>>;
}) {
  const statuses: string[] = [];
  const child = fork(path.resolve("tests/cloud-m1/mac-child.ts"), [], {
    execArgv: ["--import", import.meta.resolve("tsx")],
    env: {
      PATH: [path.dirname(process.execPath), "/usr/bin", "/bin"].join(path.delimiter),
      TSX_DISABLE_CACHE: "1",
      ...input.tls.childEnvironment(),
    },
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve();
        return;
      }
      const timer = setTimeout(() => child.kill("SIGKILL"), 10000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      if (child.connected) child.send({ operation: "stop" }, () => {});
      else child.kill("SIGTERM");
    }));
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("fixture_mac_start_timeout")), 20000);
      const fail = () => {
        clearTimeout(timer);
        reject(new Error("fixture_mac_start_failed"));
      };
      child.once("error", fail);
      child.once("exit", fail);
      child.on("message", (message: unknown) => {
        if (!message || typeof message !== "object") return;
        const frame = message as { type?: unknown; code?: unknown };
        if (
          frame.type === "status" &&
          typeof frame.code === "string" &&
          /^[a-z_]{1,100}$/.test(frame.code) &&
          statuses.length < 128
        )
          statuses.push(frame.code);
        if (frame.type === "failed") fail();
        if (frame.type === "ready") {
          clearTimeout(timer);
          child.removeListener("error", fail);
          child.removeListener("exit", fail);
          resolve();
        }
      });
      const { tls: _tls, ...configuration } = input;
      child.send({ operation: "start", ...configuration }, (error) => {
        if (error) fail();
      });
    });
    return Object.freeze({ statuses: () => [...statuses], close });
  } catch {
    await close();
    throw new Error("fixture_mac_start_failed");
  }
}
