import type { ArtifactManifest } from "@zoltbot/protocol";
import type { RuntimeContext } from "../api.js";
import { blobBytes, possibleSecret } from "./intake.js";
import { artifactDirectory } from "./model.js";

/** Exact immutable text, never a workspace path or instructions. JSON size includes escaping. */
export async function readArtifactSource(
  context: RuntimeContext,
  manifest: ArtifactManifest,
  versionId: string,
  path: string,
  cursor?: string,
) {
  const file = manifest.files.find((entry) => entry.path === path);
  if (!file) throw Error("artifact_file_not_found");
  if (!/^(text\/|application\/(json|javascript)$|image\/svg\+xml$)/.test(file.mime))
    return { versionId, path, editable: false, reason: "binary_asset" };
  const bytes = await blobBytes(artifactDirectory(context.store), file.hash);
  if (bytes.length !== file.bytes) throw Error("artifact_blob_corrupt");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const check = await context.privacy.prepareData({ path, text });
  if (possibleSecret(path, text)) return { versionId, held: true };
  check(context.store.snapshot());
  // Bind pagination to exact file bytes, not merely a numeric offset from another file.
  const prefix = `${file.hash}:`;
  if (cursor && (!cursor.startsWith(prefix) || !/^(0|[1-9]\d*)$/.test(cursor.slice(prefix.length))))
    throw Error("artifact_cursor_invalid");
  const offset = cursor ? Number(cursor.slice(prefix.length)) : 0;
  if (!Number.isSafeInteger(offset) || offset > text.length) throw Error("artifact_cursor_invalid");
  if (offset > 0 && /[\uDC00-\uDFFF]/.test(text[offset] ?? ""))
    throw Error("artifact_cursor_invalid");
  let end = Math.min(text.length, offset + 2800);
  const page = () => ({
    versionId,
    path,
    editable: true,
    text: text.slice(offset, end),
    cursor: end < text.length ? `${prefix}${end}` : null,
  });
  while (JSON.stringify(page()).length > 3800) end--;
  if (end < text.length && /[\uDC00-\uDFFF]/.test(text[end] ?? "")) end--;
  return page();
}
