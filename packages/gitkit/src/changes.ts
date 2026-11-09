import { createHash, randomUUID } from "node:crypto";
import { clean, commit, git, repository, repositoryLock } from "./git.js";
import { rejectActiveHook, rejectCheckoutFilters } from "./hooks.js";
import { type ReviewFile, reviewFiles } from "./review-files.js";

export interface Changes {
  base: string;
  head: string;
  patch: string;
  status: string;
  paths: string[];
  files: ReviewFile[];
  uncommittedFiles: ReviewFile[];
  provenance: string;
  patchIncomplete: boolean;
  capturedAt: string;
}
export async function changes(cwd: string, base: string): Promise<Changes> {
  const repo = await repository(cwd),
    frozen = await commit(cwd, base);
  const untracked: ReviewFile[] = (
    await git(cwd, ["ls-files", "--others", "--exclude-standard", "-z"])
  )
    .split("\0")
    .filter(Boolean)
    .map((path) => ({
      path,
      added: 0,
      removed: 0,
      binary: false,
      patch: "",
      unavailable:
        "Untracked file. Content is not read by review; inspect locally or stage it to include its diff.",
    }));
  const files = [...(await reviewFiles(cwd, frozen)), ...untracked];
  return {
    files,
    capturedAt: new Date().toISOString(),
    patchIncomplete: files.some((file) => Boolean(file.unavailable)),
    uncommittedFiles: [...(await reviewFiles(cwd, repo.head)), ...untracked],
    provenance:
      "Task base to working tree; includes committed and uncommitted tracked changes, not turn attribution. Untracked paths are listed without reading their content; their line counts are unavailable.",
    base: frozen,
    head: repo.head,
    patch: files.map((file) => file.patch).join("\n"),
    status: await git(cwd, ["status", "--porcelain=v1", "--untracked-files=all"]),
    paths: (await git(cwd, ["diff", "--name-only", "-z", frozen, "--"]))
      .split("\0")
      .filter(Boolean),
  };
}
export interface IntegrationPreview {
  source: string;
  sourceCommit: string;
  destination: string;
  destinationHead: string;
  branch: string;
  paths: string[];
  fingerprint: string;
}
const fingerprint = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
/** v1 only accepts a reviewed source that already contains destination history. */
export async function previewIntegration(
  source: string,
  destination: string,
  reviewedCommit: string,
): Promise<IntegrationPreview> {
  const src = await repository(source),
    dst = await repository(destination);
  if (src.commonDir !== dst.commonDir || src.root === dst.root)
    throw new Error("integration_repository_mismatch");
  if (src.head !== reviewedCommit) throw new Error("source_changed_since_review");
  await clean(src.root);
  await clean(dst.root);
  try {
    await git(src.root, ["merge-base", "--is-ancestor", dst.head, src.head]);
  } catch {
    throw new Error("update_task_from_destination_required");
  }
  const branch = await git(dst.root, ["symbolic-ref", "--quiet", "HEAD"]);
  const proposal = {
    source: src.root,
    sourceCommit: src.head,
    destination: dst.root,
    destinationHead: dst.head,
    branch,
    paths: (await git(src.root, ["diff", "--name-only", "-z", dst.head, src.head, "--"]))
      .split("\0")
      .filter(Boolean),
  };
  return { ...proposal, fingerprint: fingerprint(proposal) };
}
export async function integrate(
  preview: IntegrationPreview,
  confirmed: boolean,
  recoveryRef?: string,
): Promise<{ head: string; backupRef: string }> {
  if (!confirmed) throw new Error("confirmation_required");
  const repo = await repository(preview.destination);
  return repositoryLock(repo.commonDir, async () => {
    const current = await previewIntegration(
      preview.source,
      preview.destination,
      preview.sourceCommit,
    );
    if (current.fingerprint !== preview.fingerprint) throw new Error("integration_preview_stale");
    // merge may execute post-merge hooks; fail closed until durable execution approval is wired.
    for (const hook of ["post-merge", "post-index-change", "reference-transaction"])
      await rejectActiveHook(repo.root, hook);
    await rejectCheckoutFilters(repo.root, current.sourceCommit);
    const backupRef = recoveryRef ?? `refs/zoltbot/integration-backups/${randomUUID()}`;
    if (!/^refs\/zoltbot\/integration-backups\/[a-zA-Z0-9-]+$/.test(backupRef))
      throw new Error("invalid_backup_ref");
    await git(repo.root, ["update-ref", backupRef, current.destinationHead], true);
    const finalPreview = await previewIntegration(
      preview.source,
      preview.destination,
      preview.sourceCommit,
    );
    if (finalPreview.fingerprint !== preview.fingerprint)
      throw new Error("integration_preview_stale");
    await git(repo.root, ["merge", "--ff-only", "--no-edit", current.sourceCommit], true);
    return { head: await commit(repo.root, "HEAD"), backupRef };
  });
}
