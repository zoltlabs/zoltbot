import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readlink, realpath } from "node:fs/promises";
import path from "node:path";
import { assertManagedGitConfiguration, managedGit } from "./managed-git.js";
import type { ManagedWorkspaceInput, ManagedWorkspaces } from "./workspaces.js";

interface ReviewFile {
  path: string;
  hash: string;
  mode?: string;
  excluded?: string;
}
export interface ManagedReviewPreview {
  fingerprint: string;
  head: string;
  base: string;
  files: ReviewFile[];
}
export interface PreparedReviewCommit {
  fingerprint: string;
  head: string;
  previous: string;
  base: string;
  tree: string;
  reference: string;
}
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const oid = (value: string) => /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
const message = "Review cloud task changes";

/** Native-only capability. Approved bytes go directly to Git; it never rereads them through filters. */
export function managedReviews(options: {
  workspaces: ManagedWorkspaces;
  scope: ManagedWorkspaceInput;
  signal: AbortSignal;
  assertPublic(value: unknown): Promise<void>;
}) {
  const scope = structuredClone(options.scope),
    signal = options.signal;
  const prepare = async () => {
    if (signal.aborted) throw new Error("managed_review_canceled");
    await options.assertPublic(scope);
    const workspace = await options.workspaces.prepare(scope, signal);
    await assertManagedGitConfiguration(workspace.cwd, signal);
    return workspace;
  };
  async function snapshot() {
    const workspace = await prepare();
    const git = (args: string[]) => managedGit(workspace.cwd, args, undefined, signal, 1048576);
    const head = await git(["rev-parse", "--verify", "HEAD"]);
    let reference: string;
    try {
      reference = await git(["symbolic-ref", "--quiet", "HEAD"]);
    } catch {
      reference = "HEAD";
    }
    if (!oid(head)) throw new Error("managed_review_unavailable");
    await options.assertPublic({ reference });
    if (reference !== "HEAD") await git(["check-ref-format", reference]);
    const index = await git(["ls-files", "--stage", "-z"]);
    const paths = [
      ...new Set(
        [
          ...(
            await git(["diff", "--no-ext-diff", "--no-textconv", "--name-only", "-z", "HEAD", "--"])
          ).split("\0"),
          ...(
            await git([
              "diff",
              "--cached",
              "--no-ext-diff",
              "--no-textconv",
              "--name-only",
              "-z",
              "HEAD",
              "--",
            ])
          ).split("\0"),
          ...(await git(["ls-files", "--others", "--exclude-standard", "-z"])).split("\0"),
        ].filter(Boolean),
      ),
    ].sort();
    if (paths.length > 200) throw new Error("managed_review_too_large");
    const files: ReviewFile[] = [],
      bytes = new Map<string, { body: Buffer; mode: string }>();
    let size = 0;
    for (const relative of paths) {
      if (
        path.isAbsolute(relative) ||
        relative.split("/").includes("..") ||
        relative.includes("\0")
      )
        throw new Error("managed_review_unavailable");
      const target = path.resolve(workspace.cwd, relative);
      if (!target.startsWith(`${workspace.cwd}${path.sep}`))
        throw new Error("managed_review_unavailable");
      let body: Buffer, mode: string;
      try {
        const info = await lstat(target);
        if (info.isSymbolicLink()) {
          const link = await readlink(target);
          body = Buffer.from(link);
          mode = "120000";
          const destination = path.resolve(path.dirname(target), link);
          if (
            destination !== workspace.cwd &&
            !destination.startsWith(`${workspace.cwd}${path.sep}`)
          ) {
            files.push({
              path: relative,
              hash: hash(body),
              mode,
              excluded: "Link leaves the task checkout",
            });
            continue;
          }
        } else if (info.isFile()) {
          const parent = await realpath(path.dirname(target));
          if (parent !== workspace.cwd && !parent.startsWith(`${workspace.cwd}${path.sep}`))
            throw new Error("managed_review_unavailable");
          const file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
          try {
            const current = await file.stat();
            if (
              !current.isFile() ||
              current.size > 1048576 ||
              current.ino !== info.ino ||
              current.dev !== info.dev
            )
              throw new Error("managed_review_too_large");
            body = await file.readFile();
            if (body.length > 1048576) throw new Error("managed_review_too_large");
          } finally {
            await file.close();
          }
          mode = info.mode & 0o111 ? "100755" : "100644";
        } else throw new Error("managed_review_unavailable");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        files.push({ path: relative, hash: "deleted" });
        continue;
      }
      size += body.length;
      if (size > 8 * 1048576) throw new Error("managed_review_too_large");
      await options.assertPublic(body.toString("utf8"));
      const file: ReviewFile = { path: relative, hash: hash(body), mode };
      if (
        /(^|\/)(\.env(?:\..*)?|credentials(?:\..*)?|id_rsa|id_ed25519)$|\.(pem|key|p12)$/i.test(
          relative,
        ) ||
        /-----BEGIN (?:[A-Z ]*PRIVATE KEY|OPENSSH PRIVATE KEY)-----/.test(body.toString("utf8"))
      )
        file.excluded = "Potential secret; remove or ignore this file";
      files.push(file);
      bytes.set(relative, { body, mode });
    }
    const preview: ManagedReviewPreview = {
      head,
      base: workspace.baseCommit,
      files,
      fingerprint: hash(
        JSON.stringify({ head, base: workspace.baseCommit, reference, index, files }),
      ),
    };
    await options.assertPublic(preview);
    return { workspace, preview, bytes, reference };
  }
  return Object.freeze({
    preview: async () => (await snapshot()).preview,
    async prepareCommit(fingerprint: string): Promise<PreparedReviewCommit> {
      const current = await snapshot();
      if (current.preview.fingerprint !== fingerprint) throw new Error("review_preview_stale");
      if (!current.preview.files.length) throw new Error("no_review_changes");
      if (current.preview.files.some((file) => file.excluded))
        throw new Error("review_files_excluded");
      const { workspace, preview } = current;
      const git = (args: string[], input?: Buffer) =>
        managedGit(workspace.cwd, args, undefined, signal, 1048576, false, input);
      // These writes store only bytes that passed the private-context check above.
      await git(["read-tree", preview.head]);
      for (const file of preview.files) {
        const value = current.bytes.get(file.path);
        if (!value) {
          await git(["update-index", "--force-remove", "--", file.path]);
          continue;
        }
        const object = await git(["hash-object", "-w", "--stdin", "--no-filters"], value.body);
        if (!oid(object)) throw new Error("managed_review_unavailable");
        await git(["update-index", "--add", "--cacheinfo", value.mode, object, file.path]);
      }
      const tree = await git(["write-tree"]);
      if (!oid(tree)) throw new Error("managed_review_unavailable");
      const head = await git([
        "-c",
        "user.name=Zolt Labs",
        "-c",
        "user.email=zolt@zoltbot.ai",
        "-c",
        "commit.gpgsign=false",
        "commit-tree",
        tree,
        "-p",
        preview.head,
        "-m",
        message,
      ]);
      if (!oid(head)) throw new Error("managed_review_unavailable");
      const prepared = {
        fingerprint,
        head,
        previous: preview.head,
        base: preview.base,
        tree,
        reference: current.reference,
      };
      await options.assertPublic(prepared);
      return prepared;
    },
    /** Persist the prepared identity with FULL synchronization before calling this method. */
    async finish(prepared: PreparedReviewCommit) {
      const value = structuredClone(prepared),
        workspace = await prepare();
      await options.assertPublic(value);
      if (
        ![value.head, value.previous, value.tree, value.base].every(oid) ||
        value.base !== workspace.baseCommit ||
        !/^[a-f0-9]{64}$/.test(value.fingerprint)
      )
        throw new Error("managed_review_unavailable");
      const git = (args: string[]) => managedGit(workspace.cwd, args, undefined, signal);
      if (value.reference !== "HEAD") await git(["check-ref-format", value.reference]);
      const current = await git(["rev-parse", "--verify", "HEAD"]);
      if (current !== value.head && current !== value.previous)
        throw new Error("review_preview_stale");
      const details = await git([
        "show",
        "--no-patch",
        "--no-notes",
        "--format=%T%n%P",
        value.head,
      ]);
      if (details !== `${value.tree}\n${value.previous}`)
        throw new Error("managed_review_unavailable");
      let reference: string;
      try {
        reference = await git(["symbolic-ref", "--quiet", "HEAD"]);
      } catch {
        reference = "HEAD";
      }
      if (reference !== value.reference) throw new Error("review_preview_stale");
      if (current !== value.head)
        await git(["update-ref", value.reference, value.head, value.previous]);
      if ((await git(["rev-parse", "--verify", "HEAD"])) !== value.head)
        throw new Error("review_preview_stale");
      return {
        head: value.head,
        previous: value.previous,
        base: value.base,
        fingerprint: value.fingerprint,
      };
    },
  });
}
