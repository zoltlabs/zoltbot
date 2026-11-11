import { randomUUID } from "node:crypto";
import { lstat, mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { checkedAncestors, safeFile } from "../artifacts/intake.js";
import { loadView, type ViewBundle, viewHash } from "./loader.js";
export async function exists(target: string) {
  try {
    return await lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
export async function userRoot(directory: string) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const identity = await checkedAncestors(directory);
  if ((await lstat(directory)).uid !== process.getuid?.()) throw Error("view_directory_denied");
  return identity;
}
export async function copyView(
  bundle: ViewBundle,
  user: string,
  manifest: Record<string, unknown>,
) {
  const id = String(manifest.id);
  if (!/^[a-z0-9-]{2,40}$/.test(id)) throw Error("invalid_view_id");
  const parent = await userRoot(user),
    target = path.join(user, id);
  if (await exists(target)) throw Error("view_folder_exists");
  const stage = path.join(user, `.view-stage-${randomUUID()}`),
    folder = path.join(stage, id);
  await mkdir(folder, { recursive: true, mode: 0o700 });
  try {
    for (const file of bundle.files) {
      const bytes = await safeFile(bundle.directory, file.path, {
        allowRootOwned: bundle.allowRootOwned,
      });
      if (viewHash(bytes) !== file.hash) throw Error("view_file_changed");
      const destination = path.join(folder, file.path);
      await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      await writeFile(
        destination,
        file.path === "view.json" ? `${JSON.stringify(manifest, null, 2)}\n` : bytes,
        { flag: "wx", mode: 0o600 },
      );
    }
    const checked = await loadView(folder);
    if ((await checkedAncestors(user)) !== parent || (await exists(target)))
      throw Error("view_folder_exists");
    await rename(folder, target);
    return checked.bundleHash;
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}
export async function updateViewManifest(bundle: ViewBundle, manifest: Record<string, unknown>) {
  const current = await loadView(bundle.directory);
  if (current.bundleHash !== bundle.bundleHash) throw Error("view_changed");
  const parent = await checkedAncestors(bundle.directory),
    temporary = path.join(bundle.directory, `.view-manifest-${randomUUID()}.partial`);
  try {
    await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    if ((await checkedAncestors(bundle.directory)) !== parent)
      throw Error("view_directory_changed");
    await rename(temporary, path.join(bundle.directory, "view.json"));
  } finally {
    await rm(temporary, { force: true });
  }
}
export async function deleteUserView(user: string, id: string, expectedHash?: string) {
  if (!/^[a-z0-9-]{2,40}$/.test(id)) throw Error("invalid_view_id");
  const parent = await checkedAncestors(user),
    target = path.join(user, id),
    info = await lstat(target);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.())
    throw Error("view_directory_denied");
  if (expectedHash && (await loadView(target)).bundleHash !== expectedHash)
    throw Error("view_changed");
  if ((await checkedAncestors(user)) !== parent) throw Error("view_directory_changed");
  await rm(target, { recursive: true });
}

export async function renameUserView(
  bundle: ViewBundle,
  user: string,
  id: string,
  manifest: Record<string, unknown>,
) {
  if (!/^[a-z0-9-]{2,40}$/.test(id)) throw Error("invalid_view_id");
  if ((await loadView(bundle.directory)).bundleHash !== bundle.bundleHash)
    throw Error("view_changed");
  const parent = await userRoot(user),
    target = path.join(user, id);
  if (await exists(target)) throw Error("view_folder_exists");
  const temporary = path.join(user, `.view-rename-${randomUUID()}.json`);
  let moved = false;
  try {
    await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    if ((await checkedAncestors(user)) !== parent || (await exists(target)))
      throw Error("view_directory_changed");
    await rename(bundle.directory, target);
    moved = true;
    await rename(temporary, path.join(target, "view.json"));
    moved = false;
    return await loadView(target);
  } catch (error) {
    if (moved && !(await exists(bundle.directory))) await rename(target, bundle.directory);
    throw error;
  } finally {
    await rm(temporary, { force: true });
  }
}
