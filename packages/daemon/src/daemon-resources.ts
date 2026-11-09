import { mkdirSync } from "node:fs";
import path from "node:path";
import { acquireOwnerLock } from "@zoltbot/store";
export type Cleanup = () => void | Promise<void>;
export async function withDaemonResources<T>(
  dataDir: string,
  start: (resources: Cleanup[], dispose: () => Promise<void>) => Promise<T>,
): Promise<T> {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const owner = acquireOwnerLock(path.join(dataDir, "daemon-owner.sqlite"));
  const resources: Cleanup[] = [() => owner.release()];
  const dispose = async () => {
    let failure: unknown;
    for (const cleanup of resources.splice(0).reverse()) {
      try {
        await cleanup();
      } catch (error) {
        failure ??= error;
      }
    }
    if (failure) throw failure;
  };
  try {
    return await start(resources, dispose);
  } catch (error) {
    await dispose().catch(() => {});
    throw error;
  }
}
