import { createHash } from "node:crypto";
import { lstat, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { artifactLimits, artifactPath, verifiedType } from "@zoltbot/artifact-validation";
import type { ViewRecord } from "@zoltbot/protocol";
import {
  type Permission,
  parseViewManifest,
  type ViewManifest,
} from "../../../view-api/src/index.js";
import { checkedAncestors, safeFile } from "../artifacts/intake.js";

export const viewHash = (bytes: Uint8Array | string) =>
  createHash("sha256").update(bytes).digest("hex");
export interface ViewFile {
  path: string;
  hash: string;
  bytes: number;
  mime: string;
}
export interface ViewBundle {
  directory: string;
  allowRootOwned: boolean;
  manifest: ViewManifest;
  manifestBytes: string;
  files: ViewFile[];
  bundleHash: string;
  changedAt: string;
}
const extensions = new Set([
  ".html",
  ".css",
  ".js",
  ".mjs",
  ".json",
  ".svg",
  ".md",
  ".txt",
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".woff2",
]);
export function checkedViewPath(value: string, seen: Set<string>) {
  const name = artifactPath(value);
  if (name !== value || /[\u007f:#?%]/.test(name)) throw Error("view_path_invalid");
  if (name.split("/")[0]?.toLowerCase() === "_host") throw Error("view_reserved_path");
  const folded = name.toLowerCase();
  if (seen.has(folded)) throw Error("view_path_collision");
  seen.add(folded);
  return name;
}
export function viewBundleHash(manifestBytes: string, files: ViewFile[]) {
  return viewHash(
    manifestBytes +
      files
        .map((file) => `${file.path}:${file.hash}`)
        .sort()
        .join("\n"),
  );
}
/** Reuse artifact file reads, including no-follow opens and ancestor identity checks. */
class ViewLoadFailure extends Error {
  constructor(
    error: unknown,
    readonly path: string,
  ) {
    super(error instanceof Error ? error.message : "view_invalid");
  }
}
export async function loadView(directory: string, allowRootOwned = false): Promise<ViewBundle> {
  try {
    return await loadCheckedView(directory, allowRootOwned);
  } catch (error) {
    if (error instanceof ViewLoadFailure) throw error;
    throw new ViewLoadFailure(error, "view.json");
  }
}
async function loadCheckedView(directory: string, allowRootOwned: boolean): Promise<ViewBundle> {
  await checkedAncestors(directory);
  const manifestBytes = (await safeFile(directory, "view.json", { allowRootOwned })).toString(
    "utf8",
  );
  const rawManifest = JSON.parse(manifestBytes);
  if (
    typeof rawManifest?.api === "number" &&
    Number.isSafeInteger(rawManifest.api) &&
    rawManifest.api > 1
  )
    throw new ViewLoadFailure(Error(`view_api_unsupported:${rawManifest.api}`), "view.json");
  const manifest = parseViewManifest(rawManifest, path.basename(directory));
  const files: ViewFile[] = [],
    seen = new Set<string>();
  let total = 0,
    visited = 0,
    changed = 0;
  async function visit(relative: string) {
    for (const entry of await readdir(path.join(directory, relative), { withFileTypes: true })) {
      if (++visited > artifactLimits.files * 2) throw Error("view_walk_limit");
      const relativePath = relative ? `${relative}/${entry.name}` : entry.name;
      try {
        const name = checkedViewPath(relativePath, seen);
        if (entry.isSymbolicLink()) throw Error("view_symlink_denied");
        if (entry.isDirectory()) {
          await visit(name);
          continue;
        }
        if (!entry.isFile()) throw Error("view_file_denied");
        if (files.length >= artifactLimits.files) throw Error("view_file_limit");
        if (!extensions.has(path.extname(name).toLowerCase())) throw Error("view_type_denied");
        const bytes = await safeFile(directory, name, { allowRootOwned });
        total += bytes.length;
        if (total > artifactLimits.version) throw Error("view_total_limit");
        const mime = verifiedType(name, bytes);
        files.push({ path: name, bytes: bytes.length, hash: viewHash(bytes), mime });
        changed = Math.max(changed, (await lstat(path.join(directory, name))).mtimeMs);
      } catch (error) {
        if (error instanceof ViewLoadFailure) throw error;
        throw new ViewLoadFailure(error, relativePath);
      }
    }
  }
  await visit("");
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  if (!files.some((file) => file.path === manifest.entry))
    throw new ViewLoadFailure(Error("view_entry_missing"), manifest.entry);
  if (manifest.icon && !files.some((file) => file.path === manifest.icon))
    throw new ViewLoadFailure(Error("view_icon_missing"), manifest.icon);
  // Fail a mixed read if an editor changed a file while the bundle was being checked.
  for (const file of files) {
    try {
      if (viewHash(await safeFile(directory, file.path, { allowRootOwned })) !== file.hash)
        throw Error("view_file_changed");
    } catch (error) {
      throw new ViewLoadFailure(error, file.path);
    }
  }
  return {
    directory,
    allowRootOwned,
    manifest,
    manifestBytes,
    files,
    bundleHash: viewBundleHash(manifestBytes, files),
    changedAt: new Date(changed).toISOString(),
  };
}
export interface ViewLoadError {
  id: string;
  source: "builtin" | "user";
  code: string;
  path: string;
}
export async function loadViews(builtin: string, user: string) {
  const builtins = new Map<string, ViewBundle>(),
    users = new Map<string, ViewBundle>(),
    errors: ViewLoadError[] = [];
  for (const [directory, source, target] of [
    [builtin, "builtin", builtins],
    [user, "user", users],
  ] as const) {
    const info = await lstat(directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT")
        errors.push({ id: "views", source, code: "view_directory_denied", path: "views" });
      return undefined;
    });
    if (!info) continue;
    let root = directory;
    try {
      if (info.isSymbolicLink()) throw Error("view_directory_denied");
      if (source === "builtin") root = await realpath(directory);
      await checkedAncestors(root);
    } catch {
      errors.push({ id: "views", source, code: "view_directory_denied", path: "views" });
      continue;
    }
    const entries = await readdir(root, { withFileTypes: true }).catch(() => {
      errors.push({ id: "views", source, code: "view_directory_denied", path: "views" });
      return [];
    });
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      try {
        if (!entry.isDirectory() || entry.isSymbolicLink()) throw Error("view_symlink_denied");
        target.set(entry.name, await loadView(path.join(root, entry.name), source === "builtin"));
      } catch (error) {
        errors.push({
          id: entry.name,
          source,
          code: error instanceof Error ? error.message : "view_invalid",
          path: `${entry.name}/${error instanceof ViewLoadFailure ? error.path : "view.json"}`,
        });
      }
    }
  }
  const bundles = new Map([...builtins, ...users]);
  return { builtins, bundles, errors };
}
export function viewRecord(
  bundle: ViewBundle,
  builtin: ViewBundle | undefined,
  granted: Permission[],
  enabled = true,
  basedOnBuiltin = builtin,
): ViewRecord {
  const manifest = bundle.manifest,
    user = bundle !== builtin;
  return {
    id: manifest.id,
    source: user ? "user" : "builtin",
    name: manifest.name,
    version: manifest.version,
    api: manifest.api,
    slots: manifest.slots,
    entry: manifest.entry,
    bundleHash: bundle.bundleHash,
    requested: manifest.permissions,
    granted,
    enabled,
    overridesBuiltin: user && !!builtin,
    ...(manifest.description !== undefined ? { description: manifest.description } : {}),
    ...(manifest.icon ? { icon: manifest.icon } : {}),
    ...(manifest.shortcuts ? { shortcuts: manifest.shortcuts } : {}),
    ...(manifest.basedOn ? { basedOn: manifest.basedOn } : {}),
    ...(manifest.basedOn &&
    basedOnBuiltin &&
    manifest.basedOn.bundleHash !== basedOnBuiltin.bundleHash
      ? {
          builtinUpdate: {
            version: basedOnBuiltin.manifest.version,
            bundleHash: basedOnBuiltin.bundleHash,
          },
        }
      : {}),
    changedAt: bundle.changedAt,
  };
}
