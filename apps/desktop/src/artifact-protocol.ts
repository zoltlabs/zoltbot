import { createHash } from "node:crypto";
import { type ArtifactManifest, ArtifactManifestSchema, parse } from "@zoltbot/protocol";

import { artifactMarkdownHtml } from "../../../packages/ui/src/artifacts/markdown-html.js";

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
function validPath(value: string) {
  return (
    value.length > 0 &&
    value.length <= 512 &&
    !/[\\:#?%]/.test(value) &&
    !Array.from(value).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) &&
    !value.startsWith("/") &&
    value.split("/").every((p) => p && p !== "." && p !== "..")
  );
}
const escapeText = (value: string) =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
/** Main-process only. Credentials live in the supplied fetch callback, never in a scheme URL. */
export function artifactProtocol(options: {
  origin: string;
  kitAsset?(name: string): { bytes: Uint8Array; mime: string } | undefined;
  asset(kind: "manifest" | "blob", hash: string, mime?: string): Promise<Uint8Array>;
}) {
  const manifests = new Map<string, ArtifactManifest>();
  return {
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
        let bytes = await options.asset("blob", file.hash, file.mime);
        if (
          bytes.length !== file.bytes ||
          bytes.length > 25 * 1024 * 1024 ||
          hash(bytes) !== file.hash
        )
          throw Error("artifact_blob_corrupt");
        let mime = file.mime;
        if (mime === "text/markdown") {
          const text = new TextDecoder().decode(bytes);
          const body =
            bytes.length <= 64 * 1024
              ? artifactMarkdownHtml(text)
              : `<p>Large document: showing source text.</p><pre style="white-space:pre-wrap;overflow-wrap:anywhere">${escapeText(text)}</pre>`;
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
