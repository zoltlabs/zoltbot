import { type Supervisor, supervisedTransport } from "@zoltbot/daemon";
/** Fixture loading has its own budget; provider RPC deadlines begin after this marker. */
export async function readyTransport(supervisor: Supervisor, startupMs = 5000) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let ready = (_line: string) => {};
  let failed = () => {};
  const started = new Promise<void>((resolve, reject) => {
    ready = (line) => {
      if (line === "ZOLTBOT_FAKE_READY") resolve();
    };
    failed = () => reject(new Error("fake_startup_failed"));
    supervisor.on("stderr", ready);
    supervisor.once("exit", failed);
    supervisor.once("fault", failed);
    timer = setTimeout(() => reject(new Error("fake_startup_timeout")), startupMs);
  });
  const transport = supervisedTransport(supervisor);
  try {
    await started;
    return transport;
  } catch (error) {
    await transport.close();
    throw error;
  } finally {
    clearTimeout(timer);
    supervisor.off("stderr", ready);
    supervisor.off("exit", failed);
    supervisor.off("fault", failed);
  }
}
