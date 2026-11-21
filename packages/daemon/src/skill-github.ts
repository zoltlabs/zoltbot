// M5: read a skill from a GitHub link. A shallow clone into a temporary folder, pinned to the
// commit it fetched; the folder is then read like a local skill and removed.
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { git } from "../../gitkit/src/git.js";
import { readSkillFolder, type SkillBundle } from "../../skills/src/index.js";

/** The folder may hold at most this many files; the skill reader caps their size. */
export const githubSkillLimits = { files: 100 };

export interface GithubSkillLink {
  owner: string;
  repo: string;
  /** A branch, tag or commit; the default branch when absent. */
  ref?: string;
  /** The skill's folder inside the repository; the root when empty. */
  folder: string;
  /** Everything after `/tree/`, for branch names that contain a slash. */
  rest: string[];
}

const NAME = /^[A-Za-z0-9_.-]{1,100}$/;
const SEGMENT = /^[^/\\:?#]{1,200}$/;
const plain = (part: string) =>
  SEGMENT.test(part) && [...part].every((char) => char.charCodeAt(0) >= 32);
const SHA = /^[0-9a-f]{40}$/;
const INVALID = "skill_link_invalid: paste a github.com link to a skill folder or repository.";
const FOLDER = "skill_link_invalid: link to a folder, like …/tree/main/skills/name.";

function decode(part: string) {
  try {
    return decodeURIComponent(part);
  } catch {
    throw new Error(INVALID);
  }
}

/** `https://github.com/owner/repo`, optionally `/tree/<ref>/<folder>`. Anything else is refused. */
export function parseGithubSkillLink(input: string): GithubSkillLink {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new Error(INVALID);
  }
  if (url.protocol !== "https:" || url.hostname !== "github.com" || url.search || url.username)
    throw new Error(INVALID);
  const parts = url.pathname.split("/").filter(Boolean).map(decode);
  const [owner = "", rawRepo = "", kind, ...after] = parts;
  const repo = rawRepo.replace(/\.git$/, "");
  if (!NAME.test(owner) || !NAME.test(repo) || repo === "." || repo === "..")
    throw new Error(INVALID);
  if (kind === undefined) return { owner, repo, folder: "", rest: [] };
  if (kind !== "tree" && kind !== "blob") throw new Error(FOLDER);
  // A link to SKILL.md means its folder.
  const rest =
    kind === "blob" && after.at(-1)?.toLowerCase() === "skill.md" ? after.slice(0, -1) : after;
  if (kind === "blob" && rest.length === after.length) throw new Error(FOLDER);
  if (
    rest.length === 0 ||
    rest.some((part) => !plain(part) || part === "." || part === ".." || part.startsWith("-")) ||
    rest[0]?.endsWith(".lock") ||
    rest[0]?.includes("..")
  )
    throw new Error(FOLDER);
  const [ref = "", ...folder] = rest;
  return { owner, repo, ref, folder: folder.join("/"), rest };
}

export interface GithubSkill {
  bundle: SkillBundle;
  /** The commit the preview was read from. */
  commit: string;
  /** The link the skill updates from later. */
  source: string;
}

export interface GithubFetchOptions {
  /** Where the clone goes; a fresh temporary folder by default. */
  tempRoot?: string;
  /** Tests clone a local bare repository instead of github.com. */
  cloneUrl?: (link: GithubSkillLink) => string;
}

/**
 * Hooks, LFS downloads, submodules and the owner's own git settings and sign-ins are never used,
 * so only public repositories can be read.
 */
const SAFE = [
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.symlinks=false",
  "-c",
  "credential.helper=",
  "-c",
  "filter.lfs.smudge=",
  "-c",
  "filter.lfs.process=",
  "-c",
  "filter.lfs.required=false",
  "-c",
  "submodule.recurse=false",
  "-c",
  "protocol.allow=never",
  "-c",
  "protocol.https.allow=always",
];
const ISOLATED = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_ASKPASS: "/bin/false",
  SSH_ASKPASS: "/bin/false",
};

/** The longest branch or tag that the start of the link's path names. */
function resolveRef(link: GithubSkillLink, refs: string): { ref: string; folder: string } {
  const path = link.rest.join("/");
  if (link.ref && SHA.test(link.ref)) return { ref: link.ref, folder: link.folder };
  const names = refs
    .split("\n")
    .map((line) => line.split("\t")[1] ?? "")
    .map((name) => name.replace(/^refs\/(heads|tags)\//, "").replace(/\^\{\}$/, ""))
    .filter((name) => name && (path === name || path.startsWith(`${name}/`)))
    .sort((a, b) => b.length - a.length);
  const ref = names[0];
  if (!ref) throw new Error("skill_link_unreachable: this branch or tag isn't in the repository.");
  return { ref, folder: path.slice(ref.length + 1) };
}

export async function fetchGithubSkill(
  input: string,
  options: GithubFetchOptions = {},
): Promise<GithubSkill> {
  const link = parseGithubSkillLink(input);
  const url = options.cloneUrl?.(link) ?? `https://github.com/${link.owner}/${link.repo}.git`;
  const safe = options.cloneUrl ? [...SAFE, "-c", "protocol.file.allow=always"] : SAFE;
  // The real path: skill folders are refused when any parent is a symlink, like macOS's /var.
  const base = await realpath(options.tempRoot ?? os.tmpdir());
  const root = await mkdtemp(path.join(base, "zoltbot-skill-"));
  const dir = path.join(root, "repo");
  const run = (args: string[], cwd = dir) => git(cwd, [...safe, ...args], true, ISOLATED);
  const step = async <T>(work: () => Promise<T>, message: string) => {
    try {
      return await work();
    } catch (error) {
      if (error instanceof Error && /^skill_/.test(error.message)) throw error;
      throw new Error(message);
    }
  };
  try {
    await run(["init", "--quiet", dir], root);
    await run(["remote", "add", "origin", url]);
    let target = { ref: "HEAD", folder: "" };
    if (link.ref) {
      const refs = await step(
        () => run(["ls-remote", "--heads", "--tags", "origin"]),
        "skill_link_unreachable: couldn’t reach this repository. Check the link and that it’s public.",
      );
      target = resolveRef(link, refs);
    }
    // Only the commit's folder list comes down here; file contents come with the checkout below.
    await step(
      () =>
        run([
          "fetch",
          "--quiet",
          "--depth",
          "1",
          "--filter=blob:none",
          "--no-tags",
          "origin",
          target.ref,
        ]),
      "skill_link_unreachable: couldn’t fetch this repository. Check the link and that it’s public.",
    );
    const commit = await run(["rev-parse", "FETCH_HEAD"]);
    const folder = path.join(dir, target.folder);
    if (path.relative(dir, folder).startsWith("..")) throw new Error(FOLDER);
    const listing = await step(
      () => run(["ls-tree", "-r", "--name-only", "FETCH_HEAD", "--", target.folder || "."]),
      "skill_folder_invalid: this folder isn’t in the repository.",
    );
    const files = listing.split("\n").filter(Boolean).length;
    if (files === 0) throw new Error("skill_folder_invalid: this folder isn’t in the repository.");
    if (files > githubSkillLimits.files)
      throw new Error("skill_folder_too_large: the folder has over 100 files.");
    await step(
      () => run(["checkout", "--quiet", commit, "--", target.folder || "."]),
      "skill_link_unreachable: couldn’t download this folder. Try again.",
    );
    let bundle: SkillBundle;
    try {
      bundle = readSkillFolder(folder);
    } catch (error) {
      const reason = error instanceof Error ? error.message.replace(dir, "") : "";
      throw new Error(`skill_folder_invalid: this folder isn’t a skill (${reason}).`);
    }
    const source = `https://github.com/${link.owner}/${link.repo}${
      link.ref ? `/tree/${target.ref}${target.folder ? `/${target.folder}` : ""}` : ""
    }`;
    return { bundle, commit, source };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

export const isGithubSource = (source: string) => source.startsWith("https://github.com/");
