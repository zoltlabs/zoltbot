// D3: electron-updater as an UpdateFeed. Only a build packaged with an update feed has
// app-update.yml; package-desktop.mjs writes it for signed, notarized builds alone, because
// macOS refuses to install an unsigned update.
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { UpdateFeed } from "./updater";

export async function electronUpdateFeed(packaged: boolean): Promise<UpdateFeed | undefined> {
  if (!packaged || !existsSync(join(process.resourcesPath, "app-update.yml"))) return undefined;
  const module = (await import("electron-updater")) as unknown as {
    autoUpdater?: import("electron-updater").AppUpdater;
    default?: { autoUpdater: import("electron-updater").AppUpdater };
  };
  const updater = module.autoUpdater ?? module.default?.autoUpdater;
  if (!updater) return undefined;
  // The service decides when to download; an update the owner never restarts for installs on
  // the next quit.
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = true;
  updater.logger = null;
  return {
    checkForUpdates: () => updater.checkForUpdates(),
    downloadUpdate: () => updater.downloadUpdate(),
    quitAndInstall: () => updater.quitAndInstall(),
    onProgress: (listener) => {
      updater.on("download-progress", (progress) => listener(progress.percent));
    },
  };
}
