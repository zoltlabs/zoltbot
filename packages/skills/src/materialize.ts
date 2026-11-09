import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import type { SkillSelection, SkillSnapshot, SkillsLibrary } from "./library.js";
import { assertRelative, digest } from "./parser.js";
export type SkillLayout = (skill: SkillSelection) => {
  prefix: string;
  files: { path: string; content: string }[];
  namespace: string;
};
/** The caller supplies a daemon-owned runtime root, never a project checkout. */
export function materializeSkills(
  library: SkillsLibrary,
  snapshot: SkillSnapshot,
  runtimeRoot: string,
  layout?: SkillLayout,
): string[] {
  if (!path.isAbsolute(runtimeRoot)) throw new Error("skill_runtime_root_invalid");
  mkdirSync(runtimeRoot, { recursive: true, mode: 0o700 });
  if (lstatSync(runtimeRoot).isSymbolicLink()) throw new Error("skill_runtime_root_symlink");
  const manifestDir = path.join(runtimeRoot, `skills-${digest(snapshot.manifestId)}`);
  const directory = (dir: string) => {
    if (existsSync(dir)) {
      const stat = lstatSync(dir);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("skill_snapshot_tampered");
    } else mkdirSync(dir, { mode: 0o700 });
  };
  directory(manifestDir);
  return snapshot.skills.map((selected) => {
    const bundle = library.revision(selected.skillId, selected.revision).bundle;
    if (bundle.hash !== selected.hash || bundle.name !== selected.name)
      throw new Error("skill_snapshot_hash_mismatch");
    const target = path.join(manifestDir, `${bundle.name}-${bundle.hash}`);
    directory(target);
    const wrapper = layout?.(selected),
      prefix = wrapper?.prefix ?? "";
    if (prefix) assertRelative(prefix);
    const files = [
      ...(wrapper?.files ?? []),
      ...bundle.files.map((file) => ({
        path: prefix ? `${prefix}/${file.path}` : file.path,
        content: file.content,
      })),
    ].map((file) => {
      assertRelative(file.path);
      return { ...file, hash: digest(file.content) };
    });
    if (new Set(files.map((file) => file.path)).size !== files.length)
      throw new Error("skill_wrapper_path_conflict");
    const allowed = new Set(files.map((file) => file.path));
    function verify(dir: string, parent: string) {
      for (const entry of readdirSync(dir)) {
        const relative = parent ? `${parent}/${entry}` : entry,
          absolute = path.join(dir, entry),
          stat = lstatSync(absolute);
        if (stat.isSymbolicLink()) throw new Error("skill_snapshot_tampered");
        if (stat.isDirectory()) verify(absolute, relative);
        else if (!allowed.has(relative) || !stat.isFile())
          throw new Error("skill_snapshot_tampered");
      }
    }
    verify(target, "");
    for (const file of files) {
      let dir = target;
      for (const part of file.path.split("/").slice(0, -1)) {
        dir = path.join(dir, part);
        directory(dir);
      }
      const absolute = path.join(target, file.path);
      if (existsSync(absolute)) {
        if (
          lstatSync(absolute).isSymbolicLink() ||
          digest(readFileSync(absolute, "utf8")) !== file.hash
        )
          throw new Error("skill_snapshot_tampered");
      } else writeFileSync(absolute, file.content, { flag: "wx", mode: 0o400 });
      chmodSync(absolute, 0o400);
    }
    return prefix ? path.join(target, prefix) : target;
  });
}
