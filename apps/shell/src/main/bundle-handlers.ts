// D7: main's half of moving to another computer: file dialogs, then the daemon does the work.
import { type BrowserWindow, dialog } from "electron";
import { BUNDLE_CHANNELS, type BundlePreview } from "../shared/bundle";

export interface BundleDeps {
  call: (method: string, params: unknown) => Promise<unknown>;
  chooseSavePath: () => Promise<string | undefined>;
  chooseOpenPath: () => Promise<string | undefined>;
}

export function bundleHandlers(deps: BundleDeps): Record<string, (input: unknown) => unknown> {
  return {
    [BUNDLE_CHANNELS.export]: async () => {
      const path = await deps.chooseSavePath();
      if (!path) return { saved: false };
      await deps.call("export.bundle", { path: path.endsWith(".zip") ? path : `${path}.zip` });
      return { saved: true };
    },
    [BUNDLE_CHANNELS.preview]: async (): Promise<BundlePreview | null> => {
      const path = await deps.chooseOpenPath();
      if (!path) return null;
      return (await deps.call("import.bundle", { path })) as BundlePreview;
    },
    [BUNDLE_CHANNELS.apply]: async (input) => {
      const { previewId, selected } = (input ?? {}) as { previewId?: unknown; selected?: unknown };
      if (typeof previewId !== "string" || !previewId.startsWith("bundle:"))
        throw new Error("invalid_preview");
      if (!Array.isArray(selected) || !selected.every((item) => typeof item === "string"))
        throw new Error("invalid_selection");
      await deps.call("import.apply", { previewId, selected, consent: true });
    },
  };
}

const FILTERS = [{ name: "Zoltbot export", extensions: ["zip"] }];

/** The handlers with Electron's save and open dialogs, attached to the main window. */
export function electronBundleHandlers(
  call: BundleDeps["call"],
  window: () => BrowserWindow | null,
): ReturnType<typeof bundleHandlers> {
  return bundleHandlers({
    call,
    chooseSavePath: async () => {
      const options = { defaultPath: "Zoltbot export.zip", filters: FILTERS };
      const parent = window();
      const result = parent
        ? await dialog.showSaveDialog(parent, options)
        : await dialog.showSaveDialog(options);
      return result.canceled ? undefined : result.filePath;
    },
    chooseOpenPath: async () => {
      const options = { properties: ["openFile" as const], filters: FILTERS };
      const parent = window();
      const result = parent
        ? await dialog.showOpenDialog(parent, options)
        : await dialog.showOpenDialog(options);
      return result.canceled ? undefined : result.filePaths[0];
    },
  });
}
