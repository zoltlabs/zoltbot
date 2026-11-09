import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";
import { artifactLimits, artifactPath, possibleSecret } from "@zoltbot/artifact-validation";
import { artifactSearchText } from "./search-text.js";
import { verifiedType } from "./types.js";

export { artifactLimits, artifactPath, possibleSecret } from "@zoltbot/artifact-validation";
export interface ArtifactFile {
  path: string;
  hash: string;
  bytes: number;
  mime: string;
}
export interface ImportedBundle {
  files: ArtifactFile[];
  totalBytes: number;
  held: boolean;
  external: boolean;
  text: string;
}
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
export async function checkedAncestors(target: string) {
  const absolute = path.resolve(target);
  const pieces = absolute.split(path.sep).filter(Boolean);
  let cursor = path.parse(absolute).root;
  const identities = [];
  for (const piece of pieces) {
    cursor = path.join(cursor, piece);
    const info = await lstat(cursor);
    if (!info.isDirectory() || info.isSymbolicLink()) throw Error("artifact_directory_denied");
    identities.push([cursor, info.dev, info.ino]);
  }
  if ((await realpath(absolute)) !== absolute) throw Error("artifact_directory_denied");
  return JSON.stringify(identities);
}
export async function safeFile(root: string, relative: string) {
  artifactPath(relative);
  const target = path.join(root, relative);
  const parent = path.dirname(target);
  const ancestors = await checkedAncestors(parent);
  const file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.uid !== process.getuid?.() ||
      stat.size > artifactLimits.file
    )
      throw Error("artifact_file_denied");
    const chunks: Buffer[] = [];
    let count = 0;
    for await (const chunk of file.createReadStream({ autoClose: false })) {
      count += chunk.length;
      if (count > artifactLimits.file) throw Error("artifact_file_too_large");
      chunks.push(Buffer.from(chunk));
    }
    const after = await file.stat();
    if (
      count !== stat.size ||
      after.size !== stat.size ||
      after.mtimeMs !== stat.mtimeMs ||
      after.nlink !== 1 ||
      (await checkedAncestors(parent)) !== ancestors
    )
      throw Error("artifact_file_changed");
    return Buffer.concat(chunks);
  } finally {
    await file.close();
  }
}
export async function blobBytes(directory: string, hash: string) {
  if (!/^[a-f0-9]{64}$/.test(hash)) throw Error("invalid_artifact_hash");
  const bytes = await safeFile(path.join(directory, "blobs"), hash);
  if (digest(bytes) !== hash) throw Error("artifact_blob_corrupt");
  return bytes;
}
export async function importFiles(
  directory: string,
  inputs: AsyncIterable<{ path: string; bytes: Buffer }>,
  privateCheck: (text: string) => Promise<boolean> = async () => false,
): Promise<ImportedBundle> {
  const blobs = path.join(directory, "blobs");
  await mkdir(blobs, { recursive: true, mode: 0o700 });
  await checkedAncestors(blobs);
  const files: ArtifactFile[] = [],
    seen = new Set<string>();
  let totalBytes = 0,
    held = false,
    external = false,
    visible = "";
  for await (const input of inputs) {
    const name = artifactPath(input.path);
    const folded = name.toLowerCase();
    if (seen.has(folded)) throw Error("artifact_path_collision");
    seen.add(folded);
    totalBytes += input.bytes.length;
    if (
      input.bytes.length > artifactLimits.file ||
      totalBytes > artifactLimits.version ||
      files.length >= artifactLimits.files
    )
      throw Error("artifact_limit_exceeded");
    const mime = verifiedType(name, input.bytes);
    const text =
      mime.startsWith("text/") || mime.includes("json") || mime.includes("svg")
        ? input.bytes.toString("utf8")
        : "";
    held ||= possibleSecret(name, text) || (await privateCheck(text));
    external ||= /https?:\/\//i.test(text);
    if (visible.length < 16000)
      visible += artifactSearchText(mime, text).slice(0, 16000 - visible.length);
    let hash = "";
    const temporary = path.join(blobs, `.${randomUUID()}.partial`);
    try {
      const handle = await open(temporary, "wx", 0o400);
      try {
        const hashing = createHash("sha256");
        for (let offset = 0; offset < input.bytes.length; offset += 65536) {
          const chunk = input.bytes.subarray(offset, offset + 65536);
          hashing.update(chunk);
          await handle.writeFile(chunk);
        }
        hash = hashing.digest("hex");
        await handle.sync();
      } finally {
        await handle.close();
      }
      // Rename replaces only a hash-named path in the app-owned store; verify on every serve.
      await rename(temporary, path.join(blobs, hash));
    } finally {
      await rm(temporary, { force: true });
    }
    files.push({ path: name, hash, bytes: input.bytes.length, mime });
  }
  if (!files.length) throw Error("empty_artifact");
  return {
    files: files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    totalBytes,
    held,
    external,
    text: held ? "" : visible,
  };
}
