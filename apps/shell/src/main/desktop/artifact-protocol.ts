import { createHash } from "node:crypto";
import { type ArtifactManifest, ArtifactManifestSchema, parse } from "@zoltbot/protocol";
import { artifactMarkdownHtml } from "./artifact-markdown";
import { validBundlePath as validPath } from "./bundle-path";

/** The largest agent file the window opens or downloads (C18). */
export const ARTIFACT_FILE_BYTES = 100 * 1024 * 1024;
/** Files a page can run or render as a document stay at the old limit. */
const ACTIVE_FILE_BYTES = 25 * 1024 * 1024;

/**
 * Kinds that only play or download: they stream, and a bad hash cuts them off at the end.
 * Everything else, such as HTML, SVG, scripts and Markdown, is verified whole first.
 */
export function streamable(mime: string): boolean {
  return (
    /^(image\/(png|jpeg|gif|webp|avif)|video\/[a-z0-9.+-]+|audio\/[a-z0-9.+-]+)$/.test(mime) ||
    mime === "application/octet-stream" ||
    mime === "application/zip"
  );
}

/**
 * Passes bytes through while hashing them. Too many bytes, or a wrong hash or length at the end,
 * errors the stream, so a changed file never arrives whole.
 */
export function verified(hash: string, size: number): TransformStream<Uint8Array, Uint8Array> {
  const hashing = createHash("sha256");
  let count = 0;
  return new TransformStream({
    transform(chunk, controller) {
      count += chunk.byteLength;
      if (count > size) throw Error("artifact_blob_corrupt");
      hashing.update(chunk);
      controller.enqueue(chunk);
    },
    flush() {
      if (count !== size || hashing.digest("hex") !== hash) throw Error("artifact_blob_corrupt");
    },
  });
}

const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
export const artifactScheme = "zoltbot-artifact:";
export function artifactCsp(origin: string, manifestHash: string, scripts: boolean) {
  const bundle = `${artifactScheme}//${manifestHash}`;
  return [
    "default-src 'none'",
    `sandbox${scripts ? " allow-scripts" : ""}`,
    `script-src ${scripts ? `${bundle} 'unsafe-inline'` : "'none'"}`,
    `style-src ${bundle} 'unsafe-inline'`,
    `img-src ${bundle} data: blob:`,
    `font-src ${bundle}`,
    `media-src ${bundle}`,
    `connect-src ${bundle}`,
    "form-action 'none'",
    "base-uri 'none'",
    "object-src 'none'",
    "frame-src 'none'",
    "worker-src 'none'",
    `frame-ancestors ${origin}`,
  ].join("; ");
}
const escapeText = (value: string) =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const sourceHtml = (text: string) =>
  `<p>Large document: showing source text.</p><pre style="white-space:pre-wrap;overflow-wrap:anywhere">${escapeText(text)}</pre>`;
/**
 * Main-process only. Credentials live in the supplied fetch callback, never in a scheme URL.
 * Markdown up to 64 KB renders to static HTML; larger files show as escaped source text.
 */
export function artifactProtocol(options: {
  origin: string;
  kitAsset?(name: string): { bytes: Uint8Array; mime: string } | undefined;
  asset(kind: "manifest" | "blob", hash: string, mime?: string): Promise<Uint8Array>;
  /** C18: a file as a stream, so large ones never sit in memory. Falls back to `asset`. */
  blob?(hash: string, mime: string): Promise<ReadableStream<Uint8Array>>;
}) {
  const manifests = new Map<string, ArtifactManifest>();
  return {
    /** Reads a manifest or file from the daemon, as publishing does (S1). */
    asset: (kind: "manifest" | "blob", hash: string) => options.asset(kind, hash),
    async prepare(manifestHash: string) {
      if (!/^[a-f0-9]{64}$/.test(manifestHash)) throw Error("artifact_manifest_invalid");
      const bytes = await options.asset("manifest", manifestHash);
      if (bytes.length > 1024 * 1024 || hash(bytes) !== manifestHash)
        throw Error("artifact_manifest_corrupt");
      const manifest = parse(
        ArtifactManifestSchema,
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
      );
      const paths = new Set<string>();
      let total = 0;
      for (const f of manifest.files) {
        if (!validPath(f.path) || paths.has(f.path.toLowerCase()))
          throw Error("artifact_path_invalid");
        paths.add(f.path.toLowerCase());
        total += f.bytes;
      }
      if (total > 100 * 1024 * 1024 || !manifest.files.some((f) => f.path === manifest.entry))
        throw Error("artifact_manifest_invalid");
      // Bounded metadata cache; source bytes are fetched and verified for every response.
      if (manifests.size >= 200) manifests.delete(manifests.keys().next().value ?? "");
      manifests.set(manifestHash, manifest);
      return {
        url: `${artifactScheme}//${manifestHash}/${manifest.entry.split("/").map(encodeURIComponent).join("/")}`,
      };
    },
    async handle(request: Request): Promise<Response> {
      let manifestHash = "";
      const headers = (scripts = false) => ({
        "Content-Security-Policy": artifactCsp(options.origin, manifestHash, scripts),
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "no-store",
        "Access-Control-Allow-Origin": "null",
        "X-DNS-Prefetch-Control": "off",
        "Referrer-Policy": "no-referrer",
      });
      try {
        const url = new URL(request.url);
        manifestHash = url.hostname;
        if (
          request.method !== "GET" ||
          url.protocol !== artifactScheme ||
          !/^[a-f0-9]{64}$/.test(manifestHash) ||
          url.username ||
          url.password ||
          url.port ||
          url.search
        )
          throw Error("invalid");
        const relative = decodeURIComponent(url.pathname.slice(1));
        if (!validPath(relative)) throw Error("invalid");
        const manifest = manifests.get(manifestHash);
        if (manifest?.kit === "v1" && relative.startsWith("kit/v1/")) {
          const asset = options.kitAsset?.(relative.slice(7));
          if (asset)
            return new Response(asset.bytes as BodyInit, {
              headers: { ...headers(), "Content-Type": `${asset.mime}; charset=utf-8` },
            });
        }
        const file = manifest?.files.find((f) => f.path === relative);
        if (!file) return new Response(null, { status: 404, headers: headers() });
        const passive = streamable(file.mime);
        // Anything a page could run is checked whole before it's served, so it stays at 25 MB.
        if (file.bytes > (passive ? ARTIFACT_FILE_BYTES : ACTIVE_FILE_BYTES))
          throw Error("artifact_blob_corrupt");
        if (options.blob && passive) {
          const body = (await options.blob(file.hash, file.mime)).pipeThrough(
            verified(file.hash, file.bytes),
          );
          return new Response(body, {
            headers: {
              ...headers(file.mime === "text/html"),
              "Content-Type": file.mime,
              "Content-Length": String(file.bytes),
            },
          });
        }
        let bytes = await options.asset("blob", file.hash, file.mime);
        if (
          bytes.length !== file.bytes ||
          bytes.length > (passive ? ARTIFACT_FILE_BYTES : ACTIVE_FILE_BYTES) ||
          hash(bytes) !== file.hash
        )
          throw Error("artifact_blob_corrupt");
        let mime = file.mime;
        if (mime === "text/markdown") {
          const text = new TextDecoder().decode(bytes);
          const body = bytes.length <= 64 * 1024 ? artifactMarkdownHtml(text) : sourceHtml(text);
          bytes = Buffer.from(`<!doctype html><meta charset="utf-8">${body}`);
          mime = "text/html";
        }
        return new Response(bytes as BodyInit, {
          headers: { ...headers(file.mime === "text/html"), "Content-Type": mime },
        });
      } catch {
        return new Response(null, { status: 404, headers: headers() });
      }
    },
  };
}
