import type { ChildProcessWithoutNullStreams } from "node:child_process";

/** Fixture boot is bounded independently; this does not change provider RPC timeouts. */
export async function readyChild(child: ChildProcessWithoutNullStreams, timeoutMs = 5000) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let text = "";
  let data = (_bytes: Buffer) => {};
  let failed = () => {};
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  try {
    await new Promise<void>((resolve, reject) => {
      data = (bytes) => {
        text += bytes.toString();
        if (text.split("\n").includes("ZOLTBOT_FAKE_READY")) resolve();
        else if (text.length > 8192) reject(new Error("fake_startup_failed"));
      };
      failed = () => reject(new Error("fake_startup_failed"));
      child.stderr.on("data", data);
      child.once("error", failed);
      child.once("exit", failed);
      timer = setTimeout(() => reject(new Error("fake_startup_timeout")), timeoutMs);
      if (child.exitCode !== null || child.signalCode !== null) failed();
    });
  } catch (error) {
    child.kill("SIGTERM");
    const kill = setTimeout(() => child.kill("SIGKILL"), 1000);
    try {
      await closed;
    } finally {
      clearTimeout(kill);
    }
    throw error;
  } finally {
    clearTimeout(timer);
    child.stderr.off("data", data);
    child.off("error", failed);
    child.off("exit", failed);
  }
}
