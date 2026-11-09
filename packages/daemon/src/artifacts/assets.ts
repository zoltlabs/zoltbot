import type { IncomingMessage, ServerResponse } from "node:http";
import type { Store } from "@zoltbot/store";
import { blobBytes } from "./intake.js";
import { artifactDirectory, contentHash, versionDetail } from "./model.js";
/** Called only after the daemon's existing bearer, origin and method checks. */
export async function serveArtifactAsset(
  store: Store,
  request: IncomingMessage,
  response: ServerResponse,
) {
  const match = /^\/artifact-(blob|manifest)\/([a-f0-9]{64})$/.exec(request.url ?? "");
  if (!match) throw Error("artifact_asset_not_found");
  const hash = match[2] ?? "";
  let bytes: Buffer, mime: string;
  if (match[1] === "manifest") {
    const row = store.database
      .prepare("SELECT id FROM artifact_versions WHERE manifest_hash=? LIMIT 1")
      .get(hash) as { id: string } | undefined;
    if (!row) throw Error("artifact_manifest_not_found");
    const { manifest } = versionDetail(store, row.id);
    const text = JSON.stringify(manifest);
    if (contentHash(text) !== hash) throw Error("artifact_manifest_corrupt");
    bytes = Buffer.from(text);
    mime = "application/json";
  } else {
    const requested = request.headers["x-zoltbot-artifact-mime"];
    const row = store.database
      .prepare(
        `SELECT mime,bytes FROM artifact_blob_types_aux WHERE hash=? ${typeof requested === "string" ? "AND mime=?" : ""} LIMIT 1`,
      )
      .get(...(typeof requested === "string" ? [hash, requested] : [hash])) as
      | { mime: string; bytes: number }
      | undefined;
    if (!row) throw Error("artifact_blob_not_found");
    bytes = await blobBytes(artifactDirectory(store), hash);
    if (bytes.length !== row.bytes) throw Error("artifact_blob_corrupt");
    mime = row.mime;
  }
  response.writeHead(200, {
    "Content-Type": mime,
    "Content-Length": bytes.length,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; sandbox",
  });
  response.end(bytes);
}
