import type { IncomingMessage, ServerResponse } from "node:http";
import type { ViewRegistry } from "./registry.js";
export async function serveViewAsset(
  registry: ViewRegistry,
  request: IncomingMessage,
  response: ServerResponse,
) {
  const match = /^\/view-(manifest|file)\/([a-f0-9]{64})(?:\/([a-f0-9]{64}))?$/.exec(
    request.url ?? "",
  );
  if (!match || (match[1] === "file") !== !!match[3]) throw Error("view_asset_not_found");
  const asset = await registry.asset(match[2] ?? "", match[3]);
  response.writeHead(200, {
    "Content-Type": asset.mime,
    "Content-Length": asset.bytes.length,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; sandbox",
  });
  response.end(asset.bytes);
}
