import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { ArtifactFileSchema, parse } from "@zoltbot/protocol";
import { parseViewManifest } from "../../../packages/view-api/src/index.js";
import { validBundlePath } from "./bundle-path.js";

export const viewScheme = "zoltbot-view:";
const digest = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
type File = import("@zoltbot/protocol").ArtifactManifest["files"][number];
export function viewCsp(origin: string, hash: string) {
  const bundle = `${viewScheme}//${hash}`;
  return [
    "default-src 'none'",
    "sandbox allow-scripts",
    `script-src ${bundle} 'unsafe-inline'`,
    `style-src ${bundle} 'unsafe-inline'`,
    `img-src ${bundle} data: blob:`,
    `font-src ${bundle}`,
    `media-src ${bundle} blob:`,
    `worker-src ${bundle} blob:`,
    `connect-src ${bundle}`,
    "form-action 'none'",
    "base-uri 'none'",
    "object-src 'none'",
    "frame-src 'none'",
    `frame-ancestors ${origin}`,
  ].join("; ");
}
export function viewProtocol(options: {
  origin: string;
  client?(): Uint8Array;
  asset(kind: "manifest" | "file", bundleHash: string, fileHash?: string): Promise<Uint8Array>;
}) {
  const bundles = new Map<string, { entry: string; files: File[] }>();
  return {
    async prepare(hash: string) {
      if (!/^[a-f0-9]{64}$/.test(hash)) throw Error("view_hash_invalid");
      const bytes = await options.asset("manifest", hash);
      if (bytes.length > 2 * 25 * 1024 * 1024 + 1024 * 1024) throw Error("view_manifest_too_large");
      const raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      if (
        typeof raw.manifestBytes !== "string" ||
        !Array.isArray(raw.files) ||
        !raw.files.length ||
        raw.files.length > 500
      )
        throw Error("view_manifest_invalid");
      const manifestValue = JSON.parse(raw.manifestBytes);
      const manifest = parseViewManifest(manifestValue, String(manifestValue.id));
      const files = raw.files.map((file: unknown) => parse(ArtifactFileSchema, file)) as File[];
      const names = new Set<string>();
      let total = 0;
      for (const file of files) {
        if (
          !validBundlePath(file.path) ||
          file.path !== file.path.normalize("NFC") ||
          file.path.toLowerCase().startsWith("_host/") ||
          names.has(file.path.toLowerCase())
        )
          throw Error("view_path_invalid");
        names.add(file.path.toLowerCase());
        total += file.bytes;
      }
      const expected = digest(
        raw.manifestBytes +
          files
            .map((file) => `${file.path}:${file.hash}`)
            .sort()
            .join("\n"),
      );
      const entry = files.find((file) => file.path === manifest.entry);
      const manifestFile = files.find((file) => file.path === "view.json");
      if (
        expected !== hash ||
        total > 100 * 1024 * 1024 ||
        entry?.mime !== "text/html" ||
        manifestFile?.hash !== digest(raw.manifestBytes) ||
        manifestFile.bytes !== Buffer.byteLength(raw.manifestBytes)
      )
        throw Error("view_manifest_corrupt");
      if (bundles.size >= 200) bundles.delete(bundles.keys().next().value ?? "");
      bundles.set(hash, { entry: manifest.entry, files });
      return {
        url: `${viewScheme}//${hash}/${manifest.entry.split("/").map(encodeURIComponent).join("/")}`,
      };
    },
    async handle(request: Request) {
      let hash = "";
      const headers = () => ({
        "Content-Security-Policy": viewCsp(options.origin, hash),
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
        "Access-Control-Allow-Origin": "null",
        "X-DNS-Prefetch-Control": "off",
      });
      try {
        const url = new URL(request.url);
        hash = url.hostname;
        if (
          request.method !== "GET" ||
          url.protocol !== viewScheme ||
          !/^[a-f0-9]{64}$/.test(hash) ||
          url.username ||
          url.password ||
          url.port ||
          url.search ||
          url.hash
        )
          throw Error("invalid");
        const name = decodeURIComponent(url.pathname.slice(1));
        if (!validBundlePath(name)) throw Error("invalid");
        const bundle = bundles.get(hash);
        if (!bundle) throw Error("view_not_prepared");
        let bytes: Uint8Array, mime: string;
        if (name === "_host/v1/zolt.js" && options.client) {
          bytes = options.client();
          mime = "text/javascript";
          if (bytes.length > 256 * 1024) throw Error("view_client_too_large");
        } else {
          const file = bundle.files.find((entry) => entry.path === name);
          if (!file) throw Error("view_file_not_found");
          bytes = await options.asset("file", hash, file.hash);
          mime = file.mime;
          if (
            bytes.length !== file.bytes ||
            bytes.length > 25 * 1024 * 1024 ||
            digest(bytes) !== file.hash
          )
            throw Error("view_file_corrupt");
        }
        return new Response(bytes as BodyInit, { headers: { ...headers(), "Content-Type": mime } });
      } catch {
        return new Response(null, { status: 404, headers: headers() });
      }
    },
  };
}
/** Only main-process code receives this callback; no credential enters the scheme or frame. */
export function desktopViewProtocol(
  origin: string,
  root: string,
  connection: () => { url: string; token: string },
) {
  return viewProtocol({
    origin,
    client: () => readFileSync(path.join(root, "packages/view-api/client/zolt.js")),
    async asset(kind, hash, fileHash) {
      const info = connection(),
        url = new URL(info.url.replace(/^ws:/, "http:"));
      if (url.hostname !== "127.0.0.1") throw Error("invalid_daemon_address");
      url.pathname = `/view-${kind}/${hash}${fileHash ? `/${fileHash}` : ""}`;
      const limit = kind === "manifest" ? 2 * 25 * 1024 * 1024 + 1024 * 1024 : 25 * 1024 * 1024;
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${info.token}` },
        signal: AbortSignal.timeout(10000),
        redirect: "error",
      });
      if (!response.ok || Number(response.headers.get("content-length")) > limit)
        throw Error("view_unavailable");
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.length > limit) throw Error("view_too_large");
      return bytes;
    },
  });
}
