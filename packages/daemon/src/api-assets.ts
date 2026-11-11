import { createServer } from "node:http";
import type { Store } from "@zoltbot/store";
import { serveArtifactAsset } from "./artifacts/assets.js";
import { evidenceBytes } from "./browser/evidence.js";
import { serveViewAsset } from "./views/assets.js";
import type { ViewRegistry } from "./views/registry.js";
export function assetServer(
  store: Store,
  token: string,
  origins: ReadonlySet<string>,
  views?: () => ViewRegistry | undefined,
) {
  return createServer((request, response) => {
    const authorized = request.headers.authorization === `Bearer ${token}`;
    if (
      !authorized ||
      (request.headers.origin && !origins.has(request.headers.origin)) ||
      request.method !== "GET"
    ) {
      response.writeHead(403);
      response.end();
      return;
    }
    if ((request.url ?? "").startsWith("/view-")) {
      const registry = views?.();
      if (!registry) {
        response.writeHead(404);
        response.end();
        return;
      }
      void serveViewAsset(registry, request, response).catch(() => {
        response.writeHead(404);
        response.end();
      });
      return;
    }
    if (/^\/artifact-(blob|manifest)\/[a-f0-9]{64}$/.test(request.url ?? "")) {
      void serveArtifactAsset(store, request, response).catch(() => {
        response.writeHead(404);
        response.end();
      });
      return;
    }
    if (!/^\/browser-evidence\/[a-f0-9]{64}$/.test(request.url ?? "")) {
      response.writeHead(403);
      response.end();
      return;
    }
    try {
      const bytes = evidenceBytes(store, (request.url ?? "").split("/")[2] ?? "");
      response.writeHead(200, {
        "Content-Type": "image/png",
        "Content-Length": bytes.length,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      });
      response.end(bytes);
    } catch {
      response.writeHead(404);
      response.end();
    }
  });
}
