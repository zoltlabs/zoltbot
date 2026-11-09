import { constants } from "node:fs";
import { access, lstat, readdir } from "node:fs/promises";
import path from "node:path";
import { git } from "./git.js";

export async function rejectActiveHook(root: string, name: string) {
  const hook = path.resolve(root, await git(root, ["rev-parse", "--git-path", `hooks/${name}`]));
  try {
    await access(hook, constants.X_OK);
  } catch (error) {
    if (["ENOENT", "ENOTDIR", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? ""))
      return;
    throw error;
  }
  throw new Error("hook_execution_approval_required");
}
/** lstat every directory; never follow links while looking for embedded repositories. */
export async function rejectNestedRepositories(root: string, maxEntries = 20_000) {
  let count = 0;
  async function walk(folder: string) {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      if (++count > maxEntries) throw new Error("repository_scan_limit");
      if (folder === root && entry.name === ".git") continue;
      if (entry.name === ".git") throw new Error("nested_repositories_unsupported");
      const target = path.join(folder, entry.name);
      if ((await lstat(target)).isDirectory()) {
        // Ignored directories are never copied into a prepared checkout or review commit.
        let ignored = false;
        try {
          await git(root, ["check-ignore", "--quiet", "--", path.relative(root, target)]);
          ignored = true;
        } catch {}
        if (!ignored) await walk(target);
      }
    }
  }
  await walk(root);
}

export async function executionFingerprint(root: string): Promise<string> {
  const { createHash } = await import("node:crypto");
  const { readFile } = await import("node:fs/promises");
  const digest = createHash("sha256");
  digest.update(await git(root, ["config", "--null", "--list", "--show-origin"]));
  for (const name of [
    "post-checkout",
    "pre-push",
    "pre-commit",
    "prepare-commit-msg",
    "commit-msg",
    "post-commit",
    "post-rewrite",
    "post-merge",
    "reference-transaction",
    "post-index-change",
  ]) {
    const file = path.resolve(root, await git(root, ["rev-parse", "--git-path", `hooks/${name}`]));
    digest.update(name);
    try {
      const info = await lstat(file);
      if (info.size > 1024 * 1024) throw new Error("hook_too_large");
      digest.update(await readFile(file));
      digest.update(String(info.mode));
    } catch (error) {
      if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    }
  }
  return digest.digest("hex");
}

export async function rejectCheckoutFilters(root: string, source: string) {
  const files = (await git(root, ["ls-tree", "-r", "--name-only", "-z", source]))
    .split("\0")
    .filter(Boolean);
  for (let index = 0; index < files.length; index += 100) {
    const attributes = await git(root, [
      "check-attr",
      "--source",
      source,
      "filter",
      "--",
      ...files.slice(index, index + 100),
    ]);
    if (
      attributes
        .split("\n")
        .some((line) => !line.endsWith(": unspecified") && !line.endsWith(": unset"))
    )
      throw new Error("checkout_filter_execution_approval_required");
  }
}

export async function preparationExecutionHash(root: string, base: string) {
  const { createHash } = await import("node:crypto");
  return createHash("sha256")
    .update(base)
    .update(await executionFingerprint(root))
    .digest("hex");
}
