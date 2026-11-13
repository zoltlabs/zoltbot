import path from "node:path";

/** Deployment-owned paths. Cell leases and RPCs cannot select the worker's home. */
export function workerPaths(source: Record<string, string | undefined>) {
  const home = source.ZOLTBOT_WORKER_HOME ?? "/home/user";
  if (
    !path.isAbsolute(home) ||
    path.resolve(home) !== home ||
    path.dirname(home) === home ||
    home.length > 4096 ||
    /[\0\r\n]/.test(home)
  )
    throw new Error("worker_paths_invalid");
  return Object.freeze({
    directory: path.join(home, ".zoltbot"),
    workDirectory: path.join(home, "work"),
  });
}
