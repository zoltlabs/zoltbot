import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import path from "node:path";
import { parseDocument } from "yaml";

export const skillLimits = {
  files: 100,
  fileBytes: 256_000,
  totalBytes: 1_000_000,
  bodyBytes: 64_000,
};
export interface SkillFile {
  path: string;
  content: string;
  hash: string;
  bytes: number;
}
export interface SkillBundle {
  name: string;
  description: string;
  body: string;
  files: SkillFile[];
  hash: string;
  warnings: string[];
}
export const digest = (value: string) => createHash("sha256").update(value).digest("hex");
export function assertRelative(file: string) {
  if (
    !file ||
    file.includes("\\") ||
    path.posix.isAbsolute(file) ||
    file.split("/").some((p) => !p || p === "." || p === "..") ||
    [...file].some((c) => c.charCodeAt(0) < 32)
  )
    throw new Error(`${file}: invalid relative path`);
}
function text(content: string, file: string) {
  if (Buffer.byteLength(content) > skillLimits.fileBytes)
    throw new Error(`${file}: file too large`);
  if (
    [...content].some(
      (c) =>
        c.charCodeAt(0) < 9 || (c.charCodeAt(0) > 13 && c.charCodeAt(0) < 32) || c === "\ufffd",
    )
  )
    throw new Error(`${file}: binary or invalid UTF-8`);
  if (
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:sk-proj-|sk-ant-)[A-Za-z0-9_-]{16,}|\bgh[pousr]_[A-Za-z0-9]{20,}|(?:api[_-]?key|access[_-]?token|password)\s*[:=]\s*["']?[A-Za-z0-9_+/-]{16,}/i.test(
      content,
    )
  )
    throw new Error(`${file}: possible secret; remove it before importing`);
}
export function parseSkill(files: { path: string; content: string }[]): SkillBundle {
  if (!files.length || files.length > skillLimits.files)
    throw new Error("skill: invalid file count");
  const names = new Set<string>();
  let total = 0;
  const entries = files
    .map((file) => {
      assertRelative(file.path);
      if (names.has(file.path.toLowerCase())) throw new Error(`${file.path}: duplicate file`);
      names.add(file.path.toLowerCase());
      if (
        /(^|\/)(?:\.env(?:\..*)?|credentials(?:\.json)?|package\.json|\.npmrc|\.git|node_modules)(\/|$)/i.test(
          file.path,
        )
      )
        throw new Error(`${file.path}: configuration/install hooks are not allowed`);
      text(file.content, file.path);
      const bytes = Buffer.byteLength(file.content);
      total += bytes;
      return { ...file, bytes, hash: digest(file.content) };
    })
    .sort((a, b) => a.path.localeCompare(b.path));
  if (total > skillLimits.totalBytes) throw new Error("skill: folder too large");
  const source = entries.find((file) => file.path === "SKILL.md")?.content;
  if (!source) throw new Error("SKILL.md: required");
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(source);
  if (!match || Buffer.byteLength(match[1] ?? "") > 8000)
    throw new Error("SKILL.md: bounded YAML frontmatter required");
  const doc = parseDocument(match[1] ?? "", { schema: "core", uniqueKeys: true, customTags: [] });
  if (doc.errors.length || doc.warnings.length)
    throw new Error("SKILL.md: invalid YAML frontmatter");
  let meta: unknown;
  try {
    meta = doc.toJS({ maxAliasCount: 0 });
  } catch {
    throw new Error("SKILL.md: YAML aliases are not allowed");
  }
  if (!meta || typeof meta !== "object" || Array.isArray(meta))
    throw new Error("SKILL.md: metadata must be a mapping");
  for (const key of Object.keys(meta))
    if (!["name", "description", "license", "compatibility"].includes(key))
      throw new Error(
        `SKILL.md: ${key} is not allowed; managed skills cannot change tools, models, hooks or permissions`,
      );
  const { name, description } = meta as Record<string, unknown>;
  if (typeof name !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name.length > 64)
    throw new Error("SKILL.md: name must be a lowercase slug (64 characters maximum)");
  if (typeof description !== "string" || !description.trim() || description.length > 1024)
    throw new Error("SKILL.md: description required (1024 characters maximum)");
  const body = match[2] ?? "";
  if (!body.trim() || Buffer.byteLength(body) > skillLimits.bodyBytes)
    throw new Error("SKILL.md: instructions required (64000 bytes maximum)");
  if (/!`/.test(source)) throw new Error("SKILL.md: dynamic shell substitution is not allowed");
  const warnings: string[] = [];
  for (const file of entries) {
    if (file.path.startsWith("scripts/") || /\.(sh|py|js|ts|rb|ps1)$/.test(file.path))
      warnings.push(`${file.path}: script; never executed during import`);
    for (const link of file.content.matchAll(/\]\(([^\s)]+)[^)]*\)/g)) {
      const target = link[1] ?? "";
      if (/^https?:\/\//.test(target)) {
        const url = new URL(target);
        if (
          url.username ||
          url.password ||
          [...url.searchParams.keys()].some((key) =>
            /token|secret|key|auth|password|signature/i.test(key),
          )
        )
          throw new Error(`${file.path}: credential-bearing URL is not allowed`);
        warnings.push(`${file.path}: external reference ${target.split(/[?#]/)[0]}`);
        continue;
      }
      if (target.startsWith("#")) continue;
      assertRelative(target.split("#")[0] ?? "");
      const resolved = path.posix.normalize(
        path.posix.join(path.posix.dirname(file.path), target.split("#")[0] ?? ""),
      );
      assertRelative(resolved);
      if (!names.has(resolved.toLowerCase()))
        throw new Error(`${file.path}: missing relative reference ${target}`);
    }
  }
  if (/\b(?:Bash|AskUserQuestion|ToolSearch)\b/.test(source))
    warnings.push("Mentions provider-specific tools; portability is not verified");
  return {
    name,
    description,
    body,
    files: entries,
    warnings: [...new Set(warnings)],
    hash: digest(JSON.stringify(entries.map(({ path, hash }) => [path, hash]))),
  };
}
export function readSkillFolder(root: string): SkillBundle {
  if (!path.isAbsolute(root)) throw new Error("skill folder: absolute path required");
  // Check every ancestor: a symlinked source is never silently dereferenced.
  let ancestor = path.resolve(root);
  while (true) {
    const stat = lstatSync(ancestor);
    if (stat.isSymbolicLink() || !stat.isDirectory())
      throw new Error(`${ancestor}: symlinks/non-directories are not allowed`);
    const parent = path.dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  const files: { path: string; content: string }[] = [];
  let total = 0;
  function walk(dir: string, prefix: string, depth: number) {
    if (depth > 8) throw new Error(`${prefix}: folder nesting limit exceeded`);
    for (const name of readdirSync(dir).sort()) {
      const relative = prefix ? `${prefix}/${name}` : name;
      assertRelative(relative);
      const absolute = path.join(dir, name),
        stat = lstatSync(absolute);
      if (stat.isSymbolicLink()) throw new Error(`${relative}: symlinks are not allowed`);
      if (stat.isDirectory()) {
        walk(absolute, relative, depth + 1);
        continue;
      }
      if (!stat.isFile() || stat.size > skillLimits.fileBytes)
        throw new Error(`${relative}: non-regular or oversized file`);
      if (++total > skillLimits.files) throw new Error("skill: too many files");
      const fd = openSync(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const current = fstatSync(fd);
        if (
          !current.isFile() ||
          current.ino !== stat.ino ||
          current.dev !== stat.dev ||
          current.size > skillLimits.fileBytes
        )
          throw new Error(`${relative}: source changed; review again`);
        files.push({ path: relative, content: readFileSync(fd).toString("utf8") });
      } finally {
        closeSync(fd);
      }
    }
  }
  walk(root, "", 0);
  return parseSkill(files);
}
