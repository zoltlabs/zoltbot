import { lstat, opendir, rm, rmdir } from "node:fs/promises";
import path from "node:path";
import type { ArtifactBinding } from "@zoltbot/protocol";
import type { Store } from "@zoltbot/store";
import { artifactLimits, artifactPath, checkedAncestors, safeFile } from "./intake.js";
export async function* stagedFiles(
  binding: Pick<ArtifactBinding, "stagingRoot">,
  directory: string,
) {
  const cwd = path.dirname(path.dirname(path.dirname(binding.stagingRoot)));
  const root = path.resolve(cwd, directory);
  if (root !== binding.stagingRoot && !root.startsWith(`${binding.stagingRoot}${path.sep}`))
    throw Error("artifact_staging_scope_denied");
  await checkedAncestors(root);
  let count = 0;
  async function* visit(folder: string): AsyncGenerator<{ path: string; bytes: Buffer }> {
    for await (const entry of await opendir(folder)) {
      if (++count > artifactLimits.files * 2) throw Error("artifact_walk_limit");
      const full = path.join(folder, entry.name);
      if (entry.isSymbolicLink()) throw Error("artifact_symlink_denied");
      if (entry.isDirectory()) yield* visit(full);
      else if (entry.isFile()) {
        const relative = path.relative(root, full);
        artifactPath(relative);
        yield { path: relative, bytes: await safeFile(root, relative) };
      } else throw Error("artifact_file_denied");
    }
  }
  yield* visit(root);
}
export async function cleanupStaging(binding: ArtifactBinding) {
  try {
    await checkedAncestors(path.dirname(binding.stagingRoot));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const info = await lstat(binding.stagingRoot).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  });
  if (info)
    await rm(binding.stagingRoot, {
      recursive: info.isDirectory() && !info.isSymbolicLink(),
      force: true,
    });
  for (const folder of [
    path.dirname(binding.stagingRoot),
    path.dirname(path.dirname(binding.stagingRoot)),
  ]) {
    try {
      await rmdir(folder);
    } catch (error) {
      if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes((error as NodeJS.ErrnoException).code ?? ""))
        throw error;
    }
  }
}

export async function cleanupThreadStaging(store: Store, threadId: string) {
  const sessions = (store.snapshot(["session"]).session ?? []).filter(
    (s) => s.threadId === threadId,
  );
  for (const session of sessions) {
    const configuration = store.record("settings", `runtime.configuration.${session.id}`)?.value as
      | { launchManifest?: { artifact?: ArtifactBinding } }
      | undefined;
    if (configuration?.launchManifest?.artifact)
      await cleanupStaging(configuration.launchManifest.artifact);
  }
}
