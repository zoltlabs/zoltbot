// Saves a PDF or video from the Mac to the phone's cache and opens it in the system viewer: Quick
// Look on iPhone, the default app for its type on Android. Only the latest file is kept.
import { requireOptionalNativeModule } from "expo";
import type { SavedFile, SaveFile } from "./attachment-preview";

type Files = typeof import("expo-file-system");
let files: Promise<Files | undefined> | undefined;
function loadFiles() {
  files ??= requireOptionalNativeModule("FileSystem")
    ? import("expo-file-system").catch(() => undefined)
    : Promise.resolve(undefined);
  return files;
}

let previous: { delete(): void } | undefined;

export const saveToCache: SaveFile = async (name) => {
  const loaded = await loadFiles();
  if (!loaded) throw new Error("attachment_preview_unavailable");
  try {
    previous?.delete();
  } catch {}
  const file = new loaded.File(loaded.Paths.cache, name);
  file.write("", { encoding: "base64" });
  previous = file;
  const saved: SavedFile = {
    uri: file.uri,
    append: (base64) => file.write(base64, { encoding: "base64", append: true }),
    remove: () => {
      try {
        file.delete();
      } catch {}
    },
  };
  return saved;
};

/** Opens a saved file. Resolves false when nothing on the phone can show it. */
export async function openSaved(uri: string, title: string, mimeType: string): Promise<boolean> {
  const loaded = await loadFiles();
  if (!loaded) return false;
  const file = new loaded.File(uri);
  if (!(await file.canPreview({ mimeType }))) return false;
  await file.preview({ title, mimeType });
  return true;
}
