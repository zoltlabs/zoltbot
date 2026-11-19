import { resolve } from "node:path";
import { artifactKitAsset } from "@zoltbot/artifact-kit";

/**
 * Folder that holds `packages/artifact-kit/v1`. A packaged app reads it from its own app folder,
 * where scripts/package-desktop.mjs stages it; a development run reads it from the checkout.
 */
export function artifactKitRoot(packaged: boolean, appPath: string) {
  if (packaged) return appPath;
  return process.env.ZOLTBOT_REPO_ROOT ?? resolve(appPath, "../..");
}

export function desktopKitAsset(packaged: boolean, appPath: string) {
  const root = artifactKitRoot(packaged, appPath);
  return (name: string) => artifactKitAsset(root, name);
}
