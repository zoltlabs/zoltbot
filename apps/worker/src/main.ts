import metadata from "../package.json" with { type: "json" };
import { workerCliMetadata } from "./discovery.js";
import { readWorkerEnvironment, workerSecretNames } from "./environment.js";
import { startWorker } from "./index.js";

async function boot() {
  const environment = readWorkerEnvironment(process.env);
  for (const name of workerSecretNames) delete process.env[name];
  let worker: Awaited<ReturnType<typeof startWorker>> | undefined,
    stopped = false;
  const status = (code: string) =>
    process.stdout.write(
      `${JSON.stringify({ type: "worker.status", code: /^[a-z_]{1,100}$/.test(code) ? code : "worker_unavailable" })}\n`,
    );
  const stop = () => {
    stopped = true;
    if (worker)
      void worker.close().catch(() => {
        status("worker_cleanup_required");
        process.exitCode = 1;
      });
  };
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, stop);
  worker = await startWorker({
    environment,
    clis: (directory) => workerCliMetadata(environment.provider, directory),
    versions: { worker: metadata.version, node: process.versions.node },
    status,
  });
  if (stopped) await worker.close();
  else status("worker_started");
}
try {
  await boot();
} catch {
  process.stderr.write("worker_start_unavailable\n");
  process.exitCode = 1;
}
